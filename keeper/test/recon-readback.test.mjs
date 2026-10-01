/**
 * keeper/basket-recon.mjs on a node that has not seen our last block
 * (2026-10-01): the record contract of call() and each stage's re-run
 * reconciliation, against keeper/test/fake-chain.mjs — a model of one vault
 * whose node lags after every transaction (stale / empty / block-not-found
 * answers, in turn). No network, no key.
 *
 *   node --test keeper/test/recon-readback.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAddress } from 'viem';
import { savePlan, loadPlan, toRefPrice, readVault } from '../basket-plan.mjs';
import { READ_TIMING } from '../readback.mjs';
import { stageAnnounce, stageExecute, stageFirstPrices, settleSent, reconcileSession, runTrade, call } from '../basket-recon.mjs';
import { FakeChain, ZERO32 } from './fake-chain.mjs';

READ_TIMING.stepMs = 2; // the bound stays 30 s of fake waits; each wait is 2 ms here
READ_TIMING.waitMs = 400;

const V = getAddress('0x88d3b5f638fe0d331797c612a5496bd8f0491fd4');
const OWNER = getAddress('0x8c23d05ea268a9c183ee033cf07cfec38d0f7902');
const AAA = getAddress('0x1111111111111111111111111111111111111111');
const BBB = getAddress('0x2222222222222222222222222222222222222222');
const CRV = getAddress('0x0581ba8a63d787b4a39ed898445b1bfdde84bdf6');
const ASTER = getAddress('0xf96360330e54e861b4b95faa023a77daddcf6511');
const SHA = 'ab'.repeat(32);
const E18 = 10n ** 18n;
const REF_AAA = toRefPrice(10, 8); // $10, 8 dec
const REF_BBB = toRefPrice(2, 8);
const REF_CRV = toRefPrice(0.5, 8);
const REF_ASTER = toRefPrice(1.2, 8);

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-rb-')); });

function newChain({ lagReads = 0 } = {}) {
  const c = new FakeChain({
    vault: V, owner: OWNER,
    assets: [
      { address: AAA, symbol: 'mAAA', decimals: 8, balance: 1_000n * 10n ** 8n, ref: REF_AAA, registry: true },
      { address: BBB, symbol: 'mBBB', decimals: 8, balance: 5_000n * 10n ** 8n, ref: REF_BBB, registry: true },
      { address: CRV, symbol: 'mCRV', decimals: 8, balance: 4_000n * 10n ** 8n, ref: REF_CRV, registry: true },
      { address: ASTER, symbol: 'mASTER', decimals: 8, balance: 0n },
    ],
  });
  c.head.state.bidders[OWNER.toLowerCase()] = true;
  for (const t of [AAA, BBB, CRV, ASTER]) c.head.state.balances[t.toLowerCase()][OWNER.toLowerCase()] = 10n ** 15n;
  c.lagReads = lagReads;
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
    removes: [{ symbol: 'CRV', address: CRV, balance: (4_000n * 10n ** 8n).toString() }],
    announceTuple: { adds: [ASTER], removes: [CRV], decisionSha256: `0x${SHA}` },
    announce: null, decisionSha256: SHA, notes: [], trades: [], fills: [], finalize: [], firstPrices: [], targets: [],
    policy: { duration: 1800, minTradeUsd: 1, tolerancePoints: 5 },
  };
}

function ctxFor(chain, planFile, { live = true, opts = {} } = {}) {
  const ledger = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({ id: '2099-01-01-qdefi-test', file: 'decisions/2099-01-01-qdefi-test.md', sha256: SHA, txHash: '0xtest', anchoredAt: 'test' }) + '\n');
  const reader = chain.reader();
  const wallet = chain.wallet(OWNER);
  const lines = [];
  return {
    o: { index: 'qdefi', stage: 'test', decisions: ledger, allowPlanDate: true, fill: 'fair', fairWindowBps: 10, firstPriceTol: 0.02, refDriftTol: 0.05, warp: true, faucet: true, maxFaucetCalls: 60, maxRounds: 3, ...opts },
    log: (m) => lines.push(m), lines,
    plan: loadPlan(planFile), planFile, reader, pc: reader.publicClient, devNode: true,
    keeperAddr: OWNER, keeperWallet: wallet, bidderAddr: OWNER, bidderWallet: wallet, live, hook: null,
    pendingThisRun: new Set(), floor: 0n, receipts: new Map(), events: null,
  };
}
function planOn(chain, mutate = (p) => p, name = 'plan.json') {
  const f = path.join(dir, name);
  savePlan(f, mutate(basePlan(chain)));
  return f;
}
const strip = (rec) => JSON.parse(JSON.stringify(rec, (k, v) => (k === 'sentAt' ? undefined : typeof v === 'bigint' ? v.toString() : v)));
const isRefused = (e) => e?.constructor?.name === 'Refused';

// ================================================================ announce
test('announce on a lagging node records the same plan.announce as on a clean node, and the hash is in plan.sent before the receipt', async () => {
  const runOn = async (lagReads) => {
    const chain = newChain({ lagReads });
    const f = planOn(chain);
    const ctx = ctxFor(chain, f);
    await stageAnnounce(ctx);
    return { chain, ctx, plan: loadPlan(f) };
  };
  const clean = await runOn(0);
  const lag = await runOn(6);
  assert.equal(clean.chain.sent.length, 1);
  assert.equal(lag.chain.sent.length, 1, 'one transaction, not two');
  assert.ok(lag.chain.reads > clean.chain.reads, 'the lagging node was asked again');
  assert.ok(lag.ctx.lines.some((l) => /answered at read [2-9]/.test(l)), 'a read after the write was repeated');
  const a = clean.plan.announce;
  assert.equal(a.pendingHash, clean.chain.head.state.pending);
  assert.equal(a.eta, clean.chain.head.state.eta.toString());
  assert.equal(a.block, clean.chain.head.number.toString());
  assert.equal(a.at, new Date(Number(clean.chain.head.timestamp) * 1000).toISOString());
  // Same chain model, same block numbers and times: the records are identical.
  assert.deepEqual(strip(lag.plan.announce), strip({ ...a, txHash: lag.plan.announce.txHash }));
  assert.deepEqual(lag.plan.announceTuple, lag.plan.announce.tuple);
  assert.equal(lag.plan.sent[0].status, 'success');
  assert.equal(lag.plan.sent[0].hash, lag.plan.announce.txHash);
});

test('announce: a node that never serves the receipt block — the record is saved (at = eta − delay) BEFORE the check gives up', async () => {
  const chain = newChain();
  const f = planOn(chain);
  const ctx = ctxFor(chain, f);
  chain.neverHas = chain.head.number + 1n; // the announce block
  await assert.rejects(stageAnnounce(ctx), /pending change after announce at block \d+: no answer after/);
  const p = loadPlan(f);
  const st = chain.head.state;
  assert.equal(p.announce.pendingHash, st.pending, 'from the RegistryChangeAnnounced event in the receipt');
  assert.equal(p.announce.eta, st.eta.toString());
  assert.equal(p.announce.at, new Date(Number(st.eta - st.registryDelay) * 1000).toISOString());
  assert.equal(p.announce.at, new Date(Number(chain.head.timestamp) * 1000).toISOString(), 'eta − delay IS the block time');
  assert.equal(p.sent[0].at, null, 'the block time could not be read: recorded as null, not thrown');
  assert.ok(ctx.lines.some((l) => /WARN the time of block/.test(l)));
});

test('announce: the receipt never comes — the hash is on disk; the re-run settles it and adopts the pending change', async () => {
  const chain = newChain();
  const f = planOn(chain);
  chain.receiptFails = 3;
  const ctx = ctxFor(chain, f);
  await assert.rejects(stageAnnounce(ctx), (e) => /was sent but no receipt came back after 3 waits/.test(e.message) && e.message.includes(chain.sent[0].hash));
  let p = loadPlan(f);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].hash, chain.sent[0].hash);
  assert.equal(p.sent[0].status, undefined, 'sent, receipt unknown');
  assert.equal(p.announce, null);
  // The re-run: a fresh process on the same plan file.
  const ctx2 = ctxFor(chain, f);
  await settleSent(ctx2);
  assert.equal(ctx2.floor, chain.head.number);
  await stageAnnounce(ctx2);
  p = loadPlan(f);
  assert.equal(chain.sent.length, 1, 'nothing sent again');
  assert.equal(p.announce.txHash, chain.sent[0].hash);
  assert.equal(p.announce.adopted, true);
  assert.equal(p.announce.pendingHash, chain.head.state.pending);
  assert.equal(p.announce.eta, chain.head.state.eta.toString());
  assert.equal(p.announce.block, chain.head.number.toString());
  assert.equal(p.sent[0].status, 'success');
});

test('announce: a pending change with this tuple and no record (no sent list either) is adopted from the log; a dry run only says so', async () => {
  const chain = newChain();
  const f = planOn(chain);
  const t = basePlan(chain).announceTuple;
  const { hash } = chain.send(OWNER, { address: V, functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  const before = fs.readFileSync(f, 'utf8');
  const dry = ctxFor(chain, f, { live: false });
  await stageAnnounce(dry);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'a dry run writes nothing');
  assert.ok(dry.lines.some((l) => /already pending on chain .* a live run adopts it/.test(l)));
  const live = ctxFor(chain, f);
  await stageAnnounce(live);
  const p = loadPlan(f);
  assert.equal(chain.sent.length, 1, 'nothing sent');
  assert.equal(p.announce.txHash, hash);
  assert.equal(p.announce.signer, OWNER);
  assert.equal(p.announce.adopted, true);
  // The day-7 planner's condition (basket-plan.mjs): prev.announce.pendingHash == chain pending.
  assert.equal(p.announce.pendingHash.toLowerCase(), chain.head.state.pending.toLowerCase());
  // …and a third run refuses as before: recorded and pending.
  await assert.rejects(stageAnnounce(ctxFor(chain, f)), (e) => isRefused(e) && /already pending and recorded/.test(e.message));
});

test('announce: another change pending is still refused', async () => {
  const chain = newChain();
  const f = planOn(chain);
  chain.send(OWNER, { address: V, functionName: 'announceRegistryChange', args: [[ASTER], [], `0x${'cd'.repeat(32)}`] });
  await assert.rejects(stageAnnounce(ctxFor(chain, f)), (e) => isRefused(e) && /a registry change is already pending/.test(e.message));
  assert.equal(chain.sent.length, 1);
});

test('settleSent: an entry without a receipt is REFUSED with the hash and what to check', async () => {
  const chain = newChain();
  const t = basePlan(chain).announceTuple;
  const { hash } = chain.send(OWNER, { address: V, functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  chain.receiptHidden.add(hash.toLowerCase());
  const f = planOn(chain, (p) => ({ ...p, sent: [{ what: 'announce', call: 'announceRegistryChange(…)', hash, sentAt: '2026-10-02T07:00:00.000Z' }] }));
  await assert.rejects(settleSent(ctxFor(chain, f), { waitMs: 20 }), (e) => isRefused(e) && e.message.includes(hash) && /"status": "dropped"/.test(e.message));
  chain.receiptHidden.clear();
  const ctx = ctxFor(chain, f);
  await settleSent(ctx);
  assert.equal(loadPlan(f).sent[0].status, 'success');
  assert.equal(ctx.floor, chain.head.number);
});

// ======================================================== execute & prices
async function announced(chain) {
  const t = basePlan(chain).announceTuple;
  chain.send(OWNER, { address: V, functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  chain.timeOffset = chain.head.state.registryDelay + 10n;
  chain.mine();
}

test('execute on a lagging node: recorded from the receipt, then the registry read at the receipt block — same record as a clean node', async () => {
  const runOn = async (lagReads) => {
    const chain = newChain();
    await announced(chain);
    const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: chain.head.state.pending, tuple: p.announceTuple } }));
    chain.lagReads = lagReads;
    await stageExecute(ctxFor(chain, f));
    return loadPlan(f).execute;
  };
  const a = await runOn(0);
  const b = await runOn(6);
  assert.equal(a.assetCount, 4);
  assert.deepEqual(a.order, [AAA, BBB, CRV, ASTER]);
  assert.deepEqual({ ...b, txHash: null }, { ...a, txHash: null });
});

test('execute: registry read never answers — plan.execute is on disk with the tx before the error', async () => {
  const chain = newChain();
  await announced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: chain.head.state.pending, tuple: p.announceTuple } }));
  chain.neverHas = chain.head.number + 1n;
  await assert.rejects(stageExecute(ctxFor(chain, f)), /registry after execute at block/);
  const e = loadPlan(f).execute;
  assert.equal(e.txHash, chain.sent.at(-1).hash);
  assert.equal(e.assetCount, null);
  // Re-run once the node has it: already executed and recorded, nothing sent.
  chain.neverHas = null;
  const n = chain.sent.length;
  const ctx = ctxFor(chain, f);
  await settleSent(ctx);
  await stageExecute(ctx);
  assert.equal(chain.sent.length, n);
});

test('execute re-run: our execute mined but not recorded — found through plan.sent, recorded as ours (not a third party), nothing sent', async () => {
  const chain = newChain();
  await announced(chain);
  const t = basePlan(chain).announceTuple;
  const pend = chain.head.state.pending;
  const { hash } = chain.send(OWNER, { address: V, functionName: 'executeRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, sent: [{ what: 'execute', call: 'executeRegistryChange(…)', hash, sentAt: 'x' }] }));
  const ctx = ctxFor(chain, f);
  await settleSent(ctx);
  await stageExecute(ctx);
  const e = loadPlan(f).execute;
  assert.equal(e.txHash, hash);
  assert.equal(e.signer, OWNER);
  assert.equal(e.byThirdParty, false);
  assert.equal(chain.sent.length, 2);
});

async function executed(chain) {
  await announced(chain);
  const t = basePlan(chain).announceTuple;
  const pend = chain.head.state.pending;
  chain.send(OWNER, { address: V, functionName: 'executeRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  return pend;
}

test('first prices on a lagging node: recorded, then checked at the receipt block; a re-run adopts a post it finds on chain', async () => {
  const chain = newChain();
  const pend = await executed(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple } }));
  chain.lagReads = 6;
  await stageFirstPrices(ctxFor(chain, f));
  let p = loadPlan(f);
  assert.equal(p.firstPrices.length, 1);
  assert.equal(p.firstPrices[0].price, REF_ASTER.toString());
  assert.equal(p.firstPrices[0].txHash, chain.sent.at(-1).hash);
  // An earlier run that posted and stopped before recording:
  const chain2 = newChain();
  const pend2 = await executed(chain2);
  const f2 = planOn(chain2, (q) => ({ ...q, announce: { pendingHash: pend2, tuple: q.announceTuple } }), 'plan2.json');
  const { hash } = chain2.send(OWNER, { address: V, functionName: 'setRefPrice', args: [ASTER, REF_ASTER] });
  const n = chain2.sent.length;
  await stageFirstPrices(ctxFor(chain2, f2));
  p = loadPlan(f2);
  assert.equal(chain2.sent.length, n, 'not posted again');
  assert.equal(p.firstPrices[0].txHash, hash);
  assert.equal(p.firstPrices[0].adopted, true);
});

// ===================================================== the session stages
async function priced(chain) {
  const pend = await executed(chain);
  chain.send(OWNER, { address: V, functionName: 'setRefPrice', args: [ASTER, REF_ASTER] });
  return pend;
}
const T1 = { seq: 1, sell: 'AAA', sellAddress: AAA, buy: 'ASTER', buyAddress: ASTER, sellAmount: (100n * 10n ** 8n).toString(), duration: 1800, drain: false };
const T2 = { seq: 2, sell: 'CRV', sellAddress: CRV, buy: 'BBB', buyAddress: BBB, sellAmount: (4_000n * 10n ** 8n).toString(), duration: 1800, drain: true };

/** An earlier run: open, wait to the fair point, fill — and stop before recording. */
function earlierFill(chain, { sell, buy, amount, elapsed = 1170n, take = amount }) {
  const o = chain.send(OWNER, { address: V, functionName: 'openAuction', args: [sell, buy, amount, 1800n] });
  const id = BigInt(chain.head.state.auctions.length - 1);
  chain.timeOffset = elapsed - 1n;
  const fl = chain.send(OWNER, { address: V, functionName: 'fill', args: [id, take] });
  return { id, openTx: o.hash, fillTx: fl.hash };
}

test('fills: a mined fill missing from plan.fills is recorded as its planned seq and NOT traded again; a dry run only says so', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T1, T2] }));
  const { id, fillTx, openTx } = earlierFill(chain, { sell: AAA, buy: ASTER, amount: 100n * 10n ** 8n });
  const dry = ctxFor(chain, f, { live: false });
  let v = await readVault(dry.reader, V);
  const seqsDry = await reconcileSession(dry, v);
  assert.deepEqual([...seqsDry], [1]);
  assert.equal(loadPlan(f).fills.length, 0, 'a dry run writes nothing');
  const ctx = ctxFor(chain, f);
  v = await readVault(ctx.reader, V);
  const seqs = await reconcileSession(ctx, v, { cancelOrphans: true, halt: true });
  assert.deepEqual([...seqs], [1]);
  const p = loadPlan(f);
  assert.equal(p.fills.length, 1);
  const r = p.fills[0];
  assert.deepEqual([r.seq, r.round, r.auctionId, r.sell, r.buy, r.fillTx, r.openTx, r.adopted, r.elapsed], [1, 1, id.toString(), 'AAA', 'ASTER', fillTx, openTx, true, 1170]);
  // factor at 1,170 s of 1,800 with premium 200 and floor 100: 10000 + 200 − ⌊300·1170/1800⌋ = 10005 (inside the fair window)
  assert.equal(r.factorBps, 10_005);
  // The auction filled completely is closed: no orphan cancel was sent.
  assert.equal(chain.sent.at(-1).hash, fillTx);
  // A second pass records nothing new.
  await reconcileSession(ctxFor(chain, f), v);
  assert.equal(loadPlan(f).fills.length, 1);
});

test('fills: under the fair policy an adopted fill outside the fair window HALTs (after it is recorded), like a fill made now', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T1] }));
  earlierFill(chain, { sell: AAA, buy: ASTER, amount: 100n * 10n ** 8n, elapsed: 60n }); // factor 10190: above the window
  const ctx = ctxFor(chain, f);
  await assert.rejects(reconcileSession(ctx, await readVault(ctx.reader, V), { halt: true }), /HALT: adopted fill .* factor 10190/);
  assert.equal(loadPlan(f).fills.length, 1, 'recorded before the HALT');
});

test('fills: two planned trades with the fill\'s pair → REFUSED (record it by hand); a fill of no planned pair → adopted-<id>', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T1, { ...T1, seq: 3 }] }));
  earlierFill(chain, { sell: AAA, buy: ASTER, amount: 10n * 10n ** 8n });
  const ctx = ctxFor(chain, f);
  await assert.rejects(reconcileSession(ctx, await readVault(ctx.reader, V)), (e) => isRefused(e) && /matches planned trades #1, #3/.test(e.message));
  const chain2 = newChain();
  const pend2 = await priced(chain2);
  const f2 = planOn(chain2, (p) => ({ ...p, announce: { pendingHash: pend2, tuple: p.announceTuple }, trades: [T1] }), 'plan2.json');
  const { id } = earlierFill(chain2, { sell: BBB, buy: ASTER, amount: 10n * 10n ** 8n });
  const ctx2 = ctxFor(chain2, f2);
  const seqs = await reconcileSession(ctx2, await readVault(ctx2.reader, V));
  assert.equal(seqs.size, 0);
  const r = loadPlan(f2).fills[0];
  assert.deepEqual([r.seq, r.round], [`adopted-${id}`, null]);
});

test('fills: a fill whose receipt never came — the re-run settles it from plan.sent and records it as its planned seq', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T1] }));
  chain.send(OWNER, { address: V, functionName: 'openAuction', args: [AAA, ASTER, 100n * 10n ** 8n, 1800n] });
  const id = BigInt(chain.head.state.auctions.length - 1);
  chain.timeOffset = 1169n;
  chain.mine();
  chain.receiptFails = 3;
  const ctx = ctxFor(chain, f);
  await assert.rejects(call(ctx, { who: 'bidder', to: V, functionName: 'fill', args: [id, 100n * 10n ** 8n], gas: 1n, what: 'fill #1 (auction 0)' }), /no receipt came back/);
  const hash = chain.sent.at(-1).hash;
  assert.equal(loadPlan(f).sent.at(-1).hash, hash);
  assert.equal(loadPlan(f).fills.length, 0);
  // The re-run: settle, then the auctions stage's reconciliation.
  const ctx2 = ctxFor(chain, f);
  await settleSent(ctx2);
  const seqs = await reconcileSession(ctx2, await readVault(ctx2.reader, V), { cancelOrphans: true, halt: true });
  assert.deepEqual([...seqs], [1], 'round 1 will skip #1');
  const r = loadPlan(f).fills[0];
  assert.deepEqual([r.seq, r.fillTx, r.adopted, r.factorBps], [1, hash, true, 10_005]);
  assert.equal(chain.sent.at(-1).hash, hash, 'nothing sent: the auction is closed, no orphan to cancel');
});

test('orphans: an auction an earlier run opened and never filled is cancelled before anything is opened (dry run: printed only)', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T1] }));
  chain.send(OWNER, { address: V, functionName: 'openAuction', args: [AAA, ASTER, 100n * 10n ** 8n, 1800n] });
  const id = BigInt(chain.head.state.auctions.length - 1);
  const n = chain.sent.length;
  const dry = ctxFor(chain, f, { live: false });
  await reconcileSession(dry, await readVault(dry.reader, V), { cancelOrphans: true });
  assert.equal(chain.sent.length, n);
  assert.ok(dry.lines.some((l) => /still open from an earlier run — a live run cancels it/.test(l)));
  const ctx = ctxFor(chain, f);
  await reconcileSession(ctx, await readVault(ctx.reader, V), { cancelOrphans: true });
  assert.equal(chain.sent.length, n + 1);
  assert.deepEqual([chain.sent.at(-1).functionName, chain.sent.at(-1).args[0]], ['cancelAuction', id]);
  assert.equal(chain.head.state.auctions[Number(id)].open, false);
  assert.ok(loadPlan(f).sent.at(-1).what.startsWith(`cancel auction ${id}`));
});

test('finalize: a removal out of the registry but not in plan.finalize is recorded from RemovalFinalized', async () => {
  const chain = newChain();
  const pend = await priced(chain);
  const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T2], fills: [] }));
  earlierFill(chain, { sell: CRV, buy: BBB, amount: 4_000n * 10n ** 8n });
  const fin = chain.send(OWNER, { address: V, functionName: 'finalizeRemoval', args: [CRV] });
  const ctx = ctxFor(chain, f);
  await reconcileSession(ctx, await readVault(ctx.reader, V));
  const p = loadPlan(f);
  assert.equal(p.finalize.length, 1);
  assert.deepEqual([p.finalize[0].symbol, p.finalize[0].txHash, p.finalize[0].adopted], ['CRV', fin.hash, true]);
  assert.equal(p.fills.length, 1, 'and the drain fill');
  assert.equal(p.fills[0].seq, 2);
});

// ============================================ one trade, end to end, lagging
test('runTrade on a lagging node: the same sent calls and the same plan records as on a clean node; the id comes from AuctionOpened', async () => {
  const runOn = async (lagReads) => {
    const chain = newChain();
    const pend = await priced(chain);
    // Another auction exists before ours: the id must be 1, from the event.
    chain.send(OWNER, { address: V, functionName: 'openAuction', args: [BBB, AAA, 10n, 1800n] });
    chain.send(OWNER, { address: V, functionName: 'cancelAuction', args: [0n] });
    const f = planOn(chain, (p) => ({ ...p, announce: { pendingHash: pend, tuple: p.announceTuple }, trades: [T1, T2] }));
    chain.lagReads = lagReads;
    const ctx = ctxFor(chain, f);
    const n0 = chain.sent.length;
    const v = await readVault(ctx.reader, V);
    await runTrade(ctx, v, T1, 1);
    chain.lagNow(0); // the harness's own read below is not under test
    await runTrade(ctx, await readVault(ctx.reader, V), T2, 1); // a drain: fill, balance 0, finalize at once
    return { sent: chain.sent.slice(n0).map((s) => ({ fn: s.functionName, args: s.args.map(String), gas: String(s.gas) })), plan: loadPlan(f), chain, ctx };
  };
  const clean = await runOn(0);
  const lag = await runOn(5);
  assert.deepEqual(lag.sent, clean.sent, 'what is sent is the same');
  assert.deepEqual(clean.sent.map((s) => s.fn), ['openAuction', 'setRefPrice', 'setRefPrice', 'fill', 'openAuction', 'setRefPrice', 'setRefPrice', 'fill', 'finalizeRemoval']);
  assert.equal(clean.sent[3].args[0], '1', 'fill(1, …): the id from AuctionOpened');
  const norm = (p) => ({ fills: p.fills.map((x) => ({ ...x, openTx: null, fillTx: null })), finalize: p.finalize.map((x) => ({ ...x, txHash: null })) });
  assert.deepEqual(norm(lag.plan), norm(clean.plan));
  assert.equal(clean.plan.fills.length, 2);
  assert.equal(clean.plan.finalize[0].symbol, 'CRV');
  assert.deepEqual(clean.plan.finalize[0].order, [AAA, BBB, ASTER]);
  assert.ok(lag.chain.reads > clean.chain.reads);
});

test('call(): a simulation after a write runs at a block ≥ the last receipt — a lagging node cannot fake a revert; a real revert is still refused', async () => {
  const chain = newChain();
  await priced(chain);
  const f = planOn(chain);
  const ctx = ctxFor(chain, f);
  // Our post moves the reference; the next post is only in band from the NEW value.
  await call(ctx, { who: 'keeper', to: V, functionName: 'setRefPrice', args: [AAA, (REF_AAA * 114n) / 100n], gas: 1n, what: 'post 1' });
  chain.lagReads = 3;
  chain.lagNow(3); // the next reads come from a node one block behind (the old reference)
  await call(ctx, { who: 'keeper', to: V, functionName: 'setRefPrice', args: [AAA, (REF_AAA * 128n) / 100n], gas: 1n, what: 'post 2' });
  assert.equal(chain.head.state.refPrice[AAA.toLowerCase()], (REF_AAA * 128n) / 100n);
  await assert.rejects(call(ctx, { who: 'keeper', to: V, functionName: 'setRefPrice', args: [AAA, REF_AAA * 2n], gas: 1n, what: 'post 3' }), (e) => isRefused(e) && /NavMoveTooLarge/.test(e.message));
});
