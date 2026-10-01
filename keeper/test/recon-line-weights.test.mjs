/**
 * A qREV / qDEFI / qAI record line shows the BOOK weight of every member —
 * units x price over the book value — on a reconstitution day as on any other
 * day. The rule's weight before the tolerance step is written beside it as
 * `targetWeight`, on a reconstitution line only.
 *
 * Before 2026-10-02 a reconstitution line wrote the target weight into
 * `weight` while its level was computed from the book, so the next line (a
 * mark of the same book) appeared to change the weights overnight.
 *
 * paper-index.mjs runs main() on import, so the helpers are lifted out of its
 * source text, as keeper/test/recon-renormalise.test.mjs does.
 *
 *   node --test keeper/test/recon-line-weights.test.mjs
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
const bookValueAt = lift('bookValueAt');
const bookWeight = lift('bookWeight');

const r4 = (x) => Math.round(x * 10000) / 10000;

// Old book of four names; by the reconstitution A has run up, C has fallen.
// New targets: A is inside the 5-point tolerance (kept at its drifted count),
// B and C are traded, D is a new name, E is a target with no price today (not
// held). X leaves the index.
const prevUnits = { A: 0.4, B: 0.3, C: 0.2, X: 0.1 };
const priceNow = { A: 1.25, B: 1.0, C: 0.7, D: 2.0, X: 1.1 };
const targets = [
  { symbol: 'A', weight: 0.47 },
  { symbol: 'B', weight: 0.2 },
  { symbol: 'C', weight: 0.13 },
  { symbol: 'D', weight: 0.15 },
  { symbol: 'E', weight: 0.05 },
];
const TOL = 0.05;
const CAP = 0.5;

/** The reconstitution step as main() runs it for qREV / qDEFI / qAI. */
function reconstitute() {
  const level = bookValueAt(prevUnits, priceNow);
  const units = applyToleranceAndTrade(targets, priceNow, prevUnits, level, TOL, CAP);
  renormaliseBook(units, priceNow, level);
  return { level, units };
}

test('helpers are defined in paper-index.mjs', () => {
  assert.equal(typeof bookValueAt, 'function');
  assert.equal(typeof bookWeight, 'function');
});

test('a reconstitution-day weight equals units x price / book value', () => {
  const { level, units } = reconstitute();
  const total = Object.entries(units).reduce((t, [s, u]) => t + u * priceNow[s], 0);
  assert.ok(Math.abs(total - level) < 1e-12, 'M9: no value in or out');
  const bv = bookValueAt(units, priceNow);
  for (const { symbol } of targets) {
    const expect = r4(((units[symbol] ?? 0) * (priceNow[symbol] ?? 0)) / total);
    assert.equal(bookWeight(units, priceNow, symbol, bv), expect, symbol);
  }
  assert.equal(bookWeight(units, priceNow, 'E', bv), 0, 'a target with no price is not held');
  assert.equal(bookWeight(units, priceNow, 'X', bv), 0, 'a name that left holds nothing');
  const sum = targets.reduce((t, { symbol }) => t + ((units[symbol] ?? 0) * (priceNow[symbol] ?? 0)) / bv, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, 'book weights over the members sum to 1');
});

test('the book weight differs from the target where the tolerance kept a name', () => {
  const { units } = reconstitute();
  const bv = bookValueAt(units, priceNow);
  const a = bookWeight(units, priceNow, 'A', bv);
  console.log(`  A target ${targets[0].weight}  book ${a}`);
  assert.notEqual(a, targets[0].weight);
});

test('the next mark of the same book at the same prices shows the same weights', () => {
  const { units } = reconstitute();
  const bv = bookValueAt(units, priceNow);
  const reconLine = Object.fromEntries(targets.map(({ symbol }) => [symbol, bookWeight(units, priceNow, symbol, bv)]));
  // mark-to-market branch: level = sum(u x p), members = keys of units
  const level = bookValueAt(units, priceNow);
  for (const sym of Object.keys(units)) assert.equal(bookWeight(units, priceNow, sym, level), reconLine[sym], sym);
});

test('bookWeight is null when the book has no value', () => {
  assert.equal(bookWeight({ A: 1 }, {}, 'A', 0), null);
});

test('main() writes the book weight and the target separately on a reconstitution line', () => {
  const main = SRC.slice(SRC.indexOf('async function main()'));
  const recon = main.slice(main.indexOf('members = weights.map('), main.indexOf('members = weights.map(') + 400);
  assert.match(recon, /weight: bookWeight\(units, priceNow, w\.symbol, bookValue\)/);
  assert.match(recon, /targetWeight: Math\.round\(w\.weight \* 10000\) \/ 10000/);
  const before = main.slice(0, main.indexOf('members = weights.map('));
  assert.match(before.slice(-600), /const bookValue = bookValueAt\(units, priceNow\);/);
  const mark = main.slice(main.indexOf("console.log('mark-to-market only"));
  assert.match(mark.slice(0, 1200), /weight: bookWeight\(units, priceNow, sym, level\)/);
});
