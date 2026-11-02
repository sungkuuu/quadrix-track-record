/**
 * Realized line of the BTC volatility index (working name): the pure
 * functions (T1–T3, T23) and the CLI's completeness, finality, catch-up and
 * determinism rules on SYNTHETIC bars (T4–T7). No network.
 *
 *   node --test keeper/test/vol-realized.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  realizedFromWindow, dayClose, canonicalMinuteText, parseKlines, sha256, r2, minuteGaps, windowDates,
} from '../vol-realized.mjs';
import { spawnSync } from 'node:child_process';
import { run } from '../vol-index.mjs';
import { syntheticDays, dayMinutes, writeOffline, fakeBinance, tmpDir, readJsonl, cli, timeless, addDays, dayMs, MIN_MS, REPO } from './vol-helpers.mjs';

const P = { windowDays: 30, yearDays: 365 };
const REC = 'record-volbtc-realized.jsonl';
const verifyDir = (dir) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'verify-vol.mjs'), '--dir', dir], { encoding: 'utf8', env: { PATH: process.env.PATH } });

// ---------------------------------------------------------------------- T1
test('T1 closed form: returns of +-ln(1.01) every day give 100 x sqrt(365) x ln(1.01)', () => {
  const x = Math.log(1.01);
  const window = [];
  let c = 50000;
  for (let k = 0; k <= 30; k++) {
    window.push([`d${k}`, c]);
    c = c * Math.exp(k % 2 === 0 ? x : -x);
  }
  const { variance, value, returns } = realizedFromWindow(window, null, P);
  assert.equal(returns, 30);
  assert.ok(Math.abs(variance - 365 * x * x) / (365 * x * x) < 1e-12, `variance ${variance}`);
  assert.equal(value, r2(100 * Math.sqrt(365) * x));
  assert.equal(value, 19.01);
});

test('T1b known answer on a hand-written window: (365/30) x sum r^2, mean not subtracted', () => {
  // closes 100, 110, 99, 99 … (all later days 99): r1 = ln 1.1, r2 = ln 0.9, the rest 0
  const window = [['a', 100], ['b', 110], ['c', 99], ...Array.from({ length: 28 }, (_, k) => [`z${k}`, 99])];
  const { variance, value } = realizedFromWindow(window, null, P);
  const want = (365 / 30) * (Math.log(1.1) ** 2 + Math.log(0.9) ** 2);
  assert.ok(Math.abs(variance - want) / want < 1e-12);
  assert.equal(value, Math.round(100 * Math.sqrt(want) * 100) / 100);
  assert.equal(value, 49.56); // 100 x sqrt(12.1667 x (0.0090840 + 0.0111008)) = 49.556…
});

// ---------------------------------------------------------------------- T2
test('T2 day close: the close of the 1-minute bar that opened latest that day (W1)', () => {
  const mins = dayMinutes('2099-02-01', 60000, 61234.56);
  assert.deepEqual(dayClose(mins), { close: 61234.56, lastBar: '23:59' });
  assert.equal(mins.at(-1).c, 61234.56);
  // the same value as the old "close of the last 15-minute bar": the 23:45 bar closes at the 23:59 minute
  // whole 23:45-23:59 block missing: the latest minute before it (23:44), as the old 23:30 bar's close
  const cut = mins.filter((m) => m.openMs < mins[1425].openMs);
  assert.deepEqual(dayClose(cut), { close: mins[1424].c, lastBar: '23:44' });
  // only the 23:59 minute missing: the 23:58 minute
  assert.deepEqual(dayClose(mins.slice(0, 1439)), { close: mins[1438].c, lastBar: '23:58' });
  // order of the input does not matter: the latest open time wins
  assert.deepEqual(dayClose([...mins].reverse()), { close: 61234.56, lastBar: '23:59' });
  assert.deepEqual(dayClose([]), { close: null, lastBar: null });
});

// ---------------------------------------------------------------------- T3
test('T3 canonical text: the same value written with other digits gives the same sha256', () => {
  const a = parseKlines([[4070908800000, '64000.00000000', '64010.50000000', '63990.10000000', '64005.00000000', '1', 4070908859999]]);
  const b = parseKlines([[4070908800000, '64000', '64010.5', '63990.1', '64005', '9', 4070908859999]]);
  assert.equal(canonicalMinuteText(a), '4070908800000,64000,64010.5,63990.1,64005\n');
  assert.equal(sha256(canonicalMinuteText(a)), sha256(canonicalMinuteText(b)));
  const c = parseKlines([[4070908800000, '64000.00000001', '64010.5', '63990.1', '64005', '1', 4070908859999]]);
  assert.notEqual(sha256(canonicalMinuteText(a)), sha256(canonicalMinuteText(c)));
});

// --------------------------------------------------------------------- T23
test('T23 rounding: x * 100 exactly n + 0.5 rounds up (not to even)', () => {
  assert.equal(36.125 * 100, 3612.5); // exact in binary64
  assert.equal(r2(36.125), 36.13);
  assert.equal(r2(0.125), 0.13);
  assert.equal(r2(12.5 / 100 + 40), 40.13);
  assert.equal(r2(36.124999999999), 36.12);
  // the verifier's language-neutral form floor(y + 0.5) / 100 gives the same
  for (const x of [36.125, 0.125, 19.0100804, 55.6776436, 13.9278422]) assert.equal(Math.floor(x * 100 + 0.5) / 100, r2(x));
});

test('null-day rule: a day with no bar counts as the previous close; the next return spans both days', () => {
  const closes = [100, 101, 102, null, 104, ...Array.from({ length: 26 }, () => 104)];
  const window = closes.map((c, k) => [`d${k}`, c]);
  const { variance, returns } = realizedFromWindow(window, null, P);
  assert.equal(returns, 29);
  const want = (365 / 30) * (Math.log(101 / 100) ** 2 + Math.log(102 / 101) ** 2 + 0 + Math.log(104 / 102) ** 2);
  assert.ok(Math.abs(variance - want) / want < 1e-12);
  // first close null → carriedFrom stands in
  const w2 = [['d0', null], ...window.slice(1)];
  assert.throws(() => realizedFromWindow(w2, null, P), /no first close/);
  const v2 = realizedFromWindow(w2, ['dX', 100], P);
  assert.equal(v2.variance, variance);
});

// ------------------------------------------------------- CLI on synthetic bars

const FIRST = '2099-01-01'; // first synthetic day; line dates start FIRST + 31
const L0 = addDays(FIRST, 31);

function offlineSetup(n, opts) {
  const dir = tmpDir('vol-off');
  const { days } = syntheticDays(FIRST, n, opts);
  writeOffline(path.join(dir, 'bars'), days);
  return { dir, bars: path.join(dir, 'bars'), out: path.join(dir, 'out'), days };
}
const replay = (from, to) => ['--replay', `${from}..${to}`];

test('T4a completeness: a day with 1,439 bars stops the run (exit 1), no line for it and none after', async () => {
  const s = offlineSetup(36, { drop: { [addDays(FIRST, 32)]: new Set([700]) } });
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, ...replay(L0, addDays(L0, 4))]);
  assert.equal(r.code, 1, r.err);
  const lines = readJsonl(path.join(s.out, REC));
  assert.deepEqual(lines.map((l) => l.date), [L0, addDays(L0, 1)]); // the line covering FIRST+32 (date FIRST+33) is not written
  assert.match(r.err, /has 1439 of 1440 1-minute bars; missing 11:40-11:40 \(1 min\); canonical text sha256 [0-9a-f]{64}/);
});

test('T4b accepted gap: a matching sha256 writes the line with gaps; a mismatch stops', async () => {
  const gapDay = addDays(FIRST, 32);
  const s = offlineSetup(36, { drop: { [gapDay]: new Set([120, 121, 122]) } });
  const text = canonicalMinuteText(s.days[gapDay]);
  const missing = minuteGaps(s.days[gapDay], gapDay);
  assert.deepEqual(missing, [{ from: '02:00', to: '02:02', minutes: 3 }]);
  const good = path.join(s.dir, 'gaps-good.json');
  fs.writeFileSync(good, JSON.stringify([{ id: 'syn-1', series: 'volbtc-realized', day: gapDay, sha256: sha256(text), missing, note: 'synthetic', confirmedAt: '2099-01-01T00:00:00Z' }]));
  const bad = path.join(s.dir, 'gaps-bad.json');
  fs.writeFileSync(bad, JSON.stringify([{ id: 'syn-1', series: 'volbtc-realized', day: gapDay, sha256: 'a'.repeat(64), missing, note: 'synthetic', confirmedAt: '2099-01-01T00:00:00Z' }]));
  const rb = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', bad, ...replay(L0, addDays(L0, 4))]);
  assert.equal(rb.code, 1);
  assert.equal(readJsonl(path.join(s.out, REC)).length, 2);
  const rg = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', good, ...replay(L0, addDays(L0, 4))]);
  assert.equal(rg.code, 0, rg.err);
  const lines = readJsonl(path.join(s.out, REC));
  assert.equal(lines.length, 5);
  const g = lines.find((l) => l.source.day === gapDay);
  assert.deepEqual(g.gaps, missing);
  assert.equal(g.gapAccepted, 'syn-1');
  assert.equal(g.source.rows, 1437);
  assert.equal(lines.filter((l) => l.gaps).length, 1);
});

test('T4c accepted day with 23:45-23:59 missing: the close is the latest 1-minute bar before the gap', async () => {
  const gapDay = addDays(FIRST, 31); // source day of line L0 + 1
  const drop = new Set(Array.from({ length: 15 }, (_, k) => 1425 + k));
  const s = offlineSetup(34, { drop: { [gapDay]: drop } });
  const gf = path.join(s.dir, 'g.json');
  fs.writeFileSync(gf, JSON.stringify([{ id: 'syn-2345', series: 'volbtc-realized', day: gapDay, sha256: sha256(canonicalMinuteText(s.days[gapDay])), missing: minuteGaps(s.days[gapDay], gapDay), note: 'synthetic', confirmedAt: 'x' }]));
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', gf, ...replay(L0, addDays(L0, 1))]);
  assert.equal(r.code, 0, r.err);
  const l = readJsonl(path.join(s.out, REC))[1];
  assert.equal(l.source.lastBar, '23:44');
  assert.equal(l.window[30][1], s.days[gapDay][1424].c);
  assert.deepEqual(l.gaps, [{ from: '23:45', to: '23:59', minutes: 15 }]);
});

test('T4d accepted whole-day gap inside the window: null in the window, returns 29, the next return spans two days', async () => {
  const empty = addDays(FIRST, 31);
  const s = offlineSetup(36, { empty: new Set([empty]) });
  const gf = path.join(s.dir, 'g.json');
  fs.writeFileSync(gf, JSON.stringify([{ id: 'syn-empty', series: 'volbtc-realized', day: empty, sha256: sha256(''), missing: [{ from: '00:00', to: '23:59', minutes: 1440 }], note: 'synthetic', confirmedAt: 'x' }]));
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', gf, ...replay(L0, addDays(L0, 3))]);
  assert.equal(r.code, 0, r.err);
  const lines = readJsonl(path.join(s.out, REC));
  // line L0+1 covers the empty day as its LAST day: last return 0
  const endEmpty = lines[1];
  assert.equal(endEmpty.source.day, empty);
  assert.equal(endEmpty.window[30][1], null);
  assert.equal(endEmpty.source.rows, 0);
  assert.equal(endEmpty.source.lastBar, null);
  assert.equal(endEmpty.returns, 29);
  const w0 = lines[0].window;
  const manual = realizedFromWindow([...w0.slice(1), [empty, null]], null, P);
  assert.equal(endEmpty.variance, manual.variance);
  // line L0+2: the empty day inside, the return after it spans two days
  const inside = lines[2];
  assert.equal(inside.window[29][1], null);
  assert.equal(inside.returns, 29);
  const w = inside.window.map((e) => e[1]);
  let S = 0;
  let prev = w[0];
  for (let k = 1; k <= 30; k++) {
    const c = w[k] ?? prev;
    S = S + Math.log(c / prev) ** 2;
    prev = c;
  }
  assert.ok(Math.abs(inside.variance - (365 / 30) * S) / inside.variance < 1e-12);
});

test('T4e first close missing (accepted empty day at D-31): carriedFrom from the nearest earlier close, then carried on', async () => {
  const empty = addDays(FIRST, 1);
  const s = offlineSetup(36, { empty: new Set([empty]) });
  const gf = path.join(s.dir, 'g.json');
  fs.writeFileSync(gf, JSON.stringify([{ id: 'syn-first', series: 'volbtc-realized', day: empty, sha256: sha256(''), missing: [{ from: '00:00', to: '23:59', minutes: 1440 }], note: 'synthetic', confirmedAt: 'x' }]));
  const first = addDays(empty, 31); // its window starts at the empty day
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', gf, ...replay(first, addDays(first, 1))]);
  assert.equal(r.code, 0, r.err);
  const [a, b] = readJsonl(path.join(s.out, REC));
  assert.equal(a.window[0][1], null);
  // first line: the carried day with its source record (rows, sha256), like an entry of `sources`
  assert.deepEqual(a.carriedFrom, [FIRST, s.days[FIRST].at(-1).c, 1440, sha256(canonicalMinuteText(s.days[FIRST]))]);
  assert.equal(a.returns, 30);
  assert.deepEqual(a.sources[0], [empty, 0, sha256(''), 'syn-first']);
  assert.ok(!('carriedFrom' in b));
  const v = verifyDir(s.out);
  assert.equal(v.status, 0, v.stdout);
});

test('T4e-2 two empty days at the window start: later lines carry [date, close] only; an accepted partial carried day adds its acceptance id', async () => {
  const e1 = addDays(FIRST, 1);
  const e2 = addDays(FIRST, 2);
  const s = offlineSetup(37, { empty: new Set([e1, e2]), drop: { [FIRST]: new Set([10]) } });
  const gf = path.join(s.dir, 'g.json');
  const entry = (id, day, mins) => ({ id, series: 'volbtc-realized', day, sha256: sha256(canonicalMinuteText(mins)), missing: minuteGaps(mins, day), note: 'synthetic', confirmedAt: 'x' });
  fs.writeFileSync(gf, JSON.stringify([entry('syn-part', FIRST, s.days[FIRST]), entry('syn-e1', e1, []), entry('syn-e2', e2, [])]));
  const first = addDays(e1, 31);
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', gf, ...replay(first, addDays(first, 2))]);
  assert.equal(r.code, 0, r.err);
  const [a, b, c] = readJsonl(path.join(s.out, REC));
  assert.deepEqual(a.carriedFrom, [FIRST, s.days[FIRST].at(-1).c, 1439, sha256(canonicalMinuteText(s.days[FIRST])), 'syn-part']);
  assert.equal(b.window[0][1], null);
  assert.deepEqual(b.carriedFrom, [FIRST, s.days[FIRST].at(-1).c]);
  assert.ok(!('carriedFrom' in c));
  assert.equal(b.variance, realizedFromWindow(b.window, b.carriedFrom, P).variance);
  const v = verifyDir(s.out);
  assert.equal(v.status, 0, v.stdout);
});

test('acceptance entry: the missing list is compared field by field (key order does not matter)', async () => {
  const gapDay = addDays(FIRST, 32);
  const s = offlineSetup(35, { drop: { [gapDay]: new Set([120, 121, 122]) } });
  const missing = minuteGaps(s.days[gapDay], gapDay).map(({ from, to, minutes }) => ({ minutes, to, from }));
  const gf = path.join(s.dir, 'g.json');
  fs.writeFileSync(gf, JSON.stringify([{ id: 'syn-order', series: 'volbtc-realized', day: gapDay, sha256: sha256(canonicalMinuteText(s.days[gapDay])), missing, note: 'synthetic', confirmedAt: 'x' }]));
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', s.out, '--gaps', gf, ...replay(L0, addDays(L0, 2))]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readJsonl(path.join(s.out, REC)).filter((l) => l.gapAccepted === 'syn-order').length, 1);
  // a list that differs in a value is still refused (exit 2)
  fs.writeFileSync(gf, JSON.stringify([{ id: 'syn-order', series: 'volbtc-realized', day: gapDay, sha256: sha256(canonicalMinuteText(s.days[gapDay])), missing: [{ ...missing[0], minutes: 4 }], note: 'synthetic', confirmedAt: 'x' }]));
  const out2 = path.join(s.dir, 'out2');
  const r2 = await cli(run, ['--line', 'realized', '--dry-run', '--offline', s.bars, '--out', out2, '--gaps', gf, ...replay(L0, addDays(L0, 2))]);
  assert.equal(r2.code, 2);
});

test('T5 finality: the next day’s first bar missing or not yet closed → no line, exit 0', async () => {
  const { days } = syntheticDays(FIRST, 33);
  const out = tmpDir('vol-t5');
  // serverTime inside the 00:00 minute of L0 → that bar is open, day L0-1 not over
  const t = dayMs(L0) + 30_000;
  const fb = fakeBinance(days, t);
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--out', out, ...replay(L0, L0)], { fetch: fb.fetch, now: () => t });
  assert.equal(r.code, 0, r.err);
  assert.equal(readJsonl(path.join(out, REC)).length, 0);
  assert.match(r.out, /has not ended/);
  // no bar at or after 00:00 at all
  const days2 = Object.fromEntries(Object.entries(days).filter(([d]) => d < L0));
  const fb2 = fakeBinance(days2, dayMs(L0) + 3_600_000);
  const r2b = await cli(run, ['--line', 'realized', '--dry-run', '--out', out, ...replay(L0, L0)], { fetch: fb2.fetch, now: () => dayMs(L0) + 3_600_000 });
  assert.equal(r2b.code, 0);
  assert.equal(readJsonl(path.join(out, REC)).length, 0);
});

test('T6 catch-up and determinism: two ended days → two lines in order, only the first late; a late run writes the same lines; a second run writes none', async () => {
  const { days } = syntheticDays(FIRST, 34);
  const X = L0;
  const tOnTime = dayMs(addDays(X, 1)) + 3_600_000; // during X+1: days X-1 and X are over, X+1 is not
  const outA = tmpDir('vol-t6a');
  const fa = fakeBinance(days, tOnTime);
  const ra = await cli(run, ['--line', 'realized', '--dry-run', '--out', outA, ...replay(X, addDays(X, 5))], { fetch: fa.fetch, now: () => tOnTime });
  assert.equal(ra.code, 0, ra.err);
  const A = readJsonl(path.join(outA, REC));
  assert.deepEqual(A.map((l) => l.date), [X, addDays(X, 1)]);
  assert.equal(A[0].late, true);
  assert.ok(!('late' in A[1]));
  assert.equal(A[1].prevHash, A[0].hash);
  // a run three days later (late) over the same two days
  const tLate = dayMs(addDays(X, 4)) + 7_200_000;
  const outB = tmpDir('vol-t6b');
  const fbk = fakeBinance(days, tLate);
  const rb = await cli(run, ['--line', 'realized', '--dry-run', '--out', outB, ...replay(X, addDays(X, 1))], { fetch: fbk.fetch, now: () => tLate });
  assert.equal(rb.code, 0, rb.err);
  const B = readJsonl(path.join(outB, REC));
  assert.equal(B.length, 2);
  assert.equal(B[1].late, true);
  assert.deepEqual(B.map(timeless), A.map(timeless));
  assert.equal(JSON.stringify(B.map(timeless)), JSON.stringify(A.map(timeless)));
  // the same run again: nothing new
  const fa2 = fakeBinance(days, tOnTime);
  const ra2 = await cli(run, ['--line', 'realized', '--dry-run', '--out', outA, ...replay(X, addDays(X, 5))], { fetch: fa2.fetch, now: () => tOnTime });
  assert.equal(ra2.code, 0);
  assert.equal(readJsonl(path.join(outA, REC)).length, 2);
});

test('T7 two fetches of the same day differ → exit 1, nothing written', async () => {
  const { days } = syntheticDays(FIRST, 33);
  const out = tmpDir('vol-t7');
  const t = dayMs(addDays(L0, 1)) + 3_600_000;
  let n = 0;
  const fb = fakeBinance(days, t, {
    tamper: (_call, rows) => {
      if (rows.length === 1000 && rows[0][0] === dayMs(addDays(FIRST, 5))) {
        n++;
        if (n === 2)
          return rows.map((r, i) => {
            if (i !== 10) return r;
            const c2 = Number(r[4]) + 0.01;
            return [r[0], r[1], Math.max(Number(r[2]), c2).toFixed(8), r[3], c2.toFixed(8), ...r.slice(5)];
          });
      }
      return rows;
    },
  });
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--out', out, ...replay(L0, L0)], { fetch: fb.fetch, now: () => t });
  assert.equal(r.code, 1);
  assert.match(r.err, /two fetches of .* differ/);
  assert.equal(readJsonl(path.join(out, REC)).length, 0);
});

test('REST path: 1-minute bars twice per day in two pages; window and sources cover D-31 … D-1', async () => {
  const { days } = syntheticDays(FIRST, 33);
  const out = tmpDir('vol-rest');
  const t = dayMs(addDays(L0, 1)) + 3_600_000;
  const fb = fakeBinance(days, t);
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--out', out, ...replay(L0, L0)], { fetch: fb.fetch, now: () => t });
  assert.equal(r.code, 0, r.err);
  const [l] = readJsonl(path.join(out, REC));
  assert.deepEqual(l.window.map((e) => e[0]), windowDates(L0, 30));
  assert.equal(l.sources.length, 31);
  assert.equal(l.source.rows, 1440);
  assert.equal(l.source.lastBar, '23:59');
  assert.equal(l.source.host, 'data-api.binance.vision');
  assert.equal(l.source.sha256, sha256(canonicalMinuteText(days[addDays(L0, -1)])));
  const kl = fb.calls.filter((c) => c.startsWith('/api/v3/klines'));
  assert.equal(kl.length, 31 * 2 * 2 + 1); // 31 days x 2 pages x 2 fetches + the finality probe
  assert.equal(fb.calls.filter((c) => c === '/api/v3/time').length, 1);
  assert.equal(l.window[30][1], days[addDays(L0, -1)].at(-1).c);
  assert.equal(MIN_MS, 60000);
});
