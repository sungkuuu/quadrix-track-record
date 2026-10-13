/**
 * The two announce shapes of QuadrixBasketVault (keeper/basket-plan.mjs
 * ANNOUNCE_ABI): the deployed index baskets announce (adds, removes,
 * decisionSha256); a vault built from the hardened source announces (adds,
 * addRefPrices, removes, decisionSha256) and emits a five-argument
 * RegistryChangeAnnounced. Against two fake vaults (keeper/test/fake-chain.mjs,
 * one per shape): the shape read from the code, the announce encoding, the
 * event decoding, the plan file's fields, and the priced-adds stages
 * (announce gate, first post in the band of the committed price, the
 * auctions guard). No network, no key.
 *
 *   node --test keeper/test/vault-shapes.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, decodeFunctionData, encodeFunctionData, parseEventLogs, keccak256, encodeAbiParameters } from 'viem';
import {
  VAULT_ABI, ANNOUNCE_ABI, SHAPE_MARKERS, vaultAbiFor, vaultAbiFromCode, detectVaultAbi, announceTupleFor,
  committedBandNote, savePlan, loadPlan, toRefPrice, decimalsByPrice, buildPlan,
} from '../basket-plan.mjs';
import { READ_TIMING } from '../readback.mjs';
import { stageAnnounce, stageExecute, stageFirstPrices, stageAuctions, requireSizingBeforeExecute, pricedTupleProblems, committedPostRefusal, vaultShape } from '../basket-recon.mjs';
import { FakeChain } from './fake-chain.mjs';

READ_TIMING.stepMs = 2;
READ_TIMING.waitMs = 400;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = getAddress('0x88d3b5f638fe0d331797c612a5496bd8f0491fd4');
const OWNER = getAddress('0x8c23d05ea268a9c183ee033cf07cfec38d0f7902');
const AAA = getAddress('0x1111111111111111111111111111111111111111');
const BBB = getAddress('0x2222222222222222222222222222222222222222');
const CRV = getAddress('0x0581ba8a63d787b4a39ed898445b1bfdde84bdf6');
const ASTER = getAddress('0xf96360330e54e861b4b95faa023a77daddcf6511');
const NEWT = getAddress('0x3333333333333333333333333333333333333333');
const SHA = 'ab'.repeat(32);
const REF_AAA = toRefPrice(10, 8);
const REF_BBB = toRefPrice(2, 8);
const REF_CRV = toRefPrice(0.5, 8);
const REF_ASTER = toRefPrice(1.2, 8);
const REF_NEWT = toRefPrice(3, 8);
const isRefused = (e) => e?.constructor?.name === 'Refused';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-shapes-')); });

function newChain(shape) {
  const c = new FakeChain({
    vault: V, owner: OWNER, shape,
    assets: [
      { address: AAA, symbol: 'mAAA', decimals: 8, balance: 1_000n * 10n ** 8n, ref: REF_AAA, registry: true },
      { address: BBB, symbol: 'mBBB', decimals: 8, balance: 5_000n * 10n ** 8n, ref: REF_BBB, registry: true },
      { address: CRV, symbol: 'mCRV', decimals: 8, balance: 4_000n * 10n ** 8n, ref: REF_CRV, registry: true },
      { address: ASTER, symbol: 'mASTER', decimals: 8, balance: 0n },
      { address: NEWT, symbol: 'mNEWT', decimals: 8, balance: 0n },
    ],
  });
  c.head.state.bidders[OWNER.toLowerCase()] = true;
  return c;
}

/** A plan as basket-plan.mjs writes it: adds in book order (ASTER before
 *  NEWT, i.e. NOT ascending), the tuple for the vault's shape. */
function basePlan(chain, shape) {
  const adds = [
    { symbol: 'ASTER', address: ASTER, decimals: 8, priceA: 1.2, priceB: 1.205, disagreementBps: 42, firstRefPrice: REF_ASTER.toString() },
    { symbol: 'NEWT', address: NEWT, decimals: 8, priceA: 3, priceB: 3.01, disagreementBps: 33, firstRefPrice: REF_NEWT.toString() },
  ];
  return {
    index: 'qdefi', date: new Date().toISOString().slice(0, 10), chainId: 91342, vault: V, vaultAbi: shape,
    block: { number: chain.head.number.toString(), timestamp: chain.head.timestamp.toString() },
    registry: [
      { symbol: 'AAA', address: AAA, planRefPrice: REF_AAA.toString() },
      { symbol: 'BBB', address: BBB, planRefPrice: REF_BBB.toString() },
      { symbol: 'CRV', address: CRV, planRefPrice: REF_CRV.toString(), inRemoval: false },
    ],
    adds,
    removes: [{ symbol: 'CRV', address: CRV, balance: (4_000n * 10n ** 8n).toString() }],
    announceTuple: announceTupleFor({ shape, adds, removes: [CRV], decisionSha256: SHA }),
    announce: null, decisionSha256: SHA, notes: [], trades: [], fills: [], finalize: [], firstPrices: [], targets: [],
    policy: { duration: 1800, minTradeUsd: 1, tolerancePoints: 5, firstPriceTolBps: 200 },
  };
}

function ctxFor(chain, planFile, opts = {}) {
  const ledger = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({ id: '2099-01-01-qdefi-test', file: 'decisions/2099-01-01-qdefi-test.md', sha256: SHA, txHash: '0xtest', anchoredAt: 'test' }) + '\n');
  const reader = chain.reader();
  const wallet = chain.wallet(OWNER);
  const lines = [];
  return {
    o: { index: 'qdefi', stage: 'test', decisions: ledger, allowPlanDate: true, fill: 'fair', fairWindowBps: 10, firstPriceTol: 0.02, refDriftTol: 0.05, warp: true, faucet: true, maxFaucetCalls: 60, maxRounds: 3, ...opts },
    log: (m) => lines.push(m), lines,
    plan: loadPlan(planFile), planFile, reader, pc: reader.publicClient, devNode: true,
    keeperAddr: OWNER, keeperWallet: wallet, bidderAddr: OWNER, bidderWallet: wallet, live: true, hook: null,
    pendingThisRun: new Set(), floor: 0n, receipts: new Map(), events: null,
  };
}
function planOn(chain, shape, mutate = (p) => p, name = 'plan.json') {
  const f = path.join(dir, name);
  savePlan(f, mutate(basePlan(chain, shape)));
  return f;
}
const tupleHash = (adds, removes, sha) => keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'address[]' }, { type: 'bytes32' }], [adds, removes, sha]));

// ============================================================ the shapes
test('the markers are the two signatures measured on chain', () => {
  assert.equal(SHAPE_MARKERS['unpriced-adds'].selector, '0xe13b5641', 'announceRegistryChange(address[],address[],bytes32)');
  assert.equal(SHAPE_MARKERS['priced-adds'].selector, '0x560c659b', 'announceRegistryChange(address[],uint256[],address[],bytes32)');
  assert.equal(SHAPE_MARKERS['unpriced-adds'].topic, '0x0f24ab2a2024de3e9dd0647addb8afd663c8d2ad1f8550caf663904be65ee317');
  assert.equal(SHAPE_MARKERS['priced-adds'].topic, '0x859c59013ff1bc8e89beca35ebff6d434e2ddd86b3bcd2b795c63df2f1f364e0');
  assert.ok(!VAULT_ABI.some((x) => x.type === 'function' && x.name === 'announceRegistryChange'), 'VAULT_ABI carries no announce: a call must pick its shape');
  assert.equal(VAULT_ABI.filter((x) => x.type === 'event' && x.name === 'RegistryChangeAnnounced').length, 2, 'both event shapes decode');
});

test('the shape is read from the code: one shape\'s two markers, else refused', async () => {
  const m = SHAPE_MARKERS;
  const code = (k) => `0x60806040${'63'}${m[k].selector.slice(2)}${'7f'}${m[k].topic.slice(2)}`;
  assert.equal(vaultAbiFromCode(code('unpriced-adds')), 'unpriced-adds');
  assert.equal(vaultAbiFromCode(code('priced-adds')), 'priced-adds');
  assert.equal(vaultAbiFromCode(code('unpriced-adds') + code('priced-adds').slice(2)), null, 'both shapes: ambiguous');
  assert.equal(vaultAbiFromCode(`0x63${m['priced-adds'].selector.slice(2)}`), null, 'a selector without its event topic is not enough');
  assert.equal(vaultAbiFromCode('0x6080'), null);
  for (const shape of ['unpriced-adds', 'priced-adds']) assert.equal(await detectVaultAbi(newChain(shape).client(), V), shape);
  const pc = (answers) => ({ getCode: async () => answers.shift() });
  assert.equal(await detectVaultAbi(pc(['0x', undefined, code('priced-adds')]), V, { waitMs: 1 }), 'priced-adds', 'an empty answer is asked again');
  await assert.rejects(detectVaultAbi(pc(['0x', '0x']), V, { tries: 2, waitMs: 1 }), /no contract code/);
  await assert.rejects(detectVaultAbi(pc(['0x6080']), V), /not a QuadrixBasketVault this keeper knows/);
});

// =========================================================== encodings
test('announce encodes per shape: three arguments, or four with the prices', () => {
  const t = announceTupleFor({ shape: 'priced-adds', adds: basePlan(newChain('priced-adds'), 'priced-adds').adds, removes: [CRV], decisionSha256: SHA });
  const oldData = encodeFunctionData({ abi: vaultAbiFor('unpriced-adds'), functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.decisionSha256] });
  const newData = encodeFunctionData({ abi: vaultAbiFor('priced-adds'), functionName: 'announceRegistryChange', args: [t.adds, t.addRefPrices, t.removes, t.decisionSha256] });
  assert.ok(oldData.startsWith('0xe13b5641'));
  assert.ok(newData.startsWith('0x560c659b'));
  const back = decodeFunctionData({ abi: ANNOUNCE_ABI['priced-adds'], data: newData });
  assert.deepEqual(back.args, [t.adds, t.addRefPrices, t.removes, t.decisionSha256]);
  assert.throws(() => encodeFunctionData({ abi: vaultAbiFor('priced-adds'), functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.decisionSha256] }));
});

test('the plan tuple: unpriced-adds keeps the plan order; priced-adds sorts adds (prices alongside) and removes ascending', () => {
  const adds = basePlan(newChain('priced-adds'), 'priced-adds').adds; // ASTER (0xf9…) before NEWT (0x33…)
  const u = announceTupleFor({ shape: 'unpriced-adds', adds, removes: [CRV, BBB], decisionSha256: SHA });
  assert.deepEqual(u, { adds: [ASTER, NEWT], removes: [CRV, BBB], decisionSha256: `0x${SHA}` });
  const p = announceTupleFor({ shape: 'priced-adds', adds, removes: [CRV, BBB], decisionSha256: SHA });
  assert.deepEqual(p, { adds: [NEWT, ASTER], addRefPrices: [REF_NEWT, REF_ASTER], removes: [CRV, BBB].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)), decisionSha256: `0x${SHA}` });
  assert.deepEqual(p.removes, [CRV, BBB], '0x0581… < 0x2222…');
  assert.deepEqual(Object.keys(p), ['adds', 'addRefPrices', 'removes', 'decisionSha256']);
});

test('the event decodes on both shapes with the same tuple hash; the priced one carries addRefPrices', async () => {
  for (const shape of ['unpriced-adds', 'priced-adds']) {
    const chain = newChain(shape);
    const f = planOn(chain, shape);
    await stageAnnounce(ctxFor(chain, f));
    const [ev] = parseEventLogs({ abi: VAULT_ABI, logs: chain.logs, eventName: 'RegistryChangeAnnounced' });
    const t = loadPlan(f).announceTuple;
    assert.deepEqual(ev.args.adds, t.adds.map((a) => getAddress(a)));
    assert.equal(tupleHash(ev.args.adds, ev.args.removes, ev.args.decisionSha256), chain.head.state.pending, `${shape}: keccak(adds, removes, sha) is the pending hash`);
    if (shape === 'priced-adds') assert.deepEqual(ev.args.addRefPrices, [REF_NEWT, REF_ASTER]);
    else assert.equal(ev.args.addRefPrices, undefined);
    assert.equal(chain.sent[0].args.length, shape === 'priced-adds' ? 4 : 3);
  }
});

// ============================================================== announce
test('priced-adds announce: sorted tuple with the committed prices sent, recorded, and readable on chain', async () => {
  const chain = newChain('priced-adds');
  const f = planOn(chain, 'priced-adds');
  const ctx = ctxFor(chain, f);
  await stageAnnounce(ctx);
  assert.equal(chain.sent.length, 1);
  assert.deepEqual(chain.sent[0].args, [[NEWT, ASTER], [REF_NEWT, REF_ASTER], [CRV], `0x${SHA}`]);
  const p = loadPlan(f);
  assert.deepEqual(p.announce.tuple, { adds: [NEWT, ASTER], addRefPrices: [REF_NEWT.toString(), REF_ASTER.toString()], removes: [CRV], decisionSha256: `0x${SHA}` });
  assert.deepEqual(p.announceTuple, p.announce.tuple);
  assert.equal(p.announce.pendingHash, chain.head.state.pending);
  assert.equal(chain.head.state.refPrice[ASTER.toLowerCase()], REF_ASTER);
  assert.ok(ctx.lines.some((l) => /priced-adds: committing first references NEWT \d+, ASTER \d+/.test(l)));
});

test('priced-adds announce refuses before sending: order, missing prices, a price that is not the plan\'s, the two-source gate, a plan not made today', async () => {
  const cases = [
    ['adds not ascending', (p) => ({ ...p, announceTuple: { ...p.announceTuple, adds: [ASTER, NEWT], addRefPrices: [REF_ASTER.toString(), REF_NEWT.toString()] } }), {}, /adds not in strictly ascending address order/],
    ['no prices (a plan for the other shape)', (p) => ({ ...p, announceTuple: { adds: p.announceTuple.adds, removes: p.announceTuple.removes, decisionSha256: p.announceTuple.decisionSha256 } }), {}, /no addRefPrices in the tuple/],
    ['a price that is not firstRefPrice', (p) => ({ ...p, announceTuple: { ...p.announceTuple, addRefPrices: [(REF_NEWT + 1n).toString(), REF_ASTER.toString()] } }), {}, /NEWT: addRefPrice \d+ != the plan's firstRefPrice/],
    ['sources 5% apart', (p) => ({ ...p, adds: p.adds.map((a) => (a.symbol === 'ASTER' ? { ...a, priceB: 1.26 } : a)) }), {}, /ASTER: sources disagree by 5\.00% .* committed at the announcement/],
    ['plan not made today', (p) => ({ ...p, date: '2026-01-01' }), { allowPlanDate: false }, /not generated today .* commits each add's first reference/],
  ];
  for (const [name, mutate, opts, re] of cases) {
    const chain = newChain('priced-adds');
    const f = planOn(chain, 'priced-adds', mutate, `${name.replace(/\W+/g, '-')}.json`);
    await assert.rejects(stageAnnounce(ctxFor(chain, f, opts)), (e) => isRefused(e) && re.test(e.message), name);
    assert.equal(chain.sent.length, 0, `${name}: nothing sent`);
  }
});

test('a plan for one shape is refused on a vault of the other', async () => {
  const a = newChain('priced-adds');
  const fa = planOn(a, 'priced-adds', (p) => { const { vaultAbi, ...rest } = p; return { ...rest, announceTuple: announceTupleFor({ shape: 'unpriced-adds', adds: p.adds, removes: [CRV], decisionSha256: SHA }) }; });
  await assert.rejects(stageAnnounce(ctxFor(a, fa)), (e) => isRefused(e) && /is a priced-adds vault .* made for unpriced-adds \(no vaultAbi in the plan/.test(e.message));
  const b = newChain('unpriced-adds');
  const fb = planOn(b, 'priced-adds');
  await assert.rejects(vaultShape(ctxFor(b, fb)), (e) => isRefused(e) && /is a unpriced-adds vault .* made for priced-adds/.test(e.message));
  assert.equal(a.sent.length + b.sent.length, 0);
});

test('priced-adds announce mined but not recorded: the re-run adopts it with the prices from the event', async () => {
  const chain = newChain('priced-adds');
  const t = basePlan(chain, 'priced-adds').announceTuple;
  chain.send(OWNER, { address: V, functionName: 'announceRegistryChange', args: [t.adds, t.addRefPrices, t.removes, t.decisionSha256] });
  const f = planOn(chain, 'priced-adds');
  await stageAnnounce(ctxFor(chain, f));
  const p = loadPlan(f);
  assert.equal(p.announce.adopted, true);
  assert.deepEqual(p.announce.tuple.addRefPrices, [REF_NEWT.toString(), REF_ASTER.toString()]);
  assert.equal(chain.sent.length, 1, 'nothing sent by the re-run');
});

// ======================================================= day 7, priced
async function announcedAndDue(chain, f) {
  await stageAnnounce(ctxFor(chain, f));
  chain.timeOffset = chain.head.state.registryDelay + 10n;
  chain.mine();
}

test('priced-adds day 7: the band of the committed price is checked before execute; nothing is sent when today\'s price is outside it', async () => {
  const chain = newChain('priced-adds');
  const f = planOn(chain, 'priced-adds');
  await announcedAndDue(chain, f);
  const p = loadPlan(f);
  // Day 7: ASTER 20% higher than when it was committed.
  const up = 1.2 * 1.2;
  p.adds = p.adds.map((a) => (a.symbol === 'ASTER' ? { ...a, priceA: up, priceB: up * 1.001, firstRefPrice: toRefPrice(up, 8).toString() } : a));
  savePlan(f, p);
  const n = chain.sent.length;
  await assert.rejects(requireSizingBeforeExecute(ctxFor(chain, f)), (e) => isRefused(e) && /ASTER: today's first reference \d+ is 20\.00% from the \d+ committed at the announcement, outside the contract's ±15% band/.test(e.message));
  assert.equal(chain.sent.length, n);
  // Inside the band (+5%): passes.
  const in5 = 1.2 * 1.05;
  p.adds = p.adds.map((a) => (a.symbol === 'ASTER' ? { ...a, priceA: in5, priceB: in5, firstRefPrice: toRefPrice(in5, 8).toString() } : a));
  savePlan(f, p);
  await requireSizingBeforeExecute(ctxFor(chain, f));
});

test('priced-adds day 7: execute → the auctions refuse until the first post → first-prices posts even at the committed price → re-run sends nothing', async () => {
  const chain = newChain('priced-adds');
  const f = planOn(chain, 'priced-adds');
  await announcedAndDue(chain, f);
  await stageExecute(ctxFor(chain, f));
  assert.equal(chain.head.state.refPrice[ASTER.toLowerCase()], REF_ASTER, 'entered at the committed price');
  assert.equal(chain.head.state.refAt[ASTER.toLowerCase()], 0n, 'never posted');
  await assert.rejects(stageAuctions(ctxFor(chain, f)), (e) => isRefused(e) && /never posted since admission \(committed price only\): NEWT, ASTER — run first-prices/.test(e.message));
  const n = chain.sent.length;
  const ctx = ctxFor(chain, f);
  await stageFirstPrices(ctx);
  assert.equal(chain.sent.length, n + 2, 'one post per add, although today\'s price equals the committed one');
  assert.deepEqual(chain.sent.slice(-2).map((x) => [x.functionName, x.args[0], x.args[1]]), [['setRefPrice', ASTER, REF_ASTER], ['setRefPrice', NEWT, REF_NEWT]]);
  assert.ok(chain.head.state.refAt[ASTER.toLowerCase()] > 0n);
  assert.ok(ctx.lines.some((l) => /ASTER: entered at the reference committed at the announcement/.test(l)));
  assert.ok(!ctx.lines.some((l) => /BAND-FREE/.test(l)), 'no band-free post on this vault');
  assert.deepEqual(loadPlan(f).firstPrices.map((x) => x.symbol), ['ASTER', 'NEWT']);
  await stageFirstPrices(ctxFor(chain, f));
  assert.equal(chain.sent.length, n + 2, 'already posted: skipped');
});

test('committedPostRefusal and committedBandNote: the same ±15% band, in the executor and in the plan', () => {
  const add = { symbol: 'ASTER', decimals: 8, priceA: 1.2, firstRefPrice: REF_ASTER };
  assert.equal(committedPostRefusal(add, REF_ASTER, REF_ASTER), null);
  assert.match(committedPostRefusal(add, 0n, null), /no committed first reference on chain/);
  assert.match(committedPostRefusal(add, REF_ASTER + 1n, REF_ASTER), /is not the \d+ the announcement committed/);
  const at = (p) => ({ ...add, priceA: p, firstRefPrice: toRefPrice(p, 8), committedRefPrice: REF_ASTER });
  assert.equal(committedPostRefusal(at(1.2 * 1.149), REF_ASTER, REF_ASTER), null);
  assert.match(committedPostRefusal(at(1.2 * 1.151), REF_ASTER, REF_ASTER), /outside the contract's ±15% band/);
  assert.equal(committedBandNote([at(1.2 * 1.149)]), null);
  assert.match(committedBandNote([at(1.2 * 0.84)]), /^committed-price band: ASTER 16\.00% between today's first reference and the one committed/);
  assert.deepEqual(pricedTupleProblems({ adds: [NEWT, ASTER], prices: [REF_NEWT, REF_ASTER], removes: [CRV] }, basePlan(newChain('priced-adds'), 'priced-adds').adds), []);
  assert.match(pricedTupleProblems({ adds: [NEWT, ASTER], prices: [REF_NEWT], removes: [] }, []).join(), /1 addRefPrices for 2 adds/);
  assert.match(pricedTupleProblems({ adds: [NEWT], prices: [10n ** 30n + 1n], removes: [] }, []).join(), /outside \(0, 1e30\]/);
  assert.match(pricedTupleProblems({ adds: [], prices: [], removes: [CRV, CRV] }, []).join(), /removes not in strictly ascending/);
});

// ========================================================= the plan file
test('buildPlan writes vaultAbi and the tuple for the vault\'s shape (adds with prices, ascending) — both fake vaults', async () => {
  const date = '2099-01-02';
  const rb = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'rulebooks', 'qdefi.json'), 'utf8')).basket;
  const reg = ['HYPE', 'LINK', 'UNI', 'AAVE', 'ONDO'].map((s) => ({ symbol: s, address: getAddress(rb.assets[s].address), decimals: rb.assets[s].decimals }));
  const px = { HYPE: 40, LINK: 20, UNI: 8, AAVE: 150, ONDO: 1, ZZA: 2.5, ZZB: 0.75 };
  // ZZA at a higher address than ZZB, and first in the book: priced-adds must sort them.
  const ZZA = getAddress('0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed');
  const ZZB = getAddress('0x0000000000000000000000000000000000c0ffee');
  const cacheDir = path.join(HERE, '..', 'cache');
  const cacheFile = path.join(cacheDir, `cg-markets-top500-${date}.json`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(Object.entries(px).map(([symbol, price]) => ({ id: symbol.toLowerCase(), symbol, price }))));
  try {
    const bFile = path.join(dir, 'prices-b.json');
    fs.writeFileSync(bFile, JSON.stringify(Object.fromEntries(Object.entries(px).map(([s, p]) => [s, p * 1.001]))));
    const book = path.join(dir, 'state-qdefi.json');
    fs.writeFileSync(book, JSON.stringify({ units: { HYPE: 10, LINK: 20, AAVE: 3, ZZA: 100, ZZB: 300 } }));
    const mocks = path.join(dir, 'mocks.json');
    fs.writeFileSync(mocks, JSON.stringify({ qdefi: { ZZA: { address: ZZA, decimals: decimalsByPrice(px.ZZA) }, ZZB: { address: ZZB, decimals: decimalsByPrice(px.ZZB) } } }));
    const ledger = path.join(dir, 'decisions.jsonl');
    fs.writeFileSync(ledger, JSON.stringify({ id: `${date}-qdefi-basket-reconstitution`, file: `decisions/${date}-qdefi-basket-reconstitution.md`, sha256: SHA, txHash: '0xtest', anchoredAt: 'test' }) + '\n');
    const out = {};
    for (const shape of ['unpriced-adds', 'priced-adds']) {
      const chain = new FakeChain({
        vault: getAddress(rb.vault), owner: OWNER, shape,
        assets: [
          ...reg.map((r) => ({ address: r.address, symbol: `m${r.symbol}`, decimals: r.decimals, balance: BigInt(Math.round((1000 / px[r.symbol]) * 10 ** r.decimals)), ref: toRefPrice(px[r.symbol], r.decimals), registry: true })),
          { address: ZZA, symbol: 'mZZA', decimals: decimalsByPrice(px.ZZA) },
          { address: ZZB, symbol: 'mZZB', decimals: decimalsByPrice(px.ZZB) },
        ],
      });
      const log = console.log;
      console.log = () => {};
      try {
        await buildPlan({
          index: 'qdefi', date, rpc: 'fake', chainId: 91342, reader: chain.reader(),
          pending: path.join(dir, 'no-pending.json'), book, mocks, pricesB: bFile, decisions: ledger, decision: `${date}-qdefi-basket-reconstitution`,
          duration: 1800, out: path.join(dir, `plan-${shape}.json`), noFetch: true, reweightBlock: false,
        });
      } finally { console.log = log; }
      out[shape] = loadPlan(path.join(dir, `plan-${shape}.json`));
    }
    const u = out['unpriced-adds'];
    const p = out['priced-adds'];
    assert.equal(u.vaultAbi, 'unpriced-adds');
    assert.equal(p.vaultAbi, 'priced-adds');
    assert.deepEqual(u.adds.map((a) => a.symbol), ['ZZA', 'ZZB'], 'book order');
    assert.deepEqual(u.announceTuple, { adds: [ZZA, ZZB], removes: [reg[2].address, reg[4].address], decisionSha256: `0x${SHA}` }, 'unpriced: as before (plan order, no prices)');
    const zz = Object.fromEntries(p.adds.map((a) => [a.symbol, a]));
    assert.deepEqual(p.announceTuple, {
      adds: [ZZB, ZZA],
      addRefPrices: [zz.ZZB.firstRefPrice, zz.ZZA.firstRefPrice],
      removes: [reg[4].address, reg[2].address], // ONDO 0x8361… < UNI 0xecc5…
      decisionSha256: `0x${SHA}`,
    });
    assert.equal(zz.ZZA.firstRefPrice, toRefPrice(px.ZZA, decimalsByPrice(px.ZZA)).toString(), 'addRefPrice = firstRefPrice = toRefPrice(source A, mock decimals)');
    assert.ok(p.notes.some((n) => /announceTuple\.addRefPrices\[i\] = that add's firstRefPrice/.test(n)));
    assert.ok(!u.notes.some((n) => /priced-adds/.test(n)));
  } finally {
    fs.rmSync(cacheFile, { force: true });
  }
});
