/**
 * M9 (2026-09-29): a qREV / qDEFI / qAI reconstitution must move no value in
 * or out of the book.
 *
 * applyToleranceAndTrade keeps a name inside the 5-point tolerance at its
 * drifted unit count and sizes every traded name to target x level, so the
 * book it returns is worth level x (sum of retained drifted weights + sum of
 * traded target weights), not level. The next daily mark recomputes the level
 * as sum(units x price), so that residual would show up as a level jump with no
 * cash flow. renormaliseBook scales every unit by k = level / book, the same
 * step the Triens Quality sleeve takes and the research engine's renormalised
 * weight vector (docs/research/qrev/qrev-backtest.py run()).
 *
 * paper-index.mjs runs main() on import, so the two functions are lifted out
 * of its source text and evaluated here; the test exercises the shipped code.
 *
 *   node --test keeper/test/recon-renormalise.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'paper-index.mjs'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const end = SRC.indexOf('\n}\n', start);
  return new Function(`${SRC.slice(start, end + 2)}\nreturn ${name};`)();
}
const applyToleranceAndTrade = lift('applyToleranceAndTrade');
const renormaliseBook = lift('renormaliseBook');

const bookValue = (units, px) => Object.entries(units).reduce((t, [s, u]) => t + u * px[s], 0);

// Three names bought at 1.00 into 40 / 30 / 30. By the reconstitution A has
// run to 1.20 and C fallen to 0.80: the book is worth 1.02 and drifted to
// A 47.06% / B 29.41% / C 23.53%. New targets 45 / 40 / 15: A is 2.06 points
// off (inside the 5-point tolerance, kept at its drifted count), B and C are
// 10.59 and 8.53 points off (traded).
const prevUnits = { A: 0.4, B: 0.3, C: 0.3 };
const priceNow = { A: 1.2, B: 1.0, C: 0.8 };
const targets = [
  { symbol: 'A', weight: 0.45 },
  { symbol: 'B', weight: 0.4 },
  { symbol: 'C', weight: 0.15 },
];
const TOL = 0.05;
const CAP = 0.5;

test('applyToleranceAndTrade alone does not preserve the book value (the M9 defect)', () => {
  const level = bookValue(prevUnits, priceNow); // 1.02 — the pre-trade mark
  const units = applyToleranceAndTrade(targets, priceNow, prevUnits, level, TOL, CAP);
  const after = bookValue(units, priceNow);
  const residual = after - level;
  console.log(
    `  pre-trade level ${level.toFixed(6)}  post-trade sum(u*p) ${after.toFixed(6)}  ` +
      `residual ${residual >= 0 ? '+' : ''}${residual.toFixed(6)} (${((after / level - 1) * 100).toFixed(4)}% of the level)`
  );
  assert.equal(units.A, prevUnits.A, 'A is inside the tolerance and keeps its unit count');
  // residual = level x (A drifted - A target) = 1.02 x (0.48/1.02 - 0.45)
  assert.ok(Math.abs(residual - (0.48 - 1.02 * 0.45)) < 1e-12);
  assert.ok(Math.abs(residual) > 0.02, 'the book is off by ~2% of the level');
});

test('renormaliseBook brings the book back to the pre-trade level, weights pro rata', () => {
  assert.equal(typeof renormaliseBook, 'function', 'renormaliseBook is defined in paper-index.mjs');
  const level = bookValue(prevUnits, priceNow);
  const units = applyToleranceAndTrade(targets, priceNow, prevUnits, level, TOL, CAP);
  const before = bookValue(units, priceNow);
  const k = renormaliseBook(units, priceNow, level);
  const after = bookValue(units, priceNow);
  console.log(`  k = ${k.toFixed(6)}  post-fix sum(u*p) ${after.toFixed(12)}  level ${level.toFixed(12)}`);
  assert.ok(Math.abs(k - level / before) < 1e-15);
  assert.ok(Math.abs(after - level) < 1e-12, 'no value in or out');
  // Same weights as the research engine: tolerance-substituted vector / its sum.
  const t = 0.48 / 1.02 + 0.4 + 0.15;
  const w = (s) => (units[s] * priceNow[s]) / after;
  assert.ok(Math.abs(w('A') - 0.48 / 1.02 / t) < 1e-12);
  assert.ok(Math.abs(w('B') - 0.4 / t) < 1e-12);
  assert.ok(Math.abs(w('C') - 0.15 / t) < 1e-12);
});

test('renormaliseBook leaves a fully traded book untouched (k = 1, units unchanged)', () => {
  assert.equal(typeof renormaliseBook, 'function', 'renormaliseBook is defined in paper-index.mjs');
  const level = bookValue(prevUnits, priceNow);
  const units = applyToleranceAndTrade(targets, priceNow, prevUnits, level, 0 /* no tolerance: everything trades */, CAP);
  const snapshot = { ...units };
  const k = renormaliseBook(units, priceNow, level);
  assert.ok(Math.abs(k - 1) < 1e-12);
  assert.deepEqual(units, snapshot, 'unit counts are bit-identical');
});

test('the qREV / qDEFI / qAI reconstitution branch renormalises right after the tolerance step', () => {
  const main = SRC.slice(SRC.indexOf('async function main()'));
  const call = main.indexOf('units = applyToleranceAndTrade(');
  assert.ok(call > 0);
  const next = main.slice(call, call + 600);
  assert.match(next, /renormaliseBook\(units, priceNow, level\)/);
});
