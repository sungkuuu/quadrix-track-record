/**
 * qVOL realized-line pre-registration — daily 1-minute input files (registration-draft.md §4-1).
 *
 *   node convert-daily-1m.mjs <v6-folder> <out-dir>
 *
 * <v6-folder> = docs/research/leverage/params-v6 of origin/research/leverage-params-v6 (holds read-1m.mjs, data-1m/).
 * Reads loadPair('BTCUSDT', { patch: true }) (dense Int32 ticks, scale 1000) and writes one file per UTC day
 * 2017-08-17 .. 2026-09-29: btcusdt-1m-YYYY-MM-DD.csv, no header, open time ascending,
 * rows `openTimeMs,open,high,low,close\n`, prices as 8-decimal strings built with integer arithmetic only
 * (floor(t/1000) "." (t mod 1000, 3 digits) "00000"). A day with no bar gets an empty file.
 * Prints one JSON summary line (days, rows per day) to stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [v6, out] = process.argv.slice(2);
if (!v6 || !out) { console.error('usage: node convert-daily-1m.mjs <v6-folder> <out-dir>'); process.exit(2); }
const { loadPair } = await import(pathToFileURL(path.resolve(v6, 'read-1m.mjs')).href);

const P = loadPair('BTCUSDT', { patch: true });
if (P.scale !== 1000) throw new Error(`scale ${P.scale} != 1000`);
const MIN = 60_000, DAY = 86_400_000;
const FIRST = Date.UTC(2017, 7, 17), LAST = Date.UTC(2026, 8, 29);

function px(t) { // integer tick -> 8-decimal string, integer ops only
  if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`bad tick ${t}`);
  const r = t % 1000;
  const q = (t - r) / 1000; // exact: t - r is a multiple of 1000
  return `${q}.${String(r).padStart(3, '0')}00000`;
}

fs.mkdirSync(out, { recursive: true });
const perDay = {};
let total = 0;
for (let d = FIRST; d <= LAST; d += DAY) {
  const name = `btcusdt-1m-${new Date(d).toISOString().slice(0, 10)}.csv`;
  const parts = [];
  for (let m = 0; m < 1440; m++) {
    const ms = d + m * MIN;
    const i = (ms - P.t0) / MIN;
    if (i < 0 || i >= P.n || !P.has[i]) continue;
    parts.push(`${ms},${px(P.op[i])},${px(P.hi[i])},${px(P.lo[i])},${px(P.cl[i])}\n`);
  }
  fs.writeFileSync(path.join(out, name), parts.join(''));
  perDay[name] = parts.length;
  total += parts.length;
}
// bars of the dense array outside the day range (must be none)
let outside = 0;
for (let i = 0; i < P.n; i++) if (P.has[i]) { const ms = P.t0 + i * MIN; if (ms < FIRST || ms >= LAST + DAY) outside++; }
console.log(JSON.stringify({ days: Object.keys(perDay).length, rows: total, barsOutsideRange: outside, patched: P.patched, sha256: P.sha256 }));
