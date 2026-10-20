// qETH1.5X (index qeth15), P24 mark gate — measured size: on how many UTC days of 2017-09-01 … 2026-09-29 did the
// daily level move outside the vault contract's ±25% bound per mark, and how many marks does the largest day need?
//
// Same method as the qBTC2X stage-A measurement behind rulebooks/qbtc2x.md §13 (3,316 days, 28 outside ±25%):
// the arithmetic is NOT re-implemented. Four functions — bigFlags, makeBars, interestTable, simulate — are cut
// verbatim out of the registered ETH 1.5x test engine (leverage-eth15.mjs, sha256 63157268…, the engine that
// keeper/test/leverage-engine-diff-eth15.test.mjs compares the keeper's level against) and evaluated with the rule
// read from keeper/rulebooks/qeth15.json (target 1.5, check every 15 minutes, trigger 2.3). A daily-reset book stands
// at exactly the target at every day end, so each UTC day is simulated on its own from the previous day's last close;
// the day's move is that day's end equity ÷ 1. A continuous run over the whole span is made as a cross-check: its
// day-end equity ratios must equal the one-day runs.
// Steps: (a) as the qBTC2X measurement — the fewest moves of at most 24% each; (b) the keeper's own step list,
// keeper/leverage-step.mjs markSteps (the contract's bound, old ± old·2500/10000, integer 6-decimal units), from a
// share price of 1.000000.
//
// Inputs (site repository, private; the same files as the engine comparison test):
//   P24_ENGINE  path to leverage-eth15.mjs           (sha256 63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596)
//   P24_DATA    path to ethusdt-15m.csv.gz           (sha256 323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478)
// Usage: P24_ENGINE=… P24_DATA=… node docs/research/leverage/eth-1p5/evidence/p24-daily-moves.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { markSteps } from '../../../../../keeper/leverage-step.mjs';

const ENGINE_SHA = '63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596';
const DATA_SHA = '323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const RB = JSON.parse(fs.readFileSync(new URL('../../../../../keeper/rulebooks/qeth15.json', import.meta.url), 'utf8'));
const TARGET = RB.product.target, N = RB.check.minutes, T = RB.check.trigger;
const CONVENTIONS = [RB.level.primary, { costBp: 30, ratePct: 6 }];

const text = fs.readFileSync(process.env.P24_ENGINE, 'utf8');
if (sha(text) !== ENGINE_SHA) throw new Error(`engine sha256 ${sha(text)} is not ${ENGINE_SHA}`);
const cut = (from, to) => { const a = text.indexOf(from), b = text.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`cannot cut ${from}`); return text.slice(a, b); };
const src = [
  cut('function bigFlags(', '// bar arrays from rows'),
  cut('function makeBars(', 'function loadBars('),
  cut('function interestTable(', 'const FTABS = '),
  cut('function simulate(', '// daily tracking values'),
].join('\n');
const checkMins = JSON.parse(/const CHECK_MINS = PROFILE === 'v6' \? (\[[^\]]+\])/.exec(text)[1]);
const lltv = Number(/const LLTV = ([0-9.]+);/.exec(text)[1]);
if (!/const STEP_MIN = PROFILE === 'v6' \? 15 : 60;/.test(text) || !/const DAY_MIN = 1440;/.test(text)) throw new Error('engine constants differ');
const consts = { STEP_MIN: 15, STEP_MS: 900_000, DAY_MIN: 1440, LLTV: lltv, STRESS_MOVE: 0.05, STRESS_MULT: 3, CHECK_MINS: checkMins };
const SCENARIOS = CONVENTIONS.map((c) => ({ c: c.costBp, r: c.ratePct, stress: false }));
// eslint-disable-next-line no-new-func
const lib = new Function(...Object.keys(consts), 'SCENARIOS', `${src}\nconst FTABS = SCENARIOS.map((s) => interestTable(s.r));\nreturn { makeBars, simulate };`)(...Object.values(consts), SCENARIOS);

const raw = fs.readFileSync(process.env.P24_DATA);
if (sha(raw) !== DATA_SHA) throw new Error(`data sha256 ${sha(raw)} is not ${DATA_SHA}`);
const lines = zlib.gunzipSync(raw).toString('utf8').trim().split('\n');
if (lines.shift() !== 'time_utc,open,high,low,close,n1m') throw new Error('header');
const n = lines.length, ts = new Array(n), t = new Float64Array(n), op = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n), cl = new Float64Array(n), vol = new Float64Array(n);
for (let i = 0; i < n; i++) { const p = lines[i].split(','); ts[i] = p[0]; t[i] = Date.parse(`${p[0]}:00Z`); op[i] = +p[1]; hi[i] = +p[2]; lo[i] = +p[3]; cl[i] = +p[4]; }
const H = lib.makeBars('ETH', { ts, t, op, hi, lo, cl, vol }, 900_000, sha(raw));

const R_START = '2017-09-01', DATA_END = '2026-09-30';
const BIT = 1 << checkMins.indexOf(N);
const steps24 = (r) => { if (Math.abs(r - 1) <= 0.24) return 1; let k = 0, x = 1; if (r > 1) { while (x < r) { x *= 1.24; k++; } } else { while (x > r) { x *= 0.76; k++; } } return k; };
const keeperSteps = (r) => markSteps(1_000_000n, BigInt(Math.round(r * 1e6))).length;
const pct = (r) => `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(2)}%`;

console.log(`engine leverage-eth15.mjs sha256 ${ENGINE_SHA}; functions cut: bigFlags, makeBars, interestTable, simulate; LLTV ${lltv}`);
console.log(`input ethusdt-15m.csv.gz sha256 ${DATA_SHA}; ${n} bars ${ts[0]} … ${ts[n - 1]} UTC`);
console.log(`rule keeper/rulebooks/qeth15.json: target ${TARGET}, check ${N} min, trigger ${T}; region [${R_START}, ${DATA_END}) UTC days`);

for (let s = 0; s < CONVENTIONS.length; s++) {
  const { costBp, ratePct } = CONVENTIONS[s];
  const region = H.days.map((d, k) => ({ d, k })).filter(({ d, k }) => k >= 1 && d.date >= R_START && d.date < DATA_END);
  const days = region.map(({ d }) => {
    const o = lib.simulate(H, d.first, d.last - d.first + 1, TARGET, true, 0, T, BIT, costBp, s, null);
    return { date: d.date, r: o.nav, liq: o.liqK >= 0, trig: o.trigN };
  });
  // cross-check: one continuous run, day-end equity ratios
  const off = region[0].d.first;
  const rec = { nav: new Float64Array(region.length) };
  const oc = lib.simulate(H, off, region.at(-1).d.last - off + 1, TARGET, true, 0, T, BIT, costBp, s, rec);
  let maxDiff = 0;
  for (let k = 0; k < region.length; k++) { const prev = k === 0 ? 1 : rec.nav[k - 1]; maxDiff = Math.max(maxDiff, Math.abs(rec.nav[k] / prev - days[k].r)); }
  const live = days.filter((x) => !x.liq);
  const o25 = live.filter((x) => x.r > 1.25 || x.r < 0.75);
  const o15 = live.filter((x) => Math.abs(x.r - 1) > 0.15);
  const since23 = (xs) => xs.filter((x) => x.date >= '2023-01-01').length;
  const sorted = [...live].sort((a, b) => Math.abs(b.r - 1) - Math.abs(a.r - 1));
  const big = sorted[0];
  const byYear = {}; for (const x of o25) byYear[x.date.slice(0, 4)] = (byYear[x.date.slice(0, 4)] ?? 0) + 1;
  const dist24 = {}, distK = {}; for (const x of o25) { const a = steps24(x.r), b = keeperSteps(x.r); dist24[a] = (dist24[a] ?? 0) + 1; distK[b] = (distK[b] ?? 0) + 1; }
  console.log(`\n== ${costBp} bp · ${ratePct}% a year${s === 0 ? ' (the recorded level, level.primary)' : ' (the test headline; the convention of the qBTC2X §13 measurement)'}`);
  console.log(`days ${days.length} (${days[0].date} → ${days.at(-1).date}); model liquidations ${days.filter((x) => x.liq).map((x) => x.date).join(', ') || 'none'}; trigger days ${days.filter((x) => x.trig > 0).length}`);
  console.log(`continuous-run cross-check: final equity ${oc.nav}, liquidation ${oc.liqK >= 0}, max |ratio difference| ${maxDiff.toExponential(2)}`);
  console.log(`daily level outside ±25%: ${o25.length} days (since 2023-01-01: ${since23(o25)}) by year ${JSON.stringify(byYear)}`);
  console.log(`  ${o25.map((x) => `${x.date} ${pct(x.r)}`).join(' · ')}`);
  console.log(`daily level |move| > 15%: ${o15.length} days (since 2023-01-01: ${since23(o15)})`);
  console.log(`largest daily move: ${big.date} ${pct(big.r)}; steps (≤24% each, as qBTC2X §13): ${steps24(big.r)}; keeper markSteps from 1.000000: ${keeperSteps(big.r)}`);
  console.log(`next largest: ${sorted.slice(1, 5).map((x) => `${x.date} ${pct(x.r)}`).join(' · ')}`);
  console.log(`days outside ±25% by steps needed — ≤24% rule ${JSON.stringify(dist24)}; keeper markSteps ${JSON.stringify(distK)}`);
}
