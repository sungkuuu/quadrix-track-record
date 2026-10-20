/**
 * The testnet mark vault of a leverage series (qBTC2X, qETH2X, qETH1.5X):
 * deploys a QuadrixIndexVault — the contract of the redeployed vaults, with a
 * guardian — with a deposit cap of 0, so nobody can deposit from deployment
 * until the owner opens it, then appoints its guardian; and the owner actions
 * after it (open deposits, pause, set the guardian).
 *
 * DRY RUN IS THE DEFAULT: the deployment is simulated (eth_call of the
 * creation code) and the runtime code it returns is compared with the
 * artifact; nothing is sent and nothing is written. A transaction is sent only
 * with --live AND --confirm EXECUTE, signed here with KEEPER_PK (the public
 * endpoint holds no key) or, on a local anvil fork only, from an unlocked
 * --from account.
 *
 * Every transaction is signed here first and written to the log BEFORE it is
 * broadcast (keeper/mark-vaults.jsonl: a "signed" line with its hash and
 * nonce, then a "sent" line once the node has taken it, a "mined" line after
 * the receipt), so a run that dies anywhere after signing — even with the
 * node's answer to the broadcast lost — still leaves the hash on disk (on a
 * local fork, an impersonated account the node cannot sign for is sent with
 * eth_sendTransaction and logged "sent" with its hash). The
 * read-back is pinned to the
 * receipt's block and repeated for up to 30 s while the node that answers has
 * not seen that block yet (GIWA's public endpoint is load-balanced —
 * keeper/readback.mjs); only then is a disagreement reported (exit 1, the
 * logged lines stay).
 *
 * Before deploying, the artifact (keeper/artifacts/QuadrixIndexVault.json) is
 * compared with the code of the reference vault: the qBTC2X mark vault named
 * in keeper/leverage-vaults.json as committed (on a local fork too, where the
 * fork's own registry starts with every address emptied). Equal except the
 * immutable `usd` and the trailing CBOR metadata — the same contract. The
 * reference must also answer symbol() "qBTC2X" and a guardian() other than 0,
 * so a registry line pointing elsewhere (an old vault, another series) is
 * refused rather than taken as the standard.
 *
 * The guardian (--guardian, required for a deployment) is checked as the
 * redeployment checks it: not 0, not the keeper, not the owner, and — with
 * --timelock — no proposer, canceller or admin role on that timelock. Checked
 * before anything is sent (the manager becomes owner and keeper) and again on
 * the chain after setGuardian. The deployment and setGuardian are two
 * transactions; the registry is written only after both are read back. A run
 * that stops between them leaves the deployment "sent but not in the registry"
 * (below): a person writes the address in, then runs --action set-guardian.
 *
 * Before anything else, every transaction of the index that the log shows
 * signed but with no outcome (no receipt line, not abandoned) is looked up on
 * the chain by its hash. Found: its receipt is recorded and the run goes on —
 * a deployment found mined goes on to its read-back, setGuardian and the
 * registry, without deploying again. Not found: the run is refused and
 * nothing is sent until a person has looked at that hash and nonce.
 *
 * A deployment that was sent but whose address never reached the registry
 * (the read-back disagreed, or setGuardian did not complete) blocks every
 * later deployment of that index until a person resolves it — by writing its
 * address into the registry or marking its transaction "abandoned" in the log.
 * Re-running the same command never deploys a second vault.
 *
 * The registry line is checked before every owner action (set-guardian,
 * open-deposits, pause): the address must run the artifact's code, answer
 * symbol() = this index's ticker, and — on a live run — have the signer as
 * its keeper. A line naming another vault sends nothing.
 *
 * A successful deployment writes the address into keeper/leverage-vaults.json
 * and leaves `gate` as it is: with a gate ({"mode":"step"}: qBTC2X, owner
 * 2026-10-05) the daily leg marks the vault from the next line once the
 * address is written; with `gate` null it marks nothing. On a local fork (--rpc
 * 127.0.0.1/localhost) every output goes to keeper/dryrun/ instead, and the
 * fork's registry starts from the real one with every address emptied, so a
 * fork rehearsal still works after the real vaults exist (rehearsal C4).
 *
 * Usage:
 *   node keeper/deploy-mark-vault.mjs --index qeth15 --manager 0x… --guardian 0x…          # dry run
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qeth15 --manager 0x… --guardian 0x… --live --confirm EXECUTE
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qeth15 --action set-guardian --guardian 0x… --live --confirm EXECUTE
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qeth15 --action open-deposits --cap 1000000000000 --live --confirm EXECUTE
 *   KEEPER_PK=0x… node keeper/deploy-mark-vault.mjs --index qeth15 --action pause --live --confirm EXECUTE
 *   node keeper/deploy-mark-vault.mjs --index qeth15 --manager 0x<anvil> --guardian 0x<anvil> --live --confirm EXECUTE \
 *        --rpc http://127.0.0.1:8545 --from 0x<anvil>                                           # fork rehearsal
 *
 * Options:
 *   --index qbtc2x|qeth2x|qeth15   required
 *   --action deploy|set-guardian|open-deposits|pause   default deploy
 *   --manager 0x…             deploy: the constructor's manager_ (becomes owner and keeper; a live
 *                             deployment is signed by it, since it also sends setGuardian)
 *   --guardian 0x…            deploy, set-guardian: the guardian (its one power: disableKeeper)
 *   --timelock 0x…            optional: the guardian must hold no role on this timelock
 *   --cap n                   open-deposits: the new cap, in 6-decimal mUSD units
 *   --live --confirm EXECUTE  send (otherwise dry run)
 *   --rpc URL --from 0x…      local fork rehearsal; --chain-id n (default 91342)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress, encodeDeployData, encodeFunctionData, keccak256, parseAbi, parseTransaction, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { retryRead } from './readback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = JSON.parse(fs.readFileSync(path.join(HERE, 'artifacts', 'QuadrixIndexVault.json'), 'utf8'));
export const MOCK_USD = '0xf70B2b744eE604728D661b7D07460843DBD1be76';
/** The reference the artifact's code is compared with: this index's vault in the registry as committed. */
export const REFERENCE_INDEX = 'qbtc2x';
export const REFERENCE_SYMBOL = 'qBTC2X';
const GIWA_RPC = 'https://sepolia-rpc.giwa.io';
/** name, symbol — the symbol is the rulebook's ticker (keeper/rulebooks/<index>.json): the leg marks only a vault whose symbol() is it. */
export const NAMES = { qbtc2x: ['Quadrix BTC 2x Vault', 'qBTC2X'], qeth2x: ['Quadrix ETH 2x Vault', 'qETH2X'], qeth15: ['Quadrix ETH 1.5x Vault', 'qETH1.5X'] };
const ACTIONS = ['deploy', 'set-guardian', 'open-deposits', 'pause'];
/** The artifact's contract has a guardian (the redeployed code): a deployment must appoint one. */
export const HAS_GUARDIAN = ARTIFACT.abi.some((f) => f.type === 'function' && f.name === 'setGuardian');
const TIMELOCK_ABI = parseAbi([
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function PROPOSER_ROLE() view returns (bytes32)',
  'function CANCELLER_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
]);
const DEPLOY_GAS = 3_000_000n;
const ADMIN_GAS = 120_000n;

export class Refused extends Error {}
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
    guardian: opt('--guardian'),
    timelock: opt('--timelock'),
    cap: opt('--cap'),
    live: flag('--live'),
    confirm: opt('--confirm'),
    rpc: opt('--rpc', GIWA_RPC),
    from: opt('--from'),
    chainId: Number(opt('--chain-id', '91342')),
  };
  if (!Object.hasOwn(NAMES, o.index)) throw new Refused(`--index must be one of ${Object.keys(NAMES).join(', ')} (got ${o.index})`);
  if (!ACTIONS.includes(o.action)) throw new Refused(`--action must be one of ${ACTIONS.join(', ')} (got ${o.action})`);
  if (o.action === 'deploy' && !(o.manager && isAddress(o.manager))) throw new Refused('--manager <address> is required for a deployment (it becomes owner and keeper)');
  const needGuardian = o.action === 'set-guardian' || (o.action === 'deploy' && HAS_GUARDIAN);
  if (needGuardian && !(o.guardian && isAddress(o.guardian))) throw new Refused(`--guardian <address> is required for ${o.action === 'deploy' ? 'a deployment of this contract (it has a guardian; a vault is never left with guardian 0)' : 'set-guardian'}`);
  if (o.guardian != null && !needGuardian) throw new Refused(`--guardian is for deploy and set-guardian, not ${o.action}`);
  if (o.timelock != null && !(isAddress(o.timelock) && o.guardian)) throw new Refused('--timelock <address> goes with --guardian (the guardian must hold no role on it)');
  if (o.action === 'deploy' && o.guardian) staticGuardianCheck({ guardian: o.guardian, keeper: o.manager, owner: o.manager });
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
export function readTxLog(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
}
/** The transactions of `index` on `chainId` that the log shows signed or sent with no outcome: no "mined" or "reverted" line, not "abandoned". */
export function openTxs(txLog, index, chainId) {
  const mine = (l) => l.index === index && l.chainId === chainId;
  const closed = new Set(txLog.filter((l) => mine(l) && ['mined', 'reverted', 'abandoned'].includes(l.status)).map((l) => l.tx));
  const open = new Map();
  for (const l of txLog) if (mine(l) && (l.status === 'signed' || l.status === 'sent') && !closed.has(l.tx) && !open.has(l.tx)) open.set(l.tx, l);
  return [...open.values()];
}

/** The guardian rule of the vault redeployment, without the timelock part: the problems, empty if none. */
export function guardianProblems({ guardian, keeper, owner }) {
  const g = getAddress(guardian);
  const bad = [];
  if (getAddress(keeper) === zeroAddress) bad.push('keeper is 0');
  if (g === zeroAddress) bad.push('guardian unset (0)');
  if (g === getAddress(keeper)) bad.push(`guardian == keeper (${g})`);
  if (g === getAddress(owner)) bad.push(`guardian == owner (${g})`);
  return bad;
}
function staticGuardianCheck(roles) {
  const bad = guardianProblems(roles);
  if (bad.length) throw new Refused(`guardian check: ${bad.join('; ')} — the guardian must be a key of its own: not 0, not the keeper, not the owner`);
}
/** With a timelock: the guardian holds no proposer, canceller or admin role on it (as in the owner handover to the timelock). */
export async function timelockProblems(pc, timelock, guardian, at = {}) {
  if (!timelock) return [];
  const tl = getAddress(timelock);
  const code = await pc.getCode({ address: tl, ...at });
  if (!code || code === '0x') return [`timelock ${tl} has no code`];
  const bad = [];
  for (const [role, what] of [['PROPOSER_ROLE', 'proposer'], ['CANCELLER_ROLE', 'canceller'], ['DEFAULT_ADMIN_ROLE', 'admin']]) {
    const id = await pc.readContract({ address: tl, abi: TIMELOCK_ABI, functionName: role, ...at });
    if (await pc.readContract({ address: tl, abi: TIMELOCK_ABI, functionName: 'hasRole', args: [id, getAddress(guardian)], ...at })) bad.push(`guardian is a timelock ${what}`);
  }
  return bad;
}

/**
 * The vault the artifact is compared with: REFERENCE_INDEX's address in the registry as committed
 * (paths.seed — on a fork too, whose own registry empties every address). Besides the code, it must
 * answer symbol() REFERENCE_SYMBOL and a guardian() other than 0: a registry line naming another
 * vault is refused, not taken as the standard.
 */
export async function referenceVault(pc, seed, chainId) {
  const reg = JSON.parse(fs.readFileSync(seed, 'utf8'));
  const e = reg[REFERENCE_INDEX];
  if (!e || e.chainId !== chainId || !e.address || !isAddress(e.address)) throw new Refused(`the reference vault: keeper/leverage-vaults.json (as committed) names no ${REFERENCE_INDEX} vault on chain ${chainId} — cannot check the artifact`);
  const address = getAddress(e.address);
  const code = await pc.getCode({ address });
  if (!code || code === '0x') throw new Refused(`the reference vault ${address} (${REFERENCE_INDEX} in the registry) has no code on this chain — cannot check the artifact`);
  if (codeShape(code) !== codeShape(ARTIFACT.deployedBytecode)) throw new Refused(`keeper/artifacts/QuadrixIndexVault.json is not the contract of the reference vault ${address} (${REFERENCE_INDEX} in the registry): runtime code differs beyond the immutables and the metadata`);
  const symbol = await pc.readContract({ address, abi: ARTIFACT.abi, functionName: 'symbol' });
  if (symbol !== REFERENCE_SYMBOL) throw new Refused(`the reference vault ${address} is ${JSON.stringify(symbol)}, not ${REFERENCE_SYMBOL} — the registry's ${REFERENCE_INDEX} line names another vault`);
  const guardian = getAddress(await pc.readContract({ address, abi: ARTIFACT.abi, functionName: 'guardian' }));
  if (guardian === zeroAddress) throw new Refused(`the reference vault ${address} has guardian 0 — not a vault set up by the redeployment; refusing to take it as the standard`);
  return address;
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

  const rpcName = o.fork ? o.rpc : 'giwa-sepolia';
  const rel = (p) => path.relative(path.join(HERE, '..'), p);
  /**
   * sign → log "signed" (hash, nonce) → broadcast → log "sent" → receipt → log "mined"; returns the receipt.
   * The hash is on disk before the node sees the transaction, so a lost answer to the broadcast still
   * leaves it for the next run to look up (settleOpen). With KEEPER_PK the key signs here; on a fork an
   * unlocked account with a key is signed by the node (eth_signTransaction), in the same order. An
   * account impersonated on a local fork has no key the node can sign with (anvil answers "No Signer
   * available"): on a local RPC only, it is sent with eth_sendTransaction and logged "sent" with its hash.
   */
  async function send(what, req) {
    const prepared = await wallet.prepareTransactionRequest({ ...req, account: wallet.account, chain });
    let raw = null;
    try {
      raw = await wallet.signTransaction(prepared);
    } catch (e) {
      const noSigner = /no signer available/i.test(`${e?.details ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`);
      if (!noSigner) throw e;
      if (!isLocalRpc(o.rpc)) throw new Refused(`${what}: the node has no signer for ${signer} — a live transaction is signed here with KEEPER_PK; nothing sent`);
    }
    let tx;
    if (raw) {
      tx = keccak256(raw);
      const p = parseTransaction(raw);
      const same = (a, b) => (a ? getAddress(a) : null) === (b ? getAddress(b) : null);
      if (p.chainId !== o.chainId || p.nonce !== prepared.nonce || !same(p.to, req.to) || String(p.data ?? '0x').toLowerCase() !== String(req.data).toLowerCase()) {
        throw new Error(`${what}: the signed transaction is not the one prepared (chain ${p.chainId}, nonce ${p.nonce}, to ${p.to ?? 'none'}) — nothing broadcast`);
      }
      append(paths.log, { at: new Date().toISOString(), index: o.index, action: o.action, what, chainId: o.chainId, status: 'signed', tx, nonce: prepared.nonce, from: signer, rpc: rpcName });
      const echoed = await wallet.sendRawTransaction({ serializedTransaction: raw });
      if (echoed.toLowerCase() !== tx) throw new Error(`${what}: the node answered hash ${echoed} for the transaction signed as ${tx} (logged)`);
      append(paths.log, { at: new Date().toISOString(), index: o.index, action: o.action, what, chainId: o.chainId, status: 'sent', tx, nonce: prepared.nonce, from: signer, rpc: rpcName });
    } else {
      // local fork, impersonated account: the node signs nothing; the hash comes back with the send
      tx = await wallet.sendTransaction(req);
      append(paths.log, { at: new Date().toISOString(), index: o.index, action: o.action, what, chainId: o.chainId, status: 'sent', tx, nonce: null, from: signer, rpc: rpcName, impersonated: true });
    }
    const rc = await pc.waitForTransactionReceipt({ hash: tx });
    append(paths.log, { at: new Date().toISOString(), index: o.index, action: o.action, what, chainId: o.chainId, status: rc.status === 'success' ? 'mined' : 'reverted', tx, block: rc.blockNumber, gasUsed: rc.gasUsed, contractAddress: rc.contractAddress ?? null });
    if (rc.status !== 'success') throw new Error(`${what} reverted (tx ${tx}, block ${rc.blockNumber})`);
    return rc;
  }

  /** setGuardian(guardian) on `vault` (the signer is its owner), then the guardian rule on the chain's own values at the receipt's block. */
  async function setGuardianAndCheck(vault, guardian, owner) {
    const data = encodeFunctionData({ abi: ARTIFACT.abi, functionName: 'setGuardian', args: [guardian] });
    await pc.call({ account: signer ?? owner, to: vault, data });
    const rc = await send('setGuardian', { to: vault, data, gas: ADMIN_GAS });
    await retryRead(
      async () => {
        const at = { blockNumber: rc.blockNumber };
        const r = (functionName) => pc.readContract({ address: vault, abi: ARTIFACT.abi, functionName, ...at });
        const got = { guardian: getAddress(await r('guardian')), keeper: getAddress(await r('keeper')), owner: getAddress(await r('owner')) };
        const bad = got.guardian === guardian ? [] : [`guardian ${got.guardian}, not ${guardian}`];
        bad.push(...guardianProblems(got), ...(await timelockProblems(pc, o.timelock, got.guardian, at)));
        if (bad.length) throw Object.assign(new Error(bad.join('; ')), { differs: true });
        return got;
      },
      { what: `setGuardian read-back of ${vault} at block ${rc.blockNumber}` }
    );
    return { tx: rc.transactionHash, block: rc.blockNumber };
  }

  /**
   * The re-run gate. Every transaction of this index that the log shows signed (or sent) with no outcome
   * is looked up on the chain by its hash before anything new is sent. With a receipt: the outcome is
   * recorded (a live run appends the lines; a dry run only says so) and returned, and the run goes on.
   * Without one: refused — nothing is sent until a person has looked at that hash and nonce.
   */
  async function settleOpen(txLog) {
    const found = [];
    for (const l of openTxs(txLog, o.index, o.chainId)) {
      const rc = await pc.getTransactionReceipt({ hash: l.tx }).catch((e) => {
        if (e?.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      });
      if (!rc) {
        const count = l.from && isAddress(l.from) && l.nonce != null ? await pc.getTransactionCount({ address: getAddress(l.from), blockTag: 'latest' }) : null;
        const nonceText =
          count == null ? ''
          : count > l.nonce ? `; nonce ${l.nonce} of ${l.from} is used (its count is ${count}) — by another transaction, or by this one on a node that does not show the receipt yet`
          : `; nonce ${l.nonce} of ${l.from} is not used yet (its count is ${count}) — the transaction may still be pending, or never reached the chain`;
        throw new Refused(`${l.what ?? 'a transaction'} of ${o.index} on chain ${o.chainId} was signed (tx ${l.tx}), the log has no outcome for it, and the chain has no receipt for it${nonceText}. Nothing is sent until a person resolves it, never by sending again: look the hash and the nonce up on the explorer; once it is mined, re-run (its receipt is recorded and the run goes on); if it can never be mined (its nonce is taken by another transaction), append {"index":"${o.index}","chainId":${o.chainId},"tx":"${l.tx}","status":"abandoned","note":"…"} to ${rel(paths.log)}`);
      }
      const base = { at: new Date().toISOString(), index: o.index, action: l.action, what: l.what, chainId: o.chainId, tx: l.tx, recovered: true };
      const lines = [];
      if (!txLog.some((x) => x.tx === l.tx && x.status === 'sent')) lines.push({ ...base, status: 'sent', nonce: l.nonce ?? null, from: l.from ?? null, rpc: rpcName });
      lines.push({ ...base, status: rc.status === 'success' ? 'mined' : 'reverted', block: rc.blockNumber, gasUsed: rc.gasUsed, contractAddress: rc.contractAddress ?? null });
      for (const x of lines) {
        txLog.push(x);
        if (o.live) append(paths.log, x);
      }
      log(`${l.what} tx ${l.tx} (signed, no outcome in the log) is ${rc.status === 'success' ? 'mined' : 'reverted'} at block ${rc.blockNumber}${o.live ? ' — recorded in the log' : ' — a live run records it'}`);
      found.push({ line: l, rc });
    }
    return found;
  }

  /**
   * The registry line is checked before every owner action: the address runs the artifact's code
   * (immutables and metadata aside), answers symbol() = this index's ticker, and — on a live run — has
   * the signer as its keeper. A line naming another vault is refused before anything is sent.
   */
  async function registryVault() {
    const vault = getAddress(entry.address);
    const code = await pc.getCode({ address: vault });
    if (!code || code === '0x' || codeShape(code) !== codeShape(ARTIFACT.deployedBytecode)) throw new Refused(`${vault} (${o.index} in the registry) does not run the artifact's code — check the address`);
    const read = (functionName) => pc.readContract({ address: vault, abi: ARTIFACT.abi, functionName });
    const vsym = await read('symbol');
    if (vsym !== NAMES[o.index][1]) throw new Refused(`${vault} is ${JSON.stringify(vsym)}, not ${NAMES[o.index][1]} — the registry's ${o.index} line names another vault`);
    const keeper = getAddress(await read('keeper'));
    const owner = getAddress(await read('owner'));
    if (o.live && getAddress(signer) !== keeper) throw new Refused(`the signer ${signer} is not the keeper ${keeper} of ${vault} (${o.index} in the registry) — check the address and the key`);
    return { vault, owner, keeper };
  }

  const txLog = readTxLog(paths.log);
  const settled = await settleOpen(txLog);

  if (o.action === 'deploy') {
    if (entry.address) throw new Refused(`${o.index} already names a vault (${entry.address}) — a replacement is its own decision; mark the old one superseded by hand first`);
    // A deployment the log shows signed with no outcome, found mined above: the run goes on from its
    // receipt (read-back, setGuardian, registry) and deploys nothing again.
    const resumable = settled.filter((x) => (x.line.what ?? 'deploy') === 'deploy' && x.line.action === 'deploy' && x.rc.status === 'success');
    if (resumable.length > 1) throw new Refused(`${resumable.length} deployments of ${o.index} were signed with no outcome in the log and are all mined (tx ${resumable.map((x) => x.line.tx).join(', ')}) — a person decides which one is the vault`);
    const resume = resumable[0] ?? null;
    // A deployment that was sent but never reached the registry (the read-back
    // disagreed, or setGuardian did not complete) is still on chain.
    // Re-running must not deploy a second vault: a person resolves the first.
    const mine = (l) => l.index === o.index && l.chainId === o.chainId;
    const abandoned = new Set(txLog.filter((l) => mine(l) && l.status === 'abandoned').map((l) => l.tx));
    const unresolved = txLog.filter((l) => mine(l) && l.action === 'deploy' && (l.what ?? 'deploy') === 'deploy' && l.status === 'sent' && !abandoned.has(l.tx) && l.tx !== resume?.line.tx);
    if (unresolved.length) {
      throw new Refused(`a deployment of ${o.index} on chain ${o.chainId} was already sent (tx ${unresolved.map((l) => l.tx).join(', ')}) and ${path.relative(path.join(HERE, '..'), paths.vaults)} names no vault — resolve it first, never by deploying again: if that transaction created the vault, write its address into the registry; if it failed or is to be dropped, append {"index":"${o.index}","chainId":${o.chainId},"tx":"<hash>","status":"abandoned","note":"…"} to ${path.relative(path.join(HERE, '..'), paths.log)}`);
    }
    const usdCode = await pc.getCode({ address: MOCK_USD });
    if (!usdCode || usdCode === '0x') throw new Refused(`MockUSD ${MOCK_USD} has no code on this chain`);
    const reference = await referenceVault(pc, paths.seed, o.chainId);
    const [name, symbol] = NAMES[o.index];
    const manager = getAddress(o.manager);
    const guardian = o.guardian ? getAddress(o.guardian) : null;
    if (guardian) {
      const tbad = await timelockProblems(pc, o.timelock, guardian);
      if (tbad.length) throw new Refused(`guardian check: ${tbad.join('; ')}`);
    }
    // setGuardian is onlyOwner and the manager becomes the owner: the signer must be the manager
    if (guardian && o.live && getAddress(signer) !== manager) throw new Refused(`the signer ${signer} is not the manager ${manager}: setGuardian, sent right after the deployment, is the owner's — deploy from the manager`);
    const args = [MOCK_USD, name, symbol, 0n, manager];
    const data = encodeDeployData({ abi: ARTIFACT.abi, bytecode: ARTIFACT.bytecode, args });
    const want = expectedRuntime(MOCK_USD);
    const sim = await pc.call({ account: signer ?? manager, data, gas: DEPLOY_GAS });
    if (sim.data?.toLowerCase() !== want) throw new Refused('the simulated deployment returns runtime code that is not the artifact with usd = MockUSD');
    log(`artifact = the code of the reference vault ${reference} (${REFERENCE_SYMBOL}, guardian set; immutables and metadata aside); simulated deployment returns the expected runtime (${(want.length - 2) / 2} bytes, keccak ${keccak256(want).slice(0, 18)}…)`);
    log(`constructor: usd ${MOCK_USD}, name "${name}", symbol ${symbol}, depositCap 0 (closed), manager ${manager} (owner and keeper)`);
    if (guardian) log(`then setGuardian(${guardian}) — guardian check passed: not 0, not the keeper, not the owner${o.timelock ? `, no role on the timelock ${getAddress(o.timelock)}` : ' (no --timelock given: the timelock part is not checked)'}`);
    if (resume) log(`the deployment tx ${resume.line.tx} is mined at block ${resume.rc.blockNumber} (contract ${resume.rc.contractAddress}): the run goes on from its receipt — read-back, setGuardian, registry; nothing is deployed again`);
    if (!o.live) {
      log(resume ? 'dry run: would go on from the mined deployment — nothing sent' : 'dry run: would deploy — nothing sent');
      return 0;
    }
    const rc = resume ? resume.rc : await send('deploy', { data, gas: DEPLOY_GAS });
    if (!rc.contractAddress) throw new Error(`the deployment tx ${rc.transactionHash} has no contract address in its receipt`);
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
          ...(HAS_GUARDIAN ? { guardian: getAddress(await r('guardian')), pendingOwner: getAddress(await r('pendingOwner')) } : {}),
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
        if (HAS_GUARDIAN && got.guardian !== zeroAddress) bad.push(`guardian ${got.guardian} before setGuardian`);
        if (HAS_GUARDIAN && got.pendingOwner !== zeroAddress) bad.push(`pendingOwner ${got.pendingOwner}`);
        if (bad.length) throw Object.assign(new Error(bad.join('; ')), { differs: true });
        return got;
      },
      { what: `read-back of ${address} at block ${rc.blockNumber}` }
    ).catch((e) => {
      throw new Error(`deployed at ${address} (tx ${rc.transactionHash}, logged) but the read-back disagrees: ${e.message}`);
    });
    let gtx = null;
    if (guardian) {
      const resolve = `the registry is not written: check the vault by hand, write its address (and deployTx ${rc.transactionHash}, block ${rc.blockNumber}) into ${path.relative(path.join(HERE, '..'), paths.vaults)}, then run --action set-guardian --guardian ${guardian}`;
      try {
        const g = await setGuardianAndCheck(address, guardian, manager);
        gtx = g.tx;
      } catch (e) {
        throw new Error(`deployed at ${address} (tx ${rc.transactionHash}, logged) but setGuardian did not complete: ${e.message} — ${resolve}`);
      }
    }
    const fresh = readVaults(paths.vaults, paths.seed, o.fork);
    fresh[o.index] = { ...fresh[o.index], address, deployTx: rc.transactionHash, block: Number(rc.blockNumber) };
    fs.mkdirSync(path.dirname(paths.vaults), { recursive: true });
    fs.writeFileSync(paths.vaults, JSON.stringify(fresh, null, 2) + '\n');
    log(`deployed ${symbol} at ${address} tx=${rc.transactionHash} block ${rc.blockNumber} gas ${rc.gasUsed}; read back ok${rb.reads > 1 ? ` (at read ${rb.reads})` : ''}: owner = keeper = ${manager}, navPerShare 1000000, depositCap 0, not paused${guardian ? `; guardian ${guardian} set (tx ${gtx}) and read back` : ''}; ${path.relative(path.join(HERE, '..'), paths.vaults)} written (gate unchanged: ${JSON.stringify(fresh[o.index].gate)})`);
    return 0;
  }

  // owner actions on the deployed vault: the registry line (often written by hand) is checked first
  if (!entry.address) throw new Refused(`${o.index} has no vault address in ${path.relative(HERE, paths.vaults)}`);
  const { vault, owner, keeper } = await registryVault();
  if (o.action === 'set-guardian') {
    const guardian = getAddress(o.guardian);
    const current = getAddress(await pc.readContract({ address: vault, abi: ARTIFACT.abi, functionName: 'guardian' }));
    const bad = [...guardianProblems({ guardian, keeper, owner }), ...(await timelockProblems(pc, o.timelock, guardian))];
    if (bad.length) throw new Refused(`guardian check: ${bad.join('; ')} — the guardian must be a key of its own: not 0, not the keeper, not the owner`);
    if (current === guardian) {
      log(`${vault} already has guardian ${guardian}; guardian check passed (keeper ${keeper}, owner ${owner}) — nothing to send`);
      return 0;
    }
    if (current !== zeroAddress) throw new Refused(`${vault} already has guardian ${current} — replacing a guardian is its own decision, not this tool's`);
    await pc.call({ account: signer ?? owner, to: vault, data: encodeFunctionData({ abi: ARTIFACT.abi, functionName: 'setGuardian', args: [guardian] }) });
    log(`setGuardian(${guardian}) on ${vault} (owner ${owner}, keeper ${keeper}) — simulated ok; guardian check passed${o.timelock ? `, no role on the timelock ${getAddress(o.timelock)}` : ''}`);
    if (!o.live) {
      log('dry run: nothing sent');
      return 0;
    }
    if (getAddress(signer) !== owner) throw new Refused(`the signer ${signer} is not the vault owner ${owner}`);
    const g = await setGuardianAndCheck(vault, guardian, owner);
    log(`setGuardian sent tx=${g.tx} block ${g.block}; read back ok: guardian ${guardian}`);
    return 0;
  }
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
