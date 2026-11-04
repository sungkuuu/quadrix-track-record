// qVOL realized line — registration input snapshot (registration-draft.md §2-2, §4-2).
// Usage: node fetch-snapshot.mjs --end YYYY-MM-DD --out <dir>
// No dependencies. Same input => same bytes (gzip level 9, header mtime 0), except snapshot-meta.json (times, node version).
//
// Output layout:
//   rest-1m/btcusdt-1m-YYYY-MM-DD.json.gz   gzip of a JSON array holding two raw responses: [<resp 1: 1000 rows>,<resp 2: rest of day>]
//                                           (the raw response bodies are copied byte for byte between "[" "," "]")
//   daily-1d/btcusdt-1d-2017-08-17-to-E.json.gz   gzip of [<resp 1>,<resp 2>,...] one raw response per call (not concatenated)
//   canonical-1m.sha256                     "<date> <rows> <sha256>" per UTC day (canonical text of §2-2)
//   snapshot-meta.json, MANIFEST.sha256     (MANIFEST covers every data file, paths sorted; snapshot-meta.json is excluded so the manifest is deterministic)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const HOST = 'https://data-api.binance.vision/api/v3';
const SYMBOL = 'BTCUSDT';
const REST_START = '2026-08-01';
const D1_START = Date.UTC(2017, 7, 17);
const DAY = 86400000, MIN = 60000, GAP_MS = 250;

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const endStr = arg('--end'), outDir = arg('--out');
if (!/^\d{4}-\d{2}-\d{2}$/.test(endStr || '') || !outDir) { console.error('usage: --end YYYY-MM-DD --out <dir>'); process.exit(2); }
const dayMs = (s) => Date.parse(s + 'T00:00:00Z');
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const endMs = dayMs(endStr), restStartMs = dayMs(REST_START);
if (!(endMs >= restStartMs)) { console.error('end before ' + REST_START); process.exit(2); }

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const gz = (b) => zlib.gzipSync(b, { level: 9 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function getRaw(url) {
  for (let attempt = 0; ; attempt++) {
    await sleep(GAP_MS); calls++;
    try {
      const r = await fetch(url);
      if (r.ok) return Buffer.from(await r.arrayBuffer()).toString('utf8');
      if (attempt >= 3 || (r.status < 500 && r.status !== 429)) throw new Error(r.status + ' ' + url);
    } catch (e) { if (attempt >= 3) throw e; await sleep(1000 * (attempt + 1)); }
  }
}
const k = (iv, s, e) => `${HOST}/klines?symbol=${SYMBOL}&interval=${iv}&startTime=${s}&endTime=${e}&limit=1000`;
const S = (x) => String(Number(x));

const t0 = JSON.parse(await getRaw(HOST + '/time')).serverTime;
const wall0 = Date.now();
if (!(endMs + DAY - 1 < t0)) { console.error('E day not closed yet (serverTime ' + t0 + ')'); process.exit(1); }

fs.mkdirSync(path.join(outDir, 'rest-1m'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'daily-1d'), { recursive: true });
const written = [];
const put = (rel, buf) => { fs.writeFileSync(path.join(outDir, rel), buf); written.push(rel); };

// (a) REST 1m, two calls per day
const canon = []; let totalRows = 0;
for (let d = restStartMs; d <= endMs; d += DAY) {
  const dEnd = d + DAY - 1;
  const r1 = await getRaw(k('1m', d, dEnd));
  const a = JSON.parse(r1);
  if (a.length === 0) throw new Error('empty day ' + dayStr(d));
  const next = a[a.length - 1][0] + MIN;
  const r2 = await getRaw(k('1m', next, dEnd));
  const b = JSON.parse(r2);
  const bars = a.concat(b);
  put(`rest-1m/btcusdt-1m-${dayStr(d)}.json.gz`, gz(Buffer.from('[' + r1 + ',' + r2 + ']', 'utf8')));
  bars.sort((x, y) => x[0] - y[0]);
  for (let i = 0; i < bars.length; i++) {
    if (bars[i][0] < d || bars[i][0] > dEnd) throw new Error('bar outside day ' + dayStr(d));
    if (i && bars[i][0] === bars[i - 1][0]) throw new Error('duplicate bar ' + bars[i][0]);
    if (!(bars[i][6] < t0)) throw new Error('bar not closed ' + bars[i][0]);
  }
  const text = bars.map((x) => `${x[0]},${S(x[1])},${S(x[2])},${S(x[3])},${S(x[4])}\n`).join('');
  canon.push(`${dayStr(d)} ${bars.length} ${sha(Buffer.from(text, 'utf8'))}`);
  totalRows += bars.length;
}

// (b) exchange 1d, one array per call
const d1 = []; let s = D1_START, dRows = 0;
while (s <= endMs) {
  const raw = await getRaw(k('1d', s, endMs + DAY - 1));
  const a = JSON.parse(raw);
  if (a.length === 0) break;
  d1.push(raw); dRows += a.length;
  s = a[a.length - 1][0] + DAY;
}
put(`daily-1d/btcusdt-1d-2017-08-17-to-${endStr}.json.gz`, gz(Buffer.from('[' + d1.join(',') + ']', 'utf8')));

// (c) canonical hashes
put('canonical-1m.sha256', Buffer.from(canon.join('\n') + '\n', 'utf8'));

// (d) meta + manifest
const t1 = JSON.parse(await getRaw(HOST + '/time')).serverTime;
const meta = {
  end: endStr, restStart: REST_START, symbol: SYMBOL, host: HOST,
  serverTimeStart: t0, serverTimeEnd: t1,
  calls, restDays: canon.length, restRows: totalRows, daily1dCalls: d1.length, daily1dRows: dRows,
  elapsedMs: Date.now() - wall0, node: process.version,
};
put('snapshot-meta.json', Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8'));
const man = written.filter((rel) => rel !== 'snapshot-meta.json').sort().map((rel) => `${sha(fs.readFileSync(path.join(outDir, rel)))}  ${rel}`);
fs.writeFileSync(path.join(outDir, 'MANIFEST.sha256'), man.join('\n') + '\n');
console.log(JSON.stringify(meta));
