// node gaps-daily-1m.mjs <daily-dir>  -> accepted-gaps.json on stdout
// Days with < 1440 rows; canonical text per registration-draft.md §2-2: `${openTimeMs},${S(o)},${S(h)},${S(l)},${S(c)}\n`, S(x) = String(Number(x)).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const dir = process.argv[2];
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => /^btcusdt-1m-\d{4}-\d{2}-\d{2}\.csv$/.test(x)).sort()) {
  const day = f.slice(11, 21), d0 = Date.parse(`${day}T00:00:00Z`);
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  if (lines.length >= 1440) continue;
  const present = new Uint8Array(1440);
  const canon = lines.map((l) => { const [t, ...p] = l.split(','); present[(+t - d0) / 60000] = 1; return `${t},${p.map((x) => String(Number(x))).join(',')}\n`; }).join('');
  const missing = []; let s = -1;
  for (let m = 0; m <= 1440; m++) { const gap = m < 1440 && !present[m]; if (gap && s < 0) s = m; if (!gap && s >= 0) { missing.push(s === m - 1 ? hm(s) : `${hm(s)}-${hm(m - 1)}`); s = -1; } }
  const latest = lines.length ? hm((+lines[lines.length - 1].split(',')[0] - d0) / 60000) : null;
  const first = lines.length ? hm((+lines[0].split(',')[0] - d0) / 60000) : null;
  out.push({ day, rows: lines.length, missingMinutes: missing, sha256: crypto.createHash('sha256').update(canon, 'utf8').digest('hex'), firstBar: first, latestBar: latest });
}
console.log(JSON.stringify(out, null, 1));
