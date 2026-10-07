/**
 * The testnet mark vault of a leverage series (qBTC2X, qETH2X): deploys a
 * QuadrixIndexVault — the contract of the qX20 tracking vault, unchanged —
 * with a deposit cap of 0, so nobody can deposit from deployment until the
 * owner opens it; and the two owner actions after it (open deposits, pause).
 *
 * DRY RUN IS THE DEFAULT: the deployment is simulated (eth_call of the
 * creation code) and the runtime code it returns is compared with the
 * artifact; nothing is sent and nothing is written. A transaction is sent only
 * with --live AND --confirm EXECUTE, signed here with KEEPER_PK (the public
 * endpoint holds no key) or, on a local anvil fork only, from an unlocked
 * --from account.
 *
 * Every transaction is written to the log BEFORE anything else is read
 * (keeper/mark-vaults.jsonl: a "sent" line right after the send, a "mined"
 * line after the receipt), so a run that dies waiting for a receipt or a
 * read-back still leaves the hash on disk. The read-back is pinned to the
 * receipt's block and repeated for up to 30 s while the node that answers has
 * not seen that block yet (GIWA's public endpoint is load-balanced —
 * keeper/readback.mjs); only then is a disagreement reported (exit 1, the
 * logged lines stay).
 *
 * Before deploying, the artifact (keeper/artifacts/QuadrixIndexVault.json) is
 * compared with the code of the live qX20 tracking vault: equal except the
 * immutable `usd` and the trailing CBOR metadata — the same contract.
 *
 * A deployment that was sent but whose address never reached the registry
 * (the run died, or the read-back disagreed) blocks every later deployment of
 * that index until a person resolves it — by writing its address into the
 * registry or marking its transaction "abandoned" in the log. Re-running the
 * same command never deploys a second vault.
 *
 * A successful deployment writes the address into keeper/leverage-vaults.json
 * and leaves `gate` as it is. The registry on this branch already holds the
 * owner's gate ({"mode":"step"}, 2026-10-05), so the daily leg marks the vault
 * from the first line after the genesis (seq 1) once the address is written;
 * with `gate` null it would mark nothing. On a local fork (--rpc
 * 127.0.0.1/localhost) every output goes to keeper/dryrun/ instead, and the
 * fork's registry starts from the real one with every address emptied, so a
 * fork rehearsal still works after the real vaults exist (rehearsal C4).
 *
 * Usage:
 *   node keeper/deploy-mark-vault.mjs --index qbtc2x --manager 0x…                         # dry run
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qbtc2x --manager 0x… --live --confirm EXECUTE
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qbtc2x --action open-deposits --cap 1000000000000 --live --confirm EXECUTE
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qbtc2x --action pause --live --confirm EXECUTE
 *   node keeper/deploy-mark-vault.mjs --index qbtc2x --manager 0x<anvil> --live --confirm EXECUTE \
 *        --rpc http://127.0.0.1:8545 --from 0x<anvil>                                           # fork rehearsal
 *
 * Options:
 *   --index qbtc2x|qeth2x     required
 *   --action deploy|open-deposits|pause   default deploy
 *   --manager 0x…             deploy: the constructor's manager_ (becomes owner and keeper)
 *   --cap n                   open-deposits: the new cap, in 6-decimal mUSD units
 *   --live --confirm EXECUTE  send (otherwise dry run)
 *   --rpc URL --from 0x…      local fork rehearsal; --chain-id n (default 91342)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress, encodeDeployData, encodeFunctionData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { retryRead } from './readback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = JSON.parse(fs.readFileSync(path.join(HERE, 'artifacts', 'QuadrixIndexVault.json'), 'utf8'));
export const MOCK_USD = '0xf70B2b744eE604728D661b7D07460843DBD1be76';
/** The live qX20 tracking vault: the reference the artifact's code is compared with. */
export const REFERENCE_VAULT = '0x2A165501ddA6e430fF98E82682f53CA8465Bb21f';
const GIWA_RPC = 'https://sepolia-rpc.giwa.io';
const NAMES = { qbtc2x: ['Quadrix BTC 2x Vault', 'qBTC2X'], qeth2x: ['Quadrix ETH 2x Vault', 'qETH2X'] };
const DEPLOY_GAS = 3_000_000n;
const ADMIN_GAS = 120_000n;

class Refused extends Error {}
const isLocalRpc = (rpc) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(rpc));

/** Runtime code with the immutables zeroed and the CBOR metadata cut — what must equal between two builds of the same source. */
export function codeShape(hex) {
  const h = hex.replace(/^0x/, '').toLowerCase();
  const b = h.split('');
  for (const r of Object.values(ARTIFACT.immutableReferences).flat()) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = '0';
  return b.join('').slice(0, h.length - ARTIFACT.metadataBytes * 2);
}
/** The exact runtime code a deployment of the artifact must leave at its address. */
export function expectedRuntime(usd) {
  const b = ARTIFACT.deployedBytecode.replace(/^0x/, '').toLowerCase().split('');
  const word = getAddress(usd).slice(2).toLowerCase().padStart(64, '0');
  for (const r of Object.values(ARTIFACT.immutableReferences).flat()) for (let i = 0; i < 64; i++) b[r.start * 2 + i] = word[i];
  return `0x${b.join('')}`;
}

function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d = null) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const o = {
    index: opt('--index'),
    action: opt('--action', 'deploy'),
    manager: opt('--manager'),
    cap: opt('--cap'),
    live: flag('--live'),
    confirm: opt('--confirm'),
    rpc: opt('--rpc', GIWA_RPC),
    from: opt('--from'),
    chainId: Number(opt('--chain-id', '91342')),
  };
  if (!NAMES[o.index]) throw new Refused(`--index must be qbtc2x or qeth2x (got ${o.index})`);
  if (!['deploy', 'open-deposits', 'pause'].includes(o.action)) throw new Refused(`--action must be deploy, open-deposits or pause (got ${o.action})`);
  if (o.action === 'deploy' && !(o.manager && isAddress(o.manager))) throw new Refused('--manager <address> is required for a deployment (it becomes owner and keeper)');
  if (o.action === 'open-deposits' && !/^\d+$/.test(String(o.cap))) throw new Refused('--cap <integer, 6-decimal mUSD units> is required for open-deposits');
  if (o.live && o.confirm !== 'EXECUTE') throw new Refused('--live needs --confirm EXECUTE — refusing rather than sending by accident');
  if (o.from && !(isLocalRpc(o.rpc) && isAddress(o.from))) throw new Refused('--from is for an unlocked account on a local fork (--rpc http://127.0.0.1:… or localhost)');
  o.fork = isLocalRpc(o.rpc);
  if (o.fork && o.live && !o.from) throw new Refused('a live run on a local RPC needs --from (an unlocked anvil account); KEEPER_PK is never used against a local node');
  return o;
}

function outPaths(fork) {
  const dir = fork ? path.join(HERE, 'dryrun') : HERE;
  return { log: path.join(dir, 'mark-vaults.jsonl'), vaults: path.join(dir, 'leverage-vaults.json'), seed: path.join(HERE, 'leverage-vaults.json') };
}
const append = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
};
export function readVaults(p, seed, fork = false) {
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const v = JSON.parse(fs.readFileSync(seed, 'utf8'));
  // a fork starts from the real registry's shape and gates, never from its addresses (rehearsal C4)
  if (fork) for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object' && 'address' in v[k]) v[k] = { ...v[k], address: null, deployTx: null, block: null };
  return v;
}

export async function main(argv = process.argv.slice(2), env = process.env, log = (m) => console.log(`[mark-vault] ${m}`)) {
  const o = parseArgs(argv);
  const paths = outPaths(o.fork);
  const chain = defineChain({ id: o.chainId, name: o.chainId === 91342 ? 'GIWA Sepolia' : `chain ${o.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [o.rpc] } } });
  const pc = createPublicClient({ chain, transport: http(o.rpc), pollingInterval: o.fork ? 200 : 2000 });
  const onchain = await pc.getChainId();
  if (onchain !== o.chainId) throw new Refused(`RPC ${o.rpc} is chain ${onchain}, expected ${o.chainId}`);
  const client = await pc.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');

  // signer: only for a live run
  let wallet = null;
  let signer = null;
  if (o.live) {
    if (o.fork) {
      if (!/anvil|hardhat/i.test(String(client))) throw new Refused(`--from needs a local anvil/hardhat node; ${o.rpc} reports "${client}"`);
      signer = getAddress(o.from);
      wallet = createWalletClient({ account: signer, chain, transport: http(o.rpc) });
    } else {
      if (!env.KEEPER_PK) throw new Refused('--live needs KEEPER_PK in the environment');
      const acct = privateKeyToAccount(env.KEEPER_PK);
      signer = acct.address;
      wallet = createWalletClient({ account: acct, chain, transport: http(o.rpc) });
    }
  }
  const vaults = readVaults(paths.vaults, paths.seed, o.fork);
  const entry = vaults[o.index];
  if (!entry || entry.chainId !== o.chainId) throw new Refused(`${path.relative(HERE, paths.vaults)} has no ${o.index} entry for chain ${o.chainId}`);
  log(`${o.live ? `LIVE from ${signer}` : 'DRY RUN — nothing is sent, nothing is written'}; ${o.action} ${o.index}; rpc ${o.rpc} (${client})`);

  /** send → log "sent" → receipt → log "mined"; returns the receipt. */
  async function send(what, req) {
    const tx = await wallet.sendTransaction(req);
    append(paths.log, { at: new Date().toISOString(), index: o.index, action: o.action, what, chainId: o.chainId, status: 'sent', tx, from: signer, rpc: o.fork ? o.rpc : 'giwa-sepolia' });
    const rc = await pc.waitForTransactionReceipt({ hash: tx });
    append(paths.log, { at: new Date().toISOString(), index: o.index, action: o.action, what, chainId: o.chainId, status: rc.status === 'success' ? 'mined' : 'reverted', tx, block: rc.blockNumber, gasUsed: rc.gasUsed, contractAddress: rc.contractAddress ?? null });
    if (rc.status !== 'success') throw new Error(`${what} reverted (tx ${tx}, block ${rc.blockNumber})`);
    return rc;
  }

  if (o.action === 'deploy') {
    if (entry.address) throw new Refused(`${o.index} already names a vault (${entry.address}) — a replacement is its own decision; mark the old one superseded by hand first`);
    // A deployment that was sent but never reached the registry (the run died
    // waiting for the receipt, or the read-back disagreed) is still on chain.
    // Re-running must not deploy a second vault: a person resolves the first.
    const txLog = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
    const mine = (l) => l.index === o.index && l.chainId === o.chainId;
    const abandoned = new Set(txLog.filter((l) => mine(l) && l.status === 'abandoned').map((l) => l.tx));
    const unresolved = txLog.filter((l) => mine(l) && l.action === 'deploy' && l.status === 'sent' && !abandoned.has(l.tx));
    if (unresolved.length) {
      throw new Refused(`a deployment of ${o.index} on chain ${o.chainId} was already sent (tx ${unresolved.map((l) => l.tx).join(', ')}) and ${path.relative(path.join(HERE, '..'), paths.vaults)} names no vault — resolve it first, never by deploying again: if that transaction created the vault, write its address into the registry; if it failed or is to be dropped, append {"index":"${o.index}","chainId":${o.chainId},"tx":"<hash>","status":"abandoned","note":"…"} to ${path.relative(path.join(HERE, '..'), paths.log)}`);
    }
    const usdCode = await pc.getCode({ address: MOCK_USD });
    if (!usdCode || usdCode === '0x') throw new Refused(`MockUSD ${MOCK_USD} has no code on this chain`);
    const ref = await pc.getCode({ address: REFERENCE_VAULT });
    if (!ref || ref === '0x') throw new Refused(`the reference vault ${REFERENCE_VAULT} has no code on this chain — cannot check the artifact`);
    if (codeShape(ref) !== codeShape(ARTIFACT.deployedBytecode)) throw new Refused('keeper/artifacts/QuadrixIndexVault.json is not the contract of the qX20 tracking vault (runtime code differs beyond the immutables and the metadata)');
    const [name, symbol] = NAMES[o.index];
    const manager = getAddress(o.manager);
    const args = [MOCK_USD, name, symbol, 0n, manager];
    const data = encodeDeployData({ abi: ARTIFACT.abi, bytecode: ARTIFACT.bytecode, args });
    const want = expectedRuntime(MOCK_USD);
    const sim = await pc.call({ account: signer ?? manager, data, gas: DEPLOY_GAS });
    if (sim.data?.toLowerCase() !== want) throw new Refused('the simulated deployment returns runtime code that is not the artifact with usd = MockUSD');
    log(`artifact = the qX20 tracking vault's code (immutables and metadata aside); simulated deployment returns the expected runtime (${(want.length - 2) / 2} bytes, keccak ${keccak256(want).slice(0, 18)}…)`);
    log(`constructor: usd ${MOCK_USD}, name "${name}", symbol ${symbol}, depositCap 0 (closed), manager ${manager} (owner and keeper)`);
    if (!o.live) {
      log('dry run: would deploy — nothing sent');
      return 0;
    }
    const rc = await send('deploy', { data, gas: DEPLOY_GAS });
    const address = getAddress(rc.contractAddress);
    const VIEW = ARTIFACT.abi;
    const rb = await retryRead(
      async () => {
        const at = { blockNumber: rc.blockNumber };
        const code = await pc.getCode({ address, ...at });
        if (!code || code === '0x') throw new Error('no code at the address yet');
        const r = (functionName) => pc.readContract({ address, abi: VIEW, functionName, ...at });
        const got = {
          code: code.toLowerCase() === want, owner: getAddress(await r('owner')), keeper: getAddress(await r('keeper')), navPerShare: await r('navPerShare'), depositCap: await r('depositCap'),
          depositsPaused: await r('depositsPaused'), usd: getAddress(await r('usd')), name: await r('name'), symbol: await r('symbol'), decimals: await r('decimals'),
        };
        const bad = [];
        if (!got.code) bad.push('runtime code differs from the artifact');
        if (got.owner !== manager) bad.push(`owner ${got.owner}`);
        if (got.keeper !== manager) bad.push(`keeper ${got.keeper}`);
        if (got.navPerShare !== 1_000_000n) bad.push(`navPerShare ${got.navPerShare}`);
        if (got.depositCap !== 0n) bad.push(`depositCap ${got.depositCap}`);
        if (got.depositsPaused !== false) bad.push('depositsPaused true');
        if (got.usd !== getAddress(MOCK_USD)) bad.push(`usd ${got.usd}`);
        if (got.name !== name || got.symbol !== symbol || Number(got.decimals) !== 6) bad.push(`name/symbol/decimals ${got.name}/${got.symbol}/${got.decimals}`);
        if (bad.length) throw Object.assign(new Error(bad.join('; ')), { differs: true });
        return got;
      },
      { what: `read-back of ${address} at block ${rc.blockNumber}` }
    ).catch((e) => {
      throw new Error(`deployed at ${address} (tx ${rc.transactionHash}, logged) but the read-back disagrees: ${e.message}`);
    });
    const fresh = readVaults(paths.vaults, paths.seed, o.fork);
    fresh[o.index] = { ...fresh[o.index], address, deployTx: rc.transactionHash, block: Number(rc.blockNumber) };
    fs.mkdirSync(path.dirname(paths.vaults), { recursive: true });
    fs.writeFileSync(paths.vaults, JSON.stringify(fresh, null, 2) + '\n');
    log(`deployed ${symbol} at ${address} tx=${rc.transactionHash} block ${rc.blockNumber} gas ${rc.gasUsed}; read back ok${rb.reads > 1 ? ` (at read ${rb.reads})` : ''}: owner = keeper = ${manager}, navPerShare 1000000, depositCap 0, not paused; ${path.relative(path.join(HERE, '..'), paths.vaults)} written (gate unchanged: ${JSON.stringify(fresh[o.index].gate)})`);
    return 0;
  }

  // owner actions on the deployed vault
  if (!entry.address) throw new Refused(`${o.index} has no vault address in ${path.relative(HERE, paths.vaults)}`);
  const vault = getAddress(entry.address);
  const owner = getAddress(await pc.readContract({ address: vault, abi: ARTIFACT.abi, functionName: 'owner' }));
  const [fn, args, check] =
    o.action === 'open-deposits'
      ? ['setDepositCap', [BigInt(o.cap)], async (blockNumber) => (await pc.readContract({ address: vault, abi: ARTIFACT.abi, functionName: 'depositCap', blockNumber })) === BigInt(o.cap)]
      : ['setDepositsPaused', [true], async (blockNumber) => (await pc.readContract({ address: vault, abi: ARTIFACT.abi, functionName: 'depositsPaused', blockNumber })) === true];
  const data = encodeFunctionData({ abi: ARTIFACT.abi, functionName: fn, args });
  await pc.call({ account: signer ?? owner, to: vault, data });
  log(`${fn}(${args.join(', ')}) on ${vault} (owner ${owner}) — simulated ok`);
  if (!o.live) {
    log('dry run: nothing sent');
    return 0;
  }
  if (getAddress(signer) !== owner) throw new Refused(`the signer ${signer} is not the vault owner ${owner}`);
  const rc = await send(fn, { to: vault, data, gas: ADMIN_GAS });
  await retryRead(
    async () => {
      if (!(await check(rc.blockNumber))) throw new Error('not yet');
      return true;
    },
    { what: `${fn} read-back at block ${rc.blockNumber}` }
  );
  log(`${fn} sent tx=${rc.transactionHash} block ${rc.blockNumber}; read back ok`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      if (e instanceof Refused) { console.error(`REFUSED: ${e.message}`); process.exitCode = 2; return; }
      console.error(e?.shortMessage ?? e?.message ?? e);
      process.exitCode = 1;
    }
  );
}
