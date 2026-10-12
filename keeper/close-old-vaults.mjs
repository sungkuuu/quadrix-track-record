/**
 * Closes deposits on two retired GIWA Sepolia testnet vaults that the
 * redeployment leaves out. Redemptions stay open on both: neither call
 * touches an exit path.
 *
 *   qDV, QuadrixVault (ERC-4626)       0xdf54c6b518335825947d90a941c706e26531a502
 *     setDepositsPaused(true). deposit() and mint() check maxDeposit /
 *     maxMint, which are 0 while paused; withdraw() and redeem() are never
 *     gated (the verified source's own comment on maxDeposit).
 *   QBV v3, QuadrixBasketVault (v3)    0xa908c180be8d58f223a220da98dd71db0f0be45d
 *     setPerTxCreateCap(0). This deployment predates openCreation(); its
 *     create() reverts CapExceeded for any gross > perTxCreateCap, and gross
 *     is never 0 (ZeroShares), so a cap of 0 refuses every creation;
 *     redeem() never reads the cap. The setter emits no event — the tx hash
 *     and the read-back in the log below are the record.
 *
 * Both setters are onlyOwner; the owner of both is the keeper key.
 *
 * DRY RUN IS THE DEFAULT: both vaults are read (owner, name, symbol, supply,
 * the value to change), the call is simulated from the owner — or from
 * KEEPER_PK's address when it is set, which must then BE the owner — and the
 * calldata is printed. Nothing is sent, nothing is written. A transaction is
 * sent only with --live AND --confirm EXECUTE, signed with KEEPER_PK or, on a
 * local anvil fork only, from an unlocked --from account (start anvil with
 * --auto-impersonate and pass the owner).
 *
 * A vault that is already closed (depositsPaused true, perTxCreateCap 0) is
 * skipped and nothing is sent for it: a re-run is safe.
 *
 * Every transaction is appended to keeper/old-vaults.jsonl BEFORE anything
 * else is read: a "sent" line right after the send (with the value before),
 * a "mined" line after the receipt (block, gas, the value after). The value
 * after is read at the receipt's block and repeated for up to 30 s while the
 * node that answers lacks that block (keeper/readback.mjs); nothing between
 * the receipt and the "mined" line throws, so a read that still fails is
 * logged as null and the run stops AFTER the line is written. A final read
 * of both vaults, at a block no lower than the last receipt, must show both
 * closed (exit 1 otherwise). On a local RPC every line goes to
 * keeper/dryrun/old-vaults.jsonl instead.
 *
 * Usage:
 *   node keeper/close-old-vaults.mjs                                           # dry run
 *   KEEPER_PK=0x… node keeper/close-old-vaults.mjs --live --confirm EXECUTE
 *   node keeper/close-old-vaults.mjs --live --confirm EXECUTE \
 *        --rpc http://127.0.0.1:8545 --from 0x<owner>                          # fork rehearsal
 *
 * Options:
 *   --rpc URL                 default GIWA Sepolia public RPC; --chain-id n (default 91342)
 *   --live --confirm EXECUTE  send (otherwise dry run)
 *   --from 0x…                unlocked owner on a local anvil/hardhat fork (needs --live and a local --rpc)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, getAddress, isAddress, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GIWA_RPC, GIWA_CHAIN_ID, chainFor, isLocalRpc, sleep } from './basket-plan.mjs';
import { retryRead, blockAtLeast } from './readback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ADMIN_GAS = 120_000n;
/** Receipt waits per transaction (each viem's default timeout). */
const RECEIPT_WAITS = 3;

const COMMON = [
  'function owner() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];
const QDV_ABI = parseAbi([...COMMON, 'function depositsPaused() view returns (bool)', 'function setDepositsPaused(bool paused)']);
const QBV_ABI = parseAbi([...COMMON, 'function perTxCreateCap() view returns (uint256)', 'function setPerTxCreateCap(uint256 cap)']);

/** The two vaults, the value that says "closed", and the call that closes it. */
export const TARGETS = [
  {
    key: 'qdv',
    label: 'qDV (QuadrixVault, ERC-4626)',
    address: getAddress('0xdf54c6b518335825947d90a941c706e26531a502'),
    abi: QDV_ABI,
    field: 'depositsPaused',
    fn: 'setDepositsPaused',
    args: [true],
    isClosed: (v) => v === true,
  },
  {
    key: 'qbv-v3',
    label: 'QBV v3 (QuadrixBasketVault)',
    address: getAddress('0xa908c180be8d58f223a220da98dd71db0f0be45d'),
    abi: QBV_ABI,
    field: 'perTxCreateCap',
    fn: 'setPerTxCreateCap',
    args: [0n],
    isClosed: (v) => v === 0n,
  },
];

class Refused extends Error {}

function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d = null) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const o = {
    live: flag('--live'),
    confirm: opt('--confirm'),
    rpc: opt('--rpc', GIWA_RPC),
    from: opt('--from'),
    chainId: Number(opt('--chain-id', String(GIWA_CHAIN_ID))),
  };
  if (o.live && o.confirm !== 'EXECUTE') throw new Refused('--live needs --confirm EXECUTE — refusing rather than sending by accident');
  if (o.from && !(o.live && isLocalRpc(o.rpc) && isAddress(o.from))) throw new Refused('--from is for an unlocked account on a local fork (--live and --rpc http://127.0.0.1:… or localhost)');
  o.fork = isLocalRpc(o.rpc);
  if (o.fork && o.live && !o.from) throw new Refused('a live run on a local RPC needs --from (an unlocked anvil account); KEEPER_PK is never used against a local node');
  return o;
}

const json = (obj) => JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const append = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, json(obj) + '\n');
};
const show = (v) => (typeof v === 'bigint' && v === 2n ** 256n - 1n ? `${v} (2^256-1, no cap)` : String(v));

async function sendNonceSafe(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!/nonce/i.test(String(e && e.message))) throw e;
      await sleep(4000 * (i + 1));
    }
  }
  throw last;
}

export async function main(argv = process.argv.slice(2), env = process.env, log = (m) => console.log(`[close-old-vaults] ${m}`)) {
  const o = parseArgs(argv);
  const logPath = path.join(o.fork ? path.join(HERE, 'dryrun') : HERE, 'old-vaults.jsonl');
  const chain = chainFor(o.rpc, o.chainId);
  const pc = createPublicClient({ chain, transport: http(o.rpc), pollingInterval: o.fork ? 200 : 2000 });
  const onchain = await pc.getChainId();
  if (onchain !== o.chainId) throw new Refused(`RPC ${o.rpc} is chain ${onchain}, expected ${o.chainId}`);
  const client = await pc.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');

  let signer = null;
  let wallet = null;
  if (o.live && o.fork) {
    if (!/anvil|hardhat/i.test(String(client))) throw new Refused(`--from needs a local anvil/hardhat node; ${o.rpc} reports "${client}"`);
    signer = getAddress(o.from);
    wallet = createWalletClient({ account: signer, chain, transport: http(o.rpc) });
  } else if (o.live) {
    if (!env.KEEPER_PK) throw new Refused('--live needs KEEPER_PK in the environment');
    const acct = privateKeyToAccount(env.KEEPER_PK);
    signer = acct.address;
    wallet = createWalletClient({ account: acct, chain, transport: http(o.rpc) });
  } else if (env.KEEPER_PK) {
    signer = privateKeyToAccount(env.KEEPER_PK).address; // the address a live run would sign with; the key is never printed
  }
  log(`${o.live ? `LIVE from ${signer}` : `DRY RUN — nothing is sent, nothing is written${signer ? `; simulating as KEEPER_PK's address ${signer}` : '; no KEEPER_PK, simulating as each owner'}`}; rpc ${o.rpc} (${client}); chain ${onchain}`);

  // (a) read both vaults at one block. The head comes from one node of the
  // load-balanced endpoint; a node without that block yet answers an error or
  // an empty "0x" (keeper/readback.mjs), so each read is repeated within the
  // bound, and a vault that still shows no code after it is refused.
  const head = await pc.getBlockNumber({ cacheTime: 0 });
  const state = [];
  for (const t of TARGETS) {
    const r = (functionName) => pc.readContract({ address: t.address, abi: t.abi, functionName, blockNumber: head });
    const s = await retryRead(async () => {
      const code = await pc.getCode({ address: t.address, blockNumber: head });
      if (!code || code === '0x') throw new Error(`no code at block ${head}`);
      return { t, owner: getAddress(await r('owner')), name: await r('name'), symbol: await r('symbol'), totalSupply: await r('totalSupply'), value: await r(t.field) };
    }, { what: `${t.label} ${t.address} at block ${head}` })
      .then((x) => x.value)
      .catch((e) => { throw new Refused(`${t.label} ${t.address} could not be read on this chain: ${e.message}`); });
    state.push(s);
    log(`${t.label} ${t.address} at block ${head}: name "${s.name}", symbol ${s.symbol}, totalSupply ${s.totalSupply}, owner ${s.owner}, ${t.field} = ${show(s.value)}${t.isClosed(s.value) ? ' (closed already)' : ''}`);
  }
  // the signer must be the owner of every vault that still needs a call
  for (const s of state) {
    if (s.t.isClosed(s.value) || !signer) continue;
    if (getAddress(signer) !== s.owner) throw new Refused(`${s.t.label}: ${s.t.fn} is onlyOwner; owner is ${s.owner}, signer is ${signer}`);
  }

  // (b) simulate, print calldata, and send (live only)
  let nextNonce = null;
  let floor = head;
  let sent = 0;
  for (const s of state) {
    const { t } = s;
    if (t.isClosed(s.value)) { log(`  ${t.label}: ${t.field} is already ${show(s.value)} — nothing to send`); continue; }
    const data = encodeFunctionData({ abi: t.abi, functionName: t.fn, args: t.args });
    const from = signer ?? s.owner;
    try {
      await pc.call({ account: from, to: t.address, data });
    } catch (e) {
      throw new Refused(`${t.label}: ${t.fn}(${t.args.join(', ')}) would revert as ${from} — ${e.shortMessage ?? e.message}`);
    }
    log(`  ${t.label}: ${t.fn}(${t.args.join(', ')}) to ${t.address} as ${from} — simulated ok; calldata ${data}`);
    if (!o.live) continue;

    const tx = await sendNonceSafe(async () => {
      const pending = await pc.getTransactionCount({ address: signer, blockTag: 'pending' });
      const nonce = nextNonce != null && nextNonce > pending ? nextNonce : pending;
      const hash = await wallet.sendTransaction({ to: t.address, data, gas: ADMIN_GAS, nonce });
      nextNonce = nonce + 1;
      return hash;
    });
    const base = { vault: t.key, contract: t.address, chainId: o.chainId, fn: t.fn, args: t.args, field: t.field, tx };
    append(logPath, { at: new Date().toISOString(), ...base, status: 'sent', from: signer, before: s.value, beforeBlock: head, rpc: o.fork ? o.rpc : 'giwa-sepolia' });
    sent++;
    log(`  ${t.label}: ${t.fn} sent tx=${tx}; logged`);

    let rc = null;
    let lastErr = null;
    for (let i = 1; i <= RECEIPT_WAITS && !rc; i++) {
      try { rc = await pc.waitForTransactionReceipt({ hash: tx }); } catch (e) { lastErr = e; log(`  ${t.label}: no receipt yet for ${tx} (${e.shortMessage ?? e.message})`); }
    }
    if (!rc) throw new Error(`${t.label}: ${t.fn} tx ${tx} was sent (logged as "sent") but no receipt came back after ${RECEIPT_WAITS} waits (${lastErr?.shortMessage ?? lastErr?.message}) — read ${t.field}() on ${t.address} before re-running; a re-run skips the vault once it reads closed`);

    // From the receipt to the "mined" line nothing throws.
    let after = null;
    let blockTime = null;
    const problems = [];
    if (rc.status === 'success') {
      try {
        after = (await retryRead(() => pc.readContract({ address: t.address, abi: t.abi, functionName: t.field, blockNumber: rc.blockNumber }), { what: `${t.field} at block ${rc.blockNumber}` })).value;
      } catch (e) { problems.push(e.message); }
    }
    try {
      const blk = (await retryRead(() => pc.getBlock({ blockNumber: rc.blockNumber }), { what: `block ${rc.blockNumber}` })).value;
      blockTime = new Date(Number(blk.timestamp) * 1000).toISOString();
    } catch (e) { problems.push(e.message); }
    append(logPath, { at: new Date().toISOString(), ...base, status: rc.status === 'success' ? 'mined' : 'reverted', block: rc.blockNumber, blockTime, gasUsed: rc.gasUsed, before: s.value, after });
    if (rc.blockNumber > floor) floor = rc.blockNumber;

    // (c) assert
    if (rc.status !== 'success') throw new Error(`${t.label}: ${t.fn} reverted on chain (tx ${tx}, block ${rc.blockNumber}; logged)`);
    if (after == null) throw new Error(`${t.label}: ${t.fn} tx ${tx} is mined (block ${rc.blockNumber}) and logged, but ${t.field} could not be read at that block (${problems.join('; ')}) — read it by hand before the next run`);
    if (!t.isClosed(after)) throw new Error(`${t.label}: ${t.field} reads ${show(after)} at block ${rc.blockNumber} after ${t.fn} tx ${tx}`);
    log(`  ${t.label}: ${t.fn} tx=${tx} block=${rc.blockNumber}; ${t.field} ${show(s.value)} -> ${show(after)}; logged`);
  }

  if (!o.live) {
    log('dry run: nothing sent, nothing logged');
    return 0;
  }
  // (c) final read of both, at a block no lower than the last receipt
  const { value: last } = await retryRead(async () => {
    const at = await blockAtLeast(pc, floor);
    const vals = [];
    for (const t of TARGETS) vals.push(await pc.readContract({ address: t.address, abi: t.abi, functionName: t.field, blockNumber: at }));
    return { at, vals };
  }, { what: `final read at a block >= ${floor}` });
  const open = TARGETS.filter((t, i) => !t.isClosed(last.vals[i]));
  log(`final read at block ${last.at}: ${TARGETS.map((t, i) => `${t.label} ${t.field} = ${show(last.vals[i])}`).join(' · ')}`);
  if (open.length) throw new Error(`still open after the run: ${open.map((t) => t.label).join(', ')}`);
  log(`${sent} transaction(s); both vaults closed to deposits; ${path.relative(ROOT, logPath)}${sent ? ' appended' : ' unchanged'}`);
  return 0;
}

/** Run as a script (the real path too: a symlinked work directory must not skip main). */
function isMain() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const arg = path.resolve(process.argv[1]);
  if (arg === me) return true;
  try { return fs.realpathSync(arg) === fs.realpathSync(me); } catch { return false; }
}

if (isMain()) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      if (e instanceof Refused) { console.error(`REFUSED: ${e.message}`); process.exitCode = 2; return; }
      console.error(e?.shortMessage ?? e?.message ?? e);
      process.exitCode = 1;
    }
  );
}
