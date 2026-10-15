/**
 * Basket reconstitution executor — runs one plan (keeper/basket-plan.mjs)
 * against a QuadrixBasketVault, one stage at a time.
 *
 *   announce      owner: announceRegistryChange(adds, removes, decisionSha256),
 *                 or (adds, addRefPrices, removes, decisionSha256) on a
 *                 priced-adds vault
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
 * Two vault shapes (basket-plan.mjs ANNOUNCE_ABI): the shape is read from
 * the vault's code at start and must equal the plan's vaultAbi. On an
 * unpriced-adds vault (the baskets deployed before the hardening of
 * 2026-10-01) an add enters unpriced and first-prices makes its band-free
 * first post. On a priced-adds vault the announcement commits each add's
 * first reference (the plan's addRefPrices), so the two-source gate runs at
 * announce — which also requires a plan made today and adds and removes in
 * ascending address order — and first-prices posts today's price as an
 * ordinary in-band post (±15% of the committed one; refused outside it,
 * checked by day7 before execute); until that post the add's reference has
 * never been refreshed, and the auctions stage refuses to start.
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
 * Other bidders (decided 2026-10-13): once bidding is open, anyone
 * may fill our auctions. Both references are therefore re-posted (same
 * value) right before an auction that waits for its fair point is opened,
 * as well as right before our fill, so the auction is fillable from its
 * first block. Before our fill the auction's sellRemaining is read with the
 * vault's balance at one block: the fill takes min(sellRemaining, live
 * balance); fills by others that it finds are recorded in plan.fills
 * (`external: true`, their bidder) before anything else; an auction they
 * took entirely is done (a drain then finalizes at once). A fill of ours
 * that loses the race (CapExceeded or AuctionClosed in the simulation, or a
 * mined revert while sellRemaining fell) re-reads and fills what is left.
 * A fill by another bidder anywhere on the contract's curve
 * [10,000 − maxFillLossBps, 10,000 + premium] is accepted — the fill policy
 * binds our own bidder only; a fill the contract could not have taken (a
 * factor off that curve, a time after the auction's end, a loss booked at or
 * above fair) HALTs as before, after it is recorded.
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
  detectVaultAbi, vaultAbiFor, byAddress, REF_BAND_BPS, MAX_REF_PRICE,
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
  // priced-adds: each add also costs a balanceOf call and a refPrice write.
  announcePriced: (adds, removes) => 150_000n + 80_000n * BigInt(adds) + 45_000n * BigInt(removes),
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
/** The contract error a revert decodes to (e.g. CapExceeded), or null. */
function revertName(e) {
  let cur = e;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.data?.errorName) return cur.data.errorName;
    if (cur.name === 'ContractFunctionRevertedError' && cur.reason) return cur.reason;
    cur = cur.cause;
  }
  return null;
}

function fmtErr(e) {
  const name = revertName(e);
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
  const ctx = { o, log, plan, planFile, reader, pc: reader.publicClient, devNode, keeperAddr, keeperWallet, bidderAddr, bidderWallet, live: o.live, hook, pendingThisRun: new Set(), floor: 0n, receipts: new Map(), events: null };
  log(`vault shape ${await vaultShape(ctx)} (read from the vault's code; the plan says ${plan.vaultAbi ?? 'nothing — made before the shape was recorded: unpriced-adds'})`);
  return ctx;
}

/**
 * The vault's announce shape (basket-plan.mjs ANNOUNCE_ABI), read once from
 * its code and kept on the context. A plan records the shape it was made for
 * (plan.vaultAbi; a plan without it predates the field and was made for an
 * unpriced-adds vault): a plan for the other shape is refused — its tuple,
 * its first prices and its stages assume the other contract.
 */
export async function vaultShape(ctx) {
  if (ctx.vaultAbi) return ctx.vaultAbi;
  let shape;
  try { shape = await detectVaultAbi(ctx.pc, ctx.plan.vault); } catch (e) { throw new Refused(e.message); }
  const planned = ctx.plan.vaultAbi ?? 'unpriced-adds';
  if (shape !== planned) throw new Refused(`the vault at ${ctx.plan.vault} is a ${shape} vault (read from its code) but the plan was made for ${planned}${ctx.plan.vaultAbi ? '' : ' (no vaultAbi in the plan: made before the shape was recorded)'} — regenerate the plan (keeper/basket-plan.mjs) against this vault`);
  ctx.vaultAbi = shape;
  return shape;
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
  const { value } = await retryRead(async () => {
    const blockNumber = await blockAtLeast(ctx.pc, ctx.floor);
    try {
      const out = await ctx.pc.simulateContract({ ...params, blockNumber });
      // A function without a return value: the public node (op-reth) answers
      // eth_call at a block it has not got with null — no error — and viem
      // reads null as that function's empty return, so the call would pass
      // without having run (measured 2026-10-02 and 2026-10-05). At the same
      // block eth_estimateGas errors "block not found" on such a node, reverts
      // when the call reverts, and answers a number only when the call ran.
      if (out.result === undefined) await ctx.pc.estimateContractGas({ ...params, blockNumber });
      return out;
    } catch (e) {
      // The block a revert was seen at: runTrade reads the auction there
      // when a fill is refused (lostRace).
      if (e && typeof e === 'object') e.atBlock = blockNumber;
      throw e;
    }
  }, {
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
  if (receipt.status !== 'success') {
    const err = new Error(`${label} reverted on chain (tx ${entry.hash}, block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})`);
    err.reverted = true; // a fill that lost the race to another bidder is told apart by runTrade
    throw err;
  }
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
      const refused = new Refused(`${what}: ${shown} would revert as ${from} — ${fmtErr(e)}`);
      refused.revert = revertName(e); // runTrade tells a fill that lost the race (CapExceeded, AuctionClosed) apart
      refused.atBlock = e?.atBlock ?? null; // and reads the auction at the block the simulation ran at
      throw refused;
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
  return {
    adds: t.adds.map((a) => getAddress(a)), removes: t.removes.map((a) => getAddress(a)), sha: t.decisionSha256,
    // priced-adds only: the first reference each add is announced with.
    prices: Array.isArray(t.addRefPrices) ? t.addRefPrices.map((x) => big(x)) : null,
  };
}

/**
 * priced-adds: what the contract would refuse in a tuple — a price list that
 * is not one positive price ≤ MAX_REF_PRICE per add, adds or removes not in
 * strictly ascending address order (NotAscending) — and an add whose price is
 * not the plan's firstRefPrice for it, or that is not one of the plan's adds
 * at all. Pure; [] when the tuple is fine.
 */
export function pricedTupleProblems(t, adds) {
  const out = [];
  if (!t.prices) return ['no addRefPrices in the tuple — the plan was made for an unpriced-adds vault; regenerate it'];
  if (t.prices.length !== t.adds.length) out.push(`${t.prices.length} addRefPrices for ${t.adds.length} adds (LengthMismatch)`);
  const ascending = (xs) => xs.every((x, i) => i === 0 || byAddress(xs[i - 1], x) < 0);
  if (!ascending(t.adds)) out.push('adds not in strictly ascending address order (NotAscending)');
  if (!ascending(t.removes)) out.push('removes not in strictly ascending address order (NotAscending)');
  t.adds.forEach((a, i) => {
    const p = t.prices[i];
    if (p == null) return;
    const add = adds.find((x) => x.address && getAddress(x.address) === a);
    const sym = add?.symbol ?? a;
    if (!add) out.push(`${a}: not one of the plan's adds — no first reference to check the price against`);
    if (!(p > 0n) || p > MAX_REF_PRICE) out.push(`${sym}: addRefPrice ${p} outside (0, 1e30] (PriceOutOfRange)`);
    if (add && big(add.firstRefPrice) !== p) out.push(`${sym}: addRefPrice ${p} != the plan's firstRefPrice ${add.firstRefPrice}`);
  });
  return out;
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
  // What first-prices and the auctions stage would refuse once execute has
  // run, read now (post-review 2026-10-05, A2 N1): the roles, a name without
  // a reference, each add's first-price gate.
  await requireStagesWouldStart(ctx, v);
  // The auctions stage refuses a reference more than --ref-drift-tol from the
  // day's market price. Found only there, the change is already executed and
  // the first references posted, the session has not started, and a plan made
  // after that no longer sees the adds. So the same check is made here, while
  // the change is still pending and nothing has been sent.
  await requireRefsNearMarket(ctx, v, 'nothing was sent and the registry change is still pending: wait for the next daily mark, make the plan again, then run day7');
  requireRefsAsPlanned(ctx, v);
  ctx.log(`before execute: signer is the keeper, bidder ${ctx.bidderAddr} may fill, every registry name priced, ${ctx.plan.adds.length} first price(s) pass the two-source gate, every reference within ${pct(ctx.o.refDriftTol)} of the day's market price${ctx.plan.trades.length ? ' and equal to the one the plan sized at' : ''}`);
}

/**
 * day7, while the change is still pending: everything first-prices and the
 * auctions stage would refuse that can be known before execute — the
 * signer's roles, a name already in the registry without a reference (the
 * auctions stage's "unpriced"), and for each add: in the announced tuple
 * (first-prices' "not in the registry"), then the first-price gate with the
 * decimals read from the mock. After execute a refusal there leaves the
 * registry changed with unpriced or untraded names. Reads only; nothing here
 * is a new setting — the stages keep their own checks for a re-run.
 */
async function requireStagesWouldStart(ctx, v) {
  const { plan, o } = ctx;
  const stop = (m) => new Refused(`${m} — checked before execute: nothing was sent and the registry change is still pending`);
  if (ctx.keeperAddr !== v.keeper) throw stop(`setRefPrice/openAuction are keeper-only; keeper is ${v.keeper}, signer is ${ctx.keeperAddr}`);
  if (!v.biddingOpen) {
    const isB = await readNow(ctx, 'isBidder', { address: plan.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [ctx.bidderAddr] });
    if (!isB) throw stop(`bidder ${ctx.bidderAddr} is not whitelisted (isBidder false, biddingOpen false)`);
  }
  const unpriced = v.assets.filter((a) => a.refPrice === 0n);
  if (unpriced.length) throw stop(`unpriced registry assets ${unpriced.map((a) => a.address).join(', ')} — every fill reverts PriceUnset, and first-prices posts only the adds`);
  const t = tuple(plan);
  for (const add of plan.adds) {
    if (add.address && !t.adds.includes(getAddress(add.address))) throw stop(`${add.symbol} ${add.address} is not an add of the announced tuple — execute would not put it in the registry`);
  }
  const withAddress = plan.adds.filter((a) => a.address);
  const decs = await batchNow(ctx, 'decimals of the entering mocks', withAddress.map((a) => ({ address: a.address, abi: ERC20_ABI, functionName: 'decimals' })));
  for (const add of plan.adds) {
    const i = withAddress.indexOf(add);
    const why = firstPriceRefusal(add, i >= 0 ? Number(decs[i]) : null, o);
    if (why) throw stop(why);
  }
  // priced-adds: the first post after execute is banded against the price
  // committed at the announcement (readable on chain while pending).
  if (withAddress.length && (await vaultShape(ctx)) === 'priced-adds') {
    const committed = await batchNow(ctx, 'committed first references', withAddress.map((a) => ({ address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [a.address] })));
    withAddress.forEach((add, i) => {
      const why = committedPostRefusal(add, committed[i], committedRefOf(plan, add));
      if (why) throw stop(why);
    });
  }
}

/** References must be today's marks: this script never moves one. A chain
 *  reference more than --ref-drift-tol away from the plan's market price
 *  (planRefPrice; an add's first reference) refuses the session. */
async function requireRefsNearMarket(ctx, v, then = 're-mark with the daily keeper (paper-index.mjs) first; this script does not move references') {
  const { plan, o } = ctx;
  const bySym = await assetIndex(ctx, v);
  for (const [sym, a] of Object.entries(bySym)) {
    const planRef = plan.registry.find((r) => r.symbol === sym)?.planRefPrice ?? plan.adds.find((r) => r.symbol === sym)?.firstRefPrice;
    if (planRef == null) continue;
    const d = Math.abs(Number(a.refPrice) - Number(planRef)) / Number(planRef);
    if (d > o.refDriftTol) throw new Refused(`${sym}: chain reference ${a.refPrice} is ${pct(d)} from the plan's ${planRef} (> ${pct(o.refDriftTol)}) — ${then}`);
  }
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
  const { plan, log, o } = ctx;
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

  const shape = await vaultShape(ctx);
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
  if (shape === 'priced-adds') {
    // The announcement commits each add's first reference: the gate the
    // first-prices stage applies on an unpriced-adds vault applies here, to
    // today's plan.
    const problems2 = pricedTupleProblems(t, plan.adds);
    if (problems2.length) throw new Refused(`${problems2.join('; ')} — refused before anything is sent`);
    if (!(plan.date === todayUTC() || o.allowPlanDate)) throw new Refused(`plan ${plan.date} was not generated today (${todayUTC()}) — on this vault the announcement commits each add's first reference from the plan's two sources; regenerate the plan with the decision today (or pass --allow-plan-date for a rehearsal)`);
    t.adds.forEach((a, i) => {
      const add = plan.adds.find((x) => x.address && getAddress(x.address) === a);
      const why = firstPriceRefusal(add, Number(reads[i * 3 + 1]), o);
      if (why) throw new Refused(`${why} — on this vault the first reference is committed at the announcement`);
    });
    log(`priced-adds: committing first references ${t.adds.map((a, i) => `${plan.adds.find((x) => x.address && getAddress(x.address) === a).symbol} ${t.prices[i]}`).join(', ')} (each = the plan's firstRefPrice, two sources within ${pct(o.firstPriceTol)}); adds and removes in ascending address order`);
  }
  log(`tuple keccak ${expectedHash}; eta would be now + ${Number(v.registryDelay) / 86400} days`);
  const args = shape === 'priced-adds' ? [t.adds, t.prices, t.removes, t.sha] : [t.adds, t.removes, t.sha];
  const gas = shape === 'priced-adds' ? GAS.announcePriced(t.adds.length, t.removes.length) : GAS.announce(t.adds.length + t.removes.length);
  const r = await call(ctx, { who: 'keeper', to: plan.vault, abi: vaultAbiFor(shape), functionName: 'announceRegistryChange', args, gas, what: 'announce' });
  if (r.dry) return;
  // Recorded from the receipt alone: the RegistryChangeAnnounced event
  // carries the tuple (whose keccak IS pendingRegistryChange) and the eta;
  // the announce block's time is eta − REGISTRY_DELAY by construction.
  const ev = eventsIn(r.receipt, VAULT_ABI, 'RegistryChangeAnnounced', plan.vault)[0]?.args;
  const pendingHash = ev ? tupleHashOf(ev) : expectedHash;
  const eta = ev ? ev.eta : null;
  // priced-adds: the committed prices as the event carries them.
  const tRec = ev?.addRefPrices ? { ...t, prices: [...ev.addRefPrices] } : t;
  plan.announce = announceRecord({ txHash: r.hash, block: r.receipt.blockNumber, at: r.blockTimestamp ?? (eta != null ? eta - v.registryDelay : null), eta, pendingHash, t: tRec, entry, signer: ctx.keeperAddr });
  plan.announceTuple = plan.announce.tuple;
  savePlan(ctx.planFile, plan);
  log(`announced; recorded in the plan from the receipt (pending ${pendingHash}, eta ${eta != null ? iso(eta) : 'not in the receipt'})`);
  // Then the check, at the receipt's block (exact).
  const [pending, etaOnChain, ...committed] = await batchNow(ctx, 'pending change after announce', [
    { address: plan.vault, abi: VAULT_ABI, functionName: 'pendingRegistryChange' },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'pendingRegistryEta' },
    ...(shape === 'priced-adds' ? t.adds.map((a) => ({ address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [a] })) : []),
  ], r.receipt.blockNumber);
  if (eta == null) {
    plan.announce = announceRecord({ ...plan.announce, block: r.receipt.blockNumber, at: r.blockTimestamp ?? etaOnChain - v.registryDelay, eta: etaOnChain, pendingHash: pending, t, entry, signer: ctx.keeperAddr, txHash: r.hash });
    plan.announceTuple = plan.announce.tuple;
    savePlan(ctx.planFile, plan);
  }
  if (pending.toLowerCase() !== expectedHash.toLowerCase()) throw new Error(`announced hash ${pending} != expected ${expectedHash} (block ${r.receipt.blockNumber})`);
  if (etaOnChain !== BigInt(plan.announce.eta)) throw new Error(`pendingRegistryEta ${etaOnChain} at block ${r.receipt.blockNumber} != the event's ${plan.announce.eta}`);
  committed.forEach((c, i) => { if (c !== t.prices[i]) throw new Error(`refPrice(${t.adds[i]}) reads ${c} at block ${r.receipt.blockNumber}, the announcement committed ${t.prices[i]}`); });
  log(`announced; execute on or after ${iso(etaOnChain)}; plan updated`);
}

/** The plan.announce record — the fields basket-plan.mjs carries to day 7
 *  (pendingHash, tuple) and gen-recon-decision.mjs prints (txHash, at). */
function announceRecord({ txHash, block, at, eta, pendingHash, t, entry, signer, adopted = false, note = null }) {
  return {
    txHash, block, at: at == null ? null : (typeof at === 'string' ? at : iso(at)),
    eta: eta == null ? null : eta.toString(), etaIso: eta == null ? null : iso(eta), pendingHash,
    tuple: { adds: t.adds, ...(t.prices ? { addRefPrices: t.prices } : {}), removes: t.removes, decisionSha256: t.sha }, decisionId: entry.id, signer,
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
async function adoptAnnounce(ctx, { t: t0, v, entry, expectedHash }) {
  let t = t0;
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
  // priced-adds: the prices the chain committed (the pending hash does not
  // cover them), read from refPrice(add) — the committed price while the
  // change is pending — whether or not the announce log was found. A price
  // that is not the plan's own is recorded as the chain has it, with a note.
  let priceNote = null;
  if ((await vaultShape(ctx)) === 'priced-adds') {
    const committed = await batchNow(ctx, 'committed first references', t.adds.map((a) => ({ address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [a] })));
    const differ = t.adds.map((a, i) => (committed[i] === t0.prices?.[i] ? null : `${plan.adds.find((x) => x.address && getAddress(x.address) === a)?.symbol ?? a} ${committed[i]} (the plan's ${t0.prices?.[i] ?? 'none'})`)).filter(Boolean);
    if (differ.length) priceNote = `committed first references on chain that are not this plan's: ${differ.join(', ')} — an announcement this plan did not make; the chain's are recorded`;
    t = { ...t, prices: committed };
  }
  let signer = v.owner; // announceRegistryChange is onlyOwner
  if (txHash) {
    const tx = await retryRead(() => ctx.pc.getTransaction({ hash: txHash }), { what: `tx ${txHash}` }).then((x) => x.value).catch(() => null);
    if (tx?.from) signer = getAddress(tx.from);
  }
  const at = v.pendingRegistryEta - v.registryDelay;
  const found = (txHash ? `tx ${txHash} (block ${block}, from ${how})` : `the announce tx was not found since the plan's block ${ctx.plan.block?.number ?? '—'}`) + (priceNote ? `; ${priceNote}` : '');
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
  log(`executed; ${after.assetCount} assets; ${(await vaultShape(ctx)) === 'priced-adds' ? 'the adds hold the references committed at the announcement and have never been posted (fills on them revert RefPriceStale) until first-prices runs' : 'every fill on this vault is closed until first-prices runs (portfolioValueAtRef reverts PriceUnset)'}`);
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

/** Why the plan's first price of `add` may not be posted (the gate of the
 *  first-prices stage: decimals, two sources, the sized price), or null. */
export function firstPriceRefusal(add, onchainDecimals, o) {
  if (!add.address) return `${add.symbol}: no mock address in the plan`;
  if (onchainDecimals !== add.decimals) return `${add.symbol}: ${onchainDecimals} decimals on chain, plan says ${add.decimals}`;
  if (!(add.priceB > 0)) return `${add.symbol}: no second-source price — a first reference needs two independent sources`;
  const diff = Math.abs(add.priceA - add.priceB) / add.priceA;
  if (diff > o.firstPriceTol) return `${add.symbol}: sources disagree by ${pct(diff)} (A ${add.priceA}, B ${add.priceB}) > ${pct(o.firstPriceTol)}`;
  const target = toRefPrice(add.priceA, add.decimals);
  if (target !== big(add.firstRefPrice)) return `${add.symbol}: plan firstRefPrice ${add.firstRefPrice} != toRefPrice(${add.priceA}, ${add.decimals}) = ${target}`;
  return null;
}

/** priced-adds: the first reference the announcement committed for `add`, as
 *  the plan records it (the announced tuple, else adds[].committedRefPrice
 *  read by the planner), or null. */
export function committedRefOf(plan, add) {
  const t = plan.announce?.tuple ?? plan.announceTuple;
  if (t?.addRefPrices && add.address) {
    const k = t.adds.findIndex((a) => String(a).toLowerCase() === String(add.address).toLowerCase());
    if (k >= 0 && t.addRefPrices[k] != null) return big(t.addRefPrices[k]);
  }
  return add.committedRefPrice != null ? big(add.committedRefPrice) : null;
}

/**
 * priced-adds: why the first post of `add` after execute cannot be made —
 * `onChain` is the add's reference on chain before that post (the committed
 * one), `committed` what the plan recorded the announcement committing — or
 * null. The post is today's toRefPrice(priceA) and the contract bands it
 * against the reference on chain (REF_BAND_BPS), so outside the band it
 * reverts with the registry already changed. `executed`: asked after
 * execute (first-prices), when the add is a registry asset and a new
 * announcement can no longer carry it. Pure.
 */
export function committedPostRefusal(add, onChain, committed, { executed = false } = {}) {
  if (!(onChain > 0n)) return `${add.symbol}: no committed first reference on chain (refPrice ${onChain})`;
  if (committed != null && onChain !== committed) return `${add.symbol}: reference on chain ${onChain} is not the ${committed} the announcement committed (as the plan records it) — regenerate the plan`;
  const target = toRefPrice(add.priceA, add.decimals);
  const span = (onChain * REF_BAND_BPS) / 10_000n;
  if (target > onChain + span || target < onChain - span) return `${add.symbol}: today's first reference ${target} is ${pct(Math.abs(Number(target - onChain)) / Number(onChain))} from the ${onChain} committed at the announcement, outside the contract's ±${Number(REF_BAND_BPS) / 100}% band — ${executed ? 'the post would revert NavMoveTooLarge; a new announcement cannot change the price of a registry asset (AlreadyRegistryAsset), so the daily mark steps the reference in band' : 'the post after execute would revert NavMoveTooLarge; only a new announcement (7 more days) changes a committed price'}`;
  return null;
}

export async function stageFirstPrices(ctx) {
  const { plan, log, o } = ctx;
  requirePlanFresh(ctx);
  const v = await vaultNow(ctx);
  if (v.pendingRegistryChange !== ZERO32) throw new Refused('a registry change is still pending — execute first');
  if (ctx.keeperAddr !== v.keeper) throw new Refused(`setRefPrice is keeper-only; keeper is ${v.keeper}, signer is ${ctx.keeperAddr}`);
  if (plan.adds.length === 0) { log('no adds in the plan — nothing to post'); return; }
  const shape = await vaultShape(ctx);
  const bandBps = REF_BAND_BPS;
  for (const add of plan.adds) {
    if (!add.address) throw new Refused(`${add.symbol}: no mock address in the plan`);
    const on = v.assets.find((x) => x.address === add.address);
    if (!on) throw new Refused(`${add.symbol} ${add.address} is not in the registry — execute first`);
    const why = firstPriceRefusal(add, on.decimals, o);
    if (why) throw new Refused(why);
    const target = toRefPrice(add.priceA, add.decimals);
    // priced-adds: an add that entered at its committed price and has not
    // been posted since (refPriceUpdatedAt 0) is posted even when today's
    // price equals the committed one — the post is what makes it fresh.
    const committedOnly = shape === 'priced-adds' && on.refPriceUpdatedAt === 0n;
    if (committedOnly) {
      const why2 = committedPostRefusal(add, on.refPrice, committedRefOf(plan, add), { executed: true });
      if (why2) throw new Refused(why2);
      log(`  ${add.symbol}: entered at the reference committed at the announcement (${on.refPrice}); ${target} is inside the band — posting`);
    } else if (on.refPrice === target) {
      if (!plan.firstPrices.some((f) => getAddress(f.address) === getAddress(add.address))) { await adoptFirstPrice(ctx, add, target, on); continue; }
      log(`  ${add.symbol}: reference already ${target} — skipped`);
      continue;
    } else if (on.refPrice !== 0n) {
      const span = (on.refPrice * bandBps) / 10_000n;
      if (target > on.refPrice + span || target < on.refPrice - span) throw new Refused(`${add.symbol}: reference is already set (${on.refPrice}) and ${target} is outside the ±15% band — the daily mark steps references, this stage does not`);
      log(`  ${add.symbol}: reference already set (${on.refPrice}); ${target} is inside the band — posting`);
    }
    log(`  ${add.symbol}: first post ${target} = $${add.priceA} at ${add.decimals} dec (B $${add.priceB}, ${add.disagreementBps} bp apart); ${on.refPrice === 0n ? 'BAND-FREE first post' : committedOnly ? 'in-band of the committed reference' : 'in-band post'}`);
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

// ------------------------------------------- fills by other bidders (2026-10-13)
/** A fill of ours that loses the race to another bidder is retried after a
 *  fresh read of the auction at most this many times in a row. */
export const MAX_FILL_RACES = 3;
const FILLED_EVENT = VAULT_ABI.find((x) => x.type === 'event' && x.name === 'AuctionFilled');
const byBlockLog = (a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

/** The contract's curve at `elapsed` seconds of a `duration`-second auction
 *  (curveFactorBps). Past the duration the contract reverts AuctionExpired;
 *  the value here then falls below the curve's floor. */
export function curveFactorAt(v, elapsed, duration) {
  const premium = Number(v.premiumBps);
  return 10_000 + premium - Math.floor(((premium + Number(v.maxFillLossBps)) * elapsed) / Number(duration));
}

/** Our bidders: this run's bidder and keeper, the vault's keeper and owner,
 *  the sender of every fill in the plan's `sent` list, and the bidder of
 *  every fill our runs made. Any other address that fills is external. */
export function ourBidders(ctx, v) {
  const s = new Set();
  for (const a of [ctx.bidderAddr, ctx.keeperAddr, v?.keeper, v?.owner]) if (a) s.add(getAddress(a));
  for (const e of ctx.plan.sent ?? []) if (/^fill /.test(e.what ?? '') && e.from) s.add(getAddress(e.from));
  for (const f of ctx.plan.fills ?? []) if (f.bidder && (f.external === false || (f.external == null && !f.adopted))) s.add(getAddress(f.bidder));
  return s;
}

/** Is an AuctionFilled log already in plan.fills? By transaction and log
 *  index; a record made before log indexes were kept, by transaction and
 *  auction id (one fill of ours per transaction). */
function recordedFillMatcher(plan) {
  const exact = new Set();
  const legacy = new Set();
  for (const f of plan.fills ?? []) {
    if (!f.fillTx) continue;
    const tx = String(f.fillTx).toLowerCase();
    if (f.logIndex != null) exact.add(`${tx}:${f.logIndex}`);
    else legacy.add(`${tx}#${f.auctionId}`);
  }
  return (e) => exact.has(`${e.transactionHash.toLowerCase()}:${e.logIndex}`) || legacy.has(`${e.transactionHash.toLowerCase()}#${e.args.id}`);
}

/** The plan.fills record of an AuctionFilled log read from the chain, with
 *  the factor recomputed from the auction's start and the fill block's time. */
async function fillRecordFromLog(ctx, v, e, { seq, round, sell, buy, startTime, duration, openTx, ours, extra = {} }) {
  const blk = (await retryRead(() => ctx.pc.getBlock({ blockNumber: e.blockNumber }), { what: `block ${e.blockNumber}` })).value;
  const elapsed = Number(blk.timestamp - BigInt(startTime));
  const bidder = getAddress(e.args.bidder);
  const external = !ours.has(bidder);
  return {
    seq, round, auctionId: e.args.id.toString(), sell, buy,
    sellTaken: e.args.sellTaken.toString(), buyPaid: e.args.buyPaid.toString(), lossAtRef: e.args.lossAtRef.toString(),
    factorBps: curveFactorAt(v, elapsed, duration), elapsed, policy: external ? 'external' : 'adopted', bidder, external,
    openTx, fillTx: e.transactionHash, logIndex: e.logIndex, at: iso(blk.timestamp), adopted: true, ...extra,
  };
}

/**
 * Why a fill recorded from the chain stops the session, or null.
 *   External (not our bidder): only a factor off the contract's curve
 *   [10,000 − maxFillLossBps, 10,000 + premium], or a loss booked at or
 *   above fair — values the contract cannot produce. A below-fair fill on
 *   the curve is the contract working as designed (bounded per fill by the
 *   floor and per day by dailyLossBudgetBps).
 *   Ours: the fill policy, as for a fill made now — lossAtRef 0 unless
 *   --fill natural; a planned fill inside the fair window under --fill fair.
 */
export function fillHalt(rec, { v, o, planned, duration = null }) {
  const f = rec.factorBps;
  if (rec.external) {
    const lo = 10_000 - Number(v.maxFillLossBps);
    const hi = 10_000 + Number(v.premiumBps);
    if (f == null || f < lo || f > hi) return `HALT: external fill ${rec.fillTx} by ${rec.bidder} (auction ${rec.auctionId}) at factor ${f ?? 'unknown'}, off the contract's curve [${lo}, ${hi}] — the contract could not have taken it; check the auction and this fill by hand before re-running`;
    // The curve's integer step lets a few seconds past the end still compute
    // to the floor; the contract reverts AuctionExpired there.
    if (rec.elapsed < 0 || (duration != null && rec.elapsed > Number(duration))) return `HALT: external fill ${rec.fillTx} by ${rec.bidder} (auction ${rec.auctionId}) at ${rec.elapsed} s of a ${duration} s auction, off the contract's curve — the contract could not have taken it; check the auction and this fill by hand before re-running`;
    if (f >= 10_000 && big(rec.lossAtRef) !== 0n) return `HALT: external fill ${rec.fillTx} by ${rec.bidder} (auction ${rec.auctionId}) booked lossAtRef ${rec.lossAtRef} at factor ${f} — at or above fair the contract books no loss`;
    return null;
  }
  if (o.fill === 'natural') return null;
  if (big(rec.lossAtRef) !== 0n) return `HALT: adopted fill ${rec.fillTx} booked lossAtRef ${rec.lossAtRef} under the ${o.fill} policy`;
  if (planned && o.fill === 'fair' && (f < 10_000 || f > 10_000 + o.fairWindowBps)) return `HALT: adopted fill ${rec.fillTx} landed at factor ${f}, outside [10000, ${10_000 + o.fairWindowBps}]`;
  return null;
}

/** The auction's sellRemaining and open flag and the vault's balance of
 *  `sell`, read at one named block (returned with them). */
async function auctionState(ctx, id, sell, sym) {
  const { value: block } = await retryRead(() => blockAtLeast(ctx.pc, ctx.floor), { what: 'block number' });
  const [a, liveBal] = await Promise.all([
    readNow(ctx, `auction ${id}`, { address: ctx.plan.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] }, block),
    readNow(ctx, `${sym} in the vault`, { address: sell, abi: ERC20_ABI, functionName: 'balanceOf', args: [ctx.plan.vault] }, block),
  ]);
  return { remaining: a[2], open: a[5], liveBal, block };
}

/** Every AuctionFilled log of auction `id` in [fromBlock, toBlock], read
 *  again (within READ_WAIT_MS) until their sellTaken add up to `taken` —
 *  what the auction's sellRemaining at toBlock says was taken: a node that
 *  answers a log search short cannot hide a fill. */
async function auctionFills(ctx, id, fromBlock, toBlock, taken) {
  const { value, reads } = await retryRead(async () => {
    const out = [];
    for (let lo = BigInt(fromBlock); lo <= toBlock; lo += 10_000n) {
      const hi = lo + 9_999n < toBlock ? lo + 9_999n : toBlock;
      const logs = await ctx.pc.getLogs({ address: ctx.plan.vault, event: FILLED_EVENT, args: { id }, fromBlock: lo, toBlock: hi });
      out.push(...logs.filter((l) => l.args?.id === id));
    }
    const sum = out.reduce((s, l) => s + l.args.sellTaken, 0n);
    if (sum !== taken) throw new Error(`the AuctionFilled logs of auction ${id} in blocks ${fromBlock}–${toBlock} add up to ${sum} taken, its sellRemaining says ${taken}`);
    return out.sort(byBlockLog);
  }, { what: `fills of auction ${id} up to block ${toBlock}` });
  if (reads > 1) ctx.log(`  (fills of auction ${id}: complete at read ${reads})`);
  return value;
}

/**
 * Fills of this trade's auction that are not in plan.fills — by another
 * bidder, between our open and our fill — recorded as fills of trade
 * `t.seq` (`adopted: true`, `external` by bidder) and saved before anything
 * else; then held to fillHalt. Returns { recs, halts }: the caller cancels
 * an auction that is still open before it throws the HALTs (runTrade).
 */
async function adoptAuctionFills(ctx, v, { t, round, id, startTime, opened, toBlock, taken }) {
  const { plan, log } = ctx;
  const logs = await auctionFills(ctx, id, opened.receipt.blockNumber, toBlock, taken);
  const isRecorded = recordedFillMatcher(plan);
  const ours = ourBidders(ctx, v);
  const recs = [];
  const halts = [];
  for (const e of logs) {
    if (isRecorded(e)) continue;
    const rec = await fillRecordFromLog(ctx, v, e, {
      seq: t.seq, round, sell: t.sell, buy: t.buy, startTime, duration: t.duration, openTx: opened.hash, ours,
      extra: t.residual ? { residualOf: t.parentSeq ?? null } : {},
    });
    plan.fills.push(rec);
    savePlan(ctx.planFile, plan);
    recs.push(rec);
    log(`  ${rec.external ? `external bidder ${rec.bidder}` : `bidder ${rec.bidder} (ours, another run)`} filled auction ${id}: took ${rec.sellTaken} ${t.sell}, paid ${rec.buyPaid} ${t.buy}, factor ${rec.factorBps} bp (${rec.elapsed} s in), lossAtRef ${rec.lossAtRef} — recorded`);
    const h = fillHalt(rec, { v, o: ctx.o, planned: round === 1 && typeof t.seq === 'number', duration: t.duration });
    if (h) halts.push(h);
  }
  return { recs, halts };
}

/** Did our fill fail because another bidder filled first? A simulation
 *  refused CapExceeded or AuctionClosed, or a mined revert — and the auction,
 *  read again, has less left than our fill was sized at, or is closed. Any
 *  other failure is not a race and is thrown as before. The auction is read
 *  at a block ≥ the one the failure was seen at: a refused simulation's own
 *  block (a node at a block ≥ ctx.floor can be older than it and show the
 *  remainder from before the other fill), a mined revert's receipt block
 *  (ctx.floor). */
async function lostRace(ctx, e, id, remainingBefore) {
  const racy = (e instanceof Refused && (e.revert === 'CapExceeded' || e.revert === 'AuctionClosed')) || e?.reverted === true;
  if (!racy) return false;
  const seenAt = e.atBlock != null && e.atBlock > ctx.floor ? e.atBlock : ctx.floor;
  const { value: block } = await retryRead(() => blockAtLeast(ctx.pc, seenAt), { what: 'block number' });
  const a = await readNow(ctx, `auction ${id} after the fill failed`, { address: ctx.plan.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] }, block);
  return a[2] < remainingBefore || !a[5];
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
  const win = fairWindow(t.duration, Number(v.premiumBps), Number(v.maxFillLossBps), o.fairWindowBps);
  const aimElapsed = policy === 'fair' ? win.aim : 0;
  // Inventory for the worst case (+2% at the open), then the auction itself —
  // opened right after both references are re-posted.
  const buyWorst = (amount * pSell * (10_000n + v.premiumBps) + pBuy * 10_000n - 1n) / (pBuy * 10_000n);
  await ensureInventory(ctx, buy, t.buy, buyWorst);
  // Decided 2026-10-13: an auction that waits for its fair point
  // opens with both references just re-posted, so another bidder can fill it
  // from its first block until maxRefAge — not only in the seconds after our
  // pre-fill re-posts. Same value, same guard as those (this script never
  // moves a reference). An auction filled at once (--fill open / natural, a
  // remnant) has its pre-fill re-posts right after the open already.
  if (repost && aimElapsed > 0) {
    await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} at the open (same value)` });
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} at the open (same value)` });
  }

  const opened = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'openAuction', args: [sell, buy, amount, BigInt(t.duration)], gas: GAS.openAuction, what: `open auction #${t.seq}` });
  if (opened.dry) {
    // A dry run sends nothing: the id the open would get is auctionCount now.
    const id = await readNow(ctx, 'auctionCount', { address: plan.vault, abi: VAULT_ABI, functionName: 'auctionCount' });
    log(`  would wait ${aimElapsed} s to the ${policy === 'fair' ? `fair window [${win.eMin}, ${win.eMax}] s` : 'open'}, re-read and re-post both references at their current values, read auction ${id}'s sellRemaining (recording any other bidder's fill), then fill(${id}, min(sellRemaining, live balance)) as bidder ${ctx.bidderAddr}${t.drain ? `; then read ${t.sell}'s balance: zero → finalizeRemoval at once, else re-drain at once (≤ ${MAX_DRAIN_ATTEMPTS}×), else left waiting (finalizePending)` : ''}`);
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

  // What other bidders took of this auction (decided 2026-10-13):
  // the sellRemaining this run has accounted for, and the last fill of theirs.
  let remainingSeen = amount;
  let lastOther = null;
  const adoptOnly = async (st) => {
    if (st.remaining >= remainingSeen) return [];
    const { recs, halts } = await adoptAuctionFills(ctx, v, { t, round, id, startTime, opened, toBlock: st.block, taken: amount - st.remaining });
    if (recs.length) lastOther = recs.at(-1);
    remainingSeen = st.remaining;
    return halts;
  };
  // Records the fills of others up to st.block. A HALT is thrown after they
  // are recorded and after the auction, if still open, is cancelled: other
  // bidders would otherwise go on filling it while the run is stopped.
  const adoptTo = async (st) => {
    const halts = await adoptOnly(st);
    if (!halts.length) return;
    if (st.open) {
      let cancelled = false;
      try {
        await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id} before the HALT` });
        cancelled = true;
        halts.push(...(await adoptOnly(await auctionState(ctx, id, sell, t.sell))));
      } catch (e) {
        halts.push(cancelled
          ? `auction ${id} is cancelled, but the fills before the cancel could not be read again (${fmtErr(e)}) — a re-run records them`
          : `auction ${id} could not be cancelled before this stop (${fmtErr(e)}) — it may still be open to other bidders: cancel it by hand`);
      }
    }
    throw new Error(halts.join('; '));
  };
  // A cancel does not undo a fill mined before it: the auction is read again
  // at a block ≥ the cancel's, and every fill by others is recorded.
  const cancelAndAdopt = async (what) => {
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what });
    const after = await auctionState(ctx, id, sell, t.sell);
    await adoptTo(after);
    return after;
  };
  // Closed: taken entirely by other bidders (done), else cancelled by another keeper run (stop).
  const whenClosed = async (st, when = 'before ours') => {
    if (st.remaining !== 0n) throw new Refused(`auction ${id} (#${t.seq}) was closed with ${st.remaining} ${t.sell} unsold, and not by this run — only the keeper cancels: another keeper run is active; stopping`);
    log(`  auction ${id} was filled entirely by other bidder(s) ${when} — nothing left for our fill`);
    // K-1: their fill drained a leaving asset; it is finalized right here.
    if (t.drain && !t.residual) await settleRemoval(ctx, v, t, round);
    return lastOther;
  };
  let repostNow = repost;
  let races = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitUntil(ctx, startTime + BigInt(aimElapsed), policy === 'fair' ? `to the fair point of auction ${id}` : `auction ${id} open`);
    // Same-value re-posts: refresh the staleness clock, move nothing — so the
    // values on chain must still be the ones read at the start of this trade.
    if (repostNow) {
      // No re-post for an auction other bidders took entirely while we waited.
      const pre = await auctionState(ctx, id, sell, t.sell);
      await adoptTo(pre);
      if (!pre.open) return whenClosed(pre);
      await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} (same value)` });
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} (same value)` });
    }
    repostNow = repost;
    // K-3: the fill takes what the vault holds NOW, at most what the auction
    // has left — a redemption since the balance was read would otherwise make
    // the fill revert; anything that arrived since stays and is re-drained.
    // sellRemaining: another bidder may have filled part or all of the
    // auction since it opened; their fills are recorded before ours is sent.
    // Read before the factor, so that the factor check stays the last read
    // before the fill.
    await runHook(ctx, 'before-fill', { seq: t.seq, symbol: t.sell, asset: sell, auctionId: id, amount, drain: !!t.drain, residual: !!t.residual });
    const st = await auctionState(ctx, id, sell, t.sell);
    await adoptTo(st);
    if (!st.open) return whenClosed(st);
    const take = st.liveBal < st.remaining ? st.liveBal : st.remaining;
    if (take === 0n) {
      await cancelAndAdopt(`cancel auction ${id} (nothing left to sell)`);
      return lastOther;
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
      // Another bidder may fill between our read and the cancel: what is
      // reopened is what the auction had left when the cancel was mined.
      const after = await cancelAndAdopt(`cancel auction ${id}`);
      if (after.remaining === 0n) return whenClosed(after, 'before our cancel');
      if (attemptNo >= MAX_WINDOW_ATTEMPTS) throw new Error(`#${t.seq}: missed the fair window ${attemptNo} times (window [${win.eMin}, ${win.eMax}] s of a ${t.duration} s auction = duration/30 wide; three mined transactions must land inside it) — widen the planner's --duration (1800 s gives a 60 s window on the public chain) or run when blocks are quick`);
      // What other bidders took is traded: the reopened auction sells the rest.
      return runTrade(ctx, v, remainingSeen < amount ? { ...t, sellAmount: remainingSeen.toString() } : t, round, attemptNo + 1);
    }
    if (take !== st.remaining) log(`  live balance ${st.liveBal} ${t.sell} is below the auction's ${st.remaining} left (a redemption in the window) — filling ${take}`);
    let filled;
    try {
      filled = await call(ctx, { who: 'bidder', to: plan.vault, functionName: 'fill', args: [id, take], gas: GAS.fill(v.assetCount), what: `fill #${t.seq} (auction ${id})` });
    } catch (e) {
      if (!(await lostRace(ctx, e, id, st.remaining))) throw e;
      races++;
      if (races > MAX_FILL_RACES) throw new Error(`#${t.seq}: another bidder filled auction ${id} between our read and our fill ${races} times in a row (last: ${fmtErr(e)}) — stopping; auction ${id} stays open until a re-run cancels it. A re-run records their fills${round === 1 ? `; round 1 counts #${t.seq} as done,` : ';'} and the residual rounds trade what the bound still needs`);
      log(`  another bidder filled auction ${id} before our fill landed (${fmtErr(e)}) — reading it again (${races}/${MAX_FILL_RACES})`);
      repostNow = false; // the references were re-posted a moment ago
      attempt--; // not a missed window
      continue;
    }
    // Recorded from the receipt before any read (call() contract). Without
    // the block's time the factor is unknown: recorded as null, and a fair
    // fill then stops below instead of guessing.
    const evLog = eventsIn(filled.receipt, VAULT_ABI, 'AuctionFilled', plan.vault).find((e) => e.args.id === id);
    const ev = evLog?.args;
    if (!ev) throw new Error(`no AuctionFilled event for auction ${id} in ${filled.hash}`);
    const elapsed = filled.blockTimestamp == null ? null : Number(filled.blockTimestamp - startTime);
    const factor = elapsed == null ? null : 10_000 + Number(v.premiumBps) - Math.floor((win.range * elapsed) / t.duration);
    const rec = {
      seq: t.seq, round, auctionId: id.toString(), sell: t.sell, buy: t.buy, sellTaken: ev.sellTaken.toString(), buyPaid: ev.buyPaid.toString(),
      lossAtRef: ev.lossAtRef.toString(), factorBps: factor, elapsed, policy, bidder: ctx.bidderAddr, external: false,
      openTx: opened.hash, fillTx: filled.hash, logIndex: evLog.logIndex, at: isoOrNull(filled.blockTimestamp),
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
    if (take !== st.remaining) {
      // Our fill took less than the auction had left: other bidders' fills
      // since ours are recorded, and the unfilled rest is cancelled.
      remainingSeen = st.remaining - take;
      const a2 = await auctionState(ctx, id, sell, t.sell);
      await adoptTo(a2);
      if (a2.open) await cancelAndAdopt(`cancel the unfilled rest of auction ${id} (${a2.remaining} ${t.sell})`);
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
 *     A further fill of an auction that already has one recorded keeps that
 *     fill's seq (other bidders can fill an auction in parts). A fill whose
 *     bidder is not ours (ourBidders) is recorded `external: true`.
 *     Its factor is recomputed from the auction's startTime and the fill
 *     block's time. With `halt`, a fill is held to fillHalt: ours to the
 *     same rules as a fill made now, an external one to the contract's curve.
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
  const isRecorded = recordedFillMatcher(plan);
  const ours = ourBidders(ctx, v);
  const doneSeqs = new Set(plan.fills.filter((f) => f.round === 1).map((f) => f.seq));
  // An auction with a fill already recorded (or adopted above) keeps that
  // fill's seq: with other bidders an auction can have several fills.
  const seqOfAuction = new Map(plan.fills.filter((f) => f.auctionId != null).map((f) => [String(f.auctionId), { seq: f.seq, round: f.round }]));
  const unrecorded = events.filter((e) => e.eventName === 'AuctionFilled' && !isRecorded(e)).sort(byBlockLog);
  const halts = [];
  for (const e of unrecorded) {
    const id = e.args.id;
    const a = await readNow(ctx, `auction ${id}`, { address: vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
    const [sellA, buyA, , startTime, duration] = a;
    const openEv = events.find((x) => x.eventName === 'AuctionOpened' && x.args.id === id);
    const known = seqOfAuction.get(id.toString());
    let t = null;
    if (!known) {
      const cands = plan.trades.filter((x) => getAddress(x.sellAddress) === getAddress(sellA) && getAddress(x.buyAddress) === getAddress(buyA) && !doneSeqs.has(x.seq) && !adoptedSeqs.has(x.seq));
      if (cands.length > 1) throw new Refused(`fill ${e.transactionHash} (auction ${id}, ${symOf(plan, sellA)} → ${symOf(plan, buyA)}) is not in plan.fills and matches planned trades ${cands.map((x) => `#${x.seq}`).join(', ')} — record it in plan.fills by hand (the planned seq it was) before re-running`);
      t = cands[0] ?? null;
    }
    const seq = known ? known.seq : t ? t.seq : `adopted-${id}`;
    const round = known ? known.round : t ? 1 : null;
    if (!known) seqOfAuction.set(id.toString(), { seq, round });
    const rec = await fillRecordFromLog(ctx, v, e, { seq, round, sell: symOf(plan, sellA), buy: symOf(plan, buyA), startTime, duration, openTx: openEv?.transactionHash ?? null, ours });
    if (t) adoptedSeqs.add(t.seq);
    log(`  ${write ? 'recorded' : 'would record'} a fill ${rec.external ? `by an external bidder ${rec.bidder}` : 'an earlier run made but did not record'}: ${rec.sell}→${rec.buy} auction ${id}, took ${rec.sellTaken}, paid ${rec.buyPaid}, factor ${rec.factorBps} bp, tx ${e.transactionHash}${known ? ` — auction of #${seq}, another fill of it is recorded` : t ? ` — planned #${t.seq}, not traded again` : ' — not a planned trade (a residual or a re-drain)'}`);
    if (write) { plan.fills.push(rec); savePlan(ctx.planFile, plan); }
    if (halt) {
      const h = fillHalt(rec, { v, o, planned: round === 1, duration });
      if (h) halts.push(h);
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
  // priced-adds: an asset that entered at its committed price and was never
  // posted since would be refreshed at that price by a same-value re-post
  // below — not at today's first reference the plan sized the auctions with.
  if ((await vaultShape(ctx)) === 'priced-adds') {
    const unposted = v.assets.filter((a) => a.refPriceUpdatedAt === 0n);
    const symOf = (a) => [...plan.adds, ...plan.registry].find((x) => x.address && getAddress(x.address) === a.address)?.symbol ?? a.address;
    if (unposted.length) throw new Refused(`never posted since admission (committed price only): ${unposted.map(symOf).join(', ')} — run first-prices for the plan's adds (the daily mark posts the others) before trading`);
  }
  if (!v.biddingOpen) {
    const isB = await readNow(ctx, 'isBidder', { address: plan.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [ctx.bidderAddr] });
    if (!isB) throw new Refused(`bidder ${ctx.bidderAddr} is not whitelisted (isBidder false, biddingOpen false) — owner setBidder first`);
  }
  // A re-run first records what an earlier run did and cancels what it left
  // open — before the reference checks below, so that a run refused for a
  // moved reference still leaves the earlier run's fills in this plan's record.
  const adopted = await reconcileSession(ctx, v, { cancelOrphans: true, halt: true });
  // References must be today's marks: this script never moves one.
  await requireRefsNearMarket(ctx, v);
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
    if (on && (await vaultShape(ctx)) === 'priced-adds') check(on.refPriceUpdatedAt !== 0n, `${a.symbol} reference posted since admission (not only the committed price)`);
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

// ---------------------------------------------------------------------- day7
/** The seventh-day session: execute → first prices → auctions → finalize →
 *  verify. Every check that can refuse the session and can be made while the
 *  change is pending runs first (requirePlanFresh, requireSizingBeforeExecute),
 *  so a refused session sends nothing and leaves the change pending. */
export async function runDay7(ctx) {
  const run = async (stage, fn) => { ctx.o.stage = stage; ctx.log(`— ${stage} —`); await fn(ctx); };
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
  switch (o.stage) {
    case 'announce': return stageAnnounce(ctx);
    case 'execute': return stageExecute(ctx);
    case 'first-prices': return stageFirstPrices(ctx);
    case 'auctions': return stageAuctions(ctx);
    case 'finalize': return stageFinalize(ctx);
    case 'verify': return stageVerify(ctx);
    case 'day7': return runDay7(ctx);
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
