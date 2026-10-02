/**
 * Basket reconstitution executor — runs one plan (keeper/basket-plan.mjs)
 * against a QuadrixBasketVault v3.1, one stage at a time.
 *
 *   announce      owner: announceRegistryChange(adds, removes, decisionSha256)
 *   execute       anyone: executeRegistryChange(same tuple) once the 7 days ran
 *   first-prices  keeper: the first setRefPrice for every added asset
 *   auctions      keeper opens, the bidder fills, until every traded name is
 *                 within the bound fair fills allow of its trade target
 *                 (residualBound) and every removal is drained — and
 *                 finalized at once (below)
 *   finalize      anyone: finalizeRemoval for each drained removal still in
 *                 the registry; a remnant under $1 is reported PENDING
 *   verify        read-only: registry, order, prices, weights, a redeem simulation
 *   day7          execute → first-prices → auctions → finalize → verify in one run
 *
 * DRY RUN IS THE DEFAULT. Without --live nothing is sent: every call is
 * simulated from the role that would sign it and printed with decoded
 * arguments. --live sends, signing with KEEPER_PK from the environment, or
 * — for a rehearsal on `anvil --auto-impersonate` only — from an unlocked
 * account given as --from. Fills sign as the bidder: BIDDER_PK (live) or
 * --bidder (rehearsal); the default bidder is the keeper signer, which is
 * the deployed testnet shape (owner = keeper = bidder) and not the mainnet
 * one.
 *
 * The contract bounds what the keeper role can lose per fill and per day,
 * but three things it cannot bound are guarded HERE, and each refuses with a
 * non-zero exit rather than proceeding:
 *   - a re-announce (only one change may be pending; re-announcing restarts
 *     the clock): announce refuses while pendingRegistryChange != 0, refuses
 *     a decisionSha256 that is not in trackrecord/decisions.jsonl or that
 *     belongs to another basket's decision, and refuses an EMPTY change (a
 *     weight-only plan needs no announcement; announcing one would block the
 *     vault's auctions for the 7 days);
 *   - the first reference price of a new asset (band-free by design):
 *     first-prices refuses unless the plan's two independent sources agree
 *     within --first-price-tol (2%) and the mock's decimals on chain equal
 *     the plan's — a one-decimal slip is a 10× price;
 *   - a reference walked during a session: this script re-posts only the
 *     value already on chain (a same-value post refreshes the v3.1
 *     staleness clock, nothing else) and re-reads both legs right before
 *     each re-post, stopping if another run moved one in between; refuses
 *     any post that would step outside the ±15% band; refuses to trade
 *     while a chain reference is more than --ref-drift-tol (5%) away from
 *     the day's market price — re-mark with the daily keeper first; and
 *     refuses to trade when a chain reference is no longer the one the plan
 *     sized its amounts at (chainRefAtPlan) — regenerate the plan.
 * Fills are taken at the curve's fair point by default (--fill fair: factor
 * 10,000 ≤ f ≤ 10,010, so lossAtRef is 0 and share value is unchanged);
 * --fill open takes the +2% start (a gift to holders); --fill natural fills
 * at whatever point the script reaches, bounded only by the contract. The
 * fair window is duration/30 seconds wide (30 s at 900 s); a missed window
 * cancels and reopens at most twice, then stops with a message to widen the
 * planner's --duration (1800 s gives 60 s on the public chain).
 * Removals (red-team RT17, option K): finalizeRemoval needs the vault's
 * balance to be exactly zero, and anyone can send one base unit, or create
 * shares (which pays in a pro-rata slice of a leaving asset), between the
 * drain fill and the finalize. So a drain is finalized right after its fill,
 * not after every other auction: the balance is re-read, zero → finalize at
 * once; not zero → re-drain from the live balance at once (a remnant under
 * the plan's $1 trade minimum is filled at the curve's open without waiting
 * — the bidder pays at most 2% over reference on less than $1, lossAtRef 0;
 * $1 or more follows the fill policy), then check again — at most five
 * re-drains. Still not zero → the asset is written to plan.finalizePending
 * and the run goes on: the auctions stage, finalize and verify report it as
 * PENDING, not as a failure (redemptions and the record are unaffected; the
 * leg keeps paying out its remnant until a later drain). Each fill also
 * takes min(auction amount, the vault's live balance), so a redemption in
 * the window shrinks the fill instead of reverting it, and the unfilled rest
 * of the auction is cancelled.
 * Every transaction is simulated first, sent with fixed gas, retried on a
 * nonce error (the keeper key is shared by the crons and the desk) and
 * required to be mined WITHOUT revert before the next one (a reverted
 * receipt does not throw in viem — basket-mark.mjs, 2026-09-21). Reads go
 * through Multicall3 in paced batches. Secrets are never printed.
 *
 * Usage:
 *   node keeper/basket-recon.mjs --index qrev --stage announce                 # dry run against GIWA
 *   KEEPER_PK=0x… node keeper/basket-recon.mjs --index qrev --stage announce --live
 *   node keeper/basket-recon.mjs --index qrev --stage day7 --live --rpc http://127.0.0.1:8545 \
 *        --from 0x<owner> --bidder 0x<bidder> --warp                              # anvil rehearsal
 *
 * Options:
 *   --plan p              plan file (default: the latest keeper/plans/{index}/*.json)
 *   --rpc URL             default GIWA Sepolia public RPC; --chain-id for a fresh anvil
 *   --live                send transactions (default: dry run)
 *   --from 0x…            unlocked sender (anvil/hardhat only; requires --live and a local --rpc)
 *   --bidder 0x…          unlocked bidder (rehearsal); live fills use BIDDER_PK when set
 *   --fill fair|open|natural   fill policy (default fair)
 *   --fair-window-bps n   width of the fair window above 10,000 (default 10)
 *   --first-price-tol x   max relative disagreement between the two sources (default 0.02)
 *   --ref-drift-tol x     max chain-reference vs plan-price drift before trading (default 0.05)
 *   --decisions p         decisions ledger (default trackrecord/decisions.jsonl)
 *   --warp                on anvil, jump the clock to the fair point instead of waiting
 *   --max-rounds n        residual rebalance rounds after the plan's trades (default 3)
 *   --no-faucet           never top the bidder up from a mock's open faucet
 *   --max-faucet-calls n  cap on faucet() calls per asset (default 60)
 *   --allow-plan-date     accept a plan not generated today (first-prices, auctions)
 *   --hook file           REHEARSAL ONLY (--live --from on a local anvil): a module whose
 *                         default export is awaited at 'before-fill' (after the wait, before
 *                         the live balance is re-read) and 'after-fill' (between a drain fill
 *                         and the finalize check) — how the anvil rehearsal lands a donation,
 *                         a creation or a redemption inside those windows
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWalletClient, http, getAddress, isAddress, keccak256, encodeAbiParameters, parseEventLogs, parseAbi, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  INDEXES, GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, ERC20_ABI, DECISIONS_LEDGER,
  chainFor, isLocalRpc, sleep, makeReader, readVault, toRefPrice, bpsDiff, sha256,
  loadDecisions, loadPlan, savePlan, latestPlan, computeTrades,
} from './basket-plan.mjs';
import { retryRead, latestReader, pinnedReader, blockAtLeast, notYetReason, eventsIn, ReadTimeout } from './readback.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO32 = `0x${'0'.repeat(64)}`;
const STAGES = ['announce', 'execute', 'first-prices', 'auctions', 'finalize', 'verify', 'day7'];
/** Option K: re-drains of a removal remnant before it is left PENDING. */
export const MAX_DRAIN_ATTEMPTS = 5;

/** Fixed gas per call, scaled by the registry size where the contract loops
 *  over it. Same reason as basket-mark.mjs POST_GAS: a node estimate that is
 *  exactly right for the previous state ran a band step out of gas on
 *  2026-09-21 and the reverted receipt was logged as posted. Measured on the
 *  fork: announce 72,748 (one add), execute 52,823 (one add), fill 117,557
 *  (11 assets). */
const GAS = {
  post: 120_000n,
  announce: (k) => 150_000n + 45_000n * BigInt(k),
  execute: (k) => 120_000n + 60_000n * BigInt(k),
  openAuction: 220_000n,
  fill: (n) => 260_000n + 12_000n * BigInt(n),
  finalize: (n) => 120_000n + 8_000n * BigInt(n),
  approve: 80_000n,
  faucet: 100_000n,
};

/** A guard refusal: printed as REFUSED and exits 1; never a stack trace. */
class Refused extends Error {}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const iso = (ts) => new Date(Number(ts) * 1000).toISOString();
const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const pct = (x) => `${(x * 100).toFixed(2)}%`;

// ------------------------------------------------------------- CLI parsing
function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const o = {
    index: opt('--index', null),
    stage: opt('--stage', null),
    plan: opt('--plan', null),
    rpc: opt('--rpc', GIWA_RPC),
    chainId: Number(opt('--chain-id', GIWA_CHAIN_ID)),
    live: flag('--live'),
    from: opt('--from', null),
    bidder: opt('--bidder', null),
    fill: opt('--fill', 'fair'),
    fairWindowBps: Number(opt('--fair-window-bps', 10)),
    firstPriceTol: Number(opt('--first-price-tol', 0.02)),
    refDriftTol: Number(opt('--ref-drift-tol', 0.05)),
    decisions: opt('--decisions', DECISIONS_LEDGER),
    warp: flag('--warp'),
    maxRounds: Number(opt('--max-rounds', 3)),
    faucet: !flag('--no-faucet'),
    maxFaucetCalls: Number(opt('--max-faucet-calls', 60)),
    allowPlanDate: flag('--allow-plan-date'),
    paceMs: opt('--pace-ms', null) == null ? undefined : Number(opt('--pace-ms')),
    hook: opt('--hook', null),
  };
  if (!INDEXES.includes(o.index) || !STAGES.includes(o.stage) || !['fair', 'open', 'natural'].includes(o.fill)) {
    console.error(`usage: node keeper/basket-recon.mjs --index ${INDEXES.join('|')} --stage ${STAGES.join('|')} [--plan p] [--rpc URL] [--live] [--from 0x…] [--bidder 0x…] [--fill fair|open|natural] [--warp] …`);
    process.exit(2);
  }
  return o;
}

// ----------------------------------------------------------- error decoding
function fmtErr(e) {
  let name = null;
  let cur = e;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.data?.errorName) { name = cur.data.errorName; break; }
    if (cur.name === 'ContractFunctionRevertedError' && cur.reason) { name = cur.reason; break; }
    cur = cur.cause;
  }
  const short = e?.shortMessage ?? e?.message ?? String(e);
  return name ? `${name} (${short.split('\n')[0]})` : short.split('\n')[0];
}

// ------------------------------------------------------------ the context
async function makeCtx(o) {
  const log = (m) => console.log(`[recon:${o.index}:${o.stage}] ${m}`);
  const planFile = o.plan ?? latestPlan(o.index);
  if (!planFile) throw new Refused(`no plan for ${o.index} — run keeper/basket-plan.mjs first`);
  const plan = loadPlan(planFile);
  if (plan.index !== o.index) throw new Refused(`${planFile} is a plan for ${plan.index}, not ${o.index}`);

  const reader = await makeReader(o.rpc, { chainId: o.chainId, paceMs: o.paceMs });
  if (plan.chainId !== reader.chainId) throw new Refused(`plan is for chain ${plan.chainId}, RPC is chain ${reader.chainId}`);
  const clientVersion = await reader.publicClient.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');
  const devNode = /anvil|hardhat|ganache/i.test(String(clientVersion));
  const chain = chainFor(o.rpc, reader.chainId);

  // Signers. Addresses are printed; keys never are.
  let keeperAddr;
  let keeperWallet = null;
  let bidderAddr;
  let bidderWallet = null;
  let mode;
  if (o.live && o.from) {
    if (!devNode || !isLocalRpc(o.rpc)) throw new Refused(`--from is for an unlocked account on a local anvil/hardhat node; ${o.rpc} reports "${clientVersion}"`);
    if (!isAddress(o.from)) throw new Refused(`--from ${o.from} is not an address`);
    keeperAddr = getAddress(o.from);
    keeperWallet = createWalletClient({ account: keeperAddr, chain, transport: http(o.rpc) });
    bidderAddr = o.bidder ? getAddress(o.bidder) : keeperAddr;
    bidderWallet = bidderAddr === keeperAddr ? keeperWallet : createWalletClient({ account: bidderAddr, chain, transport: http(o.rpc) });
    mode = `LIVE, unlocked --from (${clientVersion})`;
  } else if (o.live) {
    const pk = process.env.KEEPER_PK;
    if (!pk) throw new Refused('--live needs KEEPER_PK in the environment (or --from on a local anvil)');
    const acct = privateKeyToAccount(pk);
    keeperAddr = acct.address;
    keeperWallet = createWalletClient({ account: acct, chain, transport: http(o.rpc) });
    if (process.env.BIDDER_PK) {
      const b = privateKeyToAccount(process.env.BIDDER_PK);
      bidderAddr = b.address;
      bidderWallet = createWalletClient({ account: b, chain, transport: http(o.rpc) });
    } else {
      bidderAddr = keeperAddr;
      bidderWallet = keeperWallet;
    }
    mode = `LIVE, KEEPER_PK${process.env.BIDDER_PK ? ' + BIDDER_PK' : ''} (${clientVersion})`;
  } else {
    // Dry run: simulate from the vault's real roles, so a call that the role
    // could not make shows up as a revert here too.
    const v0 = await readVault(reader, plan.vault);
    keeperAddr = o.from && isAddress(o.from) ? getAddress(o.from) : v0.keeper;
    bidderAddr = o.bidder && isAddress(o.bidder) ? getAddress(o.bidder) : process.env.BIDDER_PK ? privateKeyToAccount(process.env.BIDDER_PK).address : keeperAddr;
    mode = `DRY RUN (${clientVersion}) — nothing is sent`;
  }
  if (o.warp && !devNode) throw new Refused('--warp needs an anvil/hardhat node');
  let hook = null;
  if (o.hook) {
    if (!(o.live && o.from && devNode && isLocalRpc(o.rpc))) throw new Refused('--hook is for the anvil rehearsal only (--live --from on a local anvil)');
    hook = (await import(pathToFileURL(path.resolve(o.hook)).href)).default;
  }
  log(`${mode}; rpc ${o.rpc}; plan ${path.relative(ROOT, planFile)} (${plan.date}, ${plan.adds.length} add, ${plan.removes.length} remove, ${plan.trades.length} auction); keeper/owner signer ${keeperAddr}; bidder ${bidderAddr}; fill ${o.fill}`);
  // floor: the highest receipt block this run has seen (or this plan's
  // "sent" list records); every read after it is made at a block ≥ floor.
  return { o, log, plan, planFile, reader, pc: reader.publicClient, devNode, keeperAddr, keeperWallet, bidderAddr, bidderWallet, live: o.live, hook, pendingThisRun: new Set(), floor: 0n, receipts: new Map(), events: null };
}

// -------------------------------------------------------------- sending
/** basket-mark.mjs sendNonceSafe: the key is shared by the crons and the desk. */
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

// ------------------------------------------- reads after a write (2026-10-01)
/**
 * Every chain read of this script goes through readAt. Before the run's
 * first receipt (ctx.floor = 0: none sent yet, none in the plan's `sent`
 * list) it reads at `latest`, as it always did — a dry run of a fresh plan
 * never leaves that path. After a receipt it never reads at
 * `latest` again: it reads at a NAMED block, either `at` (a receipt's own
 * block — exact: what that transaction did) or the newest block the RPC
 * reports raised to ctx.floor (the highest receipt block seen) — and repeats
 * the read, for at most READ_WAIT_MS, while the node that answers lacks that
 * block or answers empty. A load-balanced node that has not seen our last
 * block therefore errors or answers empty; it can no longer answer with the
 * state from before our transaction (keeper/readback.mjs).
 */
async function readAt(ctx, what, fn, at = null) {
  if (at == null && ctx.floor === 0n) return fn(latestReader(ctx.reader));
  const label = at != null ? `${what} at block ${at}` : `${what} at a block ≥ ${ctx.floor}`;
  const { value, reads } = await retryRead(async () => fn(pinnedReader(ctx.reader, at ?? await blockAtLeast(ctx.pc, ctx.floor))), { what: label });
  if (reads > 1) ctx.log(`  (${label}: answered at read ${reads})`);
  return value;
}
const vaultNow = (ctx, what = 'vault state', at = null) => readAt(ctx, what, (r) => readVault(r, ctx.plan.vault), at);
const batchNow = (ctx, what, contracts, at = null) => readAt(ctx, what, (r) => r.batch(contracts), at);
const readNow = (ctx, what, contract, at = null) => readAt(ctx, what, (r) => r.read(contract), at);

/** A simulation after a write runs at a block ≥ ctx.floor, so a node that
 *  has not seen our last transaction cannot fake a revert; it is repeated
 *  only while the node lacks that block — a revert is final, as before. */
async function simulate(ctx, params) {
  if (ctx.floor === 0n) return ctx.pc.simulateContract(params);
  const { value } = await retryRead(async () => ctx.pc.simulateContract({ ...params, blockNumber: await blockAtLeast(ctx.pc, ctx.floor) }), {
    what: `simulation of ${params.functionName} at a block ≥ ${ctx.floor}`,
    retryIf: (e) => notYetReason(e) != null,
  });
  return value;
}

/** Receipt waits per transaction (each viem's default 180 s): a transport
 *  error while waiting is not the transaction's failure. */
const RECEIPT_WAITS = 3;

/** basket-mark.mjs requireMined, plus the "sent" entry: a reverted receipt
 *  must stop the run. The entry is updated and saved before that throw. */
async function waitMined(ctx, entry, label) {
  let receipt = null;
  let last = null;
  for (let i = 1; i <= RECEIPT_WAITS && !receipt; i++) {
    try { receipt = await ctx.pc.waitForTransactionReceipt({ hash: entry.hash }); } catch (e) {
      last = e;
      ctx.log(`  no receipt yet for ${entry.hash} (${fmtErr(e)})${i < RECEIPT_WAITS ? ' — waiting again' : ''}`);
    }
  }
  if (!receipt) throw new Error(`${label}: tx ${entry.hash} was sent but no receipt came back after ${RECEIPT_WAITS} waits (${fmtErr(last)}) — it is in the plan's "sent" list, and the next run looks it up before it does anything else`);
  if (receipt.blockNumber > ctx.floor) ctx.floor = receipt.blockNumber;
  ctx.receipts.set(entry.hash.toLowerCase(), receipt);
  entry.block = receipt.blockNumber;
  entry.status = receipt.status;
  entry.gasUsed = receipt.gasUsed;
  savePlan(ctx.planFile, ctx.plan);
  if (receipt.status !== 'success') throw new Error(`${label} reverted on chain (tx ${entry.hash}, block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})`);
  return receipt;
}

/** The time of a receipt's block, read at that block number and repeated
 *  while the node lacks it; null if it still cannot be read. Never throws. */
async function receiptTime(ctx, receipt) {
  try {
    const { value, reads } = await retryRead(() => ctx.pc.getBlock({ blockNumber: receipt.blockNumber }), { what: `block ${receipt.blockNumber}` });
    if (reads > 1) ctx.log(`  (block ${receipt.blockNumber} answered at read ${reads})`);
    return value.timestamp;
  } catch (e) {
    ctx.log(`  WARN the time of block ${receipt.blockNumber} could not be read (${e.message}) — the transaction is recorded without it`);
    return null;
  }
}
const isoOrNull = (ts) => (ts == null ? null : iso(ts));

/**
 * Simulate, print, and (live) send one call as `who` ('keeper' | 'bidder').
 * `dependsOnUnsent` marks a dry-run step whose simulation cannot succeed
 * because an earlier step was not sent; it is printed, not simulated.
 *
 * THE RECORD CONTRACT (live; RUNBOOK "Reads after a write"):
 *   1. The moment the RPC returns the hash, it is printed and appended to
 *      the plan's `sent` list ({what, call, to, from, hash, sentAt}) and the
 *      plan is saved — before the receipt is awaited, before any read.
 *   2. call() then waits for the receipt and writes block/status/gasUsed
 *      into that entry and saves again. A reverted receipt throws (nothing
 *      changed on chain); a receipt that never comes throws with the hash
 *      already on disk.
 *   3. After a successful receipt call() reads only the block's time —
 *      at the receipt's block number, repeated within the bound — and
 *      returns null for it rather than throw. call() never throws after a
 *      successful receipt.
 *   4. The CALLER writes its stage record (plan.announce, plan.execute,
 *      plan.firstPrices, plan.fills, plan.finalize) from what call()
 *      returned — the receipt, its events, the arguments it sent — and
 *      saves the plan BEFORE it makes any further chain read. A read that
 *      checks the write comes after that save, at the receipt's block or a
 *      block ≥ ctx.floor; if it fails, the record is already on disk.
 * A re-run settles every `sent` entry without a receipt before it does
 * anything else (settleSent) and reconciles each stage from the chain.
 */
export async function call(ctx, { who, to, abi = VAULT_ABI, functionName, args = [], gas, what, dependsOnUnsent = false }) {
  const from = who === 'bidder' ? ctx.bidderAddr : ctx.keeperAddr;
  const wallet = who === 'bidder' ? ctx.bidderWallet : ctx.keeperWallet;
  const shown = `${functionName}(${args.map((a) => (typeof a === 'bigint' ? a.toString() : Array.isArray(a) ? `[${a.join(', ')}]` : String(a))).join(', ')})`;
  let request = null;
  let result;
  if (!(dependsOnUnsent && !ctx.live)) {
    try {
      ({ request, result } = await simulate(ctx, { address: to, abi, functionName, args, account: from }));
    } catch (e) {
      if (e instanceof ReadTimeout) throw new Error(`${what}: ${shown} could not be simulated — ${e.message}`);
      throw new Refused(`${what}: ${shown} would revert as ${from} — ${fmtErr(e)}`);
    }
  }
  if (!ctx.live) {
    ctx.log(`  would ${what}: ${shown} as ${from}${dependsOnUnsent ? ' (not simulated — depends on an unsent call)' : ' (simulated ok)'}`);
    return { dry: true, result };
  }
  // The block a simulation ran at is how it was read, not part of the
  // transaction: what is sent is the same request as before.
  // The signer is the WALLET's account. The simulation was made with the
  // bare address, so request.account is a JSON-RPC account; left in, it
  // overrides a KEEPER_PK wallet's private-key account and viem asks the node
  // to sign (eth_sendTransaction) — the public endpoint holds no key
  // (eth_accounts is []), so every live send would fail. With --from the
  // wallet's account is that same JSON-RPC account, as before
  // (keeper/test/live-signing.test.mjs).
  const { blockNumber: _simulatedAt, account: _simulatedAs, ...req } = request;
  const hash = await sendNonceSafe(() => wallet.writeContract({ ...req, account: wallet.account, gas }));
  const entry = { what, call: shown, to, from, hash, sentAt: new Date().toISOString() };
  (ctx.plan.sent ??= []).push(entry);
  savePlan(ctx.planFile, ctx.plan);
  ctx.log(`  ${what}: sent tx=${hash}`);
  const receipt = await waitMined(ctx, entry, `${what}: ${shown}`);
  const blockTimestamp = await receiptTime(ctx, receipt);
  entry.at = isoOrNull(blockTimestamp);
  savePlan(ctx.planFile, ctx.plan);
  ctx.log(`  ${what}: ${shown} tx=${hash} block=${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return { hash, receipt, result, blockTimestamp };
}

// --------------------------------------------- a re-run: settle, reconcile
/**
 * Before anything else, a run settles the plan's `sent` entries that have no
 * receipt yet (an earlier run stopped while waiting): mined → the entry is
 * completed and the stages below reconcile its effect; no receipt → REFUSED,
 * because acting while an earlier transaction may still land is how a trade
 * happens twice. Every recorded block raises ctx.floor, so the run's reads
 * see what the earlier run did.
 */
export async function settleSent(ctx, { waitMs } = {}) {
  const sent = ctx.plan.sent ?? [];
  let changed = false;
  for (const e of sent) {
    if (e.status === 'dropped') continue;
    if (!e.status) {
      let rc = null;
      try {
        rc = (await retryRead(() => ctx.pc.getTransactionReceipt({ hash: e.hash }), { what: `receipt of ${e.hash}`, ...(waitMs != null ? { waitMs } : {}) })).value;
      } catch { rc = null; }
      if (!rc) throw new Refused(`${e.what} (${e.call}) was sent by an earlier run in tx ${e.hash} (${e.sentAt}) and no receipt is found — it may still be pending, or it was dropped. Look the hash up on chain before anything else: once it is mined, re-run (this run records it); if it was dropped, set "status": "dropped" on that entry in the plan's "sent" list and re-run.`);
      ctx.receipts.set(e.hash.toLowerCase(), rc);
      e.block = rc.blockNumber;
      e.status = rc.status;
      e.gasUsed = rc.gasUsed;
      e.settledLater = true;
      changed = true;
      ctx.log(`  earlier tx ${e.hash} (${e.what}) was mined in block ${rc.blockNumber}, ${rc.status} — recorded in "sent"`);
    }
    const b = BigInt(e.block);
    if (b > ctx.floor) ctx.floor = b;
  }
  if (changed && ctx.live) savePlan(ctx.planFile, ctx.plan);
}

/**
 * A live run refuses while a signer has a transaction that is sent but not
 * mined (pending nonce above the latest): an earlier run may have sent it and
 * lost its `sent` entry — a cancelled workflow run does not commit the plan
 * file — and acting before it lands is how a trade happens twice. Wait for it
 * to be mined (or replaced) and re-run; the chain-side reconciliation then
 * sees it. The keeper key is shared with the crons, which never run at the
 * same time (the `keeper-key` concurrency group).
 */
export async function requireNothingPending(ctx, { waitMs = 15_000 } = {}) {
  for (const addr of [...new Set([ctx.keeperAddr, ctx.bidderAddr])]) {
    let last = null;
    try {
      // Asked again for up to 15 s: one lagging node can answer `latest`
      // from before a transaction that another node already counts.
      await retryRead(async () => {
        const [mined, pending] = await Promise.all([
          ctx.pc.getTransactionCount({ address: addr, blockTag: 'latest' }),
          ctx.pc.getTransactionCount({ address: addr, blockTag: 'pending' }),
        ]);
        last = { mined, pending };
        if (pending > mined) throw new Error('in flight');
      }, { what: `nonces of ${addr}`, waitMs });
    } catch (e) {
      if (!last || last.pending <= last.mined) throw e;
      throw new Refused(`${last.pending - last.mined} transaction(s) from ${addr} are sent but not mined yet (nonce: latest ${last.mined}, pending ${last.pending}, for ${(waitMs / 1000).toFixed(0)} s) — an earlier run may have sent them and lost its "sent" list (a cancelled workflow run does not commit the plan file). Wait until they are mined or replaced, then re-run.`);
    }
  }
}

/** Receipts of this plan's successful `sent` entries whose `what` matches. */
async function sentReceipts(ctx, re) {
  const out = [];
  for (const e of (ctx.plan.sent ?? []).filter((x) => x.status === 'success' && re.test(x.what))) {
    const k = e.hash.toLowerCase();
    if (!ctx.receipts.has(k)) ctx.receipts.set(k, (await retryRead(() => ctx.pc.getTransactionReceipt({ hash: e.hash }), { what: `receipt of ${e.hash}` })).value);
    out.push({ entry: e, receipt: ctx.receipts.get(k) });
  }
  return out;
}

const EVENT_ABI = [...VAULT_ABI.filter((x) => x.type === 'event'), ...parseAbi(['event AuctionCancelled(uint256 indexed id)'])];
/** How far back a log search goes when the plan has no block (≈ 2.3 days of 1-s blocks). */
const EVENT_LOOKBACK = 200_000n;

/** The vault's events named in `names` since the plan was made (plan.block),
 *  up to a block ≥ ctx.floor, in 10,000-block slices; a later call in the
 *  same run reads only the blocks after the last one. */
async function vaultEvents(ctx, names) {
  const to = await blockAtLeast(ctx.pc, ctx.floor);
  if (!ctx.events) {
    const floorFrom = to > EVENT_LOOKBACK ? to - EVENT_LOOKBACK : 0n;
    const planBlock = ctx.plan.block?.number != null ? BigInt(ctx.plan.block.number) : 0n;
    ctx.events = { next: planBlock > floorFrom ? planBlock : floorFrom, list: [] };
  }
  for (let lo = ctx.events.next; lo <= to; lo += 10_000n) {
    const hi = lo + 9_999n < to ? lo + 9_999n : to;
    const { value: logs } = await retryRead(() => ctx.pc.getLogs({ address: ctx.plan.vault, fromBlock: lo, toBlock: hi }), { what: `vault logs ${lo}–${hi}` });
    ctx.events.list.push(...parseEventLogs({ abi: EVENT_ABI, logs }));
    ctx.events.next = hi + 1n;
  }
  return ctx.events.list.filter((e) => names.includes(e.eventName));
}

function tuple(plan) {
  const t = plan.announceTuple ?? plan.announce?.tuple;
  if (!t) {
    const why = plan.notes.find((n) => /^(announce tuple|nothing to announce)/.test(n)) ?? "adds' addresses or decisionSha256 missing";
    throw new Refused(`the plan has no complete announce tuple — ${why}`);
  }
  return { adds: t.adds.map((a) => getAddress(a)), removes: t.removes.map((a) => getAddress(a)), sha: t.decisionSha256 };
}

/** The ledger entry for the plan's sha, which must be THIS basket's decision:
 *  files are named `{date}-{index}-…` (or the plan's own decisionFile). A sha
 *  of another basket's document pinned into an announcement is permanent. */
function decisionEntry(ctx, sha) {
  const { plan } = ctx;
  const entry = loadDecisions(ctx.o.decisions).find((e) => e.sha256 === sha);
  if (!entry) throw new Refused(`decisionSha256 ${sha.slice(0, 12)}… is not in ${path.relative(ROOT, ctx.o.decisions)} — anchor the decision document first (anchor-decision workflow)`);
  if (!entry.file.includes(`-${plan.index}-`) && `trackrecord/${entry.file}` !== plan.decisionFile) throw new Refused(`decision ${entry.id} (${entry.file}) is not a ${plan.index} decision — its sha would be pinned into this vault's announcement for good`);
  return entry;
}

/** Review §6-1: the contract accepts a duplicate address at announce and
 *  refuses the same tuple at execute forever (the second push of an add, or
 *  a remove already in removal, reverts) — the announcement would then block
 *  every change on the vault until a re-announce restarts the seven days. */
export function tupleProblems({ adds, removes }) {
  const low = (xs) => xs.map((x) => String(x).toLowerCase());
  const dups = (xs) => [...new Set(low(xs).filter((x, i, a) => a.indexOf(x) !== i))];
  const out = [];
  const da = dups(adds);
  const dr = dups(removes);
  const both = low(adds).filter((x) => low(removes).includes(x));
  if (da.length) out.push(`duplicate address in adds: ${da.join(', ')}`);
  if (dr.length) out.push(`duplicate address in removes: ${dr.join(', ')}`);
  if (both.length) out.push(`address in both adds and removes: ${[...new Set(both)].join(', ')}`);
  return out;
}

/** The deployed convention: mock symbol = "m" + the plan's symbol. */
export const mockSymbolMismatch = (planSymbol, onchainSymbol) => onchainSymbol !== `m${planSymbol}`;

const tupleHash = ({ adds, removes, sha }) =>
  keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'address[]' }, { type: 'bytes32' }], [adds, removes, sha]));
/** keccak of a RegistryChangeAnnounced/Executed event's tuple, lower case. */
const tupleHashOf = (args) => tupleHash({ adds: args.adds.map((a) => getAddress(a)), removes: args.removes.map((a) => getAddress(a)), sha: args.decisionSha256 }).toLowerCase();

/** The plan sized every amount at the references it read on chain (planner
 *  spec 2026-10-01 §1.3) — the prices the contract fills at. A reference
 *  that moved since (a daily mark between the plan and this run) makes the
 *  planned amounts miss the book by that move: regenerate the plan. Checked
 *  by the auctions stage after its re-run reconciliation, and by day7 before
 *  it sends execute (requireSizingBeforeExecute). */
function requireRefsAsPlanned(ctx, v) {
  if (ctx.plan.trades.length === 0) return;
  const moved = [];
  for (const r of ctx.plan.registry) {
    if (r.chainRefAtPlan == null) continue;
    const on = v.assets.find((a) => a.address === getAddress(r.address));
    if (on && on.refPrice !== big(r.chainRefAtPlan)) moved.push(`${r.symbol} ${r.chainRefAtPlan}→${on.refPrice}`);
  }
  if (moved.length) throw new Refused(`reference(s) moved since the plan sized its auctions (${moved.join(', ')}) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage`);
}

/**
 * day7, before it sends execute: a plan whose sizing references moved is
 * refused while the change is still pending, because after execute a
 * regenerated plan no longer sees the adds. Once execute has run (a re-run
 * of day7) nothing is refused here: the auctions stage first records what
 * the earlier run did — its fills, finalizes, and the auctions it left open
 * — and then makes the same check, so a run stopped mid-session (the 6-hour
 * job limit) whose re-run comes after the day's mark still leaves every
 * fill in this plan's record before it refuses.
 */
export async function requireSizingBeforeExecute(ctx) {
  const v = await vaultNow(ctx, 'references before execute');
  if (v.pendingRegistryChange === ZERO32) {
    ctx.log('no registry change pending (executed already, or none in this plan): the auctions stage checks the plan\'s references after it records what an earlier run did');
    return;
  }
  requireRefsAsPlanned(ctx, v);
}

function requirePlanFresh(ctx) {
  if (ctx.plan.date === todayUTC() || ctx.o.allowPlanDate) return;
  throw new Refused(`plan ${ctx.plan.date} was not generated today (${todayUTC()}) — prices and balances have moved; regenerate it (or pass --allow-plan-date for a rehearsal)`);
}

async function assetIndex(ctx, v) {
  const bySym = {};
  for (const a of v.assets) {
    const planRow = ctx.plan.registry.find((r) => r.address === a.address) ?? ctx.plan.adds.find((r) => r.address === a.address);
    bySym[planRow?.symbol ?? a.onchainSymbol] = { ...a, symbol: planRow?.symbol ?? a.onchainSymbol };
  }
  return bySym;
}

// ================================================================ announce
export async function stageAnnounce(ctx) {
  const { plan, log } = ctx;
  const t = tuple(plan);
  // An empty tuple is a valid call for the contract, and it would lock this
  // vault's auctions for REGISTRY_DELAY. A weight-only plan trades, it does
  // not announce.
  if (t.adds.length + t.removes.length === 0) throw new Refused("empty change — a weight-only plan needs no announcement; announcing it would block this vault's auctions for 7 days (run the auctions stage instead)");
  const problems = tupleProblems(t);
  if (problems.length) throw new Refused(`${problems.join('; ')} — the contract would accept this announcement and refuse it at execute forever`);
  for (const a of t.adds) if (!plan.adds.some((x) => x.address && getAddress(x.address) === a)) throw new Refused(`tuple add ${a} is not one of the plan's adds`);
  for (const a of t.removes) if (!plan.removes.some((x) => getAddress(x.address) === a)) throw new Refused(`tuple remove ${a} is not one of the plan's removes`);
  // The decision hash must be an anchored one, of THIS basket. The ledger is
  // the truth; a file on disk that no longer hashes to it is a second signal
  // something moved.
  const sha = t.sha.replace(/^0x/, '');
  const entry = decisionEntry(ctx, sha);
  const onDisk = path.join(ROOT, 'trackrecord', entry.file);
  if (fs.existsSync(onDisk) && sha256(fs.readFileSync(onDisk)) !== sha) throw new Refused(`${entry.file} on disk does not hash to the anchored ${sha.slice(0, 12)}… — the document was edited after anchoring`);
  log(`decision ${entry.id} anchored in ${entry.txHash} (${entry.anchoredAt})`);

  const expectedHash = tupleHash(t);
  const v = await vaultNow(ctx);
  if (v.pendingRegistryChange !== ZERO32) {
    if (v.pendingRegistryChange.toLowerCase() !== expectedHash.toLowerCase()) throw new Refused(`a registry change is already pending (${v.pendingRegistryChange}, eta ${iso(v.pendingRegistryEta)}) — re-announcing would restart the 7 days; execute or wait`);
    if (plan.announce?.pendingHash?.toLowerCase() === expectedHash.toLowerCase()) throw new Refused(`this plan's change is already pending and recorded (tx ${plan.announce.txHash ?? 'not found'}, eta ${iso(v.pendingRegistryEta)}) — nothing to send; re-announcing would restart the 7 days`);
    await adoptAnnounce(ctx, { t, v, entry, expectedHash });
    return;
  }
  if (ctx.keeperAddr !== v.owner) throw new Refused(`announce is onlyOwner; owner is ${v.owner}, signer is ${ctx.keeperAddr}`);
  const reads = await batchNow(ctx, 'announce checks', [
    ...t.adds.flatMap((a) => [
      { address: plan.vault, abi: VAULT_ABI, functionName: 'isRegistryAsset', args: [a] },
      { address: a, abi: ERC20_ABI, functionName: 'decimals' },
      { address: a, abi: ERC20_ABI, functionName: 'symbol' },
    ]),
    ...t.removes.flatMap((a) => [
      { address: plan.vault, abi: VAULT_ABI, functionName: 'isRegistryAsset', args: [a] },
      { address: plan.vault, abi: VAULT_ABI, functionName: 'inRemoval', args: [a] },
      { address: a, abi: ERC20_ABI, functionName: 'symbol' },
    ]),
  ]);
  t.adds.forEach((a, i) => {
    const add = plan.adds.find((x) => x.address && getAddress(x.address) === a);
    const [isReg, dec, sym] = reads.slice(i * 3, i * 3 + 3);
    if (isReg) throw new Refused(`${add?.symbol ?? a} is already a registry asset`);
    if (Number(dec) !== add.decimals) throw new Refused(`${add.symbol}: ${a} has ${dec} decimals on chain, the plan says ${add.decimals} — a first price sized to the wrong decimals is off by 10× per decimal`);
    if (mockSymbolMismatch(add.symbol, sym)) throw new Refused(`${add.symbol}: ${a} is ${sym} on chain, not m${add.symbol} — wrong mock address in the plan`);
    log(`  add ${add.symbol.padEnd(7)} ${a} ${sym} ${dec} dec — first ref ${add.firstRefPrice} (A ${add.priceA} / B ${add.priceB ?? '—'}, ${add.disagreementBps ?? '—'} bp apart)`);
  });
  t.removes.forEach((a, i) => {
    const rem = plan.removes.find((x) => getAddress(x.address) === a);
    const [isReg, inRem, sym] = reads.slice(t.adds.length * 3 + i * 3, t.adds.length * 3 + i * 3 + 3);
    if (!isReg) throw new Refused(`${rem?.symbol ?? a} is not a registry asset`);
    if (inRem) throw new Refused(`${rem?.symbol ?? a} is already in removal`);
    if (mockSymbolMismatch(rem.symbol, sym)) throw new Refused(`${rem.symbol}: ${a} is ${sym} on chain, not m${rem.symbol} — wrong removal address in the plan`);
    log(`  remove ${rem.symbol.padEnd(7)} ${a} ${sym} (balance ${rem.balance})`);
  });
  log(`checks: no duplicate address in adds or removes, none in both; every chain symbol is m{SYMBOL} (${t.adds.length} add, ${t.removes.length} remove)`);
  log(`tuple keccak ${expectedHash}; eta would be now + ${Number(v.registryDelay) / 86400} days`);
  const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.sha], gas: GAS.announce(t.adds.length + t.removes.length), what: 'announce' });
  if (r.dry) return;
  // Recorded from the receipt alone: the RegistryChangeAnnounced event
  // carries the tuple (whose keccak IS pendingRegistryChange) and the eta;
  // the announce block's time is eta − REGISTRY_DELAY by construction.
  const ev = eventsIn(r.receipt, VAULT_ABI, 'RegistryChangeAnnounced', plan.vault)[0]?.args;
  const pendingHash = ev ? tupleHashOf(ev) : expectedHash;
  const eta = ev ? ev.eta : null;
  plan.announce = announceRecord({ txHash: r.hash, block: r.receipt.blockNumber, at: r.blockTimestamp ?? (eta != null ? eta - v.registryDelay : null), eta, pendingHash, t, entry, signer: ctx.keeperAddr });
  plan.announceTuple = plan.announce.tuple;
  savePlan(ctx.planFile, plan);
  log(`announced; recorded in the plan from the receipt (pending ${pendingHash}, eta ${eta != null ? iso(eta) : 'not in the receipt'})`);
  // Then the check, at the receipt's block (exact).
  const [pending, etaOnChain] = await batchNow(ctx, 'pending change after announce', [
    { address: plan.vault, abi: VAULT_ABI, functionName: 'pendingRegistryChange' },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'pendingRegistryEta' },
  ], r.receipt.blockNumber);
  if (eta == null) {
    plan.announce = announceRecord({ ...plan.announce, block: r.receipt.blockNumber, at: r.blockTimestamp ?? etaOnChain - v.registryDelay, eta: etaOnChain, pendingHash: pending, t, entry, signer: ctx.keeperAddr, txHash: r.hash });
    plan.announceTuple = plan.announce.tuple;
    savePlan(ctx.planFile, plan);
  }
  if (pending.toLowerCase() !== expectedHash.toLowerCase()) throw new Error(`announced hash ${pending} != expected ${expectedHash} (block ${r.receipt.blockNumber})`);
  if (etaOnChain !== BigInt(plan.announce.eta)) throw new Error(`pendingRegistryEta ${etaOnChain} at block ${r.receipt.blockNumber} != the event's ${plan.announce.eta}`);
  log(`announced; execute on or after ${iso(etaOnChain)}; plan updated`);
}

/** The plan.announce record — the fields basket-plan.mjs carries to day 7
 *  (pendingHash, tuple) and gen-recon-decision.mjs prints (txHash, at). */
function announceRecord({ txHash, block, at, eta, pendingHash, t, entry, signer, adopted = false, note = null }) {
  return {
    txHash, block, at: at == null ? null : (typeof at === 'string' ? at : iso(at)),
    eta: eta == null ? null : eta.toString(), etaIso: eta == null ? null : iso(eta), pendingHash,
    tuple: { adds: t.adds, removes: t.removes, decisionSha256: t.sha }, decisionId: entry.id, signer,
    ...(adopted ? { adopted: true } : {}), ...(note ? { note } : {}),
  };
}

/**
 * Re-run after an announcement that was mined but not recorded (the run
 * stopped between the receipt and its savePlan): the change pending on chain
 * hashes to THIS plan's tuple, so an earlier run announced it — the owner is
 * the only one who can. It is adopted into the plan instead of refused (the
 * day-7 planner needs plan.announce.pendingHash to plan at all). Nothing is
 * sent. The transaction is the plan's own `sent` entry, else the
 * RegistryChangeAnnounced log with the same tuple and eta found since the
 * plan's block; `at` is eta − REGISTRY_DELAY, the announce block's time by
 * construction (eta = block.timestamp + REGISTRY_DELAY).
 */
async function adoptAnnounce(ctx, { t, v, entry, expectedHash }) {
  const { plan, log } = ctx;
  let txHash = null;
  let block = null;
  let how;
  const fromSent = (await sentReceipts(ctx, /^announce$/)).map(({ receipt }) => ({ receipt, ev: eventsIn(receipt, VAULT_ABI, 'RegistryChangeAnnounced', plan.vault)[0]?.args }))
    .filter((x) => x.ev && tupleHashOf(x.ev) === expectedHash.toLowerCase() && x.ev.eta === v.pendingRegistryEta).at(-1);
  if (fromSent) {
    txHash = fromSent.receipt.transactionHash;
    block = fromSent.receipt.blockNumber;
    how = "the plan's own sent list";
  } else {
    const hit = (await vaultEvents(ctx, ['RegistryChangeAnnounced'])).filter((e) => tupleHashOf(e.args) === expectedHash.toLowerCase() && e.args.eta === v.pendingRegistryEta).at(-1);
    if (hit) { txHash = hit.transactionHash; block = hit.blockNumber; how = 'the RegistryChangeAnnounced log'; }
  }
  let signer = v.owner; // announceRegistryChange is onlyOwner
  if (txHash) {
    const tx = await retryRead(() => ctx.pc.getTransaction({ hash: txHash }), { what: `tx ${txHash}` }).then((x) => x.value).catch(() => null);
    if (tx?.from) signer = getAddress(tx.from);
  }
  const at = v.pendingRegistryEta - v.registryDelay;
  const found = txHash ? `tx ${txHash} (block ${block}, from ${how})` : `the announce tx was not found since the plan's block ${ctx.plan.block?.number ?? '—'}`;
  if (!ctx.live) { log(`this plan's change is already pending on chain (${v.pendingRegistryChange}, eta ${iso(v.pendingRegistryEta)}) but not recorded in the plan — a live run adopts it (${found}); nothing is sent`); return; }
  plan.announce = announceRecord({ txHash, block, at, eta: v.pendingRegistryEta, pendingHash: v.pendingRegistryChange, t, entry, signer, adopted: true, note: `adopted from the chain by a later run: ${found}` });
  plan.announceTuple = plan.announce.tuple;
  savePlan(ctx.planFile, plan);
  log(`this plan's change was already pending on chain and is now recorded in the plan (adopted: ${found}); nothing sent; execute on or after ${iso(v.pendingRegistryEta)}`);
}

// ================================================================= execute
/** K-6: executeRegistryChange is permissionless. With nothing pending, the
 *  change was executed when every add of the tuple is in the registry and
 *  every remove is in removal (or already finalized). */
function executedAlready(v, t) {
  if (t.adds.length + t.removes.length === 0) return false;
  const on = (a) => v.assets.find((x) => x.address === a);
  return t.adds.every((a) => !!on(a)) && t.removes.every((a) => !on(a) || on(a).inRemoval);
}

const EXECUTED_EVENT = VAULT_ABI.find((x) => x.type === 'event' && x.name === 'RegistryChangeExecuted');

async function findExecution(ctx, t) {
  // Our own execute, when this plan's sent list has it (a re-run after a stop).
  for (const { receipt } of (await sentReceipts(ctx, /^execute$/)).reverse()) {
    const ev = eventsIn(receipt, VAULT_ABI, 'RegistryChangeExecuted', ctx.plan.vault)[0];
    if (ev && tupleHashOf(ev.args) === tupleHash(t).toLowerCase()) return { ...ev, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }
  const latest = await blockAtLeast(ctx.pc, ctx.floor);
  const floor = latest > 100_000n ? latest - 100_000n : 0n; // ≈ 28 h of 1-s blocks, 10 reads at most
  const lo = ctx.plan.announce?.block && BigInt(ctx.plan.announce.block) > floor ? BigInt(ctx.plan.announce.block) : floor;
  for (let to = latest; to >= lo; to -= 10_000n) {
    const from = to - 9_999n > lo ? to - 9_999n : lo;
    const { value: logs } = await retryRead(() => ctx.pc.getLogs({ address: ctx.plan.vault, event: EXECUTED_EVENT, fromBlock: from, toBlock: to }), { what: `RegistryChangeExecuted logs ${from}–${to}` });
    const hit = logs.reverse().find((l) => tupleHashOf(l.args) === tupleHash(t).toLowerCase());
    if (hit) return hit;
    if (from === lo) break;
  }
  return null;
}

export async function stageExecute(ctx) {
  const { plan, log } = ctx;
  const t = tuple(plan);
  const v = await vaultNow(ctx);
  if (v.pendingRegistryChange === ZERO32) {
    if (!executedAlready(v, t)) throw new Refused('nothing is pending on chain — announce first');
    if (plan.execute?.txHash) { log(`already executed (tx ${plan.execute.txHash}); continuing`); return; }
    // K-6, and the re-run after our own execute was mined but not recorded:
    // the registry holds the change, so it is recorded from the chain.
    let ev = null;
    try { ev = await findExecution(ctx, t); } catch (e) { log(`  could not search for the RegistryChangeExecuted log (${fmtErr(e)})`); }
    const tx = ev ? await retryRead(() => ctx.pc.getTransaction({ hash: ev.transactionHash }), { what: `tx ${ev.transactionHash}` }).then((x) => x.value).catch(() => null) : null;
    const blk = ev ? await retryRead(() => ctx.pc.getBlock({ blockNumber: ev.blockNumber }), { what: `block ${ev.blockNumber}` }).then((x) => x.value).catch(() => null) : null;
    const by = tx?.from ? getAddress(tx.from) : null;
    const ours = by != null && by === ctx.keeperAddr;
    log(`nothing pending, and the registry already holds this change — executeRegistryChange is permissionless and was called ${by ? `by ${by}${ours ? ' (this keeper: an earlier run that stopped before recording it)' : ''} in tx ${ev.transactionHash} (block ${ev.blockNumber})` : 'by someone else (tx not found in the last 100,000 blocks)'}; continuing with first-prices`);
    if (!ctx.live) return;
    plan.execute = { txHash: ev?.transactionHash ?? null, block: ev?.blockNumber ?? null, at: blk ? iso(blk.timestamp) : null, assetCount: v.assetCount, order: v.assets.map((x) => x.address), signer: by, byThirdParty: by ? by !== ctx.keeperAddr : true };
    savePlan(ctx.planFile, plan);
    return;
  }
  const h = tupleHash(t);
  if (h.toLowerCase() !== v.pendingRegistryChange.toLowerCase()) throw new Refused(`the plan's tuple hashes to ${h} but the pending change is ${v.pendingRegistryChange} — this plan is not what was announced`);
  if (v.block.timestamp < v.pendingRegistryEta) throw new Refused(`timelock not elapsed: eta ${iso(v.pendingRegistryEta)}, chain time ${iso(v.block.timestamp)} (${Number(v.pendingRegistryEta - v.block.timestamp)} s to go)`);
  log(`pending ${v.pendingRegistryChange} matches the plan; eta ${iso(v.pendingRegistryEta)} passed; assetCount ${v.assetCount} → ${v.assetCount + t.adds.length}`);
  const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'executeRegistryChange', args: [t.adds, t.removes, t.sha], gas: GAS.execute(t.adds.length + t.removes.length), what: 'execute' });
  if (r.dry) return;
  // Record first (call() contract), then read the registry AT the receipt's block.
  plan.execute = { txHash: r.hash, block: r.receipt.blockNumber, at: isoOrNull(r.blockTimestamp), assetCount: null, order: null, signer: ctx.keeperAddr };
  savePlan(ctx.planFile, plan);
  const after = await vaultNow(ctx, 'registry after execute', r.receipt.blockNumber);
  plan.execute = { ...plan.execute, assetCount: after.assetCount, order: after.assets.map((x) => x.address) };
  savePlan(ctx.planFile, plan);
  if (after.assetCount !== v.assetCount + t.adds.length) throw new Error(`assetCount ${after.assetCount} after execute (block ${r.receipt.blockNumber}), expected ${v.assetCount + t.adds.length}`);
  for (const a of t.removes) if (!after.assets.find((x) => x.address === a)?.inRemoval) throw new Error(`${a} not flagged inRemoval after execute (block ${r.receipt.blockNumber})`);
  log(`executed; ${after.assetCount} assets; every fill on this vault is closed until first-prices runs (portfolioValueAtRef reverts PriceUnset)`);
}

// ============================================================ first-prices
/** A first price that is on chain but not in plan.firstPrices (a run that
 *  stopped between the receipt and its savePlan): recorded from the plan's
 *  sent list or the RefPricePosted log, never posted again. */
async function adoptFirstPrice(ctx, add, target, on) {
  const { plan, log } = ctx;
  let txHash = null;
  let at = null;
  const mine = (await sentReceipts(ctx, new RegExp(`^first price ${add.symbol}$`))).map(({ receipt }) => ({ receipt, ev: eventsIn(receipt, VAULT_ABI, 'RefPricePosted', plan.vault).find((e) => getAddress(e.args.asset) === getAddress(add.address) && e.args.price === target) })).filter((x) => x.ev).at(-1);
  if (mine) { txHash = mine.receipt.transactionHash; at = (plan.sent ?? []).find((e) => e.hash === txHash)?.at ?? null; } else {
    const hit = (await vaultEvents(ctx, ['RefPricePosted'])).filter((e) => getAddress(e.args.asset) === getAddress(add.address) && e.args.price === target).at(-1);
    if (hit) txHash = hit.transactionHash;
  }
  at ??= iso(on.refPriceUpdatedAt);
  if (!ctx.live) { log(`  ${add.symbol}: reference already ${target} on chain but not recorded in the plan — a live run records it (tx ${txHash ?? 'not found'}); nothing is sent`); return; }
  plan.firstPrices.push({ symbol: add.symbol, address: add.address, price: target.toString(), priceA: add.priceA, priceB: add.priceB, txHash, at, adopted: true });
  savePlan(ctx.planFile, plan);
  log(`  ${add.symbol}: reference already ${target} on chain — recorded in the plan (adopted, tx ${txHash ?? 'not found'}); nothing sent`);
}

export async function stageFirstPrices(ctx) {
  const { plan, log, o } = ctx;
  requirePlanFresh(ctx);
  const v = await vaultNow(ctx);
  if (v.pendingRegistryChange !== ZERO32) throw new Refused('a registry change is still pending — execute first');
  if (ctx.keeperAddr !== v.keeper) throw new Refused(`setRefPrice is keeper-only; keeper is ${v.keeper}, signer is ${ctx.keeperAddr}`);
  if (plan.adds.length === 0) { log('no adds in the plan — nothing to post'); return; }
  const bandBps = 1_500n;
  for (const add of plan.adds) {
    if (!add.address) throw new Refused(`${add.symbol}: no mock address in the plan`);
    const on = v.assets.find((x) => x.address === add.address);
    if (!on) throw new Refused(`${add.symbol} ${add.address} is not in the registry — execute first`);
    if (on.decimals !== add.decimals) throw new Refused(`${add.symbol}: ${on.decimals} decimals on chain, plan says ${add.decimals}`);
    if (!(add.priceB > 0)) throw new Refused(`${add.symbol}: no second-source price — a band-free first post needs two independent sources`);
    const diff = Math.abs(add.priceA - add.priceB) / add.priceA;
    if (diff > o.firstPriceTol) throw new Refused(`${add.symbol}: sources disagree by ${pct(diff)} (A ${add.priceA}, B ${add.priceB}) > ${pct(o.firstPriceTol)}`);
    const target = toRefPrice(add.priceA, add.decimals);
    if (target !== big(add.firstRefPrice)) throw new Refused(`${add.symbol}: plan firstRefPrice ${add.firstRefPrice} != toRefPrice(${add.priceA}, ${add.decimals}) = ${target}`);
    if (on.refPrice === target) {
      if (!plan.firstPrices.some((f) => getAddress(f.address) === getAddress(add.address))) { await adoptFirstPrice(ctx, add, target, on); continue; }
      log(`  ${add.symbol}: reference already ${target} — skipped`);
      continue;
    }
    if (on.refPrice !== 0n) {
      const span = (on.refPrice * bandBps) / 10_000n;
      if (target > on.refPrice + span || target < on.refPrice - span) throw new Refused(`${add.symbol}: reference is already set (${on.refPrice}) and ${target} is outside the ±15% band — the daily mark steps references, this stage does not`);
      log(`  ${add.symbol}: reference already set (${on.refPrice}); ${target} is inside the band — posting`);
    }
    log(`  ${add.symbol}: first post ${target} = $${add.priceA} at ${add.decimals} dec (B $${add.priceB}, ${add.disagreementBps} bp apart); ${on.refPrice === 0n ? 'BAND-FREE first post' : 'in-band post'}`);
    const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [add.address, target], gas: GAS.post, what: `first price ${add.symbol}` });
    if (r.dry) continue;
    plan.firstPrices.push({ symbol: add.symbol, address: add.address, price: target.toString(), priceA: add.priceA, priceB: add.priceB, txHash: r.hash, at: isoOrNull(r.blockTimestamp) });
    savePlan(ctx.planFile, plan);
    const back = await readNow(ctx, `refPrice(${add.symbol}) after posting`, { address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [add.address] }, r.receipt.blockNumber);
    if (back !== target) throw new Error(`${add.symbol}: refPrice reads ${back} at block ${r.receipt.blockNumber} after posting ${target}`);
  }
}

// ================================================================ auctions
/** The fair window in seconds after startTime: factor(e) = start − ⌊range·e/dur⌋
 *  (curveFactorBps), fair when ⌊range·e/dur⌋ = premium. */
function fairWindow(duration, premiumBps, maxFillLossBps, windowBps) {
  const range = premiumBps + maxFillLossBps;
  const eMin = Math.ceil(((premiumBps - windowBps) * duration) / range);
  const eMax = Math.ceil(((premiumBps + 1) * duration) / range) - 1;
  return { eMin, eMax, aim: eMin + Math.floor((eMax - eMin) * 0.4), range };
}

async function chainTime(ctx) {
  return readAt(ctx, 'chain time', async (r) => (await r.publicClient.getBlock()).timestamp);
}

async function waitUntil(ctx, targetTs, why) {
  let now = await chainTime(ctx);
  if (now >= targetTs) return;
  if (ctx.o.warp) {
    await ctx.pc.request({ method: 'evm_increaseTime', params: [Number(targetTs - now)] });
    await ctx.pc.request({ method: 'evm_mine', params: [] });
    ctx.log(`  warped ${Number(targetTs - now)} s (${why})`);
    return;
  }
  ctx.log(`  waiting ${Number(targetTs - now)} s (${why})`);
  while (now < targetTs) {
    await sleep(Math.min(15_000, Math.max(2_000, Number(targetTs - now) * 1000)));
    now = await chainTime(ctx);
  }
}

async function ensureInventory(ctx, token, symbol, need) {
  const [bal, allowance] = await batchNow(ctx, `bidder's ${symbol}`, [
    { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [ctx.bidderAddr] },
    { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.bidderAddr, ctx.plan.vault] },
  ]);
  if (bal < need) {
    if (!ctx.o.faucet) throw new Refused(`bidder ${ctx.bidderAddr} holds ${bal} ${symbol}, needs ${need}, and --no-faucet is set`);
    let faucetAmount;
    try { faucetAmount = await readNow(ctx, `${symbol} faucetAmount`, { address: token, abi: ERC20_ABI, functionName: 'faucetAmount' }); } catch {
      throw new Refused(`bidder holds ${bal} ${symbol}, needs ${need}, and ${token} has no faucet — fund the bidder`);
    }
    const calls = Number((need - bal + faucetAmount - 1n) / faucetAmount);
    if (calls > ctx.o.maxFaucetCalls) throw new Refused(`bidder needs ${calls} faucet() calls of ${symbol} (${faucetAmount} each) > --max-faucet-calls ${ctx.o.maxFaucetCalls}`);
    ctx.log(`  bidder holds ${bal} ${symbol}, needs ${need}: ${calls} × faucet() (${faucetAmount} each)`);
    for (let i = 0; i < calls; i++) {
      await call(ctx, { who: 'bidder', to: token, abi: ERC20_ABI, functionName: 'faucet', gas: GAS.faucet, what: `faucet ${symbol} ${i + 1}/${calls}` });
      if (!ctx.live) break; // one printed line stands for the loop in a dry run
    }
  }
  if (allowance < need) {
    await call(ctx, { who: 'bidder', to: token, abi: ERC20_ABI, functionName: 'approve', args: [ctx.plan.vault, maxUint256], gas: GAS.approve, what: `approve ${symbol}` });
  }
}

/** A same-value re-post must re-post the value on chain NOW, not the one read
 *  at the start of the trade: if any other keeper run (the daily mark, the
 *  6-hourly NAV keeper, a manual run) moved a reference in between, posting
 *  the old value would step it BACK — this script never moves a reference. */
async function requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t) {
  const [curS, curB] = await batchNow(ctx, 'references before the re-posts', [
    { address: ctx.plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [sell] },
    { address: ctx.plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [buy] },
  ]);
  if (curS !== pSell || curB !== pBuy) throw new Refused(`reference moved during the session (${t.sell} ${pSell}→${curS}, ${t.buy} ${pBuy}→${curB}) — another keeper run is active; stopping before any re-post`);
}

/** Missed fair windows cancel and reopen; each miss costs four keeper
 *  transactions, so the retries are bounded. */
const MAX_WINDOW_ATTEMPTS = 3;

async function runHook(ctx, point, info) {
  if (ctx.hook) await ctx.hook(point, info, { rpc: ctx.o.rpc, vault: ctx.plan.vault, chainId: ctx.reader.chainId });
}

export async function runTrade(ctx, v, t, round, attemptNo = 1) {
  const { plan, log, o } = ctx;
  // A residual drain under $1 (option K) fills at the open: waiting ~10
  // minutes for the fair point is the window a donation needs, and the most
  // the bidder overpays at the open is 2% of less than $1.
  const policy = t.immediate ? 'open' : o.fill;
  const sell = getAddress(t.sellAddress);
  const buy = getAddress(t.buyAddress);
  const [sellBal, pSell, pBuy, tsSell, tsBuy] = await batchNow(ctx, `#${t.seq} balance and references`, [
    { address: sell, abi: ERC20_ABI, functionName: 'balanceOf', args: [plan.vault] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [sell] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [buy] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPriceUpdatedAt', args: [sell] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPriceUpdatedAt', args: [buy] },
  ]);
  let amount = t.drain ? sellBal : (big(t.sellAmount) < sellBal ? big(t.sellAmount) : sellBal);
  if (amount === 0n) { log(`  #${t.seq} ${t.sell}→${t.buy}: nothing left to sell — skipped`); return null; }
  if (pSell === 0n || pBuy === 0n) throw new Refused(`#${t.seq}: a leg has no reference (${t.sell} ${pSell}, ${t.buy} ${pBuy})`);
  const now = await chainTime(ctx);
  log(`  #${t.seq} round ${round}${attemptNo > 1 ? ` attempt ${attemptNo}/${MAX_WINDOW_ATTEMPTS}` : ''}: sell ${amount} ${t.sell} for ${t.buy}${t.drain ? ' [drain to zero]' : ''}${t.immediate ? ' [remnant under $1: fill at the open]' : ''}; refs ${pSell} / ${pBuy} aged ${now - tsSell}s / ${now - tsBuy}s (maxRefAge ${v.maxRefAge}s)`);
  // An immediate fill skips the same-value re-posts while both references
  // are comfortably fresh (they were re-posted by the fill a moment ago):
  // fewer transactions, a narrower window.
  const repost = !(t.immediate && now - tsSell < v.maxRefAge - 120n && now - tsBuy < v.maxRefAge - 120n);

  // Inventory for the worst case (+2% at the open), then the auction itself.
  const buyWorst = (amount * pSell * (10_000n + v.premiumBps) + pBuy * 10_000n - 1n) / (pBuy * 10_000n);
  await ensureInventory(ctx, buy, t.buy, buyWorst);
  const opened = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'openAuction', args: [sell, buy, amount, BigInt(t.duration)], gas: GAS.openAuction, what: `open auction #${t.seq}` });
  const win = fairWindow(t.duration, Number(v.premiumBps), Number(v.maxFillLossBps), o.fairWindowBps);
  const aimElapsed = policy === 'fair' ? win.aim : 0;
  if (opened.dry) {
    // A dry run sends nothing: the id the open would get is auctionCount now.
    const id = await readNow(ctx, 'auctionCount', { address: plan.vault, abi: VAULT_ABI, functionName: 'auctionCount' });
    log(`  would wait ${aimElapsed} s to the ${policy === 'fair' ? `fair window [${win.eMin}, ${win.eMax}] s` : 'open'}, re-read and re-post both references at their current values, then fill(${id}, min(${amount}, live balance)) as bidder ${ctx.bidderAddr}${t.drain ? `; then read ${t.sell}'s balance: zero → finalizeRemoval at once, else re-drain at once (≤ ${MAX_DRAIN_ATTEMPTS}×), else left waiting (finalizePending)` : ''}`);
    await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} (same value)` });
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} (same value)` });
    await call(ctx, { who: 'bidder', to: plan.vault, functionName: 'fill', args: [id, amount], gas: GAS.fill(v.assetCount), what: `fill #${t.seq}`, dependsOnUnsent: true });
    return { dry: true };
  }
  // The id is the one in the receipt's AuctionOpened event, not auctionCount
  // read before the open (a stale read, or another open in between, would
  // name an older auction). startTime is the open block's time — openAuction
  // sets block.timestamp; the struct is read, at that block, only when the
  // block's time could not be.
  const oev = eventsIn(opened.receipt, VAULT_ABI, 'AuctionOpened', plan.vault)[0]?.args;
  if (!oev) throw new Error(`no AuctionOpened event in ${opened.hash} — the next auctions run cancels whatever it opened`);
  const id = oev.id;
  if (getAddress(oev.sellAsset) !== sell || getAddress(oev.buyAsset) !== buy || oev.sellAmount !== amount) throw new Error(`auction ${id} opened in ${opened.hash} is ${oev.sellAmount} ${oev.sellAsset} → ${oev.buyAsset}, not this trade — the next auctions run cancels it`);
  const startTime = opened.blockTimestamp ?? BigInt((await readNow(ctx, `auction ${id}`, { address: plan.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] }, opened.receipt.blockNumber))[3]);

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitUntil(ctx, startTime + BigInt(aimElapsed), policy === 'fair' ? `to the fair point of auction ${id}` : `auction ${id} open`);
    // Same-value re-posts: refresh the staleness clock, move nothing — so the
    // values on chain must still be the ones read at the start of this trade.
    if (repost) {
      await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} (same value)` });
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} (same value)` });
    }
    // K-3: the fill takes what the vault holds NOW, at most the auction's
    // amount — a redemption since the balance was read would otherwise make
    // the fill revert; anything that arrived since stays and is re-drained.
    // Read before the factor, so that the factor check stays the last read
    // before the fill.
    await runHook(ctx, 'before-fill', { seq: t.seq, symbol: t.sell, asset: sell, auctionId: id, amount, drain: !!t.drain, residual: !!t.residual });
    const liveBal = await readNow(ctx, `${t.sell} in the vault`, { address: sell, abi: ERC20_ABI, functionName: 'balanceOf', args: [plan.vault] });
    const take = liveBal < amount ? liveBal : amount;
    if (take === 0n) {
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id} (nothing left to sell)` });
      return null;
    }
    const factorNow = Number(await readNow(ctx, `curve factor of auction ${id}`, { address: plan.vault, abi: VAULT_ABI, functionName: 'curveFactorBps', args: [id] }));
    const late = policy !== 'natural' && factorNow < 10_000;
    const early = policy === 'fair' && factorNow > 10_000 + o.fairWindowBps;
    if (early) {
      log(`  factor ${factorNow} still above the window — waiting`);
      await waitUntil(ctx, (await chainTime(ctx)) + 5n, 'window');
      attempt--; // not a retry, just a wait
      continue;
    }
    if (late) {
      log(`  factor ${factorNow} is below fair — too late for a ${policy} fill; cancelling auction ${id}${attemptNo < MAX_WINDOW_ATTEMPTS ? ' and reopening' : ''}`);
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id}` });
      if (attemptNo >= MAX_WINDOW_ATTEMPTS) throw new Error(`#${t.seq}: missed the fair window ${attemptNo} times (window [${win.eMin}, ${win.eMax}] s of a ${t.duration} s auction = duration/30 wide; three mined transactions must land inside it) — widen the planner's --duration (1800 s gives a 60 s window on the public chain) or run when blocks are quick`);
      return runTrade(ctx, v, t, round, attemptNo + 1);
    }
    if (take !== amount) log(`  live balance ${liveBal} ${t.sell} is below the auction's ${amount} (a redemption in the window) — filling ${take}`);
    const filled = await call(ctx, { who: 'bidder', to: plan.vault, functionName: 'fill', args: [id, take], gas: GAS.fill(v.assetCount), what: `fill #${t.seq} (auction ${id})` });
    // Recorded from the receipt before any read (call() contract). Without
    // the block's time the factor is unknown: recorded as null, and a fair
    // fill then stops below instead of guessing.
    const ev = eventsIn(filled.receipt, VAULT_ABI, 'AuctionFilled', plan.vault).find((e) => e.args.id === id)?.args;
    if (!ev) throw new Error(`no AuctionFilled event for auction ${id} in ${filled.hash}`);
    const elapsed = filled.blockTimestamp == null ? null : Number(filled.blockTimestamp - startTime);
    const factor = elapsed == null ? null : 10_000 + Number(v.premiumBps) - Math.floor((win.range * elapsed) / t.duration);
    const rec = {
      seq: t.seq, round, auctionId: id.toString(), sell: t.sell, buy: t.buy, sellTaken: ev.sellTaken.toString(), buyPaid: ev.buyPaid.toString(),
      lossAtRef: ev.lossAtRef.toString(), factorBps: factor, elapsed, policy, bidder: ctx.bidderAddr,
      openTx: opened.hash, fillTx: filled.hash, at: isoOrNull(filled.blockTimestamp),
      ...(take !== amount ? { auctionAmount: amount.toString() } : {}),
      ...(t.residual ? { residualOf: t.parentSeq ?? null } : {}),
    };
    plan.fills.push(rec);
    savePlan(ctx.planFile, plan);
    log(`  filled auction ${id}: took ${ev.sellTaken} ${t.sell}, paid ${ev.buyPaid} ${t.buy}, factor ${factor ?? 'unknown'} bp (${elapsed ?? '?'} s in), lossAtRef ${ev.lossAtRef}`);
    if (policy !== 'natural') {
      if (ev.lossAtRef !== 0n) throw new Error(`HALT: fill ${filled.hash} booked lossAtRef ${ev.lossAtRef} under the ${policy} policy`);
      if (policy === 'fair' && factor == null) throw new Error(`HALT: fill ${filled.hash} is recorded, but the time of block ${filled.receipt.blockNumber} could not be read, so its factor is unknown — check the block's time against auction ${id}'s fair window by hand before re-running`);
      if (policy === 'fair' && (factor < 10_000 || factor > 10_000 + o.fairWindowBps)) throw new Error(`HALT: fill ${filled.hash} landed at factor ${factor}, outside [10000, ${10_000 + o.fairWindowBps}]`);
    }
    // K-1: a drain is finalized right here, not after the other auctions.
    if (t.drain && !t.residual) await settleRemoval(ctx, v, t, round);
    if (take !== amount) {
      const a2 = await readNow(ctx, `auction ${id} after the fill`, { address: plan.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
      if (a2[5]) await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel the unfilled rest of auction ${id} (${a2[2]} ${t.sell})` });
    }
    return rec;
  }
  throw new Error(`auction for #${t.seq} could not be filled in the window`);
}

// ------------------------------------------------- removals (option K)
const minTradeValue = (plan) => BigInt(Math.round((plan.policy.minTradeUsd ?? 1) * 1e18)); // USD × 1e18
const usd = (x) => (Number(x) / 1e18).toFixed(Number(x) < 1e18 ? 6 : 2);

/** finalizeRemoval for one drained asset; records it and clears any PENDING.
 *  `assetCount` sizes the gas only — passed in, so that nothing paced (the
 *  public endpoint's batches wait a second each) sits between a drain fill
 *  and its finalize. */
async function finalizeOne(ctx, asset, sym, assetCount) {
  const { plan, log } = ctx;
  const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'finalizeRemoval', args: [asset], gas: GAS.finalize(assetCount + 2), what: `finalize ${sym}` });
  if (r.dry) return;
  // Record first (call() contract), then read the registry AT the receipt's block.
  const rec = { symbol: sym, address: asset, txHash: r.hash, at: isoOrNull(r.blockTimestamp), assetCount: null, order: null };
  plan.finalize.push(rec);
  if (plan.finalizePending) plan.finalizePending = plan.finalizePending.filter((x) => x.address !== asset);
  savePlan(ctx.planFile, plan);
  const after = await vaultNow(ctx, `registry after finalize ${sym}`, r.receipt.blockNumber);
  rec.assetCount = after.assetCount;
  rec.order = after.assets.map((x) => x.address);
  savePlan(ctx.planFile, plan);
  if (after.assets.some((x) => x.address === asset)) throw new Error(`${sym} still in the registry at block ${r.receipt.blockNumber} after finalizeRemoval`);
  log(`  ${sym} removed; registry order is now (swap-and-pop) ${after.assets.map((x) => plan.registry.find((p) => p.address === x.address)?.symbol ?? plan.adds.find((p) => p.address === x.address)?.symbol ?? x.address).join(' ')}`);
}

/** K-4: the remnant stays; the run goes on and says so. */
function recordPending(ctx, entry) {
  const { plan, log } = ctx;
  ctx.pendingThisRun.add(entry.address);
  log(`  PENDING ${entry.symbol} ${entry.address}: ${entry.balance} base units (≈ $${entry.valueUsd}) still in the vault after ${entry.attempts} re-drain(s) — finalizeRemoval waits for a later drain (re-run the auctions stage). Redemptions pay the remnant pro rata meanwhile; the record is unaffected.`);
  if (!ctx.live) return;
  plan.finalizePending = [...(plan.finalizePending ?? []).filter((x) => x.address !== entry.address), entry];
  savePlan(ctx.planFile, plan);
}

/**
 * K-1/K-2/K-4 after a drain fill (or for a remnant found later): read the
 * balance; zero → finalize at once; otherwise re-drain from the live balance
 * at once and look again, at most MAX_DRAIN_ATTEMPTS times; then PENDING.
 */
async function settleRemoval(ctx, v, t, round) {
  const { plan, log, o } = ctx;
  const asset = getAddress(t.sellAddress);
  let lastTx = null;
  for (let k = 0; ; k++) {
    await runHook(ctx, 'after-fill', { seq: t.seq, symbol: t.sell, asset, attempt: k });
    // Two direct reads, not a paced batch: this is the window K closes.
    const [bal, ref] = await Promise.all([
      readNow(ctx, `${t.sell} in the vault after the drain`, { address: asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [plan.vault] }),
      readNow(ctx, `refPrice(${t.sell})`, { address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [asset] }),
    ]);
    if (bal === 0n) {
      log(`  ${t.sell}: balance 0 — finalizing now${k ? ` (after ${k} re-drain(s))` : ''}`);
      await finalizeOne(ctx, asset, t.sell, v.assetCount);
      return 'finalized';
    }
    const value = bal * ref;
    if (k >= MAX_DRAIN_ATTEMPTS) {
      recordPending(ctx, { symbol: t.sell, address: asset, balance: bal.toString(), valueUsd: usd(value), attempts: k, lastTx, at: iso(await chainTime(ctx)), stage: o.stage });
      return 'pending';
    }
    const dust = value < minTradeValue(plan);
    log(`  ${t.sell}: ${bal} base units (≈ $${usd(value)}) in the vault after the drain — re-drain ${k + 1}/${MAX_DRAIN_ATTEMPTS} now${dust ? ', filled at the open (under the $1 trade minimum)' : `, ${o.fill} fill`}`);
    const rec = await runTrade(ctx, v, { ...t, seq: `${t.seq}.r${k + 1}`, parentSeq: t.seq, sellAmount: bal, drain: true, residual: true, immediate: dust }, round);
    if (rec?.fillTx) lastTx = rec.fillTx;
  }
}

/** A buy leg for a remnant: the plan's own drain buy, else the largest holding. */
function remnantBuy(ctx, v, sym) {
  const t = ctx.plan.trades.find((x) => x.sell === sym && x.drain);
  if (t && v.assets.some((a) => a.address === getAddress(t.buyAddress) && !a.inRemoval)) return { buy: t.buy, buyAddress: getAddress(t.buyAddress), duration: t.duration };
  const best = v.assets.filter((a) => !a.inRemoval && a.refPrice > 0n).sort((a, b) => (b.balance * b.refPrice > a.balance * a.refPrice ? 1 : -1))[0];
  const bySym = ctx.plan.registry.find((r) => r.address === best.address)?.symbol ?? ctx.plan.adds.find((r) => r.address === best.address)?.symbol ?? best.onchainSymbol;
  return { buy: bySym, buyAddress: best.address, duration: ctx.plan.policy.duration };
}

/** After each round: every asset in removal is finalized when drained, or
 *  re-drained (K-2) — this covers a re-run and a remnant that reached the
 *  vault in another trade's window. One PENDING per asset per run. */
async function sweepRemovals(ctx, round) {
  const v = await vaultNow(ctx, 'vault state after the round');
  for (const a of v.assets.filter((x) => x.inRemoval)) {
    if (ctx.pendingThisRun.has(a.address)) continue;
    const sym = ctx.plan.removes.find((r) => r.address === a.address)?.symbol ?? a.onchainSymbol;
    if (a.balance === 0n) { await finalizeOne(ctx, a.address, sym, v.assetCount); continue; }
    const b = remnantBuy(ctx, v, sym);
    ctx.log(`  ${sym} is in removal with ${a.balance} base units left — draining it now`);
    await settleRemoval(ctx, v, { seq: `sweep-${sym}`, sell: sym, sellAddress: a.address, ...b, drain: true }, round);
  }
}

/** Live rows for computeTrades: chain balances, chain references, plan targets. */
async function liveRows(ctx, v) {
  const removes = new Set(ctx.plan.removes.map((r) => r.symbol));
  const bySym = await assetIndex(ctx, v);
  return Object.values(bySym).map((a) => {
    const tgt = ctx.plan.targets.find((t) => t.symbol === a.symbol);
    // The target the auctions can reach (plan tradeTargetWeight): held names
    // keep their weight, the traded set shares its own value.
    return { symbol: a.symbol, address: a.address, decimals: a.decimals, balance: a.balance, ref: a.refPrice, sizingRef: sizingRefOf(ctx.plan, a.address), targetWeight: tgt?.tradeTargetWeight ?? tgt?.targetWeight ?? 0, isAdd: false, isRemove: removes.has(a.symbol) || a.inRemoval, sleeve: tgt?.sleeve };
  });
}

/** The reference the plan sized this asset's auctions at (chainRefAtPlan; an
 *  add's first reference), or null for a plan made before 2026-10-02 or an
 *  asset the plan did not price. The trade targets are weights at THESE
 *  prices, so the check against them values the vault at them too: a later
 *  mark moves every weight at today's references, not the balances the
 *  session left (second review of the planner change). */
export function sizingRefOf(plan, address) {
  const r = (plan.registry ?? []).find((x) => x.address && getAddress(x.address) === getAddress(address));
  if (r?.chainRefAtPlan != null) return big(r.chainRefAtPlan);
  const a = (plan.adds ?? []).find((x) => x.address && getAddress(x.address) === getAddress(address));
  if (a?.firstRefPrice != null && r == null && (plan.registry ?? []).some((x) => x.chainRefAtPlan != null)) return big(a.firstRefPrice);
  return null;
}

/**
 * Owner choice 4 of the planner spec of 2026-10-01 (§5, still open): what a
 * traded name may differ from its trade target after the session. null —
 * option ①, the spec's §4 rule: the bound the fills themselves allow
 * (residualBound below, computed from settings that exist already: the fair
 * window and the $1 trade minimum). A number — option ②: a fixed width in
 * points, whose value is the owner's to set. Before this change the width
 * was the rulebook's 5-point tolerance, which hid a whole entering name.
 */
export const VERIFY_FIXED_POINTS = null;

/**
 * How far a traded name can sit from its trade target after the session's
 * fills, as a weight (planner spec §4):
 *   (Σ_f→i e_f·v_f + aim_i × Σ_f e_f·v_f) / V  +  (n × $1 + k × maxRef) / V
 * v_f — the value a fill put into its buy asset, at today's references; e_f
 * — that fill's distance from fair, |factor − 10,000| / 10,000, never less
 * than the fair window (--fair-window-bps, 10 bp): a fill at factor f pays
 * (f − 10,000)/10,000 more (or less) of the buy asset than fair, so the name
 * bought gains and every name's share of the larger vault shrinks. For fair
 * fills this is the spec's window × (bought_i + aim_i × bought) / V; a
 * remnant filled at the open, or a session run with --fill open / natural,
 * is bounded by its own factor. n — traded names (each matching step of the
 * planner leaves at most the $1 trade minimum unmatched on a name, and there
 * are fewer steps than traded names); k × maxRef — one base unit per fill
 * from rounding; V — the vault's value now.
 */
export function residualBound(ctx, rows) {
  const total = rows.reduce((t, r) => t + Number(r.balance * valuedAt(r)), 0);
  const traded = new Set(ctx.plan.targets.filter((t) => t.traded).map((t) => t.symbol));
  const windowBps = ctx.o?.fairWindowBps ?? 10;
  const refOf = Object.fromEntries(rows.map((r) => [r.symbol, valuedAt(r)]));
  const excess = {}; // Σ e_f·v_f per buy asset
  let excessAll = 0;
  const fills = ctx.plan.fills ?? [];
  for (const f of fills) {
    const ref = refOf[f.buy];
    if (ref == null) continue;
    const e = Math.max(windowBps, Math.abs(Number(f.factorBps ?? 10_000) - 10_000)) / 10_000;
    const ev = e * Number(big(f.buyPaid) * ref);
    excess[f.buy] = (excess[f.buy] ?? 0) + ev;
    excessAll += ev;
  }
  const n = rows.filter((r) => traded.has(r.symbol) || r.isRemove).length;
  const maxRef = rows.reduce((m, r) => (valuedAt(r) > m ? valuedAt(r) : m), 0n);
  const slack = total > 0 ? (n * Number(minTradeValue(ctx.plan)) + fills.length * Number(maxRef)) / total : 0;
  return (r) => (total > 0 ? ((excess[r.symbol] ?? 0) + Math.max(0, r.targetWeight) * excessAll) / total : 0) + slack;
}

/** The price a row is weighed at against its trade target: the plan's sizing
 *  reference when the row carries one (liveRows), else the reference now. */
const valuedAt = (r) => r.sizingRef ?? r.ref;

export function residual(ctx, rows) {
  const total = rows.reduce((t, r) => t + Number(r.balance * valuedAt(r)), 0);
  const traded = new Set(ctx.plan.targets.filter((t) => t.traded).map((t) => t.symbol));
  const minValue = minTradeValue(ctx.plan);
  const boundOf = VERIFY_FIXED_POINTS != null ? () => VERIFY_FIXED_POINTS / 100 : residualBound(ctx, rows);
  const out = [];
  for (const r of rows) {
    const w = total > 0 ? Number(r.balance * valuedAt(r)) / total : 0;
    const drift = w - r.targetWeight;
    const bound = boundOf(r);
    // K-4: a removal remnant under the trade minimum is PENDING, not a failure.
    const pending = r.isRemove && r.balance > 0n && r.balance * r.ref < minValue;
    out.push({ symbol: r.symbol, weight: w, targetWeight: r.targetWeight, drift, bound, ok: r.isRemove ? r.balance === 0n : !traded.has(r.symbol) || Math.abs(drift) <= bound, pending });
  }
  return out;
}

// ------------------------------------------- a re-run of a session stage
/** The symbol a vault address has in this plan (registry, adds, removes). */
const symOf = (plan, a) => {
  const x = getAddress(a);
  return [...plan.registry, ...plan.adds, ...plan.removes].find((r) => r.address && getAddress(r.address) === x)?.symbol ?? x;
};

/**
 * A session stage re-run after a run that stopped right after a mined
 * transaction. From this plan's `sent` receipts and the vault's events since
 * the plan's block (plan.block):
 *   - FILLS: a fill of this vault's auctions that is not in plan.fills is
 *     recorded, never traded again — WHOEVER the bidder: only the keeper
 *     opens auctions, so the vault traded either way, and a run whose bidder
 *     differs from the earlier run's (BIDDER_PK set in between, or a second
 *     whitelisted bidder) would otherwise trade a planned amount twice.
 *     It is matched to the planned round-1 trade with the same sell/buy
 *     pair (computeTrades never repeats a pair); two candidates → REFUSED;
 *     none → recorded as an unplanned fill (a residual round or a re-drain —
 *     those are computed from live balances, so they cannot repeat it).
 *     Its factor is recomputed from the auction's startTime and the fill
 *     block's time. With `halt`, an adopted fill is held to the same HALT
 *     rules as a fill made now.
 *   - ORPHANS (`cancelOrphans`, the auctions stage): an auction opened since
 *     the plan's block that is still open is cancelled before anything is
 *     opened — a re-run never leaves one beside a new one.
 *   - FINALIZED REMOVALS: a removal that has left the registry but is not in
 *     plan.finalize is recorded from its RemovalFinalized event.
 * `write` false (a dry run) prints what a live run would record or send.
 * Returns the planned seqs whose fills were adopted (also when not written).
 */
export async function reconcileSession(ctx, v, { cancelOrphans = false, halt = false, write = ctx.live } = {}) {
  const { plan, log, o } = ctx;
  const vault = getAddress(plan.vault);
  const events = await vaultEvents(ctx, ['AuctionOpened', 'AuctionFilled', 'AuctionCancelled', 'RemovalFinalized']);
  // The plan's own receipts too: a log search on a node behind our last block can miss them.
  const key = (e) => `${e.transactionHash.toLowerCase()}:${e.logIndex}`;
  const seen = new Set(events.map(key));
  for (const { receipt } of await sentReceipts(ctx, /^(fill |open auction |cancel |finalize )/)) {
    for (const e of parseEventLogs({ abi: EVENT_ABI, logs: receipt.logs.filter((l) => getAddress(l.address) === vault) })) {
      if (!seen.has(key(e))) { seen.add(key(e)); events.push(e); }
    }
  }
  const adoptedSeqs = new Set();
  const recordedFills = new Set(plan.fills.map((f) => String(f.fillTx ?? '').toLowerCase()));
  const doneSeqs = new Set(plan.fills.filter((f) => f.round === 1).map((f) => f.seq));
  const unrecorded = events.filter((e) => e.eventName === 'AuctionFilled' && !recordedFills.has(e.transactionHash.toLowerCase()))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const halts = [];
  for (const e of unrecorded) {
    const id = e.args.id;
    const a = await readNow(ctx, `auction ${id}`, { address: vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
    const [sellA, buyA, , startTime, duration] = a;
    const openEv = events.find((x) => x.eventName === 'AuctionOpened' && x.args.id === id);
    const cands = plan.trades.filter((t) => getAddress(t.sellAddress) === getAddress(sellA) && getAddress(t.buyAddress) === getAddress(buyA) && !doneSeqs.has(t.seq) && !adoptedSeqs.has(t.seq));
    if (cands.length > 1) throw new Refused(`fill ${e.transactionHash} (auction ${id}, ${symOf(plan, sellA)} → ${symOf(plan, buyA)}) is not in plan.fills and matches planned trades ${cands.map((t) => `#${t.seq}`).join(', ')} — record it in plan.fills by hand (the planned seq it was) before re-running`);
    const t = cands[0] ?? null;
    const blk = (await retryRead(() => ctx.pc.getBlock({ blockNumber: e.blockNumber }), { what: `block ${e.blockNumber}` })).value;
    const elapsed = Number(blk.timestamp - BigInt(startTime));
    const range = Number(v.premiumBps) + Number(v.maxFillLossBps);
    const factor = 10_000 + Number(v.premiumBps) - Math.floor((range * elapsed) / Number(duration));
    const rec = {
      seq: t ? t.seq : `adopted-${id}`, round: t ? 1 : null, auctionId: id.toString(), sell: symOf(plan, sellA), buy: symOf(plan, buyA),
      sellTaken: e.args.sellTaken.toString(), buyPaid: e.args.buyPaid.toString(), lossAtRef: e.args.lossAtRef.toString(), factorBps: factor, elapsed,
      policy: 'adopted', bidder: getAddress(e.args.bidder), openTx: openEv?.transactionHash ?? null, fillTx: e.transactionHash, at: iso(blk.timestamp), adopted: true,
    };
    if (t) adoptedSeqs.add(t.seq);
    log(`  ${write ? 'recorded' : 'would record'} a fill an earlier run made but did not record: ${rec.sell}→${rec.buy} auction ${id}, took ${rec.sellTaken}, paid ${rec.buyPaid}, factor ${factor} bp, tx ${e.transactionHash}${t ? ` — planned #${t.seq}, not traded again` : ' — not a planned trade (a residual or a re-drain)'}`);
    if (write) { plan.fills.push(rec); savePlan(ctx.planFile, plan); }
    if (halt && o.fill !== 'natural') {
      if (e.args.lossAtRef !== 0n) halts.push(`HALT: adopted fill ${e.transactionHash} booked lossAtRef ${e.args.lossAtRef} under the ${o.fill} policy`);
      else if (t && o.fill === 'fair' && (factor < 10_000 || factor > 10_000 + o.fairWindowBps)) halts.push(`HALT: adopted fill ${e.transactionHash} landed at factor ${factor}, outside [10000, ${10_000 + o.fairWindowBps}]`);
    }
  }
  if (halts.length) throw new Error(halts.join('; '));

  if (cancelOrphans) {
    const opened = events.filter((e) => e.eventName === 'AuctionOpened');
    const states = opened.length ? await batchNow(ctx, 'auctions opened since the plan', opened.map((e) => ({ address: vault, abi: VAULT_ABI, functionName: 'auctions', args: [e.args.id] }))) : [];
    for (let i = 0; i < opened.length; i++) {
      if (!states[i][5]) continue;
      const id = opened[i].args.id;
      log(`  auction ${id} (${symOf(plan, states[i][0])} → ${symOf(plan, states[i][1])}, ${states[i][2]} left, opened in ${opened[i].transactionHash}) is still open from an earlier run — ${write ? 'cancelling it' : 'a live run cancels it'} before anything is opened`);
      if (write) await call(ctx, { who: 'keeper', to: vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id} (left open by an earlier run)` });
    }
  }

  const inRegistry = new Set(v.assets.map((a) => a.address));
  for (const r of plan.removes) {
    const addr = getAddress(r.address);
    if (inRegistry.has(addr) || plan.finalize.some((f) => getAddress(f.address) === addr)) continue;
    if (!plan.registry.some((x) => getAddress(x.address) === addr)) continue; // not in the registry when planned: not this plan's to record
    const ev = events.filter((e) => e.eventName === 'RemovalFinalized' && getAddress(e.args.asset) === addr).at(-1);
    let at = null;
    if (ev) at = iso((await retryRead(() => ctx.pc.getBlock({ blockNumber: ev.blockNumber }), { what: `block ${ev.blockNumber}` })).value.timestamp);
    log(`  ${write ? 'recorded' : 'would record'} the finalize of ${r.symbol} — out of the registry, not in plan.finalize (tx ${ev?.transactionHash ?? 'not found since the plan\'s block'})`);
    if (write) {
      plan.finalize.push({ symbol: r.symbol, address: addr, txHash: ev?.transactionHash ?? null, at, assetCount: null, order: null, adopted: true });
      if (plan.finalizePending) plan.finalizePending = plan.finalizePending.filter((x) => getAddress(x.address) !== addr);
      savePlan(ctx.planFile, plan);
    }
  }
  return adoptedSeqs;
}

export async function stageAuctions(ctx) {
  const { plan, log, o } = ctx;
  requirePlanFresh(ctx);
  let v = await vaultNow(ctx);
  if (v.pendingRegistryChange !== ZERO32) throw new Refused('a registry change is pending — execute it before trading');
  if (ctx.keeperAddr !== v.keeper) throw new Refused(`openAuction/setRefPrice are keeper-only; keeper is ${v.keeper}, signer is ${ctx.keeperAddr}`);
  const unpriced = v.assets.filter((a) => a.refPrice === 0n);
  if (unpriced.length) throw new Refused(`unpriced registry assets ${unpriced.map((a) => a.address).join(', ')} — every fill reverts PriceUnset until first-prices runs`);
  if (!v.biddingOpen) {
    const isB = await readNow(ctx, 'isBidder', { address: plan.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [ctx.bidderAddr] });
    if (!isB) throw new Refused(`bidder ${ctx.bidderAddr} is not whitelisted (isBidder false, biddingOpen false) — owner setBidder first`);
  }
  // References must be today's marks: this script never moves one.
  const bySym = await assetIndex(ctx, v);
  for (const [sym, a] of Object.entries(bySym)) {
    const planRef = plan.registry.find((r) => r.symbol === sym)?.planRefPrice ?? plan.adds.find((r) => r.symbol === sym)?.firstRefPrice;
    if (planRef == null) continue;
    const d = Math.abs(Number(a.refPrice) - Number(planRef)) / Number(planRef);
    if (d > o.refDriftTol) throw new Refused(`${sym}: chain reference ${a.refPrice} is ${pct(d)} from the plan's ${planRef} (> ${pct(o.refDriftTol)}) — re-mark with the daily keeper (paper-index.mjs) first; this script does not move references`);
  }
  // A re-run first records what an earlier run did and cancels what it left
  // open — before the sizing check below, so that a run refused for a moved
  // reference still leaves the earlier run's fills in this plan's record.
  const adopted = await reconcileSession(ctx, v, { cancelOrphans: true, halt: true });
  requireRefsAsPlanned(ctx, v);
  log(`${plan.trades.length} planned auction(s); ${plan.fills.length} already filled; fill policy ${o.fill}; every reference within ${pct(o.refDriftTol)} of the plan${plan.trades.length ? ' and equal to the one the plan sized at' : ''}`);
  if (plan.trades.length === 0) {
    // A plan made on a later day has no auction for a remnant under the
    // trade minimum (computeTrades skips it), and none for a removal when
    // nothing else trades. An asset still in removal is drained and
    // finalized all the same — otherwise a PENDING left by an earlier
    // session could never be cleared by re-running this stage.
    const left = v.assets.filter((a) => a.inRemoval);
    if (left.length === 0) { log('nothing to trade'); return; }
    const names = left.map((a) => `${plan.removes.find((r) => r.address === a.address)?.symbol ?? a.onchainSymbol} (${a.balance} base units)`).join(', ');
    if (!ctx.live) { log(`no planned auction; still in removal: ${names} — a live run drains and finalizes (option K)`); return; }
    log(`no planned auction; still in removal: ${names} — draining and finalizing`);
    await sweepRemovals(ctx, 1);
    return;
  }

  for (let round = 1; round <= o.maxRounds; round++) {
    let trades;
    if (round === 1) {
      const done = new Set([...plan.fills.filter((f) => f.round === 1).map((f) => f.seq), ...adopted]);
      trades = plan.trades.filter((t) => !done.has(t.seq));
    } else {
      const rows = await liveRows(ctx, v);
      const traded = plan.targets.filter((t) => t.traded).map((t) => t.symbol);
      trades = computeTrades(rows, plan.policy, { forceTraded: traded, onlyForced: true }).trades;
      log(`round ${round}: ${trades.length} residual auction(s) from live balances`);
    }
    for (const t of trades) await runTrade(ctx, v, t, round);
    if (!ctx.live) { log('dry run: residual rounds need the fills above to have happened — stopping after round 1'); return; }
    await sweepRemovals(ctx, round);
    v = await vaultNow(ctx, 'vault state after the round');
    const res = residual(ctx, await liveRows(ctx, v));
    for (const r of res) log(`  ${r.symbol.padEnd(7)} ${pct(r.weight).padStart(7)} vs trade target ${pct(r.targetWeight).padStart(7)} (${(r.drift * 100).toFixed(4)} pt, bound ${(r.bound * 100).toFixed(4)} pt) ${r.ok ? 'ok' : r.pending ? 'PENDING (remnant under $1, finalize waiting)' : 'OUTSIDE'}`);
    if (res.every((r) => r.ok || r.pending)) { log(`inside the bound after round ${round}${res.some((r) => r.pending) ? `; PENDING: ${res.filter((r) => r.pending).map((r) => r.symbol).join(', ')}` : ''}`); return; }
  }
  throw new Error(`still outside the bound after ${o.maxRounds} round(s)`);
}

// ================================================================ finalize
export async function stageFinalize(ctx) {
  const { plan, log } = ctx;
  const v = await vaultNow(ctx);
  // An unrecorded fill is held to the HALT rules here too: once recorded it
  // is no longer "unrecorded", so the auctions stage that runs after this one
  // would not see it again.
  await reconcileSession(ctx, v, { halt: true });
  const inRem = v.assets.filter((a) => a.inRemoval);
  if (inRem.length === 0) { log('no asset is in removal — nothing to finalize'); return; }
  let blocked = 0;
  for (const a of inRem) {
    const sym = plan.removes.find((r) => r.address === a.address)?.symbol ?? a.onchainSymbol;
    if (a.balance !== 0n) {
      const value = a.balance * a.refPrice;
      if (value < minTradeValue(plan)) {
        // K-4: what the auctions stage could not drain in five tries, or a
        // remnant that arrived since — PENDING, not a failure.
        const prev = plan.finalizePending?.find((x) => x.address === a.address);
        recordPending(ctx, { symbol: sym, address: a.address, balance: a.balance.toString(), valueUsd: usd(value), attempts: prev?.attempts ?? 0, lastTx: prev?.lastTx ?? null, at: iso(v.block.timestamp), stage: 'finalize' });
        continue;
      }
      log(`  ${sym} ${a.address}: balance ${a.balance} (≈ $${usd(value)}) is not zero — cannot finalize; drain it with the auctions stage (it finalizes right after the drain)`);
      blocked++;
      continue;
    }
    await finalizeOne(ctx, a.address, sym, v.assetCount);
  }
  if (blocked) throw new Error(`${blocked} removal(s) not drained`);
}

// ================================================================== verify
export async function stageVerify(ctx) {
  const { plan, log } = ctx;
  const v = await vaultNow(ctx);
  // verify writes plan.verify in any mode; it records what the chain shows
  // an earlier run did (fills, finalized removals) the same way — and, as the
  // auctions stage does, HALTs (after recording) on an adopted fill that
  // breaks the fill policy: a verify that recorded it silently, dry run
  // included, would leave nothing for the auctions stage to HALT on.
  await reconcileSession(ctx, v, { write: true, halt: true });
  const fails = [];
  const check = (ok, msg) => { log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
  check(v.pendingRegistryChange === ZERO32, `no pending registry change (${v.pendingRegistryChange === ZERO32 ? 'none' : v.pendingRegistryChange})`);
  const bySym = await assetIndex(ctx, v);
  for (const a of plan.adds) {
    const on = a.address ? v.assets.find((x) => x.address === a.address) : null;
    check(!!on, `${a.symbol} is in the registry`);
    if (on) check(on.refPrice !== 0n, `${a.symbol} has a reference (${on.refPrice}, age ${Number(v.block.timestamp - on.refPriceUpdatedAt)} s)`);
    if (on) check(on.decimals === a.decimals, `${a.symbol} decimals ${on.decimals} == plan ${a.decimals}`);
  }
  for (const r of plan.removes) {
    const on = v.assets.find((x) => x.address === r.address);
    if (on) check(on.inRemoval, `${r.symbol} still held: inRemoval=${on.inRemoval}, balance ${on.balance} (finalize pending)`);
    else check(true, `${r.symbol} is out of the registry`);
  }
  const expectedCount = plan.registry.length + plan.adds.length - plan.finalize.length;
  check(v.assetCount === expectedCount, `assetCount ${v.assetCount} == ${expectedCount} (registry ${plan.registry.length} + adds ${plan.adds.length} − finalized ${plan.finalize.length})`);
  const order = v.assets.map((x) => bySym[Object.keys(bySym).find((s) => bySym[s].address === x.address)]?.symbol ?? x.address);
  log(`  registry order (assets(i), what the site's amount vector must follow): ${order.join(' ')}`);
  const stale = v.assets.filter((a) => v.block.timestamp - a.refPriceUpdatedAt > v.maxRefAge);
  log(`  ${stale.length} reference(s) older than maxRefAge ${v.maxRefAge} s${stale.length ? ' (fills would revert RefPriceStale until the daily mark; not a failure)' : ''}`);
  const res = residual(ctx, await liveRows(ctx, v));
  for (const r of res) {
    const book = plan.targets.find((t) => t.symbol === r.symbol)?.targetWeight;
    const line = `${r.symbol.padEnd(7)} weight ${pct(r.weight).padStart(7)} trade target ${pct(r.targetWeight).padStart(7)} (book ${book != null ? pct(book) : '—'}) drift ${(r.drift * 100).toFixed(4)} pt (bound ${(r.bound * 100).toFixed(4)} pt)`;
    if (!r.ok && r.pending) log(`  PEND ${line} — PENDING: in removal, remnant under $1, finalize waiting (not a failure)`);
    else check(r.ok, line);
  }
  for (const p of plan.finalizePending ?? []) log(`  PENDING ${p.symbol} ${p.address}: ${p.balance} base units (≈ $${p.valueUsd}) after ${p.attempts} re-drain(s), since ${p.at}`);
  // A redeem simulation from the owner (the genesis holder): the payout must
  // have one slice per registry asset. Reads no price, so it works in any state.
  const ownerShares = await readNow(ctx, 'owner shares', { address: plan.vault, abi: VAULT_ABI, functionName: 'balanceOf', args: [v.owner] });
  if (ownerShares >= 10n ** 18n) {
    try {
      const { result } = await simulate(ctx, { address: plan.vault, abi: VAULT_ABI, functionName: 'redeem', args: [10n ** 18n, v.owner], account: v.owner });
      check(result.length === v.assetCount, `redeem(1 share) simulated from ${v.owner}: ${result.length} amounts, ${result.filter((x) => x > 0n).length} nonzero`);
    } catch (e) {
      check(false, `redeem simulation reverted: ${fmtErr(e)}`);
    }
  } else log(`  (owner holds ${ownerShares} share-wei — redeem simulation skipped)`);
  plan.verify = { at: new Date().toISOString(), block: v.block.number.toString(), assetCount: v.assetCount, order: v.assets.map((x) => x.address), fails, pending: res.filter((r) => !r.ok && r.pending).map((r) => r.symbol), weights: res.map((r) => ({ symbol: r.symbol, weight: r.weight, targetWeight: r.targetWeight })) };
  savePlan(ctx.planFile, plan);
  if (fails.length) throw new Error(`verify: ${fails.length} check(s) failed`);
  log(`verify: all checks passed${plan.verify.pending.length ? ` (PENDING: ${plan.verify.pending.join(', ')})` : ''}`);
}

// ---------------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const ctx = await makeCtx(o);
  // A re-run first settles what an earlier run sent (plan.sent) and reads
  // at or after the blocks it recorded; a live run then refuses while a
  // signer still has a transaction in flight.
  await settleSent(ctx);
  if (ctx.live) await requireNothingPending(ctx);
  const run = async (stage, fn) => { ctx.o.stage = stage; ctx.log(`— ${stage} —`); await fn(ctx); };
  switch (o.stage) {
    case 'announce': return stageAnnounce(ctx);
    case 'execute': return stageExecute(ctx);
    case 'first-prices': return stageFirstPrices(ctx);
    case 'auctions': return stageAuctions(ctx);
    case 'finalize': return stageFinalize(ctx);
    case 'verify': return stageVerify(ctx);
    case 'day7':
      // first-prices and auctions refuse a plan not generated today; check it
      // BEFORE execute is sent, or a stale plan executes and then stops.
      requirePlanFresh(ctx);
      // Read through readAt: a re-run whose plan records sent transactions
      // reads at a block ≥ the last of them (settleSent raised ctx.floor).
      await requireSizingBeforeExecute(ctx);
      await run('execute', stageExecute);
      await run('first-prices', stageFirstPrices);
      await run('auctions', stageAuctions);
      await run('finalize', stageFinalize);
      await run('verify', stageVerify);
      return;
    default: throw new Error(`unknown stage ${o.stage}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    if (e instanceof Refused) {
      console.error(`REFUSED: ${e.message}`);
      process.exit(1);
    }
    console.error(e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
}
