// Independent C12 recomputation (registration §2-1 order) on this Mac, written by the verifier.
import { readFileSync } from 'node:fs';
const p = process.argv[2];
const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
let checked = 0, skippedNull = 0, varDiff = 0, valDiff = 0; const dates = new Set();
for (const r of lines) {
  const w = r.window;
  if (w.length !== 31 || w.some(x => x[1] === null)) { skippedNull++; continue; }
  let S = 0;
  for (let i = 1; i < 31; i++) { const rd = Math.log(w[i][1] / w[i - 1][1]); S = S + rd * rd; }
  const variance = (365 / 30) * S; const value = 100 * Math.sqrt(variance);
  checked++;
  if (variance !== r.variance) { varDiff++; dates.add(r.date); }
  if (value !== r.value) { valDiff++; dates.add(r.date); }
}
console.log(JSON.stringify({ file: p.split('/').slice(-2).join('/'), node: process.version, platform: process.platform, arch: process.arch, lines: lines.length, checked, skippedNull, varianceDiff: varDiff, valueDiff: valDiff, distinctDates: dates.size }));
