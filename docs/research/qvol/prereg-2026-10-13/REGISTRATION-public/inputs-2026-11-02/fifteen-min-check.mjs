// node fifteen-min-check.mjs <v6-folder> <btcusdt-15m.csv.gz> <daily-dir>
// (1) rebuild 15-minute text (README.md 15분봉 rule: slots :00/:15/:30/:45, bars that open in the slot; o first, h max, l min, c last; 3-decimal ticks; n1m)
//     from loadPair patch:false and patch:true; compare with the committed file's uncompressed bytes.
// (2) 30 random UTC days (seeded LCG, seed 20261102): last 15m bar close of the day vs last 1m row close of the daily file.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import crypto from 'node:crypto'; import { pathToFileURL } from 'node:url';
const [v6, gzPath, daily] = process.argv.slice(2);
const { loadPair } = await import(pathToFileURL(path.resolve(v6, 'read-1m.mjs')).href);
const committed = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (min) => new Date(min * 60000).toISOString().slice(0, 16);
const res = { committedSha: sha(committed) };
for (const patch of [false, true]) {
  const P = loadPair('BTCUSDT', { patch }); const g0 = P.t0 / 60000; const str = (x) => `${Math.floor(x / 1000)}.${String(x % 1000).padStart(3, '0')}`;
  const q = [];
  for (let m = 0; m < P.n; m++) if (P.has[m]) { const key = Math.floor((g0 + m) / 15); const b = q[q.length - 1];
    if (!b || b.key !== key) q.push({ key, o: P.op[m], h: P.hi[m], l: P.lo[m], c: P.cl[m], n: 1 }); else { b.h = Math.max(b.h, P.hi[m]); b.l = Math.min(b.l, P.lo[m]); b.c = P.cl[m]; b.n++; } }
  const text = 'time_utc,open,high,low,close,n1m\n' + q.map((b) => `${iso(b.key * 15)},${str(b.o)},${str(b.h)},${str(b.l)},${str(b.c)},${b.n}`).join('\n') + '\n';
  const a = text.split('\n'), c = committed.split('\n'); let diff = 0; for (let i = 0; i < Math.max(a.length, c.length); i++) if (a[i] !== c[i]) diff++;
  res[patch ? 'patched' : 'archive'] = { bars: q.length, sha: sha(text), equalToCommitted: text === committed, differingLines: diff };
}
const lines = committed.trim().split('\n').slice(1); const lastByDay = new Map();
for (const l of lines) { const f = l.split(','); lastByDay.set(f[0].slice(0, 10), { t: f[0], c: f[4] }); }
const days = fs.readdirSync(daily).filter((x) => x.endsWith('.csv')).sort();
let s = 20261102; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = new Set(); while (pick.size < 30) pick.add(days[Math.floor(rnd() * days.length)]);
res.sample = [...pick].sort().map((f) => { const r = fs.readFileSync(path.join(daily, f), 'utf8').trim().split('\n'); const last = r[r.length - 1].split(','); const day = f.slice(11, 21); const q = lastByDay.get(day);
  const c1 = last[4], c15 = q.c; return { day, last1m: new Date(+last[0]).toISOString().slice(11, 16), close1m: c1, last15m: q.t.slice(11), close15m: c15, equal: c1 === `${c15}00000` }; });
res.sampleEqual = res.sample.filter((x) => x.equal).length;
// same comparison for every day (information)
let all = 0, allEq = 0, neq = [];
for (const f of days) { const r = fs.readFileSync(path.join(daily, f), 'utf8').trim().split('\n'); const c1 = r[r.length - 1].split(',')[4]; const q = lastByDay.get(f.slice(11, 21)); all++; if (q && c1 === `${q.c}00000`) allEq++; else neq.push(f); }
res.allDays = { days: all, equal: allEq, notEqual: neq };
console.log(JSON.stringify(res, null, 1));
