#!/usr/bin/env node
// qVOL realized line — comparison script for the reproducibility test.
// Registration text: commit 0649c4b4, registration-draft.md §6-4 (V1–V4, list K), §6-2 (ranges),
// §5 (record keys), §13 (result files). Plain Node (>= 18), no dependencies.
// The author read only §5 · §6-2 · §6-4 · §6-5 · §13 of the registration text. It does not
// compute the realized line itself; it only compares records and reference inputs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ---- policy values and rules as written in §6-4 -------------------------------------------
const POLICY = {
  V1: { valueRelDiffMax: 1e-9, varianceRelDiffMax: 1e-9,
        relDiff: '|a - b| / max(|a|, |b|); both 0 -> 0; only one 0 -> 1' },
  V2: { mismatchesMax: 0 },
  V3: { mismatchesMax: 0, parts: ['(가) 1m close = last 15m bar close (file-range windows)',
        '(나) 1m close = exchange 1d close (file + REST windows, registration snapshot only)',
        '(다) K fields, REST-range line vs file-range line, overlap days'] },
  V4: { mismatchesMax: 0, minRuns: 2, fields: 'K + seq + sources, JSON.stringify bytes' },
  versionCap: 3,
};
const K = ['date', 'index', 'value', 'variance', 'window', 'returns', 'carriedFrom', 'gaps',
  'gapAccepted', 'source.day', 'source.rows', 'source.sha256', 'source.lastBar', 'rule'];

class InputError extends Error {}

// ---- arguments ----------------------------------------------------------------------------
const USAGE = `usage: node compare.mjs --a-file A.jsonl --a-rest A-rest.jsonl --a2 A-run2.jsonl [--a2 ...]
  --b-file B.jsonl --b-rest B-rest.jsonl --snapshot <snapshot/E-2026-11-02> --close15 <btcusdt-15m.csv[.gz]>
  --out <results dir> [--file-range 2017-09-18:2026-09-29] [--rest-range 2026-09-01:2026-11-02]
  [--pre-file 2025-09-02:2026-09-29] [--pre-rest 2026-09-01:2026-10-06]   (--a = --a-file, --b = --b-file)`;
function parseArgs(argv) {
  const o = { a2: [], 'file-range': '2017-09-18:2026-09-29', 'rest-range': '2026-09-01:2026-11-02',
    'pre-file': '2025-09-02:2026-09-29', 'pre-rest': '2026-09-01:2026-10-06' };
  const alias = { a: 'a-file', b: 'b-file' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new InputError(`unexpected argument ${t}\n${USAGE}`);
    let k = t.slice(2); k = alias[k] || k;
    const v = argv[++i];
    if (v === undefined) throw new InputError(`missing value for ${t}\n${USAGE}`);
    if (k === 'a2') o.a2.push(v); else o[k] = v;
  }
  for (const k of ['a-file', 'a-rest', 'b-file', 'b-rest', 'snapshot', 'close15', 'out'])
    if (!o[k]) throw new InputError(`missing --${k}\n${USAGE}`);
  for (const k of ['file-range', 'rest-range', 'pre-file', 'pre-rest']) {
    const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(o[k]);
    if (!m || m[1] > m[2]) throw new InputError(`bad --${k} ${o[k]}`);
    o[k] = [m[1], m[2]];
  }
  return o;
}

// ---- helpers ------------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readRaw = (p) => { try { return fs.readFileSync(p); } catch (e) { throw new InputError(`cannot read ${p}: ${e.message}`); } };
const readText = (p) => { const raw = readRaw(p); return (p.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'); };
const inRange = (d, [s, e]) => d >= s && d <= e;
function daysBetween([s, e]) {
  const out = []; let t = Date.parse(s + 'T00:00:00Z'); const end = Date.parse(e + 'T00:00:00Z');
  for (; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const intersect = (a, b) => { const s = a[0] > b[0] ? a[0] : b[0]; const e = a[1] < b[1] ? a[1] : b[1]; return s <= e ? [s, e] : null; };
function relDiff(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  if (a === 0 && b === 0) return 0;
  if (a === 0 || b === 0) return 1;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}
const fmt = (x) => (x === undefined ? '' : x === null ? 'null' : typeof x === 'object' ? JSON.stringify(x) : String(x));
function csv(rows, header) {
  const esc = (v) => { const s = fmt(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [header.join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
function field(rec, key) {
  let cur = rec; const parts = key.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, parts[i])) return { present: false };
    cur = cur[parts[i]];
  }
  return { present: true, value: cur };
}
const firstTwo = (cf) => (Array.isArray(cf) ? cf.map((e) => (Array.isArray(e) ? e.slice(0, 2) : e)) : cf);
// Returns the list of fields (from `keys`) whose presence or JSON.stringify bytes differ.
// carriedFrom: when the day is the first line in only one of the two runs, only the first two
// cells (date, close) of each entry are compared (§6-4, K paragraph).
function diffFields(x, y, xFirst, yFirst, keys) {
  const bad = [];
  for (const k of keys) {
    const fx = field(x, k), fy = field(y, k);
    if (fx.present !== fy.present) { bad.push(k); continue; }
    if (!fx.present) continue;
    let vx = fx.value, vy = fy.value;
    if (k === 'carriedFrom' && xFirst !== yFirst) { vx = firstTwo(vx); vy = firstTwo(vy); }
    if (JSON.stringify(vx) !== JSON.stringify(vy)) bad.push(k);
  }
  return bad;
}

// ---- record runs --------------------------------------------------------------------------
function loadRun(label, file, range, inputs) {
  const raw = readRaw(file);
  inputs.push({ role: label, path: file, sha256: sha256(raw) });
  const text = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new InputError(`${label}: ${file} has no lines`);
  const recs = lines.map((l, i) => {
    let r; try { r = JSON.parse(l); } catch (e) { throw new InputError(`${label}: line ${i + 1} is not JSON`); }
    if (!r || typeof r !== 'object' || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date))
      throw new InputError(`${label}: line ${i + 1} has no date "YYYY-MM-DD"`);
    return r;
  });
  const firstDate = recs[0].date; // "첫 줄" = first line of the run file
  const byDate = new Map(); let outOfScope = 0;
  for (const r of recs) {
    if (!inRange(r.date, range)) { outOfScope++; continue; }
    if (byDate.has(r.date)) throw new InputError(`${label}: date ${r.date} appears twice`);
    byDate.set(r.date, r);
  }
  return { label, file, range, byDate, firstDate, total: recs.length, outOfScope };
}
const isFirst = (run, date) => run.firstDate === date;

// day -> list of { sha, rows, from } from source (each line) and sources (first line)
function dayShaMap(run) {
  const m = new Map();
  const add = (day, rows, sha, from) => { if (!m.has(day)) m.set(day, []); m.get(day).push({ sha, rows, from }); };
  for (const [date, r] of run.byDate) {
    const s = r.source || {};
    add(typeof s.day === 'string' ? s.day : `(no source.day @${date})`, s.rows, s.sha256, `source@${date}`);
    if (isFirst(run, date) && Array.isArray(r.sources))
      for (const e of r.sources) if (Array.isArray(e)) add(e[0], e[1], e[2], `sources@${date}`);
  }
  return m;
}
const distinct = (list) => [...new Set((list || []).map((e) => JSON.stringify(e.sha === undefined ? null : e.sha)))].map((s) => JSON.parse(s));

// ---- reference inputs ---------------------------------------------------------------------
function loadSnapshot(dir, inputs) {
  const canonPath = path.join(dir, 'canonical-1m.sha256');
  const canonRaw = readRaw(canonPath); inputs.push({ role: 'snapshot canonical-1m.sha256', path: canonPath, sha256: sha256(canonRaw) });
  const canon = new Map();
  for (const l of canonRaw.toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    const [day, rows, sha] = l.trim().split(/\s+/);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[0-9a-f]{64}$/.test(sha || '')) throw new InputError(`bad line in ${canonPath}: ${l}`);
    canon.set(day, { rows: Number(rows), sha });
  }
  const d1dir = path.join(dir, 'daily-1d');
  let files; try { files = fs.readdirSync(d1dir).filter((f) => /\.json(\.gz)?$/.test(f)); } catch { files = []; }
  if (files.length !== 1) throw new InputError(`expected exactly one .json(.gz) file in ${d1dir}, found ${files.length}`);
  const d1path = path.join(d1dir, files[0]);
  const d1raw = readRaw(d1path); inputs.push({ role: 'snapshot 1d', path: d1path, sha256: sha256(d1raw) });
  let klines; try { klines = JSON.parse((d1path.endsWith('.gz') ? zlib.gunzipSync(d1raw) : d1raw).toString('utf8')); }
  catch { throw new InputError(`${d1path} is not JSON`); }
  // the snapshot file may hold one array per fetch call (pages of klines): flatten to kline rows
  const flat = []; const walk = (x) => { if (Array.isArray(x) && typeof x[0] === 'number') flat.push(x); else if (Array.isArray(x)) x.forEach(walk); };
  walk(klines);
  const d1 = new Map();
  for (const k of flat) {
    if (!Number.isFinite(k[0]) || k.length < 5) throw new InputError(`${d1path}: bad kline ${JSON.stringify(k).slice(0, 80)}`);
    const day = new Date(k[0]).toISOString().slice(0, 10);
    if (d1.has(day)) throw new InputError(`${d1path}: day ${day} appears twice`);
    d1.set(day, k[4]);
  }
  inputs[inputs.length - 1].days = d1.size; inputs[inputs.length - 2].days = canon.size;
  return { canon, d1 };
}
function loadClose15(p, inputs) {
  const raw = readRaw(p); inputs.push({ role: '15m file', path: p, sha256: sha256(raw) });
  const lines = (p.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8').split('\n');
  const head = lines[0].trim().split(',');
  const ti = head.indexOf('time_utc'), ci = head.indexOf('close');
  if (ti < 0 || ci < 0) throw new InputError(`${p}: header needs time_utc and close`);
  const last = new Map(); // day -> { t, close }
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split(','); const t = c[ti]; const day = t.slice(0, 10);
    const cur = last.get(day);
    if (!cur || t > cur.t) last.set(day, { t, close: c[ci] });
  }
  inputs[inputs.length - 1].days = last.size;
  return last;
}
const closeEq = (ref, c) => ref !== undefined && (typeof c === 'number' || typeof c === 'string') && Number(ref) === Number(c);

// ---- main ---------------------------------------------------------------------------------
function main() {
  const o = parseArgs(process.argv.slice(2));
  const out = o.out; fs.mkdirSync(out, { recursive: true });
  for (const f of ['DONE', 'FAILED', 'MANIFEST.sha256', 'verdict.json', 'realized-ab.csv', 'realized-close-check.csv', 'rest-vs-file.csv', 'determinism.txt'])
    fs.rmSync(path.join(out, f), { force: true });
  const inputs = [];
  const fileR = o['file-range'], restR = o['rest-range'], overlapR = intersect(fileR, restR);
  const A = loadRun('A file range', o['a-file'], fileR, inputs);
  const Ar = loadRun('A REST range', o['a-rest'], restR, inputs);
  const B = loadRun('B file range', o['b-file'], fileR, inputs);
  const Br = loadRun('B REST range', o['b-rest'], restR, inputs);
  const A2 = o.a2.map((p, i) => loadRun(`A file range run ${i + 2}`, p, fileR, inputs));
  const snap = loadSnapshot(o.snapshot, inputs);
  const last15 = loadClose15(o.close15, inputs);

  // gap days: any day reported with fewer than 1,440 rows (records or snapshot) — §6-2 marking
  const gapDays = new Set();
  for (const run of [A, Ar, B, Br, ...A2]) for (const [day, list] of dayShaMap(run)) if (list.some((e) => typeof e.rows === 'number' && e.rows < 1440)) gapDays.add(day);
  for (const [day, v] of snap.canon) if (v.rows < 1440) gapDays.add(day);
  const gapInWindow = (r) => Array.isArray(r && r.window) && r.window.some((e) => Array.isArray(e) && gapDays.has(e[0]));

  // ---- V1 + V2 (per line rows in realized-ab.csv) ----
  const abRows = []; const v1 = { compared: 0, mismatches: 0, missing: 0, maxValueRelDiff: 0, maxVarianceRelDiff: 0,
    pre1006: { file: { lines: 0, mismatches: 0 }, rest: { lines: 0, mismatches: 0 } } };
  const v2 = { daysCompared: 0, mismatches: 0, snapshotDaysCompared: 0, snapshotMismatches: 0, list: [] };
  const pairs = [['file', A, B, o['pre-file']], ['rest', Ar, Br, o['pre-rest']]];
  for (const [rangeName, X, Y, preR] of pairs) {
    const mx = dayShaMap(X), my = dayShaMap(Y);
    // V2 A vs B, every day in either map
    const dayBad = new Map();
    for (const day of [...new Set([...mx.keys(), ...my.keys()])].sort()) {
      const sx = distinct(mx.get(day)), sy = distinct(my.get(day));
      const ok = sx.length === 1 && sy.length === 1 && typeof sx[0] === 'string' && sx[0] === sy[0];
      v2.daysCompared++; dayBad.set(day, !ok);
      if (!ok) { v2.mismatches++; v2.list.push({ range: rangeName, kind: 'A-vs-B', day, a: sx, b: sy }); }
    }
    // V2 REST: A's fetched text sha256 vs registration snapshot
    const snapBad = new Map();
    if (rangeName === 'rest') for (const day of [...mx.keys()].sort()) {
      const sx = distinct(mx.get(day)); const ref = snap.canon.get(day);
      const ok = ref !== undefined && sx.length === 1 && sx[0] === ref.sha;
      v2.snapshotDaysCompared++; snapBad.set(day, !ok);
      if (!ok) { v2.snapshotMismatches++; v2.list.push({ range: rangeName, kind: 'A-vs-snapshot', day, a: sx, snapshot: ref ? ref.sha : null }); }
    }
    for (const date of [...new Set([...X.byDate.keys(), ...Y.byDate.keys()])].sort()) {
      const a = X.byDate.get(date), b = Y.byDate.get(date);
      const rv = a && b ? relDiff(a.value, b.value) : NaN, rw = a && b ? relDiff(a.variance, b.variance) : NaN;
      const ok = !!(a && b) && rv <= POLICY.V1.valueRelDiffMax && rw <= POLICY.V1.varianceRelDiffMax;
      v1.compared++; if (!ok) v1.mismatches++; if (!a || !b) v1.missing++;
      if (rv > v1.maxValueRelDiff) v1.maxValueRelDiff = rv; if (rw > v1.maxVarianceRelDiff) v1.maxVarianceRelDiff = rw;
      const pre = inRange(date, preR);
      if (pre) { v1.pre1006[rangeName].lines++; if (!ok) v1.pre1006[rangeName].mismatches++; }
      const day = (a && a.source && a.source.day) || (b && b.source && b.source.day);
      const firstDays = (r, run) => (r && isFirst(run, date) && Array.isArray(r.sources) ? r.sources.map((e) => e[0]) : []);
      const fd = [...new Set([...firstDays(a, X), ...firstDays(b, Y)])];
      abRows.push({ range: rangeName, date, pre1006: pre, gapInWindow: gapInWindow(a) || gapInWindow(b),
        aValue: a ? a.value : 'missing', bValue: b ? b.value : 'missing', valueRelDiff: rv,
        aVariance: a ? a.variance : 'missing', bVariance: b ? b.variance : 'missing', varianceRelDiff: rw, V1: ok ? 'ok' : 'MISMATCH',
        sourceDay: day, aSourceSha256: a && a.source ? a.source.sha256 : '', bSourceSha256: b && b.source ? b.source.sha256 : '',
        sourceShaMatch: dayBad.has(day) ? (dayBad.get(day) ? 'MISMATCH' : 'ok') : 'n/a',
        snapshotSha256: rangeName === 'rest' && snap.canon.get(day) ? snap.canon.get(day).sha : '',
        snapshotMatch: rangeName === 'rest' ? (snapBad.get(day) ? 'MISMATCH' : 'ok') : '',
        firstLineSourcesDays: fd.length, firstLineSourcesMismatched: fd.filter((d) => dayBad.get(d) || snapBad.get(d)).length,
        aHash: a ? a.hash : '', bHash: b ? b.hash : '' });
    }
  }

  // ---- V3 (가)(나) ----
  const closeRows = []; const v3 = { ga: { compared: 0, mismatches: 0, nullSkipped: 0 }, na: { compared: 0, mismatches: 0, nullSkipped: 0, list: [] },
    da: { linesCompared: 0, mismatches: 0 } };
  const closeRuns = [[A, true], [B, true], [Ar, false], [Br, false]]; // [run, in (가) scope]
  for (const [run, ga] of closeRuns) {
    const seen = new Map(); // day|close -> lines count
    for (const r of run.byDate.values()) for (const e of (Array.isArray(r.window) ? r.window : [])) {
      const key = JSON.stringify([e && e[0], e && e[1]]); seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const key of [...seen.keys()].sort()) {
      const [day, c] = JSON.parse(key);
      const row = { run: run.label, day, close1m: c, lines: seen.get(key), gapDay: gapDays.has(day) };
      const r15 = last15.get(day), r1d = snap.d1.get(day);
      if (ga) {
        row.close15m = r15 ? r15.close : 'missing'; row.bar15m = r15 ? r15.t.slice(11) : '';
        if (c === null) { row.ga = 'skip-null'; v3.ga.nullSkipped++; }
        else { v3.ga.compared++; const ok = closeEq(r15 && r15.close, c); row.ga = ok ? 'ok' : 'MISMATCH'; if (!ok) v3.ga.mismatches++; }
      } else row.ga = 'n/a (REST range)';
      row.close1d = r1d === undefined ? 'missing' : r1d;
      if (c === null) { row.na = 'skip-null'; v3.na.nullSkipped++; }
      else { v3.na.compared++; const ok = closeEq(r1d, c); row.na = ok ? 'ok' : 'MISMATCH';
        if (!ok) { v3.na.mismatches++; v3.na.list.push({ run: run.label, day, close1m: c, close1d: r1d === undefined ? null : r1d }); } }
      closeRows.push(row);
    }
  }
  // ---- V3 (다) ----
  const rvfRows = [];
  const overlapDays = overlapR ? daysBetween(overlapR) : [];
  for (const [impl, F, R] of [['A', A, Ar], ['B', B, Br]]) for (const date of overlapDays) {
    const lf = F.byDate.get(date), lr = R.byDate.get(date);
    const fF = isFirst(F, date), fR = isFirst(R, date);
    const bad = lf && lr ? diffFields(lf, lr, fF, fR, K) : ['missing ' + (!lf ? 'file-range line' : '') + (!lf && !lr ? ' and ' : '') + (!lr ? 'REST-range line' : '')];
    v3.da.linesCompared++; if (bad.length) v3.da.mismatches++;
    rvfRows.push({ impl, date, firstInFileRun: fF, firstInRestRun: fR,
      carriedFromRule: fF !== fR ? 'first two cells' : 'full', fieldsCompared: K.join('|'),
      mismatchedFields: bad.join('|'), result: bad.length ? 'MISMATCH' : 'ok' });
  }
  v3.da.expectedLines = overlapDays.length * 2;

  // ---- V4 ----
  const det = []; let v4mm = 0, v4cmp = 0;
  det.push('V4 determinism — A file range, run 1 vs each further run; fields: K + seq + sources (JSON.stringify bytes)');
  det.push(`run 1: ${A.file} lines-in-scope=${A.byDate.size} first=${A.firstDate}`);
  A2.forEach((R, i) => det.push(`run ${i + 2}: ${R.file} lines-in-scope=${R.byDate.size} first=${R.firstDate}`));
  for (const R of A2) {
    let mm = 0;
    for (const date of [...new Set([...A.byDate.keys(), ...R.byDate.keys()])].sort()) {
      const x = A.byDate.get(date), y = R.byDate.get(date); v4cmp++;
      const bad = x && y ? diffFields(x, y, isFirst(A, date), isFirst(R, date), [...K, 'seq', 'sources']) : ['missing line'];
      if (bad.length) { mm++; det.push(`MISMATCH ${R.label} ${date}: ${bad.join('|')}`); }
    }
    det.push(`${R.label}: mismatches ${mm}`); v4mm += mm;
  }
  const runs = 1 + A2.length;
  const v4pass = runs >= POLICY.V4.minRuns && v4mm === 0;
  det.push(`runs ${runs} (minimum ${POLICY.V4.minRuns}), lines compared ${v4cmp}, mismatches ${v4mm} -> ${v4pass ? 'pass' : 'FAIL'}`);

  // ---- write results ----
  const w = (name, body) => fs.writeFileSync(path.join(out, name), body);
  w('realized-ab.csv', csv(abRows, ['range', 'date', 'pre1006', 'gapInWindow', 'aValue', 'bValue', 'valueRelDiff', 'aVariance', 'bVariance',
    'varianceRelDiff', 'V1', 'sourceDay', 'aSourceSha256', 'bSourceSha256', 'sourceShaMatch', 'snapshotSha256', 'snapshotMatch',
    'firstLineSourcesDays', 'firstLineSourcesMismatched', 'aHash', 'bHash']));
  w('realized-close-check.csv', csv(closeRows, ['run', 'day', 'close1m', 'lines', 'gapDay', 'close15m', 'bar15m', 'ga', 'close1d', 'na']));
  w('rest-vs-file.csv', csv(rvfRows, ['impl', 'date', 'firstInFileRun', 'firstInRestRun', 'carriedFromRule', 'fieldsCompared', 'mismatchedFields', 'result']));
  w('determinism.txt', det.join('\n') + '\n');
  const v3pass = v3.ga.mismatches === 0 && v3.na.mismatches === 0 && v3.da.mismatches === 0;
  const tests = [
    { id: 'V1', pass: v1.mismatches === 0, mismatches: v1.mismatches, evidence: 'realized-ab.csv', compared: v1.compared, missingLines: v1.missing,
      maxValueRelDiff: v1.maxValueRelDiff, maxVarianceRelDiff: v1.maxVarianceRelDiff, pre1006: v1.pre1006, threshold: POLICY.V1 },
    { id: 'V2', pass: v2.mismatches === 0 && v2.snapshotMismatches === 0, mismatches: v2.mismatches + v2.snapshotMismatches, evidence: 'realized-ab.csv',
      daysCompared: v2.daysCompared, snapshotDaysCompared: v2.snapshotDaysCompared, aVsB: v2.mismatches, aRestVsSnapshot: v2.snapshotMismatches,
      list: v2.list, threshold: POLICY.V2 },
    { id: 'V3', pass: v3pass, mismatches: v3.ga.mismatches + v3.na.mismatches + v3.da.mismatches, evidence: 'realized-close-check.csv, rest-vs-file.csv',
      ga: v3.ga, na: v3.na, da: v3.da, threshold: POLICY.V3 },
    { id: 'V4', pass: v4pass, mismatches: v4mm, evidence: 'determinism.txt', runs, linesCompared: v4cmp, threshold: POLICY.V4 },
  ];
  const verdict = { registration: '0649c4b4', reproduced: tests.every((t) => t.pass),
    note: '판정 규칙을 적용하면 — four lines must all pass for 「재현됨」 (§6-4)',
    ranges: { file: fileR, rest: restR, overlap: overlapR, preFile: o['pre-file'], preRest: o['pre-rest'] },
    scope: Object.fromEntries([A, Ar, B, Br, ...A2].map((r) => [r.label, { lines: r.total, inScope: r.byDate.size, outOfScope: r.outOfScope, first: r.firstDate }])),
    gapDays: [...gapDays].sort(), tests, inputs };
  w('verdict.json', JSON.stringify(verdict, null, 2) + '\n');
  const names = ['realized-ab.csv', 'realized-close-check.csv', 'rest-vs-file.csv', 'determinism.txt', 'verdict.json'];
  w('MANIFEST.sha256', names.map((n) => `${sha256(fs.readFileSync(path.join(out, n)))}  ${n}`).join('\n') + '\n');
  w('DONE', `${new Date().toISOString()} ${tests.map((t) => `${t.id}=${t.pass ? 'pass' : 'FAIL'}`).join(' ')}\n`);
  console.log(tests.map((t) => `${t.id} ${t.pass ? 'pass' : 'FAIL'} (mismatches ${t.mismatches})`).join('\n'));
  return verdict.reproduced ? 0 : 1;
}

try { process.exitCode = main(); }
catch (e) {
  const outIdx = process.argv.indexOf('--out');
  if (outIdx > 0 && process.argv[outIdx + 1]) {
    try { fs.mkdirSync(process.argv[outIdx + 1], { recursive: true });
      fs.writeFileSync(path.join(process.argv[outIdx + 1], 'FAILED'), `${new Date().toISOString()} ${e.message}\n`); } catch {}
  }
  console.error(e instanceof InputError ? `input error: ${e.message}` : e.stack);
  process.exitCode = 2;
}
