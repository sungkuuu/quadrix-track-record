/**
 * T1 — the leg's level against the sixth leverage test's own engine.
 *
 * The engine file (leverage-params-v6.mjs, sha256 ceadadd3…) is NOT imported:
 * importing it runs its main(), which starts the study. It is read as text,
 * its sha256 is checked, and four functions are cut out of it verbatim —
 * bigFlags, makeBars, interestTable, simulate — and evaluated with the v6
 * profile's constants read from the same text (STEP_MIN 15, LLTV, CHECK_MINS).
 * Nothing of the engine is re-implemented here. The engine then runs one
 * continuous simulation over a calendar month; keeper/leverage-step.mjs runs
 * the same month one UTC day at a time from the book the previous day left
 * (as the daily leg does). Every day-end equity must be equal (===), and so
 * must the trigger count and the liquidation outcome.
 *
 * Inputs (absent in the public repository's CI — the test then skips and says
 * the comparison is missing):
 *   LEVERAGE_V6_ENGINE  path to leverage-params-v6.mjs
 *   LEVERAGE_V6_DIR     directory holding btcusdt-15m.csv.gz and ethusdt-15m.csv.gz
 *                       (default: the engine's directory)
 *
 * THROWAWAY pairs (labelled; none is a tested value): BTC 120 min · 2.2,
 * ETH 15 min · 2.3, ETH 60 min · 2.1; cost conventions 0 bp · 0% and
 * 30 bp · 6% a year.
 *
 * T1d · T1e (added with the filled values, 2026-10-05): the pairs and the
 * level convention are read from the shipped rulebooks
 * keeper/rulebooks/qbtc2x.json and qeth2x.json (check.minutes, check.trigger,
 * level.primary), so a change to either file is compared against the engine
 * again; T1d also runs each shipped pair at 30 bp · 6% (the tests' headline).
 *
 *   LEVERAGE_V6_ENGINE=…/leverage-params-v6.mjs node --test keeper/test/leverage-engine-diff.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runDay, genesisBook, stamp } from '../leverage-step.mjs';
import { read15mFile } from './leverage-helpers.mjs';

const ENGINE_SHA = 'ceadadd3003fcbbb858a9b19adcbbc3db5873308c0f7705c68cb11b7d0c2fab3';
const ENGINE = process.env.LEVERAGE_V6_ENGINE ?? null;
const DIR = process.env.LEVERAGE_V6_DIR ?? (ENGINE ? path.dirname(ENGINE) : null);
const MISSING = !ENGINE || !fs.existsSync(ENGINE);
const RULEBOOKS = ['qbtc2x', 'qeth2x'].map((index) => {
  const rb = JSON.parse(fs.readFileSync(new URL(`../rulebooks/${index}.json`, import.meta.url), 'utf8'));
  return { index, asset: rb.underlying.symbol.replace(/USDT$/, ''), n: rb.check.minutes, T: rb.check.trigger, primary: rb.level.primary };
});
// scenario table handed to the engine's interestTable: index 0 = 0 bp · 0%,
// 1 = 30 bp · 6%, then every convention a shipped rulebook uses
const CONVENTIONS = [{ costBp: 0, ratePct: 0 }, { costBp: 30, ratePct: 6 }];
for (const r of RULEBOOKS) {
  if (r.primary && !CONVENTIONS.some((c) => c.costBp === r.primary.costBp && c.ratePct === r.primary.ratePct)) CONVENTIONS.push({ costBp: r.primary.costBp, ratePct: r.primary.ratePct });
}
const scenarioOf = (costBp, ratePct) => CONVENTIONS.findIndex((c) => c.costBp === costBp && c.ratePct === ratePct);

function loadEngine() {
  const text = fs.readFileSync(ENGINE, 'utf8');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(sha, ENGINE_SHA, `engine sha256 ${sha} is not the pre-registered ${ENGINE_SHA}`);
  const cut = (from, to) => {
    const a = text.indexOf(from);
    const b = text.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`cannot cut ${from}`);
    return text.slice(a, b);
  };
  const src = [
    cut('function bigFlags(', '// bar arrays from rows'),
    cut('function makeBars(', 'function loadBars('),
    cut('function interestTable(', 'const FTABS = '),
    cut('function simulate(', '// daily tracking values'),
  ].join('\n');
  // constants of the v6 profile, read from the engine text
  const checkMins = JSON.parse(/const CHECK_MINS = PROFILE === 'v6' \? (\[[^\]]+\])/.exec(text)[1]);
  const lltv = Number(/const LLTV = ([0-9.]+);/.exec(text)[1]);
  assert.match(text, /const STEP_MIN = PROFILE === 'v6' \? 15 : 60;/);
  assert.match(text, /const DAY_MIN = 1440;/);
  const consts = { STEP_MIN: 15, STEP_MS: 900_000, DAY_MIN: 1440, LLTV: lltv, STRESS_MOVE: 0.05, STRESS_MULT: 3, CHECK_MINS: checkMins };
  // the harness's scenarios (no stress): index 0 = 0 bp · 0%, index 1 = 30 bp · 6%,
  // then the shipped rulebooks' conventions (CONVENTIONS above)
  const SCENARIOS = CONVENTIONS.map((c) => ({ c: c.costBp, r: c.ratePct, stress: false }));
  // eslint-disable-next-line no-new-func
  const lib = new Function(...Object.keys(consts), 'SCENARIOS', `${src}\nconst FTABS = SCENARIOS.map((s) => interestTable(s.r));\nreturn { makeBars, simulate };`)(...Object.values(consts), SCENARIOS);
  return { ...lib, checkMins, lltv };
}

function engineBars(eng, asset, bars) {
  const ts = bars.map((b) => stamp(b.openMs));
  const t = Float64Array.from(bars.map((b) => b.openMs));
  const f = (k) => Float64Array.from(bars.map((b) => b[k]));
  return eng.makeBars(asset, { ts, t, op: f('o'), hi: f('h'), lo: f('l'), cl: f('c'), vol: new Float64Array(bars.length) }, 900_000, '');
}

/** Engine continuous month vs leg day by day. Returns the number of days compared. */
function compareMonth(eng, H, bars, month, { n, T, costBp, ratePct, s }) {
  const days = H.days.filter((d) => d.date.startsWith(month));
  assert.ok(days.length >= 28, `${month}: ${days.length} days in the file`);
  const off = days[0].first;
  const nBars = days.at(-1).last - off + 1;
  const rec = { nav: new Float64Array(days.length) };
  const bit = 1 << eng.checkMins.indexOf(n);
  const o = eng.simulate(H, off, nBars, 2, true, 0, T, bit, costBp, s, rec);
  let book = genesisBook(2, bars[off - 1]);
  let triggers = 0;
  let liquidated = false;
  let compared = 0;
  for (let k = 0; k < days.length; k++) {
    const dayBars = bars.slice(days[k].first, days[k].last + 1);
    const r = runDay(book, dayBars, { target: 2, minutes: n, trigger: T, costBp, ratePct, lltv: eng.lltv });
    triggers += r.stats.triggers;
    if (r.liquidated) { liquidated = true; break; }
    assert.equal(r.E, rec.nav[k], `${month} ${days[k].date}: day-end equity ${r.E} (leg) vs ${rec.nav[k]} (engine)`);
    book = r.book;
    compared++;
  }
  assert.equal(triggers, o.trigN, `${month}: triggers ${triggers} (leg) vs ${o.trigN} (engine)`);
  assert.equal(liquidated, o.liqK >= 0, `${month}: liquidation leg ${liquidated} vs engine ${o.liqK >= 0}`);
  if (!liquidated) assert.equal(book.E, o.nav, `${month}: final equity`);
  return { compared, triggers: o.trigN, liquidated };
}

test('T1 engine diff: three months x three THROWAWAY pairs x two cost conventions, every day-end equity === the engine', { skip: MISSING ? 'comparison missing — set LEVERAGE_V6_ENGINE to the sixth test engine (leverage-params-v6.mjs); the public CI has no copy' : false }, async () => {
  const eng = loadEngine();
  const pairs = [['BTC', 120, 2.2], ['ETH', 15, 2.3], ['ETH', 60, 2.1]];
  const conv = [{ costBp: 0, ratePct: 0, s: 0 }, { costBp: 30, ratePct: 6, s: 1 }];
  const summary = [];
  const cache = {};
  for (const [asset, n, T] of pairs) {
    if (!cache[asset]) {
      const bars = await read15mFile(path.join(DIR, `${asset.toLowerCase()}usdt-15m.csv.gz`));
      assert.ok(bars, `${asset} 15-minute file missing in ${DIR}`);
      cache[asset] = { bars, H: engineBars(eng, asset, bars) };
    }
    const { bars, H } = cache[asset];
    for (const month of ['2020-03', '2021-05', '2025-10']) {
      for (const cv of conv) {
        const r = compareMonth(eng, H, bars, month, { n, T, ...cv });
        summary.push(`${asset} n=${n} T=${T} ${cv.costBp}bp/${cv.ratePct}% ${month}: ${r.compared} days equal, ${r.triggers} trigger(s), liquidation ${r.liquidated}`);
      }
    }
  }
  console.log(summary.join('\n'));
});

test('T1b engine diff over the whole decision region 2017-09-01 … 2026-09-29, BTC 120 · 2.2 at 30 bp · 6% (THROWAWAY pair)', { skip: MISSING ? 'comparison missing — LEVERAGE_V6_ENGINE not set' : false }, async () => {
  const eng = loadEngine();
  const bars = await read15mFile(path.join(DIR, 'btcusdt-15m.csv.gz'));
  const H = engineBars(eng, 'BTC', bars);
  const days = H.days.filter((d) => d.date >= '2017-09-01' && d.date <= '2026-09-29');
  const off = days[0].first;
  const rec = { nav: new Float64Array(days.length) };
  const o = eng.simulate(H, off, days.at(-1).last - off + 1, 2, true, 0, 2.2, 1 << eng.checkMins.indexOf(120), 30, 1, rec);
  let book = genesisBook(2, bars[off - 1]);
  let triggers = 0;
  for (let k = 0; k < days.length; k++) {
    const r = runDay(book, bars.slice(days[k].first, days[k].last + 1), { target: 2, minutes: 120, trigger: 2.2, costBp: 30, ratePct: 6, lltv: eng.lltv });
    assert.equal(r.liquidated, null);
    assert.equal(r.E, rec.nav[k], `${days[k].date}`);
    triggers += r.stats.triggers;
    book = r.book;
  }
  assert.equal(o.liqK, -1);
  assert.equal(triggers, o.trigN);
  console.log(`BTC 120/2.2 30bp/6%: ${days.length} day-end equities equal; ${triggers} triggers; final equity ${book.E}`);
});

test('T1c engine diff with a model liquidation: BTC daily reset without a trigger, 2020-03 (the engine liquidates on 2020-03-12)', { skip: MISSING ? 'comparison missing — LEVERAGE_V6_ENGINE not set' : false }, async () => {
  const eng = loadEngine();
  const bars = await read15mFile(path.join(DIR, 'btcusdt-15m.csv.gz'));
  const H = engineBars(eng, 'BTC', bars);
  const days = H.days.filter((d) => d.date.startsWith('2020-03'));
  const off = days[0].first;
  const rec = { nav: new Float64Array(days.length), traceFrom: off, traceTo: days.at(-1).last, rows: [] };
  const o = eng.simulate(H, off, days.at(-1).last - off + 1, 2, true, 0, Infinity, 1 << eng.checkMins.indexOf(120), 30, 1, rec);
  assert.ok(o.liqK >= 0, 'the engine liquidates this month');
  const liqRow = rec.rows.find((r) => r.kind === 'liquidated');
  let book = genesisBook(2, bars[off - 1]);
  let k = 0;
  for (; k < days.length; k++) {
    const r = runDay(book, bars.slice(days[k].first, days[k].last + 1), { target: 2, minutes: 120, trigger: Infinity, costBp: 30, ratePct: 6, lltv: eng.lltv });
    if (r.liquidated) {
      assert.equal(days[k].date, '2020-03-12');
      assert.equal(r.liquidated.bar, stamp(bars[liqRow.i].openMs).slice(11), 'same liquidation bar as the engine');
      assert.equal(r.E, 0);
      break;
    }
    assert.equal(r.E, rec.nav[k], days[k].date);
    book = r.book;
  }
  assert.ok(k < days.length, 'the leg liquidates too');
  console.log(`BTC daily reset, no trigger: both liquidate at ${days[k].date} ${stamp(bars[liqRow.i].openMs).slice(11)} UTC`);
});

test('T1d engine diff with the shipped values: each rulebook pair x three months x (its level convention, 30 bp · 6%), every day-end equity === the engine', { skip: MISSING ? 'comparison missing — LEVERAGE_V6_ENGINE not set' : false }, async () => {
  const eng = loadEngine();
  const summary = [];
  for (const r of RULEBOOKS) {
    assert.ok(Number.isInteger(r.n) && typeof r.T === 'number' && r.primary, `${r.index}: check.minutes, check.trigger and level.primary must be filled`);
    const bars = await read15mFile(path.join(DIR, `${r.asset.toLowerCase()}usdt-15m.csv.gz`));
    const H = engineBars(eng, r.asset, bars);
    const convs = [r.primary, { costBp: 30, ratePct: 6 }].filter((c, i, a) => a.findIndex((d) => d.costBp === c.costBp && d.ratePct === c.ratePct) === i);
    for (const month of ['2020-03', '2021-05', '2025-10']) {
      for (const cv of convs) {
        const s = scenarioOf(cv.costBp, cv.ratePct);
        assert.ok(s >= 0);
        const out = compareMonth(eng, H, bars, month, { n: r.n, T: r.T, costBp: cv.costBp, ratePct: cv.ratePct, s });
        assert.equal(out.liquidated, false, `${r.index} ${month}: no model liquidation for the shipped pair`);
        summary.push(`${r.index} n=${r.n} T=${r.T} ${cv.costBp}bp/${cv.ratePct}% ${month}: ${out.compared} days equal, ${out.triggers} trigger(s)`);
      }
    }
  }
  console.log(summary.join('\n'));
});

test('T1e engine diff with the shipped values over the whole decision region 2017-09-01 … 2026-09-29 at each rulebook\'s level convention', { skip: MISSING ? 'comparison missing — LEVERAGE_V6_ENGINE not set' : false }, async () => {
  const eng = loadEngine();
  for (const r of RULEBOOKS) {
    const bars = await read15mFile(path.join(DIR, `${r.asset.toLowerCase()}usdt-15m.csv.gz`));
    const H = engineBars(eng, r.asset, bars);
    const days = H.days.filter((d) => d.date >= '2017-09-01' && d.date <= '2026-09-29');
    const off = days[0].first;
    const s = scenarioOf(r.primary.costBp, r.primary.ratePct);
    const rec = { nav: new Float64Array(days.length) };
    const o = eng.simulate(H, off, days.at(-1).last - off + 1, 2, true, 0, r.T, 1 << eng.checkMins.indexOf(r.n), r.primary.costBp, s, rec);
    let book = genesisBook(2, bars[off - 1]);
    let triggers = 0;
    for (let k = 0; k < days.length; k++) {
      const d = runDay(book, bars.slice(days[k].first, days[k].last + 1), { target: 2, minutes: r.n, trigger: r.T, costBp: r.primary.costBp, ratePct: r.primary.ratePct, lltv: eng.lltv });
      assert.equal(d.liquidated, null, `${r.index} ${days[k].date}`);
      assert.equal(d.E, rec.nav[k], `${r.index} ${days[k].date}`);
      triggers += d.stats.triggers;
      book = d.book;
    }
    assert.equal(o.liqK, -1);
    assert.equal(triggers, o.trigN);
    console.log(`${r.index} ${r.n}/${r.T} ${r.primary.costBp}bp/${r.primary.ratePct}%: ${days.length} day-end equities equal; ${triggers} triggers; final equity ${book.E}`);
  }
});
