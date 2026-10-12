/**
 * keeper/basket-recon.mjs with other bidders on the vault (owner answers of
 * 2026-10-13: accept fills by others; re-post both references when an
 * auction opens). Against keeper/test/fake-chain.mjs — no network, no key.
 *
 *   node --test keeper/test/recon-external-fills.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAddress, keccak256, toHex } from 'viem';
import { savePlan, loadPlan, toRefPrice, readVault } from '../basket-plan.mjs';
import { READ_TIMING } from '../readback.mjs';
import { runTrade, reconcileSession, fillHalt, ourBidders, curveFactorAt } from '../basket-recon.mjs';
import { FakeChain } from './fake-chain.mjs';

READ_TIMING.stepMs = 2;
READ_TIMING.waitMs = 400;

const V = getAddress('0x88d3b5f638fe0d331797c612a5496bd8f0491fd4');
const OWNER = getAddress('0x8c23d05ea268a9c183ee033cf07cfec38d0f7902');
const EXT = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'); // another bidder
const AAA = getAddress('0x1111111111111111111111111111111111111111');
const BBB = getAddress('0x2222222222222222222222222222222222222222');
const CRV = getAddress('0x0581ba8a63d787b4a39ed898445b1bfdde84bdf6');
const ASTER = getAddress('0xf96360330e54e861b4b95faa023a77daddcf6511');
const SHA = 'ab'.repeat(32);
const U = 10n ** 8n; // one token at 8 decimals
const REF_AAA = toRefPrice(10, 8);
const REF_BBB = toRefPrice(2, 8);
const REF_CRV = toRefPrice(0.5, 8);
const REF_ASTER = toRefPrice(1.2, 8);
const lc = (a) => a.toLowerCase();

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-ext-')); });

function newChain() {
  const c = new FakeChain({
    vault: V, owner: OWNER,
    assets: [
      { address: AAA, symbol: 'mAAA', decimals: 8, balance: 1_000n * U, ref: REF_AAA, registry: true },
      { address: BBB, symbol: 'mBBB', decimals: 8, balance: 5_000n * U, ref: REF_BBB, registry: true },
      { address: CRV, symbol: 'mCRV', decimals: 8, balance: 4_000n * U, ref: REF_CRV, registry: true },
      { address: ASTER, symbol: 'mASTER', decimals: 8, balance: 0n },
    ],
  });
  c.head.state.biddingOpen = true; // anyone may fill (owner answer 4: new vaults open bidding from deploy)
  c.strictRefAge = true; // fills revert RefPriceStale past maxRefAge, as on the contract
  for (const t of [AAA, BBB, CRV, ASTER]) {
    c.head.state.balances[lc(t)][lc(OWNER)] = 10n ** 15n;
    c.head.state.balances[lc(t)][lc(EXT)] = 10n ** 15n;
  }
  return c;
}

function basePlan(chain) {
  return {
    index: 'qdefi', date: new Date().toISOString().slice(0, 10), chainId: 91342, vault: V,
    block: { number: chain.head.number.toString(), timestamp: chain.head.timestamp.toString() },
    registry: [
      { symbol: 'AAA', address: AAA, planRefPrice: REF_AAA.toString() },
      { symbol: 'BBB', address: BBB, planRefPrice: REF_BBB.toString() },
      { symbol: 'CRV', address: CRV, planRefPrice: REF_CRV.toString(), inRemoval: false },
    ],
    adds: [{ symbol: 'ASTER', address: ASTER, decimals: 8, priceA: 1.2, priceB: 1.205, disagreementBps: 42, firstRefPrice: REF_ASTER.toString() }],
    removes: [{ symbol: 'CRV', address: CRV, balance: (4_000n * U).toString() }],
    announceTuple: { adds: [ASTER], removes: [CRV], decisionSha256: `0x${SHA}` },
    announce: null, decisionSha256: SHA, notes: [], trades: [], fills: [], finalize: [], firstPrices: [], targets: [],
    policy: { duration: 1800, minTradeUsd: 1, tolerancePoints: 5 },
  };
}

function ctxFor(chain, planFile, { live = true, opts = {} } = {}) {
  const reader = chain.reader();
  const wallet = chain.wallet(OWNER);
  const lines = [];
  return {
    o: { index: 'qdefi', stage: 'test', allowPlanDate: true, fill: 'fair', fairWindowBps: 10, firstPriceTol: 0.02, refDriftTol: 0.05, warp: true, faucet: true, maxFaucetCalls: 60, maxRounds: 3, ...opts },
    log: (m) => lines.push(m), lines,
    plan: loadPlan(planFile), planFile, reader, pc: reader.publicClient, devNode: true,
    keeperAddr: OWNER, keeperWallet: wallet, bidderAddr: OWNER, bidderWallet: wallet, live, hook: null,
    pendingThisRun: new Set(), floor: 0n, receipts: new Map(), events: null,
  };
}

/** Announced, executed (ASTER in, CRV in removal) and ASTER's first price posted. */
async function priced(chain) {
  const t = basePlan(chain).announceTuple;
  chain.send(OWNER, { address: V, functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  chain.timeOffset = chain.head.state.registryDelay + 10n;
  chain.mine();
  const pend = chain.head.state.pending;
  chain.send(OWNER, { address: V, functionName: 'executeRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [ASTER, REF_ASTER] });
  return pend;
}
function planOn(chain, pend, trades, name = 'plan.json') {
  const f = path.join(dir, name);
  const p = basePlan(chain);
  savePlan(f, { ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades });
  return f;
}
const T1 = { seq: 1, sell: 'AAA', sellAddress: AAA, buy: 'ASTER', buyAddress: ASTER, sellAmount: (100n * U).toString(), duration: 1800, drain: false };
const T2 = { seq: 2, sell: 'CRV', sellAddress: CRV, buy: 'BBB', buyAddress: BBB, sellAmount: (4_000n * U).toString(), duration: 1800, drain: true };

const lastId = (chain) => BigInt(chain.head.state.auctions.length - 1);
const fillBy = (chain, from, id, take) => chain.send(from, { address: V, functionName: 'fill', args: [id, take] });
const calls = (chain, n0) => chain.sent.slice(n0).map((s) => `${s.functionName}${s.functionName === 'fill' ? (s.from === EXT ? '@ext' : '@ours') : ''}`);
const isRefused = (e) => e?.constructor?.name === 'Refused';

/** Our signer's wallet, with another bidder acting once right after our first `fnName` is mined. */
function afterOurs(chain, ctx, fnName, act) {
  const base = chain.wallet(OWNER);
  let done = false;
  const w = { account: base.account, async writeContract(req) { const h = await base.writeContract(req); if (!done && req.functionName === fnName) { done = true; await act(req); } return h; } };
  ctx.keeperWallet = w;
  ctx.bidderWallet = w;
}

/** A fill the contract could not have made (a node or indexer fault): the
 *  state and an AuctionFilled log, mined `dt` seconds after the head. */
function forgeFill(chain, { id, bidder, take, pay, loss = 0n, dt = 1n }) {
  const hash = keccak256(toHex(`forged-${chain.logs.length}-${id}`));
  const { blk } = chain.mine((st) => {
    const u = st.auctions[Number(id)];
    u.remaining -= take; if (u.remaining === 0n) u.open = false;
    st.balances[lc(u.sell)][lc(V)] -= take;
    st.balances[lc(u.buy)][lc(V)] = (st.balances[lc(u.buy)][lc(V)] ?? 0n) + pay;
  }, { dt });
  const l = { ...chain.log('AuctionFilled', { id, bidder, sellTaken: take, buyPaid: pay, lossAtRef: loss }), blockNumber: blk.number, transactionHash: hash, logIndex: chain.logs.length, blockHash: keccak256(toHex(`b${blk.number}`)), transactionIndex: 0, removed: false };
  chain.logs.push(l);
  blk.txs.push(hash);
  chain.receipts.set(lc(hash), { transactionHash: hash, blockNumber: blk.number, status: 'success', gasUsed: 1n, logs: [l], from: bidder, to: V });
  chain.txs.set(lc(hash), { hash, from: bidder, to: V, blockNumber: blk.number });
  return hash;
}

// ================================================ an external fill first
test('external fill first: another bidder takes the whole auction right after the open — recorded external with its bidder, our fill is not sent, no HALT at a factor (~10,200) outside our fair window; a drain then finalizes at once', async () => {
  for (const T of [T1, T2]) {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1, T2], `plan-${T.seq}.json`);
    const ctx = ctxFor(chain, f);
    afterOurs(chain, ctx, 'openAuction', () => { const id = lastId(chain); fillBy(chain, EXT, id, chain.head.state.auctions[Number(id)].remaining); });
    const n0 = chain.sent.length;
    const amount = T.drain ? 4_000n * U : 100n * U;
    const rec = await runTrade(ctx, await readVault(ctx.reader, V), T, 1);
    assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'fill@ext', ...(T.drain ? ['finalizeRemoval'] : [])], `${T.sell}: no re-post and no fill of ours after the auction closed`);
    const extTx = chain.sent[n0 + 3];
    assert.equal(chain.receipts.get(lc(extTx.hash)).status, 'success', 'the other bidder could fill in the first block: both references were fresh');
    const p = loadPlan(f);
    assert.equal(p.fills.length, 1);
    const r = p.fills[0];
    assert.deepEqual([r.seq, r.round, r.bidder, r.external, r.adopted, r.policy, r.sellTaken, r.lossAtRef, r.fillTx, r.openTx], [T.seq, 1, EXT, true, true, 'external', amount.toString(), '0', extTx.hash, chain.sent[n0 + 2].hash]);
    assert.equal(r.factorBps, 10_200, 'one second in: the top of the curve, a gift to holders');
    assert.equal(typeof r.logIndex, 'number');
    assert.equal(rec.fillTx, extTx.hash, 'runTrade returns the other bidder\'s fill');
    if (T.drain) assert.deepEqual(p.finalize.map((x) => x.symbol), ['CRV']);
    assert.equal(chain.head.state.auctions[Number(lastId(chain))].open, false);
  }
});

// ================================================ a partial external fill
test('partial external fill: another bidder takes 30 of 100 after the open; our fill at the fair point takes the 70 left (sellRemaining), both recorded under #1, the sum is the auction; a re-run records nothing again', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, pend, [T1]);
  const ctx = ctxFor(chain, f);
  afterOurs(chain, ctx, 'openAuction', () => fillBy(chain, EXT, lastId(chain), 30n * U));
  const n0 = chain.sent.length;
  const v = await readVault(ctx.reader, V);
  const rec = await runTrade(ctx, v, T1, 1);
  assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'fill@ext', 'setRefPrice', 'setRefPrice', 'fill@ours']);
  const id = lastId(chain);
  assert.deepEqual(chain.sent.at(-1).args, [id, 70n * U], 'ours takes what the auction has left, not the planned 100');
  const p = loadPlan(f);
  assert.deepEqual(p.fills.map((x) => [x.seq, x.round, x.bidder, x.external, x.sellTaken]), [[1, 1, EXT, true, (30n * U).toString()], [1, 1, OWNER, false, (70n * U).toString()]]);
  const ours = p.fills[1];
  assert.equal(ours.policy, 'fair');
  assert.ok(ours.factorBps >= 10_000 && ours.factorBps <= 10_010, `ours inside the fair window (${ours.factorBps})`);
  assert.equal(ours.auctionAmount, (100n * U).toString());
  assert.equal(typeof ours.logIndex, 'number');
  assert.equal(rec.fillTx, ours.fillTx);
  assert.equal(p.fills.reduce((s, x) => s + BigInt(x.sellTaken), 0n), 100n * U);
  assert.equal(chain.head.state.auctions[Number(id)].open, false, 'closed by our fill: no cancel needed');
  assert.ok(!calls(chain, n0).includes('cancelAuction'));
  // A re-run's reconciliation knows both fills (transaction and log index).
  const again = ctxFor(chain, f);
  await reconcileSession(again, await readVault(again.reader, V), { halt: true });
  assert.equal(loadPlan(f).fills.length, 2);
});

test('partial external fill in the race: another bidder fills between our read and our fill — a mined revert (CapExceeded) is read again and the rest filled; a refused simulation (AuctionClosed) ends the trade as done', async () => {
  // (a) the other fill lands in the block before ours: ours reverts on chain.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const ctx = ctxFor(chain, f);
    const base = chain.wallet(OWNER);
    let raced = false;
    ctx.bidderWallet = { account: base.account, async writeContract(req) { if (req.functionName === 'fill' && !raced) { raced = true; fillBy(chain, EXT, req.args[0], 40n * U); } return base.writeContract(req); } };
    const n0 = chain.sent.length;
    await runTrade(ctx, await readVault(ctx.reader, V), T1, 1);
    assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill@ext', 'fill@ours', 'fill@ours'], 'no further re-posts after the race');
    const [lost, won] = chain.sent.slice(-2);
    assert.equal(chain.receipts.get(lc(lost.hash)).status, 'reverted');
    assert.deepEqual(won.args.map(String), [String(lastId(chain)), String(60n * U)]);
    const p = loadPlan(f);
    assert.equal(p.sent.find((s) => s.hash === lost.hash).status, 'reverted', 'the lost fill stays in "sent" as reverted');
    assert.deepEqual(p.fills.map((x) => [x.bidder, x.external, x.sellTaken]), [[EXT, true, (40n * U).toString()], [OWNER, false, (60n * U).toString()]]);
  }
  // (b) the other bidder takes everything just before our simulation: refused AuctionClosed, then done.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const ctx = ctxFor(chain, f);
    const orig = ctx.pc.simulateContract;
    let raced = false;
    ctx.pc.simulateContract = async (p) => {
      if (p.functionName === 'fill' && !raced) {
        raced = true;
        fillBy(chain, EXT, p.args[0], chain.head.state.auctions[Number(p.args[0])].remaining);
        return orig({ ...p, blockNumber: chain.head.number }); // the node that answers has the other fill
      }
      return orig(p);
    };
    const n0 = chain.sent.length;
    const rec = await runTrade(ctx, await readVault(ctx.reader, V), T1, 1);
    assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill@ext'], 'ours is never sent');
    assert.ok(ctx.lines.some((l) => /another bidder filled auction \d+ before our fill landed \(.*AuctionClosed/.test(l)));
    const p = loadPlan(f);
    assert.deepEqual(p.fills.map((x) => [x.seq, x.bidder, x.external, x.sellTaken]), [[1, EXT, true, (100n * U).toString()]]);
    assert.equal(rec.fillTx, p.fills[0].fillTx);
  }
});

// ================================================ off the curve: HALT stays
test('curve: an external fill below fair but on the curve (9,950 bp, lossAtRef > 0) is recorded without a HALT; one off the curve (past the duration) or a loss booked at or above fair HALTs after it is recorded (during our trade: and after our auction is cancelled)', async () => {
  // (a) a re-run finds another bidder's late fill: on the curve — recorded, no HALT.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [AAA, REF_AAA] }); // the earlier run's re-posts at the open
    chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [ASTER, REF_ASTER] });
    chain.send(OWNER, { address: V, functionName: 'openAuction', args: [AAA, ASTER, 100n * U, 1800n] });
    chain.timeOffset = 1499n;
    fillBy(chain, EXT, lastId(chain), 100n * U); // 1,500 s of 1,800: 10200 − ⌊300·1500/1800⌋ = 9950
    const ctx = ctxFor(chain, f);
    const seqs = await reconcileSession(ctx, await readVault(ctx.reader, V), { cancelOrphans: true, halt: true });
    assert.deepEqual([...seqs], [1], 'planned #1 is done: not traded again');
    const r = loadPlan(f).fills[0];
    assert.deepEqual([r.seq, r.external, r.bidder, r.factorBps, r.policy], [1, true, EXT, 9_950, 'external']);
    assert.ok(BigInt(r.lossAtRef) > 0n, 'below fair: a loss at reference, bounded by the curve floor');
    assert.equal(fillHalt({ ...r, external: false }, { v: { premiumBps: 200n, maxFillLossBps: 100n }, o: ctx.o, planned: true })?.startsWith('HALT: adopted fill'), true, 'the same fill by our own bidder still HALTs under --fill fair');
  }
  // (b) a fill recorded past the auction's duration (the contract reverts AuctionExpired there): off the curve.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    chain.send(OWNER, { address: V, functionName: 'openAuction', args: [AAA, ASTER, 100n * U, 1800n] });
    const forged = forgeFill(chain, { id: lastId(chain), bidder: EXT, take: 100n * U, pay: (100n * U * REF_AAA) / REF_ASTER, dt: 1_900n });
    const ctx = ctxFor(chain, f);
    await assert.rejects(reconcileSession(ctx, await readVault(ctx.reader, V), { halt: true }), new RegExp(`HALT: external fill ${forged} by ${EXT} \\(auction 0\\) at factor 9884, off the contract's curve \\[9900, 10200\\]`));
    assert.equal(loadPlan(f).fills[0].fillTx, forged, 'recorded before the HALT');
  }
  // (c) during our trade: another bidder's fill with a loss at a factor ≥ 10,000 (the contract books none there) — HALT before ours is sent.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const ctx = ctxFor(chain, f);
    let forged = null;
    ctx.hook = async (point, info) => { if (point === 'before-fill' && !forged) forged = forgeFill(chain, { id: info.auctionId, bidder: EXT, take: 50n * U, pay: (50n * U * REF_AAA) / REF_ASTER, loss: 123n }); };
    const n0 = chain.sent.length;
    await assert.rejects(runTrade(ctx, await readVault(ctx.reader, V), T1, 1), /HALT: external fill .* booked lossAtRef 123 at factor 100\d\d/);
    assert.ok(!calls(chain, n0).includes('fill@ours'), 'our fill is not sent after the HALT');
    assert.equal(calls(chain, n0).at(-1), 'cancelAuction', 'the auction is cancelled before the run stops');
    const u = chain.head.state.auctions[Number(lastId(chain))];
    assert.deepEqual([u.open, u.remaining], [false, 50n * U], 'no one can fill the rest while the run is stopped');
    const p = loadPlan(f);
    assert.deepEqual(p.fills.map((x) => [x.fillTx, x.external]), [[forged, true]], 'recorded before the HALT');
    assert.ok(p.sent.some((s) => /cancel auction \d+ before the HALT/.test(s.what)));
  }
  // The curve itself, as the contract computes it — and a fill 1 s past the
  // end, which still computes to the floor but which the contract reverts.
  const v = { premiumBps: 200n, maxFillLossBps: 100n };
  assert.deepEqual([curveFactorAt(v, 0, 1800), curveFactorAt(v, 1200, 1800), curveFactorAt(v, 1800, 1800), curveFactorAt(v, 1801, 1800), curveFactorAt(v, 1806, 1800)], [10_200, 10_000, 9_900, 9_900, 9_899]);
  const late = { fillTx: '0xf', bidder: EXT, auctionId: '0', external: true, factorBps: 9_900, elapsed: 1801, lossAtRef: '5' };
  assert.equal(fillHalt({ ...late, elapsed: 1800 }, { v, o: { fill: 'fair', fairWindowBps: 10 }, planned: true, duration: 1800n }), null, 'the last second is on the curve');
  assert.match(fillHalt(late, { v, o: { fill: 'fair', fairWindowBps: 10 }, planned: true, duration: 1800n }), /at 1801 s of a 1800 s auction, off the contract's curve/);
});

// ================================================ re-post at the open
test('re-post at the open: both legs re-posted at their chain values right before an auction that waits for its fair point — a reference older than maxRefAge at the start is fresh from the open block on; the pre-fill re-posts stay', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, pend, [T1]);
  const st0 = chain.head.state;
  assert.ok(chain.head.timestamp - st0.refAt[lc(AAA)] > st0.maxRefAge, 'AAA\'s reference is stale when the trade starts');
  const ctx = ctxFor(chain, f);
  const n0 = chain.sent.length;
  await runTrade(ctx, await readVault(ctx.reader, V), T1, 1);
  const sent = chain.sent.slice(n0);
  assert.deepEqual(sent.map((s) => s.functionName), ['setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill']);
  assert.deepEqual([sent[0].args, sent[1].args], [[AAA, REF_AAA], [ASTER, REF_ASTER]], 'the values already on chain: nothing moves');
  assert.deepEqual([sent[3].args, sent[4].args], [[AAA, REF_AAA], [ASTER, REF_ASTER]], 'and again before our fill');
  const openBlk = chain.receipts.get(lc(sent[2].hash)).blockNumber;
  const at = chain.block(openBlk);
  for (const a of [AAA, ASTER]) assert.ok(at.timestamp - at.state.refAt[lc(a)] <= 2n, `${a}: re-posted within 2 s of the open`);
  // From the open block on, a fill by anyone passes the staleness check.
  const id = BigInt(chain.state(openBlk).auctions.length - 1);
  await chain.client().simulateContract({ address: V, functionName: 'fill', args: [id, 1n], account: EXT, blockNumber: openBlk });
  // Before this change the auction opened on the day's mark: unfillable until our pre-fill re-posts, ~1,166 s later.
  const before = newChain();
  await priced(before);
  before.send(OWNER, { address: V, functionName: 'openAuction', args: [AAA, ASTER, 100n * U, 1800n] });
  await assert.rejects(before.client().simulateContract({ address: V, functionName: 'fill', args: [lastId(before), 1n], account: EXT }), /RefPriceStale/);
});

test('re-post at the open: a reference moved after the trade read it is REFUSED before anything is opened; --fill open (filled at once) keeps its one pair of re-posts right after the open; a dry run lists the two re-posts before the open', async () => {
  // (a) another keeper run marks AAA between the trade's read and the open.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const ctx = ctxFor(chain, f);
    const orig = ctx.pc.multicall;
    let moved = false;
    ctx.pc.multicall = async (args) => {
      if (!moved && args.contracts.some((c) => c.functionName === 'allowance')) { moved = true; chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [AAA, REF_AAA + REF_AAA / 1000n] }); }
      return orig(args);
    };
    const n0 = chain.sent.length;
    await assert.rejects(runTrade(ctx, await readVault(ctx.reader, V), T1, 1), (e) => isRefused(e) && /reference moved during the session \(AAA/.test(e.message));
    assert.deepEqual(chain.sent.slice(n0).map((s) => s.functionName), ['setRefPrice'], 'only the other run\'s mark: no re-post, no open');
  }
  // (b) --fill open: no wait, so no separate re-posts before the open.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const ctx = ctxFor(chain, f, { opts: { fill: 'open' } });
    const n0 = chain.sent.length;
    await runTrade(ctx, await readVault(ctx.reader, V), T1, 1);
    assert.deepEqual(chain.sent.slice(n0).map((s) => s.functionName), ['openAuction', 'setRefPrice', 'setRefPrice', 'fill']);
  }
  // (c) dry run: simulated and printed in order, nothing sent.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const dry = ctxFor(chain, f, { live: false });
    const n0 = chain.sent.length;
    await runTrade(dry, await readVault(dry.reader, V), T1, 1);
    const at = (re) => dry.lines.findIndex((l) => re.test(l));
    const [a, b, o] = [at(/would re-post AAA at the open \(same value\)/), at(/would re-post ASTER at the open \(same value\)/), at(/would open auction #1/)];
    assert.ok(a >= 0 && a < b && b < o, `order: ${a}, ${b}, ${o}`);
    assert.equal(chain.sent.length, n0);
  }
});

// ================================================ who is ours
test('ourBidders: this run\'s bidder and keeper, the vault\'s roles, every fill sender in "sent" and every bidder of our own fills — not an adopted or external fill\'s bidder', () => {
  const B2 = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
  const B3 = getAddress('0x90f79bf6eb2c4f870365e785982e1f101e93b906');
  const ctx = {
    bidderAddr: OWNER, keeperAddr: OWNER,
    plan: {
      sent: [{ what: 'fill #3 (auction 9)', from: B2 }, { what: 're-post AAA (same value)', from: EXT }],
      fills: [{ bidder: B3, policy: 'fair' }, { bidder: EXT, adopted: true, external: true }, { bidder: getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'), adopted: true }],
    },
  };
  const s = ourBidders(ctx, { owner: OWNER, keeper: OWNER });
  assert.deepEqual([...s].sort(), [OWNER, B2, B3].sort());
});

// ================================================ a fill between our read and our cancel
test('missed fair window: another bidder fills between our read and our cancel — the auction is read again after the cancel and their fill recorded; all taken → the trade is done (no reopen); part taken → only the rest is reopened', async () => {
  for (const extTake of [100n * U, 30n * U]) {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1], `plan-${extTake}.json`);
    const ctx = ctxFor(chain, f);
    // The fill-time read lands past the fair window (400 s late) once.
    let late = false;
    ctx.hook = async (point) => { if (point === 'before-fill' && !late) { late = true; chain.timeOffset = 400n; chain.mine(); } };
    // The other bidder's fill is mined right before our cancel.
    const base = chain.wallet(OWNER);
    let raced = false;
    const w = { account: base.account, async writeContract(req) { if (req.functionName === 'cancelAuction' && !raced) { raced = true; fillBy(chain, EXT, req.args[0], extTake); } return base.writeContract(req); } };
    ctx.keeperWallet = w;
    ctx.bidderWallet = w;
    const n0 = chain.sent.length;
    const rec = await runTrade(ctx, await readVault(ctx.reader, V), T1, 1);
    const firstId = BigInt(chain.state(chain.receipts.get(lc(chain.sent[n0 + 2].hash)).blockNumber).auctions.length - 1);
    const p = loadPlan(f);
    assert.equal(chain.head.state.balances[lc(AAA)][lc(V)], 900n * U, `the vault sold the planned 100 AAA, not more (other bidder took ${extTake / U})`);
    assert.equal(p.fills.reduce((s, x) => s + BigInt(x.sellTaken), 0n), 100n * U, 'every fill of the trade is recorded');
    const ext = p.fills.find((x) => x.external);
    assert.deepEqual([ext.seq, ext.round, ext.bidder, ext.auctionId, ext.sellTaken], [1, 1, EXT, firstId.toString(), extTake.toString()]);
    assert.ok(ext.factorBps >= 9_900 && ext.factorBps < 10_000, `below fair, on the curve (${ext.factorBps})`);
    if (extTake === 100n * U) {
      assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill@ext', 'cancelAuction'], 'nothing reopened');
      assert.equal(p.fills.length, 1);
      assert.equal(rec.fillTx, ext.fillTx, 'runTrade returns the other bidder\'s fill');
      assert.ok(ctx.lines.some((l) => /filled entirely by other bidder\(s\) before our cancel/.test(l)));
    } else {
      assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill@ext', 'cancelAuction', 'setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill@ours']);
      const reopen = chain.sent.filter((s) => s.functionName === 'openAuction').at(-1);
      assert.deepEqual(reopen.args, [AAA, ASTER, 70n * U, 1800n], 'the reopened auction sells what the first one had left at the cancel');
      const ours = p.fills.find((x) => !x.external);
      assert.deepEqual([ours.seq, ours.round, ours.sellTaken], [1, 1, (70n * U).toString()]);
      assert.equal(rec.fillTx, ours.fillTx);
    }
  }
});

// ================================================ the race read at the simulation's block
test('race on a lagging node: our fill is refused (CapExceeded) at a block that has the other fill while the next node answers one block behind — the auction is read at the simulation\'s block, so the race is seen and the rest filled', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, pend, [T1]);
  const ctx = ctxFor(chain, f);
  const origRead = ctx.pc.readContract;
  const origSim = ctx.pc.simulateContract;
  let filledExt = false;
  let armed = false;
  // The other bidder fills 40 right after our last read before the fill (the factor).
  ctx.pc.readContract = async (c) => {
    const out = await origRead(c);
    if (c.functionName === 'curveFactorBps' && !filledExt) { filledExt = true; fillBy(chain, EXT, c.args[0], 40n * U); }
    return out;
  };
  // Our simulation sees it and is refused; the reads after it are answered by a node one block behind.
  ctx.pc.simulateContract = async (p) => {
    try { return await origSim(p); } catch (e) {
      if (p.functionName === 'fill' && !armed) { armed = true; chain.lagModes = ['stale']; chain.lagNow(2); }
      throw e;
    }
  };
  const n0 = chain.sent.length;
  await runTrade(ctx, await readVault(ctx.reader, V), T1, 1);
  assert.ok(armed, 'our simulation was refused');
  assert.deepEqual(calls(chain, n0), ['setRefPrice', 'setRefPrice', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill@ext', 'fill@ours']);
  assert.ok(ctx.lines.some((l) => /another bidder filled auction \d+ before our fill landed \(.*CapExceeded/.test(l)));
  assert.deepEqual(chain.sent.at(-1).args, [lastId(chain), 60n * U]);
  const p = loadPlan(f);
  assert.deepEqual(p.fills.map((x) => [x.bidder, x.external, x.sellTaken]), [[EXT, true, (40n * U).toString()], [OWNER, false, (60n * U).toString()]]);
});

// ================================================ a re-run: a second fill of one auction keeps its seq
test('re-run: an auction with one recorded fill and one that is not — the second keeps the first\'s seq and round (a recorded fill of ours + an external one; a recorded external one + ours outside the fair window, which HALTs as planned)', async () => {
  const setup = (chain) => {
    chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [AAA, REF_AAA] });
    chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [ASTER, REF_ASTER] });
    chain.send(OWNER, { address: V, functionName: 'openAuction', args: [AAA, ASTER, 100n * U, 1800n] });
    return lastId(chain);
  };
  // (a) ours recorded, theirs not.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const id = setup(chain);
    fillBy(chain, OWNER, id, 30n * U);
    const c1 = ctxFor(chain, f);
    await reconcileSession(c1, await readVault(c1.reader, V), { halt: false });
    assert.deepEqual(loadPlan(f).fills.map((x) => [x.seq, x.round, x.external]), [[1, 1, false]]);
    fillBy(chain, EXT, id, 70n * U);
    const c2 = ctxFor(chain, f);
    await reconcileSession(c2, await readVault(c2.reader, V), { halt: true });
    const p = loadPlan(f);
    assert.deepEqual(p.fills.map((x) => [x.seq, x.round, x.bidder, x.external, x.auctionId]), [[1, 1, OWNER, false, id.toString()], [1, 1, EXT, true, id.toString()]], 'not adopted-<id>, not round null');
  }
  // (b) theirs recorded, ours not — ours at the top of the curve, outside the fair window.
  {
    const chain = newChain();
    const pend = await priced(chain);
    const f = planOn(chain, pend, [T1]);
    const id = setup(chain);
    fillBy(chain, EXT, id, 30n * U);
    const c1 = ctxFor(chain, f);
    await reconcileSession(c1, await readVault(c1.reader, V), { halt: true });
    fillBy(chain, OWNER, id, 70n * U);
    const c2 = ctxFor(chain, f);
    await assert.rejects(reconcileSession(c2, await readVault(c2.reader, V), { halt: true }), /HALT: adopted fill 0x[0-9a-f]+ landed at factor 10\d\d\d, outside \[10000, 10010\]/);
    const p = loadPlan(f);
    assert.deepEqual(p.fills.map((x) => [x.seq, x.round, x.bidder, x.external]), [[1, 1, EXT, true], [1, 1, OWNER, false]], 'recorded before the HALT, as planned #1 round 1');
  }
});
