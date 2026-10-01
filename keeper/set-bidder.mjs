/**
 * Whitelists (or removes) one auction bidder on the basket vaults — the
 * owner's `setBidder(bidder, allowed)` — and appends every transaction to
 * keeper/bidder-log.jsonl.
 *
 * Why a log file: QuadrixBasketVault v3.1's owner setters emit no event
 * (red-team RT24), so a whitelisting is visible on chain only as a
 * transaction and in the `isBidder` mapping. The tx hash, the block and the
 * read-back are committed here so the record shows when each bidder was
 * allowed and by whom.
 *
 * The vaults are the rulebooks' `basket.vault` (keeper/rulebooks/*.json) —
 * the same list every other keeper tool uses — never a second hard-coded
 * list. A vault where `isBidder(bidder)` already equals `allowed` is skipped
 * and nothing is sent.
 *
 * DRY RUN IS THE DEFAULT: each call is simulated from the vault's owner and
 * printed. --live sends with KEEPER_PK (owner of the six testnet vaults), or —
 * rehearsal on a local anvil only — from an unlocked --from. Every receipt
 * must be mined without revert and `isBidder` is read back before the next
 * vault. Keys are never printed.
 *
 * Reads after the write (2026-10-01; keeper/readback.mjs): the hash is printed
 * the moment it is sent; after the receipt, `isBidder` and the block's time
 * are read AT the receipt's block, repeated for up to 30 s while the node
 * that answers lacks it — a load-balanced node one block behind can no longer
 * answer with the old mapping value. Nothing between the receipt and the log
 * line throws: a read that still fails is logged as null and the run stops
 * AFTER the line is written. A re-run where the chain already says `allowed`
 * sends nothing; if a run was killed between the receipt and the line, the
 * line is missing for good (setBidder emits no event) — the hash is in that
 * run's log.
 *
 * Usage:
 *   BIDDER_PK=0x… node keeper/set-bidder.mjs                          # dry run, all six vaults
 *   KEEPER_PK=0x… BIDDER_PK=0x… node keeper/set-bidder.mjs --live
 *   node keeper/set-bidder.mjs --bidder 0x… --live --rpc http://127.0.0.1:8545 --from 0x<owner>   # anvil
 *
 * Options:
 *   --bidder 0x…      the bidder (default: BIDDER_PK's address)
 *   --index a,b       subset of the rulebooks (default: every rulebook with a basket.vault)
 *   --allow false     remove instead of allow
 *   --rpc URL         default GIWA Sepolia public RPC; --chain-id n for a fresh anvil
 *   --live            send (default: dry run)
 *   --from 0x…        unlocked owner (anvil only; requires --live and a local --rpc)
 *   --log p           default keeper/bidder-log.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, getAddress, isAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { INDEXES, TICKER, GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, chainFor, isLocalRpc, sleep, makeReader, loadRulebook } from './basket-plan.mjs';
import { retryRead, pinnedReader } from './readback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SET_BIDDER_ABI = parseAbi(['function setBidder(address bidder, bool allowed)']).concat(VAULT_ABI);
const GAS = 80_000n;

class Refused extends Error {}

function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const allow = opt('--allow', 'true');
  if (!['true', 'false'].includes(allow)) { console.error('--allow takes true or false'); process.exit(2); }
  return {
    bidder: opt('--bidder', null),
    index: opt('--index', null),
    allowed: allow === 'true',
    rpc: opt('--rpc', GIWA_RPC),
    chainId: Number(opt('--chain-id', GIWA_CHAIN_ID)),
    live: flag('--live'),
    from: opt('--from', null),
    log: opt('--log', path.join(HERE, 'bidder-log.jsonl')),
  };
}

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

/** Receipt waits per transaction (each viem's default 180 s). */
const RECEIPT_WAITS = 3;

/**
 * After a mined setBidder: `isBidder(bidder)` and the block's time, both read
 * at the receipt's block and repeated within the bound. Never throws — a read
 * that still fails comes back null with the reason, so the caller can write
 * the log line before it stops.
 */
export async function readBackAfterReceipt(reader, { vault, bidder, receipt, opts = {} }) {
  const out = { isBidderAfter: null, at: null, problems: [] };
  try {
    out.isBidderAfter = (await retryRead(() => pinnedReader(reader, receipt.blockNumber).read({ address: vault, abi: VAULT_ABI, functionName: 'isBidder', args: [bidder] }), { what: `isBidder at block ${receipt.blockNumber}`, ...opts })).value;
  } catch (e) { out.problems.push(e.message); }
  try {
    const blk = (await retryRead(() => reader.publicClient.getBlock({ blockNumber: receipt.blockNumber }), { what: `block ${receipt.blockNumber}`, ...opts })).value;
    out.at = new Date(Number(blk.timestamp) * 1000).toISOString();
  } catch (e) { out.problems.push(e.message); }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[set-bidder] ${m}`);
  let bidder;
  if (o.bidder) {
    if (!isAddress(o.bidder)) throw new Refused(`--bidder ${o.bidder} is not an address`);
    bidder = getAddress(o.bidder);
  } else if (process.env.BIDDER_PK) {
    bidder = privateKeyToAccount(process.env.BIDDER_PK).address;
  } else {
    throw new Refused('no bidder: pass --bidder 0x… or set BIDDER_PK (repository secret) — without a separate bidder the keeper key bids, and it is whitelisted already on every vault');
  }

  const reader = await makeReader(o.rpc, { chainId: o.chainId });
  const pc = reader.publicClient;
  const clientVersion = await pc.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');
  const devNode = /anvil|hardhat|ganache/i.test(String(clientVersion));
  const chain = chainFor(o.rpc, reader.chainId);
  let signer = null;
  let wallet = null;
  let mode;
  if (o.live && o.from) {
    if (!devNode || !isLocalRpc(o.rpc)) throw new Refused(`--from is for an unlocked account on a local anvil/hardhat node; ${o.rpc} reports "${clientVersion}"`);
    if (!isAddress(o.from)) throw new Refused(`--from ${o.from} is not an address`);
    signer = getAddress(o.from);
    wallet = createWalletClient({ account: signer, chain, transport: http(o.rpc) });
    mode = `LIVE, unlocked --from (${clientVersion})`;
  } else if (o.live) {
    if (!process.env.KEEPER_PK) throw new Refused('--live needs KEEPER_PK in the environment (or --from on a local anvil)');
    const acct = privateKeyToAccount(process.env.KEEPER_PK);
    signer = acct.address;
    wallet = createWalletClient({ account: acct, chain, transport: http(o.rpc) });
    mode = `LIVE, KEEPER_PK (${clientVersion})`;
  } else {
    signer = process.env.KEEPER_PK ? privateKeyToAccount(process.env.KEEPER_PK).address : null;
    mode = `DRY RUN (${clientVersion}) — nothing is sent`;
  }

  const want = o.index ? o.index.split(',').map((s) => s.trim()).filter(Boolean) : INDEXES;
  for (const i of want) if (!INDEXES.includes(i)) throw new Refused(`unknown index ${i} (${INDEXES.join(', ')})`);
  const vaults = want.map((index) => ({ index, vault: loadRulebook(index).rulebook.basket?.vault ?? null })).filter((x) => x.vault).map((x) => ({ ...x, vault: getAddress(x.vault) }));
  if (vaults.length === 0) throw new Refused('no rulebook names a basket vault');
  log(`${mode}; rpc ${o.rpc}; bidder ${bidder} → ${o.allowed}; vaults (from keeper/rulebooks): ${vaults.map((x) => `${TICKER[x.index]} ${x.vault}`).join(' · ')}`);

  let sent = 0;
  for (const { index, vault } of vaults) {
    const T = TICKER[index];
    const [owner, isB, open] = await reader.batch([
      { address: vault, abi: VAULT_ABI, functionName: 'owner' },
      { address: vault, abi: VAULT_ABI, functionName: 'isBidder', args: [bidder] },
      { address: vault, abi: VAULT_ABI, functionName: 'biddingOpen' },
    ]);
    const from = signer ?? owner;
    if (isB === o.allowed) { log(`  ${T}: isBidder(${bidder}) is already ${isB} — nothing to send`); continue; }
    if (getAddress(from) !== getAddress(owner)) throw new Refused(`${T}: setBidder is onlyOwner; owner is ${owner}, signer is ${from}`);
    let request;
    try {
      ({ request } = await pc.simulateContract({ address: vault, abi: SET_BIDDER_ABI, functionName: 'setBidder', args: [bidder, o.allowed], account: from }));
    } catch (e) {
      throw new Refused(`${T}: setBidder(${bidder}, ${o.allowed}) would revert as ${from} — ${e.shortMessage ?? e.message}`);
    }
    if (!o.live) { log(`  ${T}: would setBidder(${bidder}, ${o.allowed}) as ${from} (simulated ok; biddingOpen ${open})`); continue; }
    const hash = await sendNonceSafe(() => wallet.writeContract({ ...request, gas: GAS }));
    log(`  ${T}: setBidder(${bidder}, ${o.allowed}) sent tx=${hash}`);
    let rc = null;
    let lastErr = null;
    for (let i = 1; i <= RECEIPT_WAITS && !rc; i++) {
      try { rc = await pc.waitForTransactionReceipt({ hash }); } catch (e) { lastErr = e; log(`  ${T}: no receipt yet for ${hash} (${e.shortMessage ?? e.message})`); }
    }
    if (!rc) throw new Error(`${T}: setBidder tx ${hash} was sent but no receipt came back after ${RECEIPT_WAITS} waits (${lastErr?.shortMessage ?? lastErr?.message}) — check isBidder(${bidder}) on ${vault} and add the line to ${path.relative(ROOT, o.log)} by hand before re-running`);
    if (rc.status !== 'success') throw new Error(`${T}: setBidder reverted on chain (tx ${hash}, block ${rc.blockNumber})`);
    // From the receipt to the log line nothing throws (readBackAfterReceipt).
    const rb = await readBackAfterReceipt(reader, { vault, bidder, receipt: rc });
    const back = rb.isBidderAfter;
    const line = { at: rb.at, index, ticker: T, vault, chainId: reader.chainId, bidder, allowed: o.allowed, txHash: hash, block: rc.blockNumber.toString(), signer: from, isBidderAfter: back };
    fs.appendFileSync(o.log, JSON.stringify(line) + '\n');
    sent++;
    if (back == null) throw new Error(`${T}: setBidder tx ${hash} is mined (block ${rc.blockNumber}) and logged, but isBidder could not be read at that block (${rb.problems.join('; ')}) — read isBidder(${bidder}) on ${vault} by hand before the next run`);
    if (back !== o.allowed) throw new Error(`${T}: isBidder(${bidder}) reads ${back} at block ${rc.blockNumber} after setBidder(${o.allowed}) tx ${hash}`);
    log(`  ${T}: setBidder(${bidder}, ${o.allowed}) tx=${hash} block=${rc.blockNumber}; isBidder now ${back}; logged`);
  }
  log(o.live ? `${sent} transaction(s); ${path.relative(ROOT, o.log)} appended` : 'dry run: nothing sent, nothing logged');
}

/** Run as a script (the real path too: a symlinked work directory, e.g. macOS /var or /tmp, must not skip main). */
function isMain() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const arg = path.resolve(process.argv[1]);
  if (arg === me) return true;
  try { return fs.realpathSync(arg) === fs.realpathSync(me); } catch { return false; }
}

if (isMain()) {
  main().catch((e) => {
    if (e instanceof Refused) { console.error(`REFUSED: ${e.message}`); process.exit(1); }
    console.error(e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
}
