// rest-to-daily.mjs — turns the raw REST 1m snapshot into the registration-draft §4-1 daily CSV form.
// Usage: node rest-to-daily.mjs [--snap E-2026-11-02] [--out <dir>]   (default out = <snap>/rest-daily; plain node, no deps)
// Input : <snap>/rest-1m/btcusdt-1m-YYYY-MM-DD.json.gz = gzip of a JSON array of raw Binance kline responses.
// Output: <out>/btcusdt-1m-YYYY-MM-DD.csv  (no header, open-time ascending, `openTimeMs,o,h,l,c\n`, price strings
//         copied verbatim, LF, UTF-8) and <out>/../rest-daily-manifest.sha256 when out is the default
//         (otherwise <out>.manifest.sha256) = `shasum -a 256` lines, names relative to rest-daily/, sorted by name.
// Refuses (exit 1) on: duplicate open time, a row outside the day, row count != canonical-1m.sha256, canonical hash mismatch.
// Canonical check: text = `${open},${S(o)},${S(h)},${S(l)},${S(c)}\n` with S = String(Number(x)); sha256 must equal canonical-1m.sha256.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const here = dirname(fileURLToPath(import.meta.url));
const snap = resolve(here, arg('--snap', 'E-2026-11-02'));
const defOut = join(snap, 'rest-daily');
const out = resolve(arg('--out', defOut));
const manifestPath = out === defOut ? join(snap, 'rest-daily-manifest.sha256') : out + '.manifest.sha256';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const S = (x) => String(Number(x));
const die = (m) => { console.error('REFUSE: ' + m); process.exit(1); };

const canon = new Map();
for (const line of readFileSync(join(snap, 'canonical-1m.sha256'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [d, n, h] = line.trim().split(/\s+/);
  canon.set(d, { n: Number(n), h });
}
mkdirSync(out, { recursive: true });
const days = readdirSync(join(snap, 'rest-1m')).map((f) => /^btcusdt-1m-(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(f)?.[1]).filter(Boolean).sort();
if (days.length !== canon.size) die(`day files ${days.length} != canonical lines ${canon.size}`);
const manifest = [];
let canonOk = 0;
for (const day of days) {
  const c = canon.get(day);
  if (!c) die(`${day}: not in canonical-1m.sha256`);
  const raw = JSON.parse(gunzipSync(readFileSync(join(snap, 'rest-1m', `btcusdt-1m-${day}.json.gz`))).toString('utf8'));
  const rows = raw.flat().sort((a, b) => a[0] - b[0]);
  const t0 = Date.parse(day + 'T00:00:00Z'), t1 = t0 + 86400000;
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r[0])) die(`${day}: duplicate open time ${r[0]}`);
    seen.add(r[0]);
    if (!(r[0] >= t0 && r[0] < t1)) die(`${day}: row outside the day ${r[0]}`);
  }
  if (rows.length !== c.n) die(`${day}: ${rows.length} rows, canonical says ${c.n}`);
  const csv = rows.map((r) => `${r[0]},${r[1]},${r[2]},${r[3]},${r[4]}\n`).join('');
  const name = `btcusdt-1m-${day}.csv`;
  writeFileSync(join(out, name), csv, 'utf8');
  manifest.push(`${sha(csv)}  ${name}\n`);
  const text = csv.split('\n').slice(0, -1).map((l) => { const [t, o, h, lo, cl] = l.split(','); return `${t},${S(o)},${S(h)},${S(lo)},${S(cl)}\n`; }).join('');
  if (sha(text) !== c.h) die(`${day}: canonical sha256 mismatch`);
  canonOk++;
}
manifest.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
writeFileSync(manifestPath, manifest.join(''), 'utf8');
console.log(`days=${days.length} canonical_ok=${canonOk}/${canon.size} manifest=${manifestPath} manifest_sha256=${sha(manifest.join(''))}`);
