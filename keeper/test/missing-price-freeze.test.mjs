/**
 * Fail-closed basket marks (2026-09-30, RUNBOOK failure mode 6): a basket leg
 * whose book holds a name with no usable price today posts nothing and exits
 * 0 with a `markDeferred: missing-price` line, instead of leaving the name out
 * of the level (before: a missing BTC walked the qX20 basket down 59%).
 *
 * The two pure helpers are lifted out of paper-index.mjs's source text (it
 * runs main() on import), as keeper/test/recon-renormalise.test.mjs does. The
 * qX20 leg is then run for real as a child process, with every network call
 * failing (a data: URL preload replaces fetch), on a fixture price file in
 * keeper/cache/ dated in 2099 so it can never be mistaken for a real day's
 * pull; the fixture is removed afterwards. Nothing else is written.
 *
 *   node --test keeper/test/missing-price-freeze.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(KEEPER, 'paper-index.mjs'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const end = SRC.indexOf('\n}\n', start);
  return new Function(`${SRC.slice(start, end + 2)}\nreturn ${name};`)();
}
const unpricedMembers = lift('unpricedMembers');
const testDropSymbols = lift('testDropSymbols');

test('unpricedMembers: only a finite number above zero is a usable price', () => {
  const prices = { A: 1.5, B: 0, C: -2, D: NaN, E: Infinity, F: null, H: '3', I: 1e-12 };
  assert.deepEqual(unpricedMembers(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], prices), ['B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.deepEqual(unpricedMembers(['I', 'A'], prices), []);
  assert.deepEqual(unpricedMembers([], prices), []);
});

test('testDropSymbols: parsed on a dry run, ignored on a live run', () => {
  assert.deepEqual(testDropSymbols(' btc, eth ,,', true), ['BTC', 'ETH']);
  assert.deepEqual(testDropSymbols(undefined, true), []);
  assert.deepEqual(testDropSymbols('BTC', false), []);
  assert.deepEqual(testDropSymbols('', false), []);
});

// ------------------------------------------------ the qX20 leg, end to end
const book = JSON.parse(fs.readFileSync(path.join(KEEPER, 'state.json'), 'utf8')).units;
const names = Object.keys(book);
const fixtures = [];
function priceFile(date, rows) {
  const f = path.join(KEEPER, 'cache', `cg-markets-top500-${date}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rows));
  fixtures.push(f);
}
after(() => {
  for (const f of fixtures) fs.rmSync(f, { force: true });
});
const row = (symbol, price = 1) => ({ id: symbol.toLowerCase(), symbol, price, marketCap: 1e9, volume24h: 1e6 });
const OFFLINE = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("offline (test)")}';
function runQx20(date, env = {}) {
  const r = spawnSync(
    process.execPath,
    ['--import', OFFLINE, path.join(KEEPER, 'paper-index.mjs'), '--index', 'qx20', '--dry-run', '--as-of', date],
    { encoding: 'utf8', env: { ...process.env, KEEPER_PK: '', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', PAPER_INDEX_TEST_DROP_SYMBOL: '', ...env } }
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('qX20 leg: a book name missing from the pull defers the whole mark, exit 0', () => {
  const [gone, ...rest] = names;
  priceFile('2099-12-29', rest.map((s) => row(s)));
  const { status, out } = runQx20('2099-12-29');
  assert.equal(status, 0, out);
  assert.match(out, /basket marks DEFERRED/);
  const line = out.split('\n').find((l) => l.startsWith('markDeferred '));
  assert.ok(line, out);
  const d = JSON.parse(line.slice('markDeferred '.length));
  assert.equal(d.markDeferred, 'missing-price');
  assert.equal(d.policy, 'freeze');
  assert.deepEqual(d.missing, [gone]);
  assert.doesNotMatch(out, /^level /m); // no level computed without the name
  assert.doesNotMatch(out, /nav: onchain|setNav|setRefPrice|registry:/); // basket-mark never reached
});

test('qX20 leg: a zero or non-finite price counts as missing', () => {
  priceFile('2099-12-28', names.map((s, i) => row(s, i === 0 ? 0 : i === 1 ? null : 1)));
  const { status, out } = runQx20('2099-12-28');
  assert.equal(status, 0, out);
  const d = JSON.parse(out.split('\n').find((l) => l.startsWith('markDeferred ')).slice(13));
  assert.deepEqual(d.missing, names.slice(0, 2));
});

test('qX20 leg: PAPER_INDEX_TEST_DROP_SYMBOL takes the same path on a dry run', () => {
  priceFile('2099-12-30', names.map((s) => row(s)));
  const target = names[names.length - 1];
  const { status, out } = runQx20('2099-12-30', { PAPER_INDEX_TEST_DROP_SYMBOL: target.toLowerCase() });
  assert.equal(status, 0, out);
  assert.match(out, new RegExp(`\\[test\\] PAPER_INDEX_TEST_DROP_SYMBOL: ${target} removed`));
  const d = JSON.parse(out.split('\n').find((l) => l.startsWith('markDeferred ')).slice(13));
  assert.deepEqual(d.missing, [target]);
});

test('qX20 leg: a fully priced book is not deferred and computes the level from every name', () => {
  priceFile('2099-12-31', names.map((s) => row(s)));
  const { out } = runQx20('2099-12-31');
  // Offline, the run stops at the first chain read inside basket-mark (exit 1)
  // — after the level line, which is what this test is about.
  assert.doesNotMatch(out, /markDeferred|DEFERRED/);
  const sum = Object.values(book).reduce((t, u) => t + u, 0); // every price is 1
  assert.match(out, new RegExp(`^level ${sum.toFixed(6)} from ${names.length} constituents`, 'm'));
});
