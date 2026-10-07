/**
 * scripts/watchdog-series.mjs — the freshness alarm for the paper and leverage
 * series (run sheet option 18), with a fixed clock and throwaway folders.
 *
 *   node --test keeper/test/watchdog-series.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeries, SERIES, SIMULATE, LIMIT_H, LIMIT_MISSING_H } from '../../scripts/watchdog-series.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TX = (n) => '0x' + n.toString(16).padStart(64, '0');
const at = (iso) => Date.parse(iso);

function folder({ decisions = [], series = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-series-'));
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), decisions.map((d) => JSON.stringify(d)).join('\n') + (decisions.length ? '\n' : ''));
  for (const [key, { records, anchors }] of Object.entries(series)) {
    if (records) fs.writeFileSync(path.join(dir, `record-${key}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (anchors) fs.writeFileSync(path.join(dir, `anchors-${key}.jsonl`), anchors.map((a) => JSON.stringify(a)).join('\n') + '\n');
  }
  return dir;
}
const inception = (key, date) => ({ id: `${date}-${key}-paper-inception`, file: `decisions/${date}-${key}-paper-inception.md`, effectiveFrom: date, sha256: 'a'.repeat(64), txHash: TX(1), anchoredAt: `${date}T00:00:00Z` });
const lines = (from, n) => Array.from({ length: n }, (_, seq) => ({ seq, date: new Date(at(`${from}T00:00:00Z`) + seq * 86400000).toISOString().slice(0, 10) }));
const anchorsFor = (recs) => recs.map((r) => ({ date: r.date, seq: r.seq, headHash: 'b'.repeat(64), txHash: TX(100 + r.seq) }));

test('watches the five paper series and the two leverage levels; stale after 40 h, missing after 16 h', () => {
  assert.deepEqual(SERIES, ['qrev', 'qdefi', 'barbell', 'triens', 'qai', 'qbtc2x', 'qeth2x']);
  assert.equal(LIMIT_H, 40);
  assert.equal(LIMIT_MISSING_H, 16);
});

test('a series with neither a file nor an inception decision has not started — no problem', () => {
  const dir = folder();
  const r = checkSeries({ dir, now: at('2026-10-20T00:00:00Z'), series: ['qbtc2x'] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, ['qbtc2x not started']);
});

test('missing: inception anchored, no record file — clear at 15.98 h after I 00:00 UTC, flagged at 16.02 h (the 18:47 UTC watchdog run of day I)', () => {
  const dir = folder({ decisions: [inception('qbtc2x', '2026-10-08')] });
  assert.deepEqual(checkSeries({ dir, now: at('2026-10-08T15:59:00Z'), series: ['qbtc2x'] }).problems, []);
  const r = checkSeries({ dir, now: at('2026-10-08T16:01:00Z'), series: ['qbtc2x'] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^qbtc2x: no record-qbtc2x\.jsonl 16\.0h after its inception 2026-10-08 00:00 UTC \(decision 2026-10-08-qbtc2x-paper-inception\)/);
});

test('a postponed opening: the latest inception decision counts, so the earlier date raises no false alarm (red team F07b)', () => {
  const dir = folder({ decisions: [inception('qbtc2x', '2026-10-08'), inception('qbtc2x', '2026-10-15')] });
  const r = checkSeries({ dir, now: at('2026-10-12T00:00:00Z'), series: ['qbtc2x'] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, ['qbtc2x pending (inception 2026-10-15)']);
});

test('a series ended by a model liquidation is not "stale" (red team F07c); its unanchored lines are still flagged', () => {
  const recs = lines('2026-10-08', 3);
  recs[2].liquidated = { bar: '09:15', ltvLow: 0.88 };
  const dir = folder({ series: { qbtc2x: { records: recs, anchors: anchorsFor(recs) } } });
  const r = checkSeries({ dir, now: at('2026-11-01T00:00:00Z'), series: ['qbtc2x'] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, ['qbtc2x 3 lines → 2026-10-10 (ended: model liquidation)']);
  const r2 = checkSeries({ dir: folder({ series: { qbtc2x: { records: recs, anchors: anchorsFor(recs).slice(0, 2) } } }), now: at('2026-11-01T00:00:00Z'), series: ['qbtc2x'] });
  assert.deepEqual(r2.problems, ['qbtc2x: line seq 2 (2026-10-10) has no anchor txHash']);
});

test('an empty record file counts as missing, and a decision for another index does not count', () => {
  const dir = folder({ decisions: [inception('qeth2x', '2026-10-08')], series: { qeth2x: { records: [] } } });
  fs.writeFileSync(path.join(dir, 'record-qeth2x.jsonl'), '');
  const r = checkSeries({ dir, now: at('2026-10-12T00:00:00Z'), series: ['qbtc2x', 'qeth2x'] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^qeth2x: no record-qeth2x\.jsonl/);
  assert.deepEqual(r.summary, ['qbtc2x not started', 'qeth2x pending (inception 2026-10-08)']);
});

test('stale: last line dated D — clear at D + 39.98 h, flagged at D + 40.02 h', () => {
  const recs = lines('2026-10-08', 2); // 10-08, 10-09
  const dir = folder({ decisions: [inception('qeth2x', '2026-10-08')], series: { qeth2x: { records: recs, anchors: anchorsFor(recs) } } });
  assert.deepEqual(checkSeries({ dir, now: at('2026-10-10T15:59:00Z'), series: ['qeth2x'] }).problems, []);
  const r = checkSeries({ dir, now: at('2026-10-10T16:01:00Z'), series: ['qeth2x'] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^qeth2x: stale — latest line is 2026-10-09 \(seq 1\), 40\.0h/);
});

test('unanchored: a line with no anchor, or an anchor without a 0x… transaction hash, is flagged', () => {
  const recs = lines('2026-09-22', 3);
  const anchors = [anchorsFor(recs)[0], { ...anchorsFor(recs)[2], txHash: null }];
  const dir = folder({ series: { qai: { records: recs, anchors } } });
  const r = checkSeries({ dir, now: at('2026-09-25T00:00:00Z'), series: ['qai'] });
  assert.deepEqual(r.problems, ['qai: line seq 1 (2026-09-23) has no anchor txHash', 'qai: line seq 2 (2026-09-24) has no anchor txHash']);
});

test('a record file with no anchors file: every line is flagged', () => {
  const recs = lines('2026-10-08', 2);
  const dir = folder({ series: { qbtc2x: { records: recs } } });
  const r = checkSeries({ dir, now: at('2026-10-09T12:00:00Z'), series: ['qbtc2x'] });
  assert.equal(r.problems.length, 2);
});

test('each --simulate name trips exactly one problem on an otherwise clear folder; an unknown name is refused', () => {
  const recs = lines('2026-10-08', 2);
  const clear = folder({ series: { qrev: { records: recs, anchors: anchorsFor(recs) } } });
  const now = at('2026-10-10T00:00:00Z');
  assert.deepEqual(checkSeries({ dir: clear, now, series: ['qrev', 'qbtc2x'] }).problems, []);
  assert.deepEqual(SIMULATE, ['series-missing', 'series-stale', 'series-anchor']);
  for (const [name, re] of [['series-missing', /^qbtc2x: no record-qbtc2x\.jsonl \[simulated/], ['series-stale', /^qrev: stale .*\[simulated\]$/], ['series-anchor', /^qrev: line seq 0 \(2026-10-08\) has no anchor txHash \[simulated\]$/]]) {
    const r = checkSeries({ dir: clear, now, simulate: name, series: ['qrev', 'qbtc2x'] });
    assert.equal(r.problems.length, 1, `${name}: ${JSON.stringify(r.problems)}`);
    assert.match(r.problems[0], re, name);
  }
  assert.throws(() => checkSeries({ dir: clear, now, simulate: 'stale' }), /unknown simulate name/);
});

test('a simulate name with nothing it applies to still produces a problem (an alarm test that trips nothing must not pass)', () => {
  const recs = lines('2026-10-08', 1);
  const dir = folder({ series: { qrev: { records: recs, anchors: anchorsFor(recs) } } });
  const r = checkSeries({ dir, now: at('2026-10-08T12:00:00Z'), simulate: 'series-missing', series: ['qrev'] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^simulate series-missing: no series in a state that case applies to/);
});

test("this repository's own series are clear at a fixed clock of 2026-10-05T12:00Z (paper series fresh and anchored; leverage not started or pending)", () => {
  const r = checkSeries({ dir: path.join(REPO, 'trackrecord'), now: at('2026-10-05T12:00:00Z') });
  assert.deepEqual(r.problems, []);
  assert.equal(r.summary.length, 7);
});
