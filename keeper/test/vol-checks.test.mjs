/**
 * Realized line of the BTC volatility index (working name): the checks C1 and
 * C7–C13 (reproducibility test, before its main run), and the W1 change (the day's close is
 * the close of the 1-minute bar that opened latest that day; the rule carries
 * no bar length). Everything runs on SYNTHETIC bars — never market data.
 *
 *   node --test keeper/test/vol-checks.test.mjs
 *
 * C7, C11, C12 and C13 are also run on a real record when VOL_CHECK_DIR names
 * a folder holding record-volbtc-realized.jsonl (skipped otherwise).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realizedFromWindow, canonicalMinuteText, parseKlines, parseOfflineLine, sha256, r2, halfUp, minuteGaps } from '../vol-realized.mjs';
import { run, rulebookProblem } from '../vol-index.mjs';
import { syntheticDays, dayMinutes, writeOffline, tmpDir, readJsonl, cli, timeless, addDays, rulebookPath, REPO } from './vol-helpers.mjs';

const P = { windowDays: 30, yearDays: 365 };
const REC = 'record-volbtc-realized.jsonl';
const FIRST = '2099-01-01';
const L0 = addDays(FIRST, 31); // the first line whose window lies inside the synthetic days
const replay = (from, to) => ['--replay', `${from}..${to}`];
const verifyDir = (dir) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'verify-vol.mjs'), '--dir', dir, '--rulebook', rulebookPath('realized')], { encoding: 'utf8', env: { PATH: process.env.PATH } });

/** Offline run of the realized line over `days` ({day: minutes[]}); returns {code, err, lines, dir}. */
async function offlineRun(days, from, to, { gaps } = {}) {
  const dir = tmpDir('vol-chk');
  writeOffline(path.join(dir, 'bars'), days);
  const extra = [];
  if (gaps) {
    fs.writeFileSync(path.join(dir, 'g.json'), JSON.stringify(gaps));
    extra.push('--gaps', path.join(dir, 'g.json'));
  }
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(dir, 'bars'), '--out', path.join(dir, 'out'), ...extra, ...replay(from, to)]);
  return { ...r, lines: readJsonl(path.join(dir, 'out', REC)), out: path.join(dir, 'out') };
}

/** Days of 1-minute bars whose day closes are `closes[1..n]` (closes[0] = the day before FIRST). */
function daysFromCloses(closes) {
  const days = {};
  for (let k = 1; k < closes.length; k++) days[addDays(FIRST, k - 1)] = dayMinutes(addDays(FIRST, k - 1), closes[k - 1], closes[k]);
  return days;
}

const acceptance = (id, day, mins) => ({ id, series: 'volbtc-realized', day, sha256: sha256(canonicalMinuteText(mins)), missing: minuteGaps(mins, day), note: 'synthetic', confirmedAt: 'x' });

// ------------------------------------------------- the checks on a record

/** C7: hash = sha256(JSON.stringify(line minus hash)); prevHash = the previous line's hash (null first). */
function chainProblems(lines) {
  const bad = [];
  lines.forEach((L, i) => {
    const { hash, ...rest } = L;
    if (sha256(JSON.stringify(rest)) !== hash) bad.push(`${L.date}: hash`);
    if (L.prevHash !== (i === 0 ? null : lines[i - 1].hash)) bad.push(`${L.date}: prevHash`);
  });
  return bad;
}

/** C11: every value >= 0. */
const valueProblems = (lines) => lines.filter((L) => !(typeof L.value === 'number' && L.value >= 0)).map((L) => `${L.date}: value ${L.value}`);

/** C12: variance = (365/30) x sum r^2 recomputed from the window in the definition's order, bit for bit. */
function varianceProblems(lines) {
  const bad = [];
  for (const L of lines) {
    const w = L.window;
    let prev = w[0][1] !== null ? w[0][1] : L.carriedFrom[1];
    let S = 0;
    for (let k = 1; k < w.length; k++) {
      const c = w[k][1] === null ? prev : w[k][1];
      const r = Math.log(c / prev);
      S = S + r * r;
      prev = c;
    }
    const variance = (L.rule.yearDays / L.rule.windowDays) * S;
    if (!Object.is(variance, L.variance)) bad.push(`${L.date}: variance ${L.variance} vs ${variance}`);
    const x = 100 * Math.sqrt(variance);
    if (Math.floor(x * 100 + 0.5) / 100 !== L.value) bad.push(`${L.date}: value ${L.value}`);
  }
  return bad;
}

/** C13: line D's window[0..29] = line D-1's window[1..30]. */
function joinProblems(lines) {
  const bad = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i].window.slice(0, -1);
    const b = lines[i - 1].window.slice(1);
    if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${lines[i].date}: window does not continue ${lines[i - 1].date}`);
  }
  return bad;
}

// -------------------------------------------------------------------- C1
test('C1 closed form: closes moving +-x every day, x = ln 1.01 → 100 x sqrt(365) x x, rounded half up', async () => {
  const x = Math.log(1.01);
  const want = Math.floor(100 * Math.sqrt(365) * x * 100 + 0.5) / 100;
  assert.equal(want, 19.01);
  // pure function on a close series C_k = 50000 x e^(+-x)
  const window = [];
  let c = 50000;
  for (let k = 0; k <= 30; k++) {
    window.push([`d${k}`, c]);
    c = c * Math.exp(k % 2 === 0 ? x : -x);
  }
  assert.equal(realizedFromWindow(window, null, P).value, want);
  // the whole keeper path on 1-minute files: day closes 50000, 50500, 50000, … (ratio 1.01 and 1/1.01)
  const closes = Array.from({ length: 36 }, (_, k) => (k % 2 === 0 ? 50000 : 50500));
  const r = await offlineRun(daysFromCloses(closes), L0, addDays(L0, 2));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.length, 3);
  for (const L of r.lines) {
    assert.equal(L.value, want, `${L.date}`);
    assert.ok(Math.abs(L.variance - 365 * x * x) / (365 * x * x) < 1e-12);
  }
});

// -------------------------------------------------------------------- C7
test('C7 chain: hash and prevHash recomputed on every line agree; a changed byte is found', async () => {
  const { days } = syntheticDays(FIRST, 38);
  const r = await offlineRun(days, L0, addDays(L0, 5));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.length, 6);
  assert.deepEqual(chainProblems(r.lines), []);
  assert.equal(r.lines[0].prevHash, null);
  const tampered = r.lines.map((l) => ({ ...l }));
  tampered[3].variance = tampered[3].variance * (1 + 1e-15);
  assert.deepEqual(chainProblems(tampered), [`${tampered[3].date}: hash`]);
  const relinked = r.lines.map((l) => ({ ...l }));
  relinked[2].prevHash = relinked[0].hash;
  assert.ok(chainProblems(relinked).includes(`${relinked[2].date}: prevHash`));
});

// -------------------------------------------------------------------- C8
/** The next binary64 number above (+1) or below (-1) a positive finite y. */
function nextDouble(y, dir) {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, y);
  v.setBigUint64(0, v.getBigUint64(0) + BigInt(dir));
  return v.getFloat64(0);
}

test('C8 rounding: y = n + 0.5 exactly goes up, the double just below goes down, the double just above goes up', () => {
  for (const n of [1, 2, 3, 1900, 3612, 3704, 9999, 123456]) {
    const y = n + 0.5;
    const below = nextDouble(y, -1);
    const above = nextDouble(y, +1);
    assert.ok(below < y && y < above);
    assert.equal(halfUp(y), n + 1, `${y}`); // up, never to even (2.5 → 3, 3704.5 → 3705)
    assert.equal(halfUp(below), n, `${below}`);
    assert.equal(halfUp(above), n + 1, `${above}`);
  }
  // n = 0 is the one place where floor(y + 0.5) in binary64 differs from exact half up: the double
  // just below 0.5 plus 0.5 rounds to 1. That y is a published value under 0.005 points; the
  // definition (docs/vol-index.md) is applied as written, and this edge is reported, not changed here.
  assert.equal(halfUp(0.5), 1);
  assert.equal(halfUp(nextDouble(0.5, +1)), 1);
  assert.equal(halfUp(nextDouble(0.5, -1)), 1); // 0.49999999999999994 + 0.5 = 1 in binary64
  assert.equal(halfUp(nextDouble(nextDouble(0.5, -1), -1)), 0);
  assert.equal(halfUp(3704.5), 3705);
  assert.equal(halfUp(2.5), 3);
  // the published value goes through the same function: y = x x 100, n / 100
  assert.equal(r2(37.045), Math.floor(37.045 * 100 + 0.5) / 100);
  assert.equal(r2(36.125), 36.13); // 36.125 x 100 = 3612.5 exactly
  assert.equal(r2(0), 0);
});

// -------------------------------------------------------------------- C9
test('C9 (a) a day with 1,439 bars: the run stops (exit 1); no line for it and none after', async () => {
  const gapDay = addDays(FIRST, 32); // source day of line L0 + 2
  const { days } = syntheticDays(FIRST, 37, { drop: { [gapDay]: new Set([1439]) } });
  const r = await offlineRun(days, L0, addDays(L0, 5));
  assert.equal(r.code, 1, r.err);
  assert.deepEqual(r.lines.map((l) => l.date), [L0, addDays(L0, 1)]);
  assert.match(r.err, /has 1439 of 1440 1-minute bars; missing 23:59-23:59 \(1 min\)/);
});

test('C9 (b) the acceptance list holds the same sha256: the run goes on; a different sha256 still stops', async () => {
  const gapDay = addDays(FIRST, 32);
  const { days } = syntheticDays(FIRST, 37, { drop: { [gapDay]: new Set([1439]) } });
  const good = await offlineRun(days, L0, addDays(L0, 5), { gaps: [acceptance('syn-c9b', gapDay, days[gapDay])] });
  assert.equal(good.code, 0, good.err);
  assert.equal(good.lines.length, 6);
  const g = good.lines.find((l) => l.source.day === gapDay);
  assert.equal(g.gapAccepted, 'syn-c9b');
  assert.deepEqual(g.gaps, [{ from: '23:59', to: '23:59', minutes: 1 }]);
  // the latest bar of that day is 23:58: its close is the day's close
  assert.equal(g.source.lastBar, '23:58');
  assert.equal(g.window[30][1], days[gapDay].at(-1).c);
  const bad = await offlineRun(days, L0, addDays(L0, 5), { gaps: [{ ...acceptance('syn-c9b', gapDay, days[gapDay]), sha256: 'b'.repeat(64) }] });
  assert.equal(bad.code, 1);
  assert.equal(bad.lines.length, 2);
});

test('C9 (c) a whole day without a bar: null in the window, its return 0, returns 29, denominator still 30', async () => {
  const empty = addDays(FIRST, 31); // source day of line L0 + 1
  const { days } = syntheticDays(FIRST, 36, { empty: new Set([empty]) });
  const r = await offlineRun(days, L0, addDays(L0, 3), { gaps: [acceptance('syn-c9c', empty, [])] });
  assert.equal(r.code, 0, r.err);
  for (const L of r.lines.slice(1)) {
    const k = L.window.findIndex((e) => e[0] === empty);
    assert.equal(L.window[k][1], null);
    assert.equal(L.returns, 29);
    // the same as the window with the empty day standing at the previous close (return 0)
    const filled = L.window.map((e, i) => (i === k ? [e[0], L.window[k - 1][1]] : e));
    assert.ok(Object.is(realizedFromWindow(filled, null, P).variance, L.variance), L.date);
  }
  assert.equal(r.lines[1].source.lastBar, null);
  assert.equal(r.lines[1].source.rows, 0);
});

test('C9 (d) the first close of the window missing: carriedFrom holds the nearest earlier close', async () => {
  const empty = addDays(FIRST, 1);
  const { days } = syntheticDays(FIRST, 36, { empty: new Set([empty]) });
  const first = addDays(empty, 31); // its window starts at the empty day
  const r = await offlineRun(days, first, addDays(first, 1), { gaps: [acceptance('syn-c9d', empty, [])] });
  assert.equal(r.code, 0, r.err);
  const [a, b] = r.lines;
  assert.equal(a.window[0][1], null);
  assert.deepEqual(a.carriedFrom, [FIRST, days[FIRST].at(-1).c, 1440, sha256(canonicalMinuteText(days[FIRST]))]);
  assert.equal(a.returns, 30);
  assert.equal(a.variance, realizedFromWindow([[FIRST, days[FIRST].at(-1).c], ...a.window.slice(1)], null, P).variance);
  assert.ok(!('carriedFrom' in b));
  const v = verifyDir(r.out);
  assert.equal(v.status, 0, v.stdout);
});

// ------------------------------------------------------------------- C10
test('C10 canonical text: the same value in other digits ("64000.00000000" and "64000") gives the same sha256', async () => {
  const k8 = [[4070908800000, '64000.00000000', '64010.50000000', '63990.10000000', '64005.00000000', '1', 4070908859999]];
  const k0 = [[4070908800000, '64000', '64010.5', '63990.1', '64005', '1', 4070908859999]];
  assert.equal(sha256(canonicalMinuteText(parseKlines(k8))), sha256(canonicalMinuteText(parseKlines(k0))));
  const o8 = parseOfflineLine('4070908800000,64000.00000000,64010.50000000,63990.10000000,64005.00000000');
  const o0 = parseOfflineLine('4070908800000,64000,64010.5,63990.1,64005');
  assert.equal(canonicalMinuteText([o8]), '4070908800000,64000,64010.5,63990.1,64005\n');
  assert.equal(sha256(canonicalMinuteText([o8])), sha256(canonicalMinuteText([o0])));
  // through the keeper: the same days written with 8 decimals give the same lines
  const { days } = syntheticDays(FIRST, 34);
  const plain = await offlineRun(days, L0, addDays(L0, 1));
  const dir = tmpDir('vol-c10');
  fs.mkdirSync(path.join(dir, 'bars'));
  for (const [d, mins] of Object.entries(days))
    fs.writeFileSync(path.join(dir, 'bars', `BTCUSDT-1m-${d}.csv`), mins.map((m) => `${m.openMs},${m.o.toFixed(8)},${m.h.toFixed(8)},${m.l.toFixed(8)},${m.c.toFixed(8)}`).join('\n') + '\n');
  const r8 = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(dir, 'bars'), '--out', path.join(dir, 'out'), ...replay(L0, addDays(L0, 1))]);
  assert.equal(r8.code, 0, r8.err);
  assert.equal(plain.code, 0, plain.err);
  const eight = readJsonl(path.join(dir, 'out', REC));
  assert.deepEqual(eight.map(timeless), plain.lines.map(timeless));
});

// ------------------------------------------------------------------- C11
test('C11 value range: every value >= 0, a flat price gives 0', async () => {
  const flat = await offlineRun(daysFromCloses(Array.from({ length: 35 }, () => 64000)), L0, addDays(L0, 1));
  assert.equal(flat.code, 0, flat.err);
  assert.deepEqual(flat.lines.map((l) => l.value), [0, 0]);
  const { days } = syntheticDays(FIRST, 40);
  const r = await offlineRun(days, L0, addDays(L0, 7));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(valueProblems([...flat.lines, ...r.lines]), []);
  assert.deepEqual(valueProblems([{ date: 'x', value: -0.01 }]), ['x: value -0.01']);
});

// ------------------------------------------------------------------- C12
test('C12 variance formula: (365/30) x sum r^2 recomputed from each window, bit for bit', async () => {
  const empty = addDays(FIRST, 33);
  const { days } = syntheticDays(FIRST, 42, { empty: new Set([empty]) });
  const r = await offlineRun(days, L0, addDays(L0, 9), { gaps: [acceptance('syn-c12', empty, [])] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.length, 10);
  assert.deepEqual(varianceProblems(r.lines), []);
  const off = r.lines.map((l) => ({ ...l }));
  off[4].variance = nextDouble(off[4].variance, +1);
  assert.deepEqual(varianceProblems(off).filter((m) => m.includes('variance')), [`${off[4].date}: variance ${off[4].variance} vs ${r.lines[4].variance}`]);
});

// ------------------------------------------------------------------- C13
test('C13 window join: line D window[0..29] = line D-1 window[1..30]', async () => {
  const { days } = syntheticDays(FIRST, 40);
  const r = await offlineRun(days, L0, addDays(L0, 7));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(joinProblems(r.lines), []);
  const broken = r.lines.map((l) => ({ ...l, window: l.window.map((e) => [...e]) }));
  broken[5].window[10][1] += 0.01;
  assert.deepEqual(joinProblems(broken), [`${broken[5].date}: window does not continue ${broken[4].date}`, `${broken[6].date}: window does not continue ${broken[5].date}`]);
});

// -------------------------------------------------------------------- W1
test('W1 the rule has no bar length: rulebook without barMinutes, lines without rule.barMinutes, lastBar = the latest 1-minute bar', async () => {
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  assert.ok(!('barMinutes' in rb.source));
  assert.equal(rulebookProblem(rb, 'realized'), null);
  const back = structuredClone(rb);
  back.source.barMinutes = 15;
  assert.match(rulebookProblem(back, 'realized'), /no barMinutes/);
  const { days } = syntheticDays(FIRST, 34);
  const r = await offlineRun(days, L0, addDays(L0, 1));
  assert.equal(r.code, 0, r.err);
  for (const L of r.lines) {
    assert.deepEqual(Object.keys(L.rule), ['rulebookSha256', 'windowDays', 'yearDays', 'sampling', 'mean']);
    assert.equal(L.source.lastBar, '23:59');
    assert.equal(L.window[30][1], days[L.source.day].at(-1).c);
  }
  // the verifier refuses a line that still carries rule.barMinutes
  const L = { ...r.lines[0], rule: { ...r.lines[0].rule, barMinutes: 15 } };
  delete L.hash;
  L.hash = sha256(JSON.stringify(L));
  const dir = tmpDir('vol-w1');
  fs.writeFileSync(path.join(dir, REC), JSON.stringify(L) + '\n');
  const v = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'verify-vol.mjs'), '--dir', dir], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(v.status, 0);
  assert.match(v.stdout + v.stderr, /rule is not the implemented definition/);
});

// -------------------------------------------- the same checks on a real record
const REAL = process.env.VOL_CHECK_DIR;
test('C7 C11 C12 C13 on a real record — only with VOL_CHECK_DIR', { skip: REAL ? false : 'VOL_CHECK_DIR not set' }, () => {
  const lines = readJsonl(path.join(REAL, REC));
  assert.ok(lines.length > 0, `no lines in ${path.join(REAL, REC)}`);
  assert.deepEqual(chainProblems(lines), [], 'C7');
  assert.deepEqual(valueProblems(lines), [], 'C11');
  assert.deepEqual(varianceProblems(lines), [], 'C12');
  assert.deepEqual(joinProblems(lines), [], 'C13');
});
