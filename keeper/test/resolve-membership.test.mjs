/**
 * M14 (2026-09-29): qREV must hold N names, not N + the grace names.
 *
 * The 2026-10-01 CI rehearsal (run 36536183753) ended qREV with 16 members
 * against N = 15: all fifteen eligible names seated, then ZRO — on exit
 * hysteresis grace after failing the six-positive-months gate — added on top.
 * The research engine does it differently (docs/research/qrev/qrev-backtest.py
 * run(), the `grace` block; qquality-backtest.py the same): grace names go
 * back into the ranking at their own rank (eligible(..., force=grace)), then
 * `new = sorted(keep + adds, key=rank)[:N]` — a hard N in which a grace name
 * holds a seat and can lose it on rank. resolveMembership now does that; the
 * Triens Quality sleeve runs the same function and, below N, is unchanged.
 *
 * paper-index.mjs runs main() on import, so the functions are lifted out of
 * its source text and evaluated here; the test exercises the shipped code.
 *
 *   node --test keeper/test/resolve-membership.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'paper-index.mjs'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in paper-index.mjs`);
  const end = SRC.indexOf('\n}\n', start);
  return new Function(`${SRC.slice(start, end + 2)}\nreturn ${name};`)();
}
const resolveMembership = lift('resolveMembership');
const byPhrAscending = lift('byPhrAscending');
const byNetRevenueDescending = lift('byNetRevenueDescending');

// The fields resolveMembership reads, from the rehearsal's eval dumps
// (eval-qrev.json / eval-triens.json, as of 2026-10-01). marketCap only has to
// be a price-bearing positive number here.
const row = (symbol, isChain, eligible, phr, netRevenue12m, issuance12m) => ({
  symbol, isChain, eligible, phr, netRevenue12m, issuance12m, marketCap: 1e9,
});
const QREV_ROWS = [
  row('HYPE', false, true, 28.3, 693234869, 0),
  row('AERO', false, true, 9.1, 9819090, 82897021),
  row('SKY', false, true, 30.5, 58918379, 2505800),
  row('LINK', false, true, 193, -998181709, 1056894313),
  row('UNI', false, true, 104.9, -128783016, 181152308),
  row('CAKE', false, true, 15.1, 54543260, 0),
  row('CRV', false, true, 21.6, -36496018, 65562063),
  row('JUP', false, true, 27, -11719232, 51980500),
  row('ASTER', false, false, 74.2, 26169857, null),
  row('RAY', false, true, 29.2, 13285943, 4127623),
  row('CVX', false, true, 13.6, -9902114, 25433967),
  row('PENDLE', false, true, 31.2, 3598461, 9635863),
  row('LDO', false, false, 53.3, 7052745, 0),
  row('NEAR', false, true, 1201.7, 5146224, null),
  row('SYRUP', false, true, 88.4, -8387608, 11410324),
  row('ZRO', false, false, 164.9, -379198452, 382589645), // failed monthsOk (3 positive months of 6)
  row('TRX', true, true, 128.8, 247701965, 98858030),
  row('BNB', true, true, 4687.6, 21802929, 0),
];
// keeper/state-qrev.json unit order on 2026-09-29 (the ten names of 2026-09-16)
const QREV_INCUMBENTS = ['AERO', 'CAKE', 'CRV', 'JUP', 'RAY', 'SKY', 'HYPE', 'PENDLE', 'UNI', 'ZRO'];
// rulebooks/qrev.json ranking.scheduled, effective 2026-10-01
const QREV_RANKING = { targetCount: 15, rankBuffer: { entryMaxRank: 12, exitMinRank: 19 } };

const TRIENS_ROWS = [
  row('HYPE', false, true, 28.3, 693234869, 0),
  row('AERO', false, true, 9.1, 9819090, 82897021),
  row('SKY', false, true, 30.5, 58918379, 2505800),
  row('EDGE', false, false, 4, 47066505, null),
  row('UNI', false, false, 104.9, -128783016, 181152308), // failed the issuance gate (issuance/hr 3.46 > θ 1)
  row('CAKE', false, true, 15.1, 54543260, 0),
  row('LIT', false, false, 38.1, 28857053, null),
  row('ASTER', false, false, 74.2, 26169857, null),
  row('RAY', false, true, 29.2, 13285943, 4127623),
  row('PENDLE', false, true, 31.2, 3598461, 9635863),
  row('TRX', true, true, 128.8, 247701965, 98858030),
  row('BNB', true, true, 4687.6, 21802929, 0),
];
// keeper/state-triens.json quality-sleeve unit order on 2026-09-29
const TRIENS_INCUMBENTS = ['HYPE', 'TRX', 'SKY', 'CAKE', 'UNI', 'BNB', 'RAY', 'PENDLE'];
const TRIENS_RANKING = { targetCount: 10, rankBuffer: { entryMaxRank: 8, exitMinRank: 13 } };

function run({ rows, incumbents, onNotice = [], ranking, rank }) {
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    const r = resolveMembership({ evaluated: rows, incumbents, onNotice: new Set(onNotice), ranking, rank, shortRule: 'test' });
    return { members: r.memberRows.map((m) => m.symbol), notice: [...r.nextOnNotice], eligible: r.eligibleCount, lines };
  } finally {
    console.log = log;
  }
}
const qrev = (over = {}) => run({ rows: QREV_ROWS, incumbents: QREV_INCUMBENTS, ranking: QREV_RANKING, rank: byPhrAscending, ...over });
const withRow = (rows, sym, patch) => rows.map((r) => (r.symbol === sym ? { ...r, ...patch } : r));

test('(a) 15 eligible + 1 grace name → 15 seats; the name left out is the lowest-ranked (the 2026-10-01 case)', () => {
  const r = qrev();
  assert.equal(r.eligible, 15);
  assert.equal(r.members.length, 15, `members: ${r.members.join(' ')}`);
  // combined ranking (15 eligible + ZRO at its own P/HR 164.9): ZRO is 13th, BNB (P/HR 4687.6) 16th and last
  assert.ok(!r.members.includes('BNB'));
  assert.ok(r.members.includes('ZRO'));
  assert.deepEqual(r.notice, ['ZRO']);
  const everyRanked = QREV_ROWS.filter((x) => x.eligible || x.symbol === 'ZRO').sort(byPhrAscending).map((x) => x.symbol);
  assert.equal(everyRanked.at(-1), 'BNB');
  assert.deepEqual([...r.members].sort(), everyRanked.slice(0, 15).sort());
  assert.ok(r.lines.some((l) => /eligible without a seat: BNB \(rank 16 of 16\)/.test(l)), r.lines.join('\n'));
});

// Fifteen incumbents — fourteen eligible in good standing plus ZRO on grace —
// and a newcomer inside the entry buffer: keep 15 + add 1 = 16 claimants for 15
// seats, so the worst-ranked claimant loses its seat (qrev-backtest.py
// `sorted(keep + adds, key=rank)[:N]`).
const OVER = {
  rows: [...QREV_ROWS, row('NEW', false, true, 5, 1e7, 0)],
  incumbents: QREV_INCUMBENTS.concat(['CVX', 'SYRUP', 'TRX', 'LINK', 'BNB']),
};

test('(a) 16 claimants to 15 seats: the worst-ranked claimant (here an incumbent) loses its seat', () => {
  const r = qrev(OVER);
  assert.equal(r.members.length, 15);
  assert.ok(r.members.includes('NEW'), 'rank 1 newcomer is seated');
  assert.ok(r.members.includes('ZRO'), 'grace name at rank 14 of 17 keeps its seat');
  assert.ok(!r.members.includes('BNB'), 'rank 17 of 17 incumbent loses its seat');
  assert.ok(!r.members.includes('NEAR'), 'NEAR (rank 16) is neither incumbent nor inside the entry buffer, and no seat is left');
  assert.deepEqual(r.notice, ['ZRO']);
  assert.ok(r.lines.some((l) => /BNB: exits — incumbent, ranked 17 of 17 with 15 seats/.test(l)), r.lines.join('\n'));
});

test('(a) 16 claimants to 15 seats: a grace name that is the worst-ranked claimant loses its seat and exits (not carried on notice)', () => {
  const r = qrev({ ...OVER, rows: withRow(OVER.rows, 'ZRO', { phr: 5000 }) });
  assert.equal(r.members.length, 15);
  assert.ok(!r.members.includes('ZRO'));
  assert.ok(r.members.includes('BNB'));
  assert.deepEqual(r.notice, []);
  assert.ok(r.lines.some((l) => /ZRO: exits — on grace this quarter, ranked 17 of 17 with 15 seats/.test(l)), r.lines.join('\n'));
});

test('(b) 14 eligible + 1 grace name → 15, every name seated', () => {
  const r = qrev({ rows: withRow(QREV_ROWS, 'BNB', { eligible: false }) });
  assert.equal(r.eligible, 14);
  assert.equal(r.members.length, 15);
  assert.ok(r.members.includes('ZRO'));
  assert.ok(!r.members.includes('BNB'));
  assert.deepEqual(r.notice, ['ZRO']);
});

test('(c) a grace name ranked above an eligible newcomer keeps its seat; the newcomer is cut', () => {
  // ZRO at P/HR 1300: 15th of 16, between NEAR (1201.7, newcomer) and BNB (4687.6, newcomer)
  const r = qrev({ rows: withRow(QREV_ROWS, 'ZRO', { phr: 1300 }) });
  assert.equal(r.members.length, 15);
  assert.ok(r.members.includes('ZRO'));
  assert.ok(r.members.includes('NEAR'));
  assert.ok(!r.members.includes('BNB'));
  assert.deepEqual(r.notice, ['ZRO']);
});

test('(c) a grace name keeps its seat against a newcomer outside the entry buffer even when it ranks below it (buffer, then fill)', () => {
  // ZRO at P/HR 5000: 16th of 16, below BNB (15th). The claimants are the ten
  // incumbents (ZRO included, on grace) and CVX / SYRUP / TRX inside the entry
  // buffer (rank <= 12) — 13, under 15 — so nothing is cut; the two remaining
  // seats are filled by best rank (LINK 13th, NEAR 14th) and BNB is left out.
  // Same as an incumbent in good standing: the buffer protects claimants from
  // fill candidates; only claimants beyond N are cut on rank.
  const r = qrev({ rows: withRow(QREV_ROWS, 'ZRO', { phr: 5000 }) });
  assert.equal(r.members.length, 15);
  assert.ok(r.members.includes('ZRO'));
  assert.ok(!r.members.includes('BNB'));
  assert.deepEqual(r.notice, ['ZRO']);
  assert.ok(r.lines.some((l) => /eligible without a seat: BNB \(rank 15 of 16\)/.test(l)), r.lines.join('\n'));
});

test('a grace name with no positive revenue (P/HR null) ranks last, as P/HR = infinity', () => {
  // under N claimants it keeps its seat at rank 16 of 16 (as above) ...
  let r = qrev({ rows: withRow(QREV_ROWS, 'ZRO', { phr: null }) });
  assert.equal(r.members.length, 15);
  assert.ok(r.members.includes('ZRO'));
  assert.ok(r.lines.some((l) => /ZRO: kept on hysteresis notice .* seated at rank 16\)/.test(l)), r.lines.join('\n'));
  // ... and with 16 claimants for 15 seats it is the one cut
  r = qrev({ ...OVER, rows: withRow(OVER.rows, 'ZRO', { phr: null }) });
  assert.equal(r.members.length, 15);
  assert.ok(!r.members.includes('ZRO'));
  assert.deepEqual(r.notice, []);
  // byPhrAscending on eligible rows is the old `a.phr - b.phr` order
  const eligible = QREV_ROWS.filter((x) => x.eligible);
  assert.deepEqual([...eligible].sort(byPhrAscending).map((x) => x.symbol), [...eligible].sort((a, b) => a.phr - b.phr).map((x) => x.symbol));
});

test('names that cannot be ranked, or were already on notice, exit instead of taking grace', () => {
  // on notice last quarter and failing again → exits
  let r = qrev({ onNotice: ['ZRO'] });
  assert.ok(!r.members.includes('ZRO'));
  assert.deepEqual(r.notice, []);
  assert.equal(r.members.length, 15);
  assert.ok(r.members.includes('BNB'));
  // no row this run (dropped from the universe / unpriced) → exits
  r = qrev({ rows: QREV_ROWS.filter((x) => x.symbol !== 'ZRO') });
  assert.ok(!r.members.includes('ZRO'));
  assert.equal(r.members.length, 15);
  // a chain token whose issuance is unmeasured cannot be ranked (the engines skip it even when forced) → exits
  r = qrev({ rows: withRow(QREV_ROWS, 'ZRO', { isChain: true, issuance12m: null, phr: null }) });
  assert.ok(!r.members.includes('ZRO'));
  assert.ok(r.lines.some((l) => /ZRO: exits \(chain token with unmeasured issuance/.test(l)), r.lines.join('\n'));
});

test('(d) Triens Quality sleeve, 8 eligible + 1 grace under N = 10: unchanged — same members, order and notice as before the fix', () => {
  const r = run({ rows: TRIENS_ROWS, incumbents: TRIENS_INCUMBENTS, ranking: TRIENS_RANKING, rank: byNetRevenueDescending });
  assert.equal(r.eligible, 8);
  // the pre-fix function's output on these rows (7179fbe, replayed 2026-09-29):
  // eligible incumbents in book order, the newcomer by rank, then the grace name
  assert.deepEqual(r.members, ['HYPE', 'TRX', 'SKY', 'CAKE', 'BNB', 'RAY', 'PENDLE', 'AERO', 'UNI']);
  assert.deepEqual(r.notice, ['UNI']);
  assert.ok(r.lines.some((l) => /universe short: 9 member\(s\) vs target 10 \(8 eligible this run\)/.test(l)), r.lines.join('\n'));
});
