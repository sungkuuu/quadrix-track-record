/**
 * keeper/qx20-members.mjs — the members written on each keeper ledger line
 * (from 2026-10-22) and joined onto the qX20 daily closes by transaction hash.
 *
 *   node --test --test-concurrency=1 keeper/test/qx20-members.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookMembers, dailyCloses } from '../qx20-members.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TX = (n) => '0x' + n.toString(16).padStart(64, '0');
const readLines = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').filter((l) => l.trim());

test('weight = units × price ÷ the book value, 4 decimals, heaviest first', () => {
  const m = bookMembers({ ETH: 1, BTC: 0.1, SOL: 10 }, { BTC: 100000, ETH: 4000, SOL: 200 });
  // values: BTC 10000, ETH 4000, SOL 2000 → 16000
  assert.deepEqual(m, [
    { symbol: 'BTC', weight: 0.625, price: 100000 },
    { symbol: 'ETH', weight: 0.25, price: 4000 },
    { symbol: 'SOL', weight: 0.125, price: 200 },
  ]);
});

test('weights are rounded to 4 decimals and sum to 1 within rounding', () => {
  const m = bookMembers({ A: 1, B: 1, C: 1 }, { A: 1, B: 1, C: 1 });
  assert.deepEqual(m.map((x) => x.weight), [0.3333, 0.3333, 0.3333]);
  const big = bookMembers(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, 1 + i])), Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, 3.7 + i * 1.3])));
  const sum = big.reduce((t, x) => t + x.weight, 0);
  assert.ok(Math.abs(sum - 1) <= 20 * 0.00005 + 1e-12, `sum ${sum}`);
  for (const x of big) assert.equal(x.weight, Number(x.weight.toFixed(4)));
});

test('a held member without a price is listed with weight null and price null, and left out of the denominator', () => {
  const m = bookMembers({ BTC: 1, XYZ: 5 }, { BTC: 50 });
  assert.deepEqual(m, [
    { symbol: 'BTC', weight: 1, price: 50 },
    { symbol: 'XYZ', weight: null, price: null },
  ]);
});

test('no book, no members', () => {
  assert.deepEqual(bookMembers(null, {}), []);
  assert.deepEqual(bookMembers({}, { BTC: 1 }), []);
});

// Rebuild the marks behind each existing close (the close is the day's last
// mark; the earlier marks only count), then rebuild the file with the real
// ledger — none of whose lines carry members yet — and require the exact bytes.
test('with the current ledger, every existing close is rebuilt byte for byte', () => {
  const file = readLines('keeper/qx20-daily.jsonl');
  const marks = [];
  for (const raw of file) {
    const c = JSON.parse(raw);
    const closeTs = Date.parse(c.at) / 1000;
    const dayStart = Date.parse(`${c.date}T00:00:00Z`) / 1000;
    for (let i = 0; i < c.marks_that_day - 1; i++) {
      assert.ok(dayStart + i < closeTs, `${c.date}: room for the earlier marks`);
      marks.push({ date: c.date, ts: dayStart + i, vault: c.vault, block: c.block - 1000 + i, tx: TX(i + 1), nav: 1, level: 1 });
    }
    marks.push({ date: c.date, ts: closeTs, vault: c.vault, block: c.block, tx: c.tx, nav: c.nav, level: c.level });
  }
  const ledger = readLines('keeper/nav-marks.jsonl').map((l) => JSON.parse(l));
  const out = dailyCloses(marks.reverse(), ledger).map((l) => JSON.stringify(l));
  assert.deepEqual(out, file);
});

test('a close whose ledger line carries members gets members and priceSource appended; the others are unchanged', () => {
  const members = [{ symbol: 'BTC', weight: 0.6, price: 100000 }, { symbol: 'ETH', weight: 0.4, price: 4000 }];
  const marks = [
    { date: '2026-10-22', ts: Date.parse('2026-10-22T06:00:00Z') / 1000, vault: '0xv', block: 10, tx: TX(10), nav: 1.2, level: 1.2 },
    { date: '2026-10-22', ts: Date.parse('2026-10-22T18:00:00Z') / 1000, vault: '0xv', block: 20, tx: TX(20), nav: 1.3, level: 1.3 },
    { date: '2026-10-23', ts: Date.parse('2026-10-23T06:00:00Z') / 1000, vault: '0xv', block: 30, tx: TX(30), nav: 1.4, level: 1.4 },
  ];
  const ledger = [
    { txHash: TX(10), priceSource: 'coingecko', members: [{ symbol: 'BTC', weight: 1, price: 1 }] }, // not the close
    { txHash: TX(20).toUpperCase().replace('0X', '0x'), priceSource: 'coinpaprika', members },
    { txHash: TX(30), priceSource: 'coingecko' }, // a ledger line without members
  ];
  const [d22, d23] = dailyCloses(marks, ledger);
  assert.deepEqual(Object.keys(d22), ['date', 'nav', 'level', 'marks_that_day', 'vault', 'block', 'tx', 'at', 'members', 'priceSource']);
  assert.equal(d22.marks_that_day, 2);
  assert.equal(d22.tx, TX(20));
  assert.deepEqual(d22.members, members);
  assert.equal(d22.priceSource, 'coinpaprika');
  assert.deepEqual(Object.keys(d23), ['date', 'nav', 'level', 'marks_that_day', 'vault', 'block', 'tx', 'at']);
});

test('update-nav writes the members on the ledger line it appends', () => {
  const src = fs.readFileSync(path.join(REPO, 'keeper/update-nav.mjs'), 'utf8');
  assert.match(src, /import \{ bookMembers \} from '\.\/qx20-members\.mjs';/);
  assert.match(src, /txHash: hash,\n\s+members: bookMembers\(units, prices\),\n\s+\}\) \+ '\\n'/);
});
