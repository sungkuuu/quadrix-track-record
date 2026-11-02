/**
 * Implied line of the BTC volatility index (working name): known answers on
 * hand-computed option chains, the constant-maturity interpolation against the
 * five published numbers of the Cboe sample calculation, a synthetic flat-vol
 * table, selection boundaries, expiry choice and minute
 * flooring. Pure functions; no network. All option data here is SYNTHETIC.
 *
 *   node --test keeper/test/vol-implied.test.mjs
 *   VOL_FIXTURE_DIR=<private dir> node --test …   # also the tests on a saved snapshot (skipped otherwise)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { termVariance, interpolate, computeTerm, computeImplied, joinQuotes, minutesTo, isValid, pickTerms, parseDeribit, r2, FormatError } from '../vol-implied.mjs';
import { syntheticTable, handTable, KEEPER } from './vol-helpers.mjs';

const CFG = { cm: 43200, ym: 525600, cutoff: 2 };
const rowsOf = (t) => joinQuotes(t.instruments, t.book);
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// bid/ask around a binary-exact mid: mid -+ 1/1024
const q = (mid) => [mid - 1 / 1024, mid + 1 / 1024];

// ------------------------------------------------ known answers, hand-computed
//
// Chain A (one term, M = 52,560 minutes → T = 0.1; strikes 80 … 120 every 10):
//   K*  = 100 (c = p = 1/16) → F = 100 / (1 - 0) = 100 → K0 = 100
//   selected: 80 P 1/64, 90 P 1/32, 100 (c+p)/2 = 1/16, 110 C 1/32, 120 C 1/64; dK = 10 everywhere
//   Q~ = q x F; sum dK/K^2 x Q~ = 10 x (1.5625/6400 + 3.125/8100 + 6.25/10000 + 3.125/12100 + 1.5625/14400)
//   sigma^2 = (2 / 0.1) x sum - (1 / 0.1) x 0 = 1627589 / 5018112 = 0.32434290027803286…
// Chain B: the same, but c(100) = 3/32, p(100) = 1/16 → F = 100 / (1 - 1/32) = 103.2258…, K0 = 100,
//   the K0 price is (3/32 + 1/16) / 2 = 5/64, and the (F/K0 - 1)^2 term is no longer zero:
//   sigma^2 = 53748395 / 150700176 = 0.35665781173341166…
// (exact fractions computed by hand and re-checked with rational arithmetic)
const chainA = [
  [80, ...q(0.25), ...q(1 / 64)],
  [90, ...q(5 / 32), ...q(1 / 32)],
  [100, ...q(1 / 16), ...q(1 / 16)],
  [110, ...q(1 / 32), ...q(0.125)],
  [120, ...q(1 / 64), ...q(0.25)],
];
const chainB = chainA.map((r) => (r[0] === 100 ? [100, ...q(3 / 32), ...q(1 / 16)] : r));

function oneTerm(rows, M = 52560) {
  const t = handTable([{ rows }], 4102444800000000, { minutes: [M] });
  return computeTerm('near', t.instruments[0].expiration_timestamp, M, rowsOf(t), CFG);
}

test('known answer, chain A: hand-computed sigma^2 = 1627589/5018112', () => {
  const { term, fail } = oneTerm(chainA);
  assert.equal(fail, null);
  assert.equal(term.atm, 100);
  assert.equal(term.forward, 100);
  assert.equal(term.k0, 100);
  assert.equal(term.putsUsed, 2);
  assert.equal(term.callsUsed, 2);
  assert.ok(rel(term.variance, 1627589 / 5018112) < 1e-12, `${term.variance}`);
});

test('known answer, chain B: forward from K/(1-(c-p)) and the (F/K0 - 1)^2 term; sigma^2 = 53748395/150700176', () => {
  const { term, fail } = oneTerm(chainB);
  assert.equal(fail, null);
  assert.ok(rel(term.forward, 100 / (1 - 1 / 32)) < 1e-15);
  assert.equal(term.k0, 100);
  assert.ok(rel(term.variance, 53748395 / 150700176) < 1e-12, `${term.variance}`);
});

test('termVariance core takes dollar values at expiry (either adapter): same as the BTC path times F', () => {
  const strikes = [80, 90, 100, 110, 120];
  const qs = [1 / 64, 1 / 32, 1 / 16, 1 / 32, 1 / 64];
  const v = termVariance({ strikes, Qt: qs.map((x) => x * 100), F: 100, K0: 100, T: 0.1 });
  assert.ok(rel(v, 1627589 / 5018112) < 1e-12);
});

test('known answer, interpolation: M1 = 21,600, M2 = 64,800, s1 = 0.16, s2 = 0.36 → V30 = 0.25 s1 + 0.75 s2 = 0.31 → 55.68', () => {
  const v = interpolate({ M1: 21600, s1: 0.16, M2: 64800, s2: 0.36, cm: 43200, ym: 525600 });
  assert.ok(rel(v, 0.31) < 1e-12);
  assert.equal(r2(100 * Math.sqrt(v)), 55.68);
});

// ---------------------------------------------------------------------- T8
test('T8 interpolation step against the Cboe sample calculation (five published numbers) → 13.93', () => {
  const s = JSON.parse(fs.readFileSync(path.join(KEEPER, 'test', 'fixtures', 'vol', 'cboe-sample.json'), 'utf8'));
  const v = interpolate({ M1: s.nearMinutes, s1: s.nearVariance, M2: s.nextMinutes, s2: s.nextVariance, cm: 43200, ym: 525600 });
  const x = 100 * Math.sqrt(v);
  assert.equal(r2(x), s.publishedValue);
  assert.ok(Math.abs(x - 13.927842) < 5e-7, `${x}`);
});

test('T8b one-term variance from the Cboe appendix table (dollar adapter) — only with VOL_FIXTURE_DIR', (t) => {
  const f = process.env.VOL_FIXTURE_DIR && path.join(process.env.VOL_FIXTURE_DIR, 'cboe-sample-table.json');
  if (!f || !fs.existsSync(f)) return t.skip('the Cboe appendix table is not in a public fixture; set VOL_FIXTURE_DIR to a private copy (cboe-sample-table.json)');
  const tb = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const term of tb.terms) {
    const v = termVariance({ strikes: term.strikes, Qt: term.mids.map((m) => Math.exp(term.R * term.T) * m), F: term.F, K0: term.K0, T: term.T });
    assert.ok(Math.abs(v - term.expectedVariance) < 5e-9, `${v} vs ${term.expectedVariance}`);
  }
});

// ---------------------------------------------------------------------- T9
for (const sigma of [0.3, 0.6, 1.2]) {
  test(`T9 synthetic flat-vol Black-76 table recovers sigma0 = ${sigma} within 0.05 points, forward within 1e-9`, () => {
    const t = syntheticTable({ F: 60000, sigma, days: [20, 40] });
    const res = computeImplied(rowsOf(t), t.usOut, CFG);
    assert.equal(res.reason, null);
    assert.ok(Math.abs(res.value - 100 * sigma) <= 0.05, `value ${res.value} vs ${100 * sigma}`);
    for (const term of res.terms) assert.ok(rel(term.forward, 60000) < 1e-9, `F ${term.forward}`);
    assert.deepEqual(res.terms.map((x) => x.minutes), [28800, 57600]);
  });
}

test('interpolation: equal term variances give the same 30-day variance; M1 = 43,200 gives the near term alone', () => {
  const v = interpolate({ M1: 30000, s1: 0.2, M2: 60000, s2: 0.2, cm: 43200, ym: 525600 });
  assert.ok(rel(v, 0.2) < 1e-12);
  const w = interpolate({ M1: 43200, s1: 0.37, M2: 50000, s2: 0.11, cm: 43200, ym: 525600 });
  assert.ok(rel(w, 0.37) < 1e-12);
});

// --------------------------------------------------------------------- T10
// ladder 60 … 140 every 10; K* = 100, F = 100
const base = () => [
  [60, ...q(0.4), ...q(1 / 128)],
  [70, ...q(0.3), ...q(1 / 64)],
  [80, ...q(0.25), ...q(1 / 64)],
  [90, ...q(5 / 32), ...q(1 / 32)],
  [100, ...q(1 / 16), ...q(1 / 16)],
  [110, ...q(1 / 32), ...q(0.125)],
  [120, ...q(1 / 64), ...q(0.25)],
  [130, ...q(1 / 64), ...q(0.3)],
  [140, ...q(1 / 128), ...q(0.4)],
];
const setPut = (rows, K, bid, ask) => rows.map((r) => (r[0] === K ? [r[0], r[1], r[2], bid, ask] : r));
const setCall = (rows, K, bid, ask) => rows.map((r) => (r[0] === K ? [r[0], bid, ask, r[3], r[4]] : r));

test('T10-1 one invalid put is skipped; the walk goes on', () => {
  const { term, fail } = oneTerm(setPut(base(), 80, null, 0.02));
  assert.equal(fail, null);
  assert.equal(term.putsUsed, 3); // 90, 70, 60
});

test('T10-2 two invalid in a row end the walk: valid strikes beyond are not used', () => {
  const { term } = oneTerm(setPut(setPut(base(), 80, null, 0.02), 70, 0, 0.01));
  assert.equal(term.putsUsed, 1); // 90 only; 60 is valid but not used
  const { term: t2 } = oneTerm(setCall(setCall(base(), 120, 0.02, 0.02), 130, null, null));
  assert.equal(t2.callsUsed, 1); // 110 only
});

test('T10-3 K0 quote invalid → k0-quote-invalid', () => {
  // K* = 110 with c - p < 0 → F < 110 → K0 = 100, whose call has no bid
  let rows = setCall(setPut(base(), 110, ...q(0.0625)), 110, ...q(1 / 32));
  rows = setCall(rows, 100, null, 0.07);
  const { term, fail } = oneTerm(rows);
  assert.equal(fail, 'k0-quote-invalid');
  assert.equal(term.atm, 110);
  assert.equal(term.k0, 100);
  assert.ok(term.forward < 110 && term.forward >= 100);
});

test('no forward: 1 - (c* - p*) = 0 or < 0 → k0-quote-invalid, atm kept, no forward field', () => {
  for (const c of [1.0625, 1.5625]) {
    // only strike 100 has a valid call and put: c* - p* = 1 (exactly, binary) or 1.5
    const rows = [
      [90, ...q(1.25), null, null],
      [100, ...q(c), ...q(0.0625)],
      [110, ...q(1.0), null, null],
    ];
    const { term, fail } = oneTerm(rows);
    assert.equal(fail, 'k0-quote-invalid');
    assert.equal(term.atm, 100);
    assert.ok(!('forward' in term) && !('k0' in term));
  }
});

test('T10-4 every OTM put excluded → no-otm-puts', () => {
  const { fail, term } = oneTerm(setPut(setPut(base(), 90, null, null), 80, null, 0.01));
  assert.equal(fail, 'no-otm-puts');
  assert.equal(term.putsUsed, 0);
});

test('T10-5 ATM tie → the lower strike', () => {
  // |c - p| = 1/32 at both 100 and 110
  let rows = setCall(setPut(base(), 100, ...q(1 / 16)), 100, ...q(3 / 32));
  rows = setCall(setPut(rows, 110, ...q(3 / 32)), 110, ...q(1 / 16));
  const { term } = oneTerm(rows);
  assert.equal(term.atm, 100);
});

test('T10-6 bid >= ask is invalid', () => {
  assert.equal(isValid(0.02, 0.02), false);
  assert.equal(isValid(0.03, 0.02), false);
  assert.equal(isValid(0, 0.02), false);
  assert.equal(isValid(null, 0.02), false);
  assert.equal(isValid(0.01, null), false);
  assert.equal(isValid(0.01, 0.02), true);
  const { term } = oneTerm(setPut(setPut(base(), 90, 0.03, 0.03), 80, 0.02, 0.01));
  assert.equal(term.putsUsed, 0 + 0); // two invalid in a row right below K0
});

// ----------------------------------------------------------- T11 / T21
test('T11 expiry choice: exactly 43,200 minutes is near; nothing beyond 30 days → no-bracket', () => {
  const us = 4102444800000000;
  const ms = us / 1000;
  const e = (min) => ms + min * 60000;
  assert.deepEqual(pickTerms([e(1000), e(43200), e(50000), e(90000)], us, 43200), { near: { expMs: e(43200), M: 43200 }, next: { expMs: e(50000), M: 50000 } });
  assert.equal(pickTerms([e(1000), e(43200)], us, 43200), null);
  assert.equal(pickTerms([e(50000)], us, 43200), null);
  const t = handTable([{ rows: chainA }, { rows: chainA }], us, { minutes: [20000, 43000] });
  const res = computeImplied(rowsOf(t), us, CFG);
  assert.equal(res.reason, 'no-bracket');
  assert.equal(res.value, null);
  assert.deepEqual(res.terms, []);
  assert.deepEqual(res.quotes, []);
});

test('T21 minute flooring on integer microseconds: 1 µs short of a whole minute floors one lower; M = 0 is no candidate', () => {
  const us = 4102444800123457; // not on a millisecond
  const expMs = 4102444800000 + 43200 * 60000;
  // (expMs*1000 - us) = 43200 min - 123457 µs → 43199
  assert.equal(minutesTo(expMs, us), 43199);
  const exact = expMs * 1000 - 43200 * 60000000; // snapshot exactly 43,200 minutes before
  assert.equal(minutesTo(expMs, exact), 43200);
  assert.equal(minutesTo(expMs, exact + 1), 43199);
  // an expiry 59 s ahead: M = 0, not a candidate
  const soon = Math.floor(us / 1000) + 59000;
  assert.equal(minutesTo(soon, us), 0);
  assert.deepEqual(pickTerms([soon, expMs, expMs + 86400000], us, 43200).near.expMs, expMs);
  // flooring usOut to milliseconds first would give a different minute here:
  const X = 4102444800000;
  const us2 = X * 1000 + 457; // 457 µs past a millisecond
  const exp2 = X + 43200 * 60000; // 43,200 minutes after that millisecond
  assert.equal(minutesTo(exp2, us2), 43199); // integer µs: 457 µs short of 43,200 minutes
  assert.equal(Math.floor((exp2 * 1000 - Math.floor(us2 / 1000) * 1000) / 60000000), 43200); // the rule this replaces
});

// ----------------------------------------------------------------- T22
test('T22 ladder: a strike with only a call is not on the ladder (not counted in the walk); no strike <= F → k0-quote-invalid', () => {
  // 85 has a call only; on the put side the walk is 90, 80, … and the call-only strike is invisible
  const rows = [...base(), [85, ...q(0.2), undefined, undefined]].sort((a, b) => a[0] - b[0]);
  const r1 = oneTerm(setPut(base(), 80, null, null));
  const r2b = oneTerm(setPut(rows, 80, null, null));
  assert.equal(r1.term.putsUsed, 3); // 90, (80 invalid), 70, 60
  assert.equal(r2b.term.putsUsed, r1.term.putsUsed);
  assert.equal(r2b.term.variance, r1.term.variance);
  // F below the lowest ladder strike: K* = 60 with c - p << 0
  const low = [
    [60, ...q(1 / 64), ...q(0.25)],
    [70, ...q(1 / 128), ...q(0.4)],
  ];
  const { term, fail } = oneTerm(low);
  assert.equal(term.atm, 60);
  assert.ok(term.forward < 60);
  assert.equal(fail, 'k0-quote-invalid');
  assert.ok(!('k0' in term));
});

test('joinQuotes: instruments only in one call are dropped; a changed shape is a FormatError', () => {
  const t = handTable([{ days: 20, rows: chainA }]);
  t.instruments.push({ instrument_name: 'BTC-ONLY-INST', expiration_timestamp: 1, strike: 1, option_type: 'call' });
  t.book.push({ instrument_name: 'BTC-ONLY-BOOK', bid_price: 0.1, ask_price: 0.2 });
  const rows = joinQuotes(t.instruments, t.book);
  assert.equal(rows.length, 10);
  assert.ok(!rows.some((r) => r.name.includes('ONLY')));
  assert.throws(() => joinQuotes([{ instrument_name: 'x', expiration_timestamp: 1, strike: 1, option_type: 'call', quote_currency: 'USDC' }], []), FormatError);
  assert.throws(() => joinQuotes(t.instruments, [{ instrument_name: 'BTC-T0-80-C', ask_price: 0.1 }]), FormatError);
  assert.throws(() => parseDeribit({ error: { code: 1 } }, 'x'), FormatError);
  assert.throws(() => parseDeribit({ result: {}, usOut: 1 }, 'x'), FormatError);
});

// ----------------------------------------------------------- T20 (private)
test('T20 saved snapshot of 2026-10-05 (throwaway input) — only with VOL_FIXTURE_DIR', (t) => {
  const dir = process.env.VOL_FIXTURE_DIR;
  const book = dir && path.join(dir, 'deribit-book-summary-btc-option-2026-10-05T022527Z.json.gz');
  const inst = dir && path.join(dir, 'deribit-instruments-btc-option-2026-10-05T0232Z.json.gz');
  if (!book || !fs.existsSync(book) || !fs.existsSync(inst)) return t.skip('VOL_FIXTURE_DIR not set (the snapshot is not a public fixture)');
  const b = parseDeribit(JSON.parse(zlib.gunzipSync(fs.readFileSync(book))), 'book');
  const i = parseDeribit(JSON.parse(zlib.gunzipSync(fs.readFileSync(inst))), 'inst');
  const res = computeImplied(joinQuotes(i.result, b.result), b.usOut, CFG);
  assert.equal(res.reason, null);
  assert.ok(Number.isFinite(res.value) && res.value > 0);
  assert.equal(res.terms[0].expiry, '2026-10-30T08:00:00.000Z');
  assert.equal(res.terms[1].expiry, '2026-11-27T08:00:00.000Z');
  const nearPuts = res.quotes.filter((x) => x[0] === 'near' && x[2] === 'P' && !isValid(x[3], x[4]));
  assert.equal(nearPuts.length, 3);
  assert.deepEqual(nearPuts.map((x) => x[1]), [40000, 45000, 48000]);
});
