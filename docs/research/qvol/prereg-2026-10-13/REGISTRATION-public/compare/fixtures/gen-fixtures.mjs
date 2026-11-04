#!/usr/bin/env node
// Builds synthetic fixtures for compare.mjs self-test. All numbers are made up; nothing here
// computes the realized line. Ranges: file 2020-03-01..2020-03-10, REST 2020-03-05..2020-03-14.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const here = path.dirname(new URL(import.meta.url).pathname);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const day = (t) => new Date(t).toISOString().slice(0, 10);
const T0 = Date.parse('2020-01-01T00:00:00Z');
const days = []; for (let t = T0; day(t) <= '2020-03-14'; t += 86400000) days.push(day(t));
const idx = (d) => days.indexOf(d);
const addDays = (d, n) => day(Date.parse(d + 'T00:00:00Z') + n * 86400000);
const NULL_DAY = '2020-02-03';  // a day with no own close (window[0] of 2020-03-05)
const GAP_DAY = '2020-03-07';   // a day with 1,430 rows
const baseClose = (d) => 7000 + idx(d) * 12.5 + (idx(d) % 7) * 0.125; // exact in 3 decimals
const rowsOf = (d) => (d === GAP_DAY ? 1430 : 1440);
const shaOf = (d) => sha('fixture-1m-' + d);

function run(label, [s, e], opt = {}) {
  const close = (d) => {
    if (d === NULL_DAY) return null;
    if (opt.swap && d === opt.swap[0]) return baseClose(opt.swap[1]);
    if (opt.swap && d === opt.swap[1]) return baseClose(opt.swap[0]);
    return baseClose(d);
  };
  const out = []; let prev = null; let seq = 0;
  for (let d = s; d <= e; d = addDays(d, 1), seq++) {
    const first = seq === 0;
    const win = []; for (let k = 31; k >= 1; k--) { const w = addDays(d, -k); win.push([w, close(w)]); }
    const value = 0.3 + idx(d) * 0.001 + 1 / 3; const variance = value * value * 30 / 365;
    const D1 = addDays(d, -1);
    const r = { seq, date: d, observedAt: `${d}T00:0${opt.minute || 1}:00.000Z`, index: 'qvol', value, variance, window: win };
    if (win[0][1] === null) { const p = addDays(win[0][0], -1); r.carriedFrom = [first ? [p, close(p), rowsOf(p), shaOf(p)] : [p, close(p)]]; }
    r.returns = win.filter((x) => x[1] !== null).length - 1;
    r.source = { host: 'fixture', symbol: 'BTCUSDT', interval: '1m', day: D1, rows: rowsOf(D1), sha256: shaOf(D1), lastBar: '23:59',
      finalBy: 'fixture', fetchedAt: null, via: 'offline' };
    if (first) r.sources = win.map(([w]) => [w, rowsOf(w), shaOf(w)]);
    if (rowsOf(D1) < 1440) { r.gaps = [[`${D1}T10:00`, `${D1}T10:09`]]; r.gapAccepted = 'fixture-accept-1'; }
    r.rule = { rulebookSha256: '0'.repeat(64), windowDays: 30, yearDays: 365, sampling: '1d-close-00:00-utc', mean: 'zero' };
    r.keeper = { lagSeconds: opt.minute || 1, run: label };
    r.prevHash = prev;
    out.push(r);
    const h = sha(JSON.stringify(r)); r.hash = h; prev = h;
  }
  return out;
}
const FILE = ['2020-03-01', '2020-03-10'], REST = ['2020-03-05', '2020-03-14'];
const write = (dir, name, recs) => { fs.mkdirSync(path.join(here, dir), { recursive: true });
  fs.writeFileSync(path.join(here, dir, name), recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
const tweak = (recs, date, f) => recs.map((r) => (r.date === date ? (f(r), r) : r));

// reference inputs
fs.mkdirSync(path.join(here, 'common/snapshot/daily-1d'), { recursive: true });
fs.writeFileSync(path.join(here, 'common/snapshot/canonical-1m.sha256'),
  days.filter((d) => d >= '2020-02-03' && d <= '2020-03-13').map((d) => `${d} ${rowsOf(d)} ${shaOf(d)}`).join('\n') + '\n');
fs.writeFileSync(path.join(here, 'common/snapshot/daily-1d/btcusdt-1d-fixture.json'),
  JSON.stringify(days.map((d) => [Date.parse(d + 'T00:00:00Z'), '0', '0', '0', baseClose(d).toFixed(8)])));
fs.writeFileSync(path.join(here, 'common/btcusdt-15m.csv'), 'time_utc,open,high,low,close,n1m\n' +
  days.filter((d) => d <= '2020-03-10' && d !== NULL_DAY).flatMap((d) => [`${d}T23:30,1,1,1,${(baseClose(d) - 1).toFixed(3)},15`,
    `${d}T23:45,1,1,1,${baseClose(d).toFixed(3)},15`]).join('\n') + '\n');

// base: B and run 2 differ only in fields outside K (observedAt, keeper, hash chain)
const base = { 'a-file.jsonl': run('A', FILE), 'a-rest.jsonl': run('A', REST), 'a2-file.jsonl': run('A2', FILE, { minute: 2 }),
  'b-file.jsonl': run('B', FILE, { minute: 3 }), 'b-rest.jsonl': run('B', REST, { minute: 3 }) };
for (const [n, r] of Object.entries(base)) write('base', n, r);
// case files: only the files that differ from base
write('v1-value', 'b-file.jsonl', tweak(run('B', FILE, { minute: 3 }), '2020-03-02', (r) => { r.value *= 1 + 1e-8; }));
write('v2-hash', 'b-file.jsonl', tweak(run('B', FILE, { minute: 3 }), '2020-03-02', (r) => { r.source.sha256 = 'f'.repeat(64); }));
const swap = { swap: ['2020-02-20', '2020-02-21'] };
write('v3-close', 'a-file.jsonl', run('A', FILE, swap)); write('v3-close', 'a-rest.jsonl', run('A', REST, swap));
write('v3-close', 'a2-file.jsonl', run('A2', FILE, { ...swap, minute: 2 }));
write('v3-close', 'b-file.jsonl', run('B', FILE, { ...swap, minute: 3 })); write('v3-close', 'b-rest.jsonl', run('B', REST, { ...swap, minute: 3 }));
write('v3-rest-vs-file', 'a-rest.jsonl', tweak(run('A', REST), '2020-03-06', (r) => { r.returns += 1; }));
write('v4-a2', 'a2-file.jsonl', tweak(run('A2', FILE, { minute: 2 }), '2020-03-03', (r) => { r.source.lastBar = '23:58'; }));
const dup = run('B', FILE, { minute: 3 }); dup.push(dup[2]); write('bad-dup', 'b-file.jsonl', dup);
