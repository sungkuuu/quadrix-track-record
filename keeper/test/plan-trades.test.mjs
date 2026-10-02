/**
 * computeTrades (keeper/basket-plan.mjs) — the block rule of the planner
 * spec of 2026-10-01: a marked name trades its whole block to the book's
 * weights, paid for by the block's own value, because the book re-weights
 * every name of the block (paper-index.mjs renormaliseBook; the Triens
 * Quality sleeve by its own factor; qX20 every name). Before this, the
 * planner shared only the value of the marked names, so an entering name
 * with a zero balance was planned at 0% (qTRI AERO) and every basket bought
 * its entering names short of the book.
 *
 * Numbered as in the spec's §4. Cases 6, 7, 8 and 15 must return what the
 * planner on main (6036647) returned; those outputs are pinned as literals
 * below. Also: the executor's verification bound (basket-recon.mjs
 * residualBound) against fills at the edges of the fair window.
 *
 *   node --test keeper/test/plan-trades.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeTrades, planRows, toRefPrice, untradedGapNote, BLOCK_ON_RULE_MARKS, BLOCK_REASON } from '../basket-plan.mjs';
import { residual, residualBound, sizingRefOf, VERIFY_FIXED_POINTS } from '../basket-recon.mjs';
import { cases, savedRows, applyFills, sig, E18, RANKED } from './plan-trades.cases.mjs';

const SAVED = JSON.parse(fs.readFileSync(new URL('./fixtures/plan-trades-2026-10-01.json', import.meta.url), 'utf8')).baskets;
const usd = (x) => Number(x) / 1e18;
const post = (res) => Object.fromEntries(res.expectedPostTradeWeights.map((w) => [w.symbol, w.weight]));
const aim = (res) => Object.fromEntries(res.targets.map((t) => [t.symbol, t.tradeTargetWeight]));
const tradedSet = (res) => res.targets.filter((t) => t.traded).map((t) => t.symbol);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
/** Weights from balances × refs. */
const weightsOf = (rows) => {
  const tot = rows.reduce((t, r) => t + Number(r.balance * r.ref), 0);
  return Object.fromEntries(rows.map((r) => [r.symbol, Number(r.balance * r.ref) / tot]));
};

test('defaults: the block rule on rule marks is the spec rule; verification uses the computed bound', () => {
  assert.equal(BLOCK_ON_RULE_MARKS, true);
  assert.equal(VERIFY_FIXED_POINTS, null);
});

test('1. a new name alone, zero balance, nothing else marked (the qTRI AERO defect): auctions buy it to its target', () => {
  const { rows, policy } = cases.newNameAlone();
  const res = computeTrades(rows, policy);
  // main planned no auction at all here (traded [NEW], trades [])
  assert.ok(res.trades.length > 0);
  assert.ok(res.trades.every((t) => t.buy === 'NEW'));
  // sleeves on target: the Quality sleeve is 30% of the vault, NEW is 4% of the sleeve in the book
  near(aim(res).NEW, 0.012, 1e-12, 'aim');
  near(post(res).NEW, 0.012, 1e-9, 'post');
  for (const s of ['Q1', 'Q2', 'Q3']) assert.deepEqual(res.targets.find((t) => t.symbol === s).reason, BLOCK_REASON);
});

test('2. ranked basket + an add: every name traded, every weight after the fills is the book weight', () => {
  const { rows, policy } = cases.rankedAdd();
  const res = computeTrades(rows, policy);
  assert.deepEqual(tradedSet(res).sort(), ['A', 'B', 'C', 'D']);
  for (const r of rows) near(post(res)[r.symbol], r.targetWeight, 1e-9, r.symbol);
  assert.ok(res.notes.some((n) => /^block rule: every name of the basket/.test(n)));
});

test('3. add + removal: the removal goes to zero, its last slice drains, a split removal is counted once', () => {
  const { rows, policy } = cases.rankedAddRemove();
  const res = computeTrades(rows, policy);
  const X = rows.find((r) => r.symbol === 'X');
  const xs = res.trades.filter((t) => t.sell === 'X');
  assert.ok(xs.length >= 2, 'the removal is split over two buys');
  assert.equal(xs.at(-1).drain, true);
  assert.ok(xs.slice(0, -1).every((t) => !t.drain));
  assert.equal(xs.reduce((t, x) => t + x.sellAmount, 0n), X.balance);
  assert.equal(post(res).X, 0);
  for (const r of rows.filter((x) => !x.isRemove)) near(post(res)[r.symbol], r.targetWeight, 1e-9, r.symbol);
  near(Object.values(post(res)).reduce((a, b) => a + b, 0), 1, 1e-12);
});

test('4. qX20 shape (signs mixed): value sold = value bought at fair, auctions ≤ sellers + buyers − 1', () => {
  const fx = SAVED.qx20;
  const rows = savedRows(fx);
  const res = computeTrades(rows, fx.policy);
  const ref = Object.fromEntries(rows.map((r) => [r.symbol, r.ref]));
  const sold = res.trades.reduce((t, x) => t + x.sellAmount * ref[x.sell], 0n);
  const boughtFair = res.trades.reduce((t, x) => t + x.expectedBuyAtFair * ref[x.buy], 0n);
  assert.ok(boughtFair >= sold);
  assert.ok(boughtFair - sold <= res.trades.reduce((t, x) => t + ref[x.buy], 0n), 'at most one base unit of each buy from rounding up');
  const sellers = new Set(res.trades.map((t) => t.sell));
  const buyers = new Set(res.trades.map((t) => t.buy));
  assert.ok(res.trades.length <= sellers.size + buyers.size - 1);
  assert.equal(sellers.size, 19);
  assert.equal(buyers.size, 4);
});

test('5. sleeve, no reset, a Quality add: BTC and WC untouched, every Quality name traded, the sleeve keeps its value', () => {
  for (const [label, { rows, policy }] of [['synthetic', cases.newNameAlone()], ['qTRI 2026-10-01', { rows: savedRows(SAVED.triens), policy: SAVED.triens.policy }]]) {
    const res = computeTrades(rows, policy);
    const q = rows.filter((r) => r.sleeve === 'quality').map((r) => r.symbol);
    const other = rows.filter((r) => r.sleeve !== 'quality').map((r) => r.symbol);
    assert.deepEqual(tradedSet(res).sort(), [...q].sort(), label);
    assert.ok(res.trades.every((t) => !other.includes(t.sell) && !other.includes(t.buy)), `${label}: no trade touches ${other.join(', ')}`);
    const after = applyFills(rows, res.trades);
    for (const s of other) assert.equal(after.find((r) => r.symbol === s).balance, rows.find((r) => r.symbol === s).balance, `${label} ${s}`);
    const val = (rs) => rs.filter((r) => r.sleeve === 'quality').reduce((t, r) => t + r.balance * r.ref, 0n);
    const lost = val(rows) - val(after);
    assert.ok(lost <= 0n && -lost <= rows.reduce((t, r) => t + r.ref, 0n) * BigInt(res.trades.length), `${label}: Quality value kept (fair fills round up in the vault's favour)`);
  }
});

test('6. sleeve reset: every name, exactly as on main', () => {
  const { rows, policy } = cases.sleeveReset();
  const res = computeTrades(rows, policy);
  assert.deepEqual(tradedSet(res), ['BTC', 'WC', 'Q1', 'Q2']);
  assert.deepEqual(sig(res.trades), [['BTC', 'WC', '100000000000000', false], ['Q2', 'Q1', '3333333333333', false]]);
  assert.deepEqual(res.notes, ['sleeve reset: monetary 40.0%→30.0%, workingCapital 30.0%→40.0%, quality 30.0%→30.0%']);
});

test('7. a basket already at the book: nothing marked, no auction (as on main)', () => {
  const { rows, policy } = cases.unchanged();
  const res = computeTrades(rows, policy);
  assert.deepEqual(tradedSet(res), []);
  assert.deepEqual(res.trades, []);
  assert.deepEqual(res.notes, []);
});

test('8. only a removal already flagged on chain: no block, no auction (as on main; option K drains it)', () => {
  for (const remnant of [0.5, 50]) {
    const { rows, policy } = cases.remnantOnly(remnant);
    const res = computeTrades(rows, policy);
    assert.deepEqual(tradedSet(res), ['X'], `$${remnant}`);
    assert.deepEqual(res.trades, [], `$${remnant}`);
    assert.deepEqual(res.notes, [], `$${remnant}`);
  }
  // the same removal NOT yet flagged (the day-7 plan, before execute) opens the block
  const { rows, policy } = cases.remnantOnly(50);
  const res = computeTrades(rows.map((r) => (r.symbol === 'X' ? { ...r, inRemoval: false } : r)), policy);
  assert.deepEqual(tradedSet(res).sort(), ['A', 'B', 'X']);
  assert.ok(res.trades.length > 0 && res.trades.at(-1).drain);
});

test('9. --reweight-block: the whole block without any mark', () => {
  const { rows, policy } = cases.smallDrift();
  assert.deepEqual(computeTrades(rows, policy).trades, []);
  const res = computeTrades(rows, policy, { reweightBlock: true });
  assert.deepEqual(tradedSet(res), ['A', 'B']);
  assert.deepEqual(sig(res.trades), [['A', 'B', '10000000000000', false]]);
  for (const r of rows) near(post(res)[r.symbol], r.targetWeight, 1e-9, r.symbol);
  assert.ok(res.notes.some((n) => /opened by --reweight-block/.test(n)));
});

test('10. no registry change, one name 5 points off: the whole block (the one path that changes without an add)', () => {
  const { rows, policy } = cases.ruleMarkOnly();
  const res = computeTrades(rows, policy);
  assert.deepEqual(tradedSet(res), ['A', 'B', 'C']);
  assert.deepEqual(sig(res.trades), [['A', 'C', '40000000000000', false], ['B', 'C', '4000000000000', false]]);
  for (const r of rows) near(post(res)[r.symbol], r.targetWeight, 1e-9, r.symbol);
  // owner choice 3, option ②: rule marks do not open the block — main's output
  const opt2 = computeTrades(rows, { ...policy, blockOnRuleMarks: false });
  assert.deepEqual(tradedSet(opt2), ['A', 'C']);
  assert.deepEqual(sig(opt2.trades), [['A', 'C', '46666666666545', false]]);
});

test('10b. above the cap where the book is above it too (qX20 BTC): marked, does not open the block', () => {
  const { rows, policy } = cases.bookAboveCap();
  const res = computeTrades(rows, policy);
  assert.deepEqual(tradedSet(res), ['A']);
  assert.deepEqual(res.trades, []);
});

test('10c. the vault above the cap while the book is not: opens the block', () => {
  const { rows, policy } = cases.vaultAboveCap();
  const res = computeTrades(rows, policy);
  assert.deepEqual(tradedSet(res), ['A', 'B', 'C']);
  for (const r of rows) near(post(res)[r.symbol], r.targetWeight, 1e-9, r.symbol);
});

test('10d. the Quality sleeve cap (Triens): a name over the in-sleeve cap opens the sleeve only where the book is under it', () => {
  const tok = (symbol, usd, decimals, value, target, sleeve) => {
    const ref = (BigInt(Math.round(usd * 1e6)) * E18) / (10n ** BigInt(decimals) * 1_000_000n);
    return { symbol, address: `0x${Buffer.from(symbol.padEnd(20, '_')).toString('hex').slice(0, 40)}`, decimals, balance: (BigInt(value) * E18) / ref, ref, targetWeight: target, isAdd: false, isRemove: false, inRemoval: false, sleeve };
  };
  const policy = { tolerancePoints: 5, capMaxWeight: null, qualityCap: 0.35, sleeve: true, duration: 1800, minTradeUsd: 1, fill: 'fair' };
  // sleeves on target (30/40/30); inside Quality Q1 holds 36.7% of the sleeve (over the 35% cap)
  const rows = (q1Book) => [
    tok('BTC', 100_000, 14, 300_000, 0.30, 'monetary'),
    tok('WC', 1, 9, 400_000, 0.40, 'workingCapital'),
    tok('Q1', 25, 10, 110_000, q1Book * 0.30, 'quality'),
    tok('Q2', 3, 9, 95_000, ((1 - q1Book) / 2) * 0.30, 'quality'),
    tok('Q3', 0.4, 8, 95_000, ((1 - q1Book) / 2) * 0.30, 'quality'),
  ];
  // the book's Q1 is over the cap too (36% of the sleeve, < 5 pt away): marked, the sleeve stays
  const above = computeTrades(rows(0.36), policy);
  assert.deepEqual(tradedSet(above), ['Q1']);
  assert.deepEqual(above.trades, []);
  // the book's Q1 is under the cap (34%): the whole Quality sleeve trades to the book, BTC and WC do not
  const under = computeTrades(rows(0.34), policy);
  assert.deepEqual(tradedSet(under).sort(), ['Q1', 'Q2', 'Q3']);
  assert.ok(under.trades.length > 0 && under.trades.every((t) => !['BTC', 'WC'].includes(t.sell) && !['BTC', 'WC'].includes(t.buy)));
});

test('11. rounding: decimals 0 and 18, sells within balances, no auction under $1, weights within (pairs × $1 + base units) / V', () => {
  const { rows, policy } = cases.rounding();
  const res = computeTrades(rows, policy);
  assert.deepEqual(rows.map((r) => r.decimals).sort((a, b) => a - b), [0, 9, 18, 18]);
  const bal = Object.fromEntries(rows.map((r) => [r.symbol, r.balance]));
  const ref = Object.fromEntries(rows.map((r) => [r.symbol, r.ref]));
  const soldBy = {};
  for (const t of res.trades) {
    soldBy[t.sell] = (soldBy[t.sell] ?? 0n) + t.sellAmount;
    assert.ok(t.sellAmount > 0n);
    assert.ok(t.sellAmount * ref[t.sell] >= E18, `#${t.seq} is worth $1 or more`);
  }
  for (const [s, n] of Object.entries(soldBy)) assert.ok(n <= bal[s], `${s} sells ${n} of ${bal[s]}`);
  const w = post(res);
  near(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-12);
  const V = usd(rows.reduce((t, r) => t + r.balance * r.ref, 0n));
  const maxUnit = usd(rows.reduce((m, r) => (r.ref > m ? r.ref : m), 0n));
  const pairs = rows.length; // matching steps ≤ sellers + buyers
  for (const r of rows) assert.ok(Math.abs(w[r.symbol] - r.targetWeight) <= (pairs * 1 + res.trades.length * maxUnit) / V, `${r.symbol} ${w[r.symbol]} vs ${r.targetWeight}`);
});

test('12. the balances a fair session leaves plan no further auction (also with --reweight-block)', () => {
  const { rows, policy } = cases.rankedAdd();
  const after = applyFills(rows, computeTrades(rows, policy).trades).map((r) => ({ ...r, isAdd: false }));
  assert.deepEqual(computeTrades(after, policy).trades, []);
  assert.deepEqual(computeTrades(after, policy, { reweightBlock: true }).trades, []);
  for (const ix of ['qx20', 'qrev', 'qdefi', 'qai', 'triens']) {
    const fx = SAVED[ix];
    const rs = savedRows(fx);
    const done = applyFills(rs, computeTrades(rs, fx.policy).trades).map((r) => ({ ...r, isAdd: false, inRemoval: r.isRemove }));
    const again = computeTrades(done, fx.policy);
    assert.deepEqual(again.trades, [], `${ix}: ${JSON.stringify(sig(again.trades))}`);
  }
});

test('13. a block worth nothing: no auction, no division by zero', () => {
  for (const name of ['emptyBlock', 'emptySleeve']) {
    const { rows, policy } = cases[name]();
    const res = computeTrades(rows, policy);
    assert.deepEqual(res.trades, [], name);
    assert.ok(res.targets.every((t) => Number.isFinite(t.tradeTargetWeight)), name);
  }
});

test('14. the five plans of 2026-10-01: 22 · 14 · 15 · 11 · 8 auctions, entering names bought to the book', () => {
  const want = { qx20: 22, qrev: 14, qdefi: 15, qai: 11, triens: 8 };
  for (const [ix, n] of Object.entries(want)) {
    const fx = SAVED[ix];
    const rows = savedRows(fx);
    const res = computeTrades(rows, fx.policy);
    assert.equal(res.trades.length, n, ix);
    assert.deepEqual(sig(res.trades), fx.block.trades, `${ix}: the spec's block-rule auctions`);
    assert.ok(fx.present.trades.length < n, `${ix}: main planned ${fx.present.trades.length}`);
    const adds = rows.filter((r) => r.isAdd);
    if (!fx.policy.sleeve) {
      const short = adds.reduce((t, r) => t + (r.targetWeight - post(res)[r.symbol]), 0);
      near(short, 0, 1e-9, `${ix} entering names short of the book`);
      for (const r of rows) near(post(res)[r.symbol], r.isRemove ? 0 : r.targetWeight, 1e-9, `${ix} ${r.symbol}`);
    } else {
      // Triens without a sleeve reset: inside Quality, the book's weights
      for (const r of rows.filter((x) => x.sleeve === 'quality')) near(post(res)[r.symbol], aim(res)[r.symbol], 1e-9, `${ix} ${r.symbol}`);
      const aero = rows.find((r) => r.isAdd);
      near(post(res)[aero.symbol], aero.targetWeight, 0.0001, `${ix} ${aero.symbol} (sleeve rule leaves < 0.01 pt)`);
      assert.ok(post(res)[aero.symbol] > 0.006);
    }
  }
});

test('15. onlyForced (the executor\'s residual rounds): exactly as on main', () => {
  {
    const { rows, policy } = cases.ruleMarkOnly();
    const res = computeTrades(rows, policy, { forceTraded: ['A', 'C'], onlyForced: true });
    assert.deepEqual(tradedSet(res), ['A', 'C']);
    assert.deepEqual(sig(res.trades), [['A', 'C', '46666666666545', false]]);
    assert.deepEqual(res.notes, []);
  }
  {
    const { rows, policy } = cases.rankedAddRemove();
    const res = computeTrades(rows, policy, { forceTraded: ['A', 'D'], onlyForced: true });
    assert.deepEqual(tradedSet(res), ['A', 'X', 'D']);
    assert.deepEqual(sig(res.trades), [['X', 'D', '93333333333333', false], ['X', 'A', '40000000000000', true]]);
  }
});

// ------------------------------------------- sizing at the chain references
/** A day-7 shape for planRows (buildPlan's rows): the chain's references are
 *  off the day's market price (a mark made earlier in the day, as on
 *  2026-10-01, when they differed by up to 543 bp), one name has no
 *  reference yet, a removal not yet in removal opens the block. */
function chainShape() {
  const market = { A: 2000, B: 50, C: 0.2, X: 0.03, D: 7, Z: 4 };
  const chain = { A: 2000 * 1.031, B: 50 * 0.954, C: 0.2 * 1.012, X: 0.03 * 0.98, Z: 0 };
  const dec = { A: 12, B: 10, C: 8, X: 7, D: 9, Z: 9 };
  const held = { A: 300_000, B: 300_000, C: 150_000, X: 200_000, Z: 50_000 }; // USD at the chain reference (Z at the market)
  const addr = (s) => `0x${Buffer.from(s.padEnd(20, '_')).toString('hex').slice(0, 40)}`;
  const registry = Object.keys(chain).map((s) => {
    const refPrice = chain[s] > 0 ? toRefPrice(chain[s], dec[s]) : 0n;
    const at = refPrice > 0n ? refPrice : toRefPrice(market[s], dec[s]);
    return { symbol: s, address: addr(s), decimals: dec[s], balance: (BigInt(held[s]) * E18) / at, refPrice, inRemoval: false };
  });
  const adds = [{ symbol: 'D', address: addr('D'), decimals: 9, firstRefPrice: toRefPrice(market.D, 9) }];
  const book = { units: { A: 120, B: 5_100, C: 900_000, D: 21_000, Z: 15_000 }, sleeveOf: {} };
  return { market, chain, registry, adds, book };
}

test('planRows: every held name is valued at its reference on chain, an add at its first reference, the book at the same prices; the market price is kept for the 5% guard', () => {
  const { market, registry, adds, book } = chainShape();
  const { rows, marketRef } = planRows({ registry, adds, book, isSleeve: false, priceA: (s) => market[s] ?? null });
  for (const r of registry) {
    const row = rows.find((x) => x.symbol === r.symbol);
    if (r.refPrice > 0n) {
      assert.equal(row.ref, r.refPrice, `${r.symbol} valued at its chain reference`);
      assert.equal(row.chainRef, r.refPrice, `${r.symbol} chainRef`);
    } else {
      assert.equal(row.ref, toRefPrice(market[r.symbol], r.decimals), `${r.symbol} without a reference: at the market`);
      assert.equal(row.chainRef, null, `${r.symbol} without a reference: no chainRef (nothing for the executor to compare)`);
    }
    assert.equal(marketRef[r.symbol], toRefPrice(market[r.symbol], r.decimals), `${r.symbol} planRefPrice is the market price`);
  }
  const d = rows.find((x) => x.symbol === 'D');
  assert.deepEqual([d.ref, d.chainRef, d.isAdd, d.balance, d.bookUnits], [adds[0].firstRefPrice, null, true, 0n, 21_000]);
  const x = rows.find((r) => r.symbol === 'X');
  assert.deepEqual([x.isRemove, x.targetWeight, x.bookUnits], [true, 0, 0]);
  // the book's weights, at the same references
  const usdOf = (r) => (Number(r.ref) * 10 ** r.decimals) / 1e18;
  const bookValue = rows.reduce((t, r) => t + (r.bookUnits || 0) * usdOf(r), 0);
  for (const r of rows) near(r.targetWeight, ((r.bookUnits || 0) * usdOf(r)) / bookValue, 1e-15, r.symbol);
});

test('planRows + computeTrades: auctions sized at the chain references and filled at them (the contract) leave every balance proportional to the book units', () => {
  const { market, chain, registry, adds, book } = chainShape();
  const { rows } = planRows({ registry, adds, book, isSleeve: false, priceA: (s) => market[s] ?? null });
  const res = computeTrades(rows, RANKED);
  assert.ok(res.trades.length > 0 && tradedSet(res).length === rows.length, 'the removal opens the whole basket');
  // the contract fills at the references on chain (an add at its first reference, a name without one at the reference first-prices or the mark gives it — here its market price)
  const fillRef = (r) => (chain[r.symbol] > 0 ? toRefPrice(chain[r.symbol], r.decimals) : r.isAdd ? adds[0].firstRefPrice : toRefPrice(market[r.symbol], r.decimals));
  const after = applyFills(rows.map((r) => ({ ...r, ref: fillRef(r) })), res.trades);
  assert.equal(after.find((r) => r.symbol === 'X').balance, 0n, 'the removal drained');
  const held = after.filter((r) => !r.isRemove);
  const per = held.map((r) => ({ s: r.symbol, k: Number(r.balance) / 10 ** r.decimals / book.units[r.symbol] }));
  const k0 = per[0].k;
  for (const p of per) near(p.k / k0, 1, 2e-6, `${p.s} units per book unit`);
});

// ------------------------------------------------ the executor's bound
/** The executor's view after a session: live rows (aim = tradeTargetWeight)
 *  and the plan's fills, every planned trade filled at `factor`. */
function sessionAt(fx, factor) {
  const rows = savedRows(fx);
  const res = computeTrades(rows, fx.policy);
  const after = applyFills(rows, res.trades, factor);
  const ref = Object.fromEntries(rows.map((r) => [r.symbol, r.ref]));
  const fills = res.trades.map((t) => {
    const num = t.sellAmount * ref[t.sell] * factor;
    const den = ref[t.buy] * 10_000n;
    return { seq: t.seq, buy: t.buy, buyPaid: ((num + den - 1n) / den).toString(), factorBps: Number(factor) };
  });
  const ctx = { plan: { policy: fx.policy, targets: res.targets, fills }, o: { fairWindowBps: 10 } };
  const live = after.map((r) => ({ symbol: r.symbol, balance: r.balance, ref: r.ref, targetWeight: res.targets.find((t) => t.symbol === r.symbol).tradeTargetWeight, isRemove: r.isRemove }));
  return { ctx, live, res };
}

test('bound: with no fill it is (traded names × $1) / V', () => {
  const { rows } = cases.rankedAdd();
  const res = computeTrades(rows, cases.rankedAdd().policy);
  const ctx = { plan: { policy: { minTradeUsd: 1 }, targets: res.targets, fills: [] } };
  const live = rows.map((r) => ({ ...r, targetWeight: r.targetWeight }));
  const b = residualBound(ctx, live);
  near(b(live[0]), 4 / 1_000_000, 1e-15);
});

test('bound: every planned fill at the fair point or at the window edge (10,010 bp) is inside it; fills at 10,200 bp recorded as fair are not', () => {
  for (const ix of ['qx20', 'qrev', 'qdefi', 'qai', 'triens']) {
    for (const f of [10_000n, 10_005n, 10_010n]) {
      const { ctx, live } = sessionAt(SAVED[ix], f);
      const res = residual(ctx, live);
      const bad = res.filter((r) => !r.ok);
      assert.deepEqual(bad.map((r) => `${r.symbol} ${r.drift} > ${r.bound}`), [], `${ix} at ${f} bp`);
    }
    // fills at the curve's open recorded as if they were fair must not pass
    const { ctx, live } = sessionAt(SAVED[ix], 10_200n);
    ctx.plan.fills = ctx.plan.fills.map((f) => ({ ...f, factorBps: 10_005 }));
    assert.ok(residual(ctx, live).some((r) => !r.ok), `${ix}: open fills recorded as fair must not pass`);
  }
});

test('bound: a session filled at the open (--fill open, 10,200 bp) or below fair (natural, 9,900 bp) is bounded by its own factors', () => {
  for (const ix of ['qx20', 'qrev', 'qdefi', 'qai', 'triens']) {
    for (const f of [10_200n, 9_900n]) {
      const { ctx, live } = sessionAt(SAVED[ix], f);
      const bad = residual(ctx, live).filter((r) => !r.ok);
      assert.deepEqual(bad.map((r) => `${r.symbol} ${r.drift} > ${r.bound}`), [], `${ix} at ${f} bp`);
    }
  }
});

test('bound: an entering name left at 0 fails verification (what the 5-point check let through)', () => {
  const fx = SAVED.triens;
  const rows = savedRows(fx);
  const res = computeTrades(rows, fx.policy);
  const ctx = { plan: { policy: fx.policy, targets: res.targets, fills: [] }, o: { fairWindowBps: 10 } };
  const live = rows.map((r) => ({ symbol: r.symbol, balance: r.balance, ref: r.ref, targetWeight: res.targets.find((t) => t.symbol === r.symbol).tradeTargetWeight, isRemove: r.isRemove }));
  const aero = residual(ctx, live).find((r) => r.symbol === 'AERO');
  assert.equal(aero.ok, false);
  assert.ok(Math.abs(aero.drift) < 0.05, 'inside the old 5-point check');
});

test('bound: a finished session still passes after a later mark moves the references (verify values the vault at the plan\'s sizing references)', () => {
  for (const ix of ['qx20', 'qrev', 'qdefi', 'qai', 'triens']) {
    const { ctx, live } = sessionAt(SAVED[ix], 10_005n);
    // the next day's mark: every reference 3% up or down, balances unchanged
    const marked = live.map((r, i) => ({ ...r, ref: (r.ref * (i % 2 ? 9_700n : 10_300n)) / 10_000n }));
    const atToday = residual(ctx, marked).filter((r) => !r.ok);
    assert.ok(atToday.length > 0, `${ix}: weighed at today's references a finished session looks off its targets`);
    const atPlan = residual(ctx, marked.map((r, i) => ({ ...r, sizingRef: live[i].ref }))).filter((r) => !r.ok);
    assert.deepEqual(atPlan.map((r) => `${r.symbol} ${r.drift} > ${r.bound}`), [], `${ix}: weighed at the plan's references it passes`);
  }
});

test('sizingRefOf: chainRefAtPlan of a registry name, the first reference of an add, null for a plan without chainRefAtPlan', () => {
  const A = '0x00000000000000000000000000000000000000a1';
  const N = '0x00000000000000000000000000000000000000b2';
  const plan = { registry: [{ address: A, chainRefAtPlan: '123' }], adds: [{ address: N, firstRefPrice: '456' }] };
  assert.equal(sizingRefOf(plan, A.toUpperCase().replace('0X', '0x')), 123n);
  assert.equal(sizingRefOf(plan, N), 456n);
  assert.equal(sizingRefOf({ registry: [{ address: A, planRefPrice: '9' }], adds: [{ address: N, firstRefPrice: '456' }] }, N), null, 'a plan made before chainRefAtPlan: today\'s reference, as before');
  assert.equal(sizingRefOf({ registry: [{ address: A, planRefPrice: '9' }], adds: [] }, A), null);
  assert.equal(sizingRefOf(plan, '0x00000000000000000000000000000000000000c3'), null);
});

test('untradedGapNote: a plan that trades nothing names the largest gap to the book and --reweight-block; a plan that trades every name has no note', () => {
  // the qAI case of the second review (⑧c): the registry change executed, a session stopped, no add left to mark
  const fx = SAVED.qai;
  const rows = savedRows(fx);
  const res = computeTrades(rows, fx.policy);
  // after execute and #1-#7 (the two drains finalized): no add left to mark, ICP still short of the book but
  // inside the 5-point tolerance — the stop of rehearsal ⑧c
  const half = applyFills(rows, res.trades.slice(0, 7)).filter((r) => !r.isRemove).map((r) => ({ ...r, isAdd: false, bookUnits: 1 }));
  const stopped = computeTrades(half, fx.policy);
  assert.equal(stopped.trades.length, 0, 'nothing opens a block: the plan trades nothing and the entering names stay short');
  const note = untradedGapNote(stopped.targets.map((t) => ({ ...t, bookUnits: half.find((r) => r.symbol === t.symbol).bookUnits })));
  assert.match(note ?? '', /largest gap between the vault and the book among them is \w+ [+-]\d+\.\d{4} pt .*--reweight-block/);
  const resumed = computeTrades(half, fx.policy, { reweightBlock: true });
  assert.equal(untradedGapNote(resumed.targets.map((t) => ({ ...t, bookUnits: half.find((r) => r.symbol === t.symbol).bookUnits }))), null);
  assert.ok(resumed.trades.length > 0);
  assert.equal(untradedGapNote([]), null);
  const two = untradedGapNote([{ symbol: 'A', traded: false, bookUnits: 2, targetWeight: 0.6, currentWeight: 0.58 }, { symbol: 'B', traded: false, bookUnits: 1, targetWeight: 0.4, currentWeight: 0.42 }]);
  assert.match(two, /A -2\.0000 pt|B \+2\.0000 pt/);
});

test('weights helper sanity: the fixture vaults are worth what the spec says', () => {
  const w = weightsOf(savedRows(SAVED.qrev));
  near(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-12);
});
