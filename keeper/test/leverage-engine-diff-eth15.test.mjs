/**
 * T1 for qETH1.5X (index qeth15) — the leg's level against the registered ETH 1.5x test engine.
 *
 * Same method as keeper/test/leverage-engine-diff.test.mjs (the qBTC2X · qETH2X comparison): the engine file
 * (leverage-eth15.mjs, sha256 63157268…, the pre-registered engine of the ETH 1.5x daily-reset test) is NOT
 * imported — importing it runs its main(). It is read as text, its sha256 is checked, and four functions are cut
 * out of it verbatim — bigFlags, makeBars, interestTable, simulate — and evaluated with the profile's constants
 * read from the same text. Nothing of the engine is re-implemented here. The engine runs one continuous
 * simulation; keeper/leverage-step.mjs runs the same span one UTC day at a time from the book the previous day
 * left (as the daily leg does). Every day-end equity must be equal (===), and so must the trigger count and the
 * liquidation outcome.
 *
 * The pair, the target and the level convention are read from the shipped rulebook keeper/rulebooks/qeth15.json
 * (product.target 1.5, check.minutes 15, check.trigger 2.3, level.primary 30 bp · 4.5%); each run is also made at
 * 30 bp · 6% (the test's headline).
 *
 * Inputs (absent in the public repository's CI — the tests then skip and say the comparison is missing):
 *   LEVERAGE_ETH15_ENGINE  path to leverage-eth15.mjs
 *   LEVERAGE_ETH15_DATA    directory holding ethusdt-15m.csv.gz (the registered input, sha256 323831dd…)
 *
 *   LEVERAGE_ETH15_ENGINE=…/leverage-eth15.mjs LEVERAGE_ETH15_DATA=…/params-v6 node --test keeper/test/leverage-engine-diff-eth15.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { runDay, genesisBook, stamp } from '../leverage-step.mjs';
import { read15mFile } from './leverage-helpers.mjs';

const ENGINE_SHA = '63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596';
const DATA_SHA = '323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478';
const ENGINE = process.env.LEVERAGE_ETH15_ENGINE ?? null;
const DIR = process.env.LEVERAGE_ETH15_DATA ?? null;
const MISSING = !ENGINE || !fs.existsSync(ENGINE) || !DIR;
const RB = JSON.parse(fs.readFileSync(new URL('../rulebooks/qeth15.json', import.meta.url), 'utf8'));
const TARGET = RB.product.target;
const N = RB.check.minutes;
const T = RB.check.trigger;
// scenario table handed to the engine's interestTable: 0 = the shipped level convention, 1 = 30 bp · 6%
const CONVENTIONS = [RB.level.primary, { costBp: 30, ratePct: 6 }];
const skip = MISSING ? 'comparison missing — set LEVERAGE_ETH15_ENGINE (leverage-eth15.mjs) and LEVERAGE_ETH15_DATA; the public CI has no copy' : false;

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
  const checkMins = JSON.parse(/const CHECK_MINS = PROFILE === 'v6' \? (\[[^\]]+\])/.exec(text)[1]);
  const lltv = Number(/const LLTV = ([0-9.]+);/.exec(text)[1]);
  assert.match(text, /const STEP_MIN = PROFILE === 'v6' \? 15 : 60;/);
  assert.match(text, /const DAY_MIN = 1440;/);
  const consts = { STEP_MIN: 15, STEP_MS: 900_000, DAY_MIN: 1440, LLTV: lltv, STRESS_MOVE: 0.05, STRESS_MULT: 3, CHECK_MINS: checkMins };
  const SCENARIOS = CONVENTIONS.map((c) => ({ c: c.costBp, r: c.ratePct, stress: false }));
  // eslint-disable-next-line no-new-func
  const lib = new Function(...Object.keys(consts), 'SCENARIOS', `${src}\nconst FTABS = SCENARIOS.map((s) => interestTable(s.r));\nreturn { makeBars, simulate };`)(...Object.values(consts), SCENARIOS);
  return { ...lib, checkMins, lltv };
}

async function loadData(eng) {
  const file = path.join(DIR, 'ethusdt-15m.csv.gz');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), DATA_SHA, 'ethusdt-15m.csv.gz is not the registered input');
  const bars = await read15mFile(file);
  const ts = bars.map((b) => stamp(b.openMs));
  const t = Float64Array.from(bars.map((b) => b.openMs));
  const f = (k) => Float64Array.from(bars.map((b) => b[k]));
  const H = eng.makeBars('ETH', { ts, t, op: f('o'), hi: f('h'), lo: f('l'), cl: f('c'), vol: new Float64Array(bars.length) }, 900_000, '');
  return { bars, H };
}

/** Engine continuous span vs leg day by day over the days `days` (one scenario). */
function compareSpan(eng, H, bars, days, s) {
  const { costBp, ratePct } = CONVENTIONS[s];
  const off = days[0].first;
  const rec = { nav: new Float64Array(days.length) };
  const o = eng.simulate(H, off, days.at(-1).last - off + 1, TARGET, true, 0, T, 1 << eng.checkMins.indexOf(N), costBp, s, rec);
  let book = genesisBook(TARGET, bars[off - 1]);
  let triggers = 0;
  let liquidated = false;
  for (let k = 0; k < days.length; k++) {
    const r = runDay(book, bars.slice(days[k].first, days[k].last + 1), { target: TARGET, minutes: N, trigger: T, costBp, ratePct, lltv: eng.lltv });
    triggers += r.stats.triggers;
    if (r.liquidated) { liquidated = true; break; }
    assert.equal(r.E, rec.nav[k], `${days[k].date}: day-end equity ${r.E} (leg) vs ${rec.nav[k]} (engine), ${costBp}bp/${ratePct}%`);
    book = r.book;
  }
  assert.equal(triggers, o.trigN, `triggers ${triggers} (leg) vs ${o.trigN} (engine)`);
  assert.equal(liquidated, o.liqK >= 0, `liquidation leg ${liquidated} vs engine ${o.liqK >= 0}`);
  if (!liquidated) assert.equal(book.E, o.nav, 'final equity');
  return { days: days.length, triggers, liquidated, final: book.E };
}

test('qeth15 T1: the shipped pair (15 min · 2.3, target 1.5) x three months x (30 bp · 4.5%, 30 bp · 6%), every day-end equity === the engine', { skip }, async () => {
  assert.deepEqual([TARGET, N, T, CONVENTIONS[0].costBp, CONVENTIONS[0].ratePct], [1.5, 15, 2.3, 30, 4.5]);
  const eng = loadEngine();
  const { bars, H } = await loadData(eng);
  const out = [];
  for (const month of ['2020-03', '2021-05', '2025-10']) {
    const days = H.days.filter((d) => d.date.startsWith(month));
    assert.ok(days.length >= 28, `${month}: ${days.length} days`);
    for (const s of [0, 1]) {
      const r = compareSpan(eng, H, bars, days, s);
      assert.equal(r.liquidated, false);
      out.push(`${month} ${CONVENTIONS[s].costBp}bp/${CONVENTIONS[s].ratePct}%: ${r.days} days equal, ${r.triggers} trigger(s)`);
    }
  }
  console.log(out.join('\n'));
});

test('qeth15 T1e: the shipped pair over the whole decision region 2017-09-01 … 2026-09-29 at 30 bp · 4.5% and 30 bp · 6%', { skip }, async () => {
  const eng = loadEngine();
  const { bars, H } = await loadData(eng);
  const days = H.days.filter((d) => d.date >= '2017-09-01' && d.date <= '2026-09-29');
  for (const s of [0, 1]) {
    const r = compareSpan(eng, H, bars, days, s);
    assert.equal(r.liquidated, false);
    console.log(`qeth15 ${N}/${T} ${CONVENTIONS[s].costBp}bp/${CONVENTIONS[s].ratePct}%: ${r.days} day-end equities equal; ${r.triggers} triggers; final equity ${r.final}`);
  }
});
