/**
 * keeper/leverage-step.mjs — the level, the check log and the vault steps.
 *
 *   (a) against an independent brute-force computation written in PRICE space
 *       (bitcoin units held, dollars owed) instead of the ratio space the leg
 *       uses, with its own 15-minute aggregation and its own check-bar search
 *       (every grid time of the day, the latest bar closed at or before it);
 *   (b) the boundaries of the spec's T3;
 *   (c) the contract-bounded mark steps of T9 (the arithmetic only; the sends
 *       are in leverage-index.test.mjs).
 *
 * No network. THROWAWAY values only (labelled): none is a tested value.
 *
 *   node --test keeper/test/leverage-step.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDay, genesisBook, aggregate15, checkSlot, markSteps, ruleProblem, interestFactor, canonicalMinuteText, minuteGaps, stamp, BAR_MS,
} from '../leverage-step.mjs';
import { synthMinutes, THROWAWAY_CHECK, THROWAWAY_LEVEL } from './leverage-helpers.mjs';

const D = (d) => Date.parse(`${d}T00:00:00Z`);
const bar = (day, hm, o, h, l, c, n1m = 15) => ({ openMs: Date.parse(`${day}T${hm}:00Z`), o, h, l, c, n1m });

/** Brute force: price space, own aggregation, own check-bar search. Returns day-end equities and per-day trigger counts. */
function bruteForce(minutesByDay, { n, T, costBp, ratePct, lltv = 0.86, lam = 2 }) {
  const c = costBp / 1e4;
  // aggregation: group by the quarter hour with a Map, then sort
  const quarters = new Map();
  for (const m of Object.values(minutesByDay).flat()) {
    const q = m.openMs - (m.openMs % BAR_MS);
    const g = quarters.get(q) ?? [];
    g.push(m);
    quarters.set(q, g);
  }
  const bars = [...quarters.entries()].sort((a, b) => a[0] - b[0]).map(([q, ms]) => {
    ms.sort((a, b) => a.openMs - b.openMs);
    return { openMs: q, close: q + BAR_MS, o: ms[0].o, h: Math.max(...ms.map((x) => x.h)), l: Math.min(...ms.map((x) => x.l)), c: ms.at(-1).c, day: new Date(q).toISOString().slice(0, 10) };
  });
  const days = [...new Set(bars.map((b) => b.day))];
  // check bars: for every grid time g (multiple of n minutes) from the first close to the last, the latest bar with close <= g
  const isCheck = new Set();
  for (let g = Math.ceil(bars[0].close / 60_000 / n) * n * 60_000; g <= bars.at(-1).close; g += n * 60_000) {
    let best = -1;
    for (let i = 0; i < bars.length; i++) if (bars[i].close <= g) best = i;
    if (best >= 0) isCheck.add(best);
  }
  const dayEnd = new Set(days.map((d) => bars.map((b, i) => [b, i]).filter(([b]) => b.day === d).at(-1)[1]));
  // start: equity 1 at the first bar's close, λ = lam
  let price = bars[0].c;
  let units = lam / price;
  let debt = lam - 1;
  const out = [];
  let trig = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const steps = (b.openMs - bars[i - 1].openMs) / BAR_MS;
    if (ratePct !== 0) debt *= Math.pow(1 + ratePct / 100 / 365, (steps * 15) / 1440);
    if (debt >= lltv * units * Math.min(price, b.l)) return { liquidatedAt: stamp(b.openMs), out };
    price = b.c;
    const equity = units * price - debt;
    const leverage = (units * price) / equity;
    let kind = dayEnd.has(i) ? 'reset' : isCheck.has(i) && leverage >= T ? 'trigger' : null;
    if (kind) {
      const value = units * price;
      // equity after paying c on the traded notional |lam*E2 - value|
      const up = lam * equity >= value;
      const e2 = up ? (equity + c * value) / (1 + c * lam) : (equity - c * value) / (1 - c * lam);
      units = (lam * e2) / price;
      debt = lam * e2 - e2;
      if (kind === 'trigger') trig++;
    }
    if (dayEnd.has(i)) {
      out.push({ day: b.day, E: units * price - debt, triggers: trig });
      trig = 0;
    }
  }
  return { liquidatedAt: null, out };
}

const close = (a, b, rel = 1e-11) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

test('(a) level vs an independent brute force in price space — three synthetic days with a crash, THROWAWAY pairs and conventions', () => {
  const days = ['2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04'];
  const minutesByDay = {};
  let p0 = 100;
  days.forEach((d, k) => {
    const ms = synthMinutes(d, {
      seed: 7 + k, p0, vol: 0.004,
      // day 3: a fall of about 35% between 09:00 and 11:00 UTC, then a partial rebound
      shock: k === 2 ? (m, r) => (m >= 540 && m < 660 ? r - 0.0036 : m >= 660 && m < 720 ? r + 0.002 : r) : null,
    });
    minutesByDay[d] = ms;
    p0 = ms.at(-1).c;
  });
  let totalTriggers = 0;
  for (const [n, T, costBp, ratePct] of [[120, 2.2, 30, 6], [15, 2.3, 0, 0], [60, 2.1, 30, 6], [THROWAWAY_CHECK.minutes, THROWAWAY_CHECK.trigger, THROWAWAY_LEVEL.costBp, THROWAWAY_LEVEL.ratePct]]) {
    // the leg: genesis at the last close of day 1, then one UTC day at a time
    const allBars = aggregate15(Object.values(minutesByDay).flat());
    const firstDayBars = allBars.filter((b) => b.openMs < D(days[1]));
    let book = genesisBook(2, firstDayBars.at(-1));
    const leg = [];
    for (const d of days.slice(1)) {
      const r = runDay(book, allBars.filter((b) => b.openMs >= D(d) && b.openMs < D(d) + 86_400_000), { target: 2, minutes: n, trigger: T, costBp, ratePct, lltv: 0.86 });
      leg.push({ day: d, E: r.E, triggers: r.stats.triggers, liq: r.liquidated });
      book = r.book;
    }
    // brute force from the same genesis close: drop day 1 but its last bar
    const bf = bruteForce(
      { ...Object.fromEntries(days.slice(1).map((d) => [d, minutesByDay[d]])), [days[0]]: minutesByDay[days[0]].filter((m) => m.openMs >= firstDayBars.at(-1).openMs) },
      { n, T, costBp, ratePct }
    );
    assert.equal(bf.liquidatedAt, null);
    assert.equal(leg.length, bf.out.length);
    for (let k = 0; k < leg.length; k++) {
      assert.equal(leg[k].day, bf.out[k].day);
      assert.ok(close(leg[k].E, bf.out[k].E), `n=${n} T=${T} ${leg[k].day}: leg ${leg[k].E} vs brute force ${bf.out[k].E}`);
      assert.equal(leg[k].triggers, bf.out[k].triggers, `n=${n} T=${T} ${leg[k].day}: triggers`);
    }
    totalTriggers += leg.reduce((a, x) => a + x.triggers, 0);
  }
  assert.ok(totalTriggers > 0, 'the crash day triggers at least once across the pairs — the comparison covers trigger trades');
});

test('(a) the crash day of the synthetic window does trigger (the comparison above is not vacuous)', () => {
  const ms = synthMinutes('2030-01-03', { seed: 9, p0: 100, vol: 0.004, shock: (m, r) => (m >= 540 && m < 660 ? r - 0.0036 : r) });
  const prev = synthMinutes('2030-01-02', { seed: 8, p0: 100, vol: 0.004 });
  const book = genesisBook(2, aggregate15(prev).at(-1));
  const r = runDay(book, aggregate15(ms), { target: 2, minutes: 120, trigger: 2.2, costBp: 30, ratePct: 6, lltv: 0.86 });
  assert.ok(r.stats.triggers >= 1, `triggers ${r.stats.triggers}`);
  assert.equal(r.slots.length, 12, 'n = 120: eleven checks and the reset');
  assert.equal(r.slots.at(-1).action, 'reset');
  assert.equal(r.slots.at(-1).t, '2030-01-04T00:00Z');
});

test('aggregation: the engine rule, and a slot without a minute has no bar', () => {
  const ms = synthMinutes('2030-02-01', { seed: 3, skip: (k) => k >= 30 && k < 45 }); // 00:30–00:44 missing
  const bars = aggregate15(ms);
  assert.equal(bars.length, 95);
  assert.equal(stamp(bars[2].openMs), '2030-02-01T00:45');
  const first = ms.slice(0, 15);
  assert.deepEqual(bars[0], { openMs: D('2030-02-01'), o: first[0].o, h: Math.max(...first.map((m) => m.h)), l: Math.min(...first.map((m) => m.l)), c: first[14].c, n1m: 15 });
  assert.deepEqual(minuteGaps(ms, '2030-02-01'), [{ from: '00:30', to: '00:44', minutes: 15 }]);
  assert.match(canonicalMinuteText(ms.slice(0, 1)), /^\d+,[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+\n$/);
});

test('(b) T3: λ exactly T triggers (≥)', () => {
  // A = 2, C = -1; close 75 after 100: A = 1.5, E = 0.5, λ = 3 exactly; T = 3 (THROWAWAY)
  const day = '2030-03-01';
  const book = { A: 2, C: -1, E: 1, lastBar: '2030-02-28T23:45', lastClose: 100 };
  const bars = [bar(day, '00:00', 100, 100, 75, 75), bar(day, '00:15', 75, 75, 75, 75)];
  const r = runDay(book, bars, { target: 2, minutes: 15, trigger: 3, costBp: 0, ratePct: 0, lltv: 0.86 });
  assert.equal(r.slots[0].lambdaBefore, 3);
  assert.equal(r.slots[0].action, 'trigger');
  // one tick above 75: λ < 3, no trigger
  const r2 = runDay(book, [bar(day, '00:00', 100, 100, 75.01, 75.01), bar(day, '00:15', 75, 75, 75, 75)], { target: 2, minutes: 15, trigger: 3, costBp: 0, ratePct: 0, lltv: 0.86 });
  assert.equal(r2.slots[0].action, 'none');
});

test('(b) T3: at the day-end bar λ ≥ T counts once, as the reset', () => {
  const day = '2030-03-02';
  const book = { A: 2, C: -1, E: 1, lastBar: '2030-03-01T23:45', lastClose: 100 };
  const r = runDay(book, [bar(day, '00:00', 100, 100, 100, 100), bar(day, '00:15', 100, 100, 70, 70)], { target: 2, minutes: 15, trigger: 2.2, costBp: 30, ratePct: 0, lltv: 0.86 });
  assert.deepEqual(r.slots.map((s) => s.action), ['none', 'reset']);
  assert.equal(r.stats.triggers, 0);
  assert.equal(r.stats.trades, 1);
});

test('(b) T3: a reset at λ = 2 exactly trades nothing and costs nothing', () => {
  const day = '2030-03-03';
  const book = { A: 2, C: -1, E: 1, lastBar: '2030-03-02T23:45', lastClose: 100 };
  const bars = Array.from({ length: 96 }, (_, k) => bar(day, `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`, 100, 100, 100, 100));
  const r = runDay(book, bars, { target: 2, minutes: 120, trigger: 2.2, costBp: 30, ratePct: 0, lltv: 0.86 });
  const reset = r.slots.at(-1);
  assert.equal(reset.action, 'reset');
  assert.equal(reset.notional, 0);
  assert.equal(reset.cost, 0);
  assert.equal(r.E, 1);
  assert.equal(r.slots.length, 12);
});

test('(b) T3: a gap covering two grid times is judged once (gridTimes 2); the bar after it accrues d = 5 steps of interest', () => {
  const day = '2030-03-04';
  const book = { A: 2, C: -1, E: 1, lastBar: '2030-03-03T23:45', lastClose: 100 };
  const p = { target: 2, minutes: 15, trigger: 9, costBp: 0, ratePct: 6, lltv: 0.86 };
  // 00:00, then 00:30 (00:15 missing): grid times 00:15 and 00:30 both fall in [00:15, 00:45)
  const r = runDay(book, [bar(day, '00:00', 100, 100, 100, 100), bar(day, '00:30', 100, 100, 100, 100), bar(day, '01:45', 100, 100, 100, 100)], p);
  assert.equal(r.slots[0].gridTimes, 2);
  assert.equal(r.slots[0].t, '2030-03-04T00:15Z');
  // interest: 1 step, 2 steps, then 5 steps (00:30 → 01:45)
  const C = -1 * interestFactor(6, 1) * interestFactor(6, 2) * interestFactor(6, 5);
  const E = 2 + C;
  assert.equal(r.slots.at(-1).lambdaBefore, Math.round((2 / E) * 1e6) / 1e6);
  assert.equal(checkSlot(Date.parse('2030-03-04T00:00:00Z'), Date.parse('2030-03-04T00:30:00Z'), 15).gridTimes, 2);
  assert.equal(checkSlot(Date.parse('2030-03-04T00:00:00Z'), Date.parse('2030-03-04T00:15:00Z'), 120), null);
});

test('(b) T3: LTV at the low exactly 0.86 is a model liquidation (level 0, series ends)', () => {
  const day = '2030-03-05';
  // A = 2, C = -0.86, low at half the previous close: A·gL = 1, −C = 0.86 = 0.86 × 1
  const book = { A: 2, C: -0.86, E: 1.14, lastBar: '2030-03-04T23:45', lastClose: 100 };
  const r = runDay(book, [bar(day, '00:00', 100, 100, 50, 60), bar(day, '00:15', 60, 60, 60, 60)], { target: 2, minutes: 15, trigger: 2.2, costBp: 0, ratePct: 0, lltv: 0.86 });
  assert.deepEqual(r.liquidated, { bar: '00:00', ltvLow: 0.86, tMs: Date.parse('2030-03-05T00:15:00Z') });
  assert.equal(r.E, 0);
  assert.equal(r.slots.at(-1).action, 'liquidated');
  assert.equal(r.slots.at(-1).level, 0);
  // one tick higher low: no liquidation
  const r2 = runDay(book, [bar(day, '00:00', 100, 100, 50.01, 60), bar(day, '00:15', 60, 60, 60, 60)], { target: 2, minutes: 15, trigger: 9, costBp: 0, ratePct: 0, lltv: 0.86 });
  assert.equal(r2.liquidated, null);
});

test('(b) T3: a day whose last bar is not 23:45 (gap to midnight) resets at that bar\'s close', () => {
  const day = '2030-03-06';
  const book = { A: 2, C: -1, E: 1, lastBar: '2030-03-05T23:45', lastClose: 100 };
  const r = runDay(book, [bar(day, '00:00', 100, 100, 100, 101), bar(day, '22:00', 101, 103, 101, 102)], { target: 2, minutes: 120, trigger: 2.2, costBp: 0, ratePct: 0, lltv: 0.86 });
  assert.equal(r.slots.at(-1).action, 'reset');
  assert.equal(r.slots.at(-1).t, '2030-03-06T22:15Z');
  assert.equal(r.book.lastBar, '2030-03-06T22:00');
  // the 00:00 bar stands for every two-hour grid time up to 22:00 (the 22:00 bar closes at 22:15)
  assert.equal(r.slots[0].gridTimes, 11);
});

test('ruleProblem: the refusal grid (spec §1-6 1–3)', () => {
  const ok = { target: 2, minutes: 120, trigger: 2.2, primary: { costBp: 30, ratePct: 6 } };
  assert.equal(ruleProblem(ok), null);
  for (const [patch, field] of [
    [{ minutes: null }, 'check.minutes'], [{ minutes: 20 }, 'check.minutes'], [{ minutes: 1440 }, 'check.minutes'], [{ minutes: 105 }, 'check.minutes'], [{ minutes: 10 }, 'check.minutes'],
    [{ trigger: null }, 'check.trigger'], [{ trigger: 2.0 }, 'check.trigger'], [{ trigger: '2.2' }, 'check.trigger'],
    [{ primary: null }, 'level.primary'], [{ primary: { costBp: -1, ratePct: 6 } }, 'level.primary'], [{ primary: { costBp: 30 } }, 'level.primary'],
  ]) assert.equal(ruleProblem({ ...ok, ...patch })?.field, field, JSON.stringify(patch));
  for (const n of [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720]) assert.equal(ruleProblem({ ...ok, minutes: n }), null, `n=${n}`);
});

test('(c) T9 steps: −69.34% from 1.000000 is five contract-bounded steps ending on round(E × 1e6)', () => {
  const target = BigInt(Math.round(0.30663 * 1e6));
  const steps = markSteps(1_000_000n, target);
  assert.equal(steps.length, 5);
  let cur = 1_000_000n;
  for (const s of steps) {
    const d = (cur * 2500n) / 10000n;
    assert.ok(s >= cur - d && s <= cur + d, `${cur} → ${s} outside the bound`);
    cur = s;
  }
  assert.equal(steps.at(-1), target);
  assert.deepEqual(markSteps(1_000_000n, 1_000_000n), []);
  assert.deepEqual(markSteps(1_000_000n, 1_200_000n), [1_200_000n]);
  assert.equal(markSteps(1_000_000n, 3_000_000n).length, 5); // 1.25 → 1.5625 → 1.953125 → 2.44140625 → 3
});

test('(c) T9 steps: a model liquidation steps down to the floor, 3 units, in 46 steps', () => {
  const steps = markSteps(1_000_000n, 0n);
  assert.equal(steps.length, 46);
  assert.equal(steps.at(-1), 3n);
  assert.deepEqual(markSteps(3n, 0n), []);
  assert.deepEqual(markSteps(4n, 0n), [3n]);
});
