// node --test keeper/special-situation.test.mjs
//
// Synthetic-data tests for the §9 trigger log (keeper/special-situation.mjs).
// The definitions are read from the real rulebook JSON, so a change to a
// threshold there is exercised here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateSpecialSituation, relVsBtcPct, tvlChange48hPct, weeklyControlOutflow } from './special-situation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QREV = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', 'qrev.json'), 'utf8'));
const TRIENS = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', 'triens.json'), 'utf8'));
const DEF = QREV.specialEvents.triggerLog;

const H = 3600;
const tvl = (before, after) => [
  [1_000_000, before],
  [1_000_000 + 24 * H, before],
  [1_000_000 + 48 * H, after],
];
const mk = (rows) => new Map(Object.entries(rows));
const noFetch = async () => {
  throw new Error('must not be called');
};
const base = {
  def: DEF,
  dateStr: '2026-10-01',
  supplyWeekly: {},
  supplyRegistry: {},
  fetchSecond24h: noFetch,
  fetchTvlSeries: noFetch,
};

test('the rulebooks carry the §9 values the rulebook text states', () => {
  for (const d of [QREV.specialEvents.triggerLog, TRIENS.specialEvents.triggerLog]) {
    assert.equal(d.A.priceVsBtc24hMaxPct, -40);
    assert.equal(d.A.tvl48hMaxPct, -50);
    assert.equal(d.B.weeklyOutflowMinFractionOfCirculating, 0.05);
  }
  for (const f of ['qdefi', 'qai', 'barbell']) {
    const rb = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', `${f}.json`), 'utf8'));
    assert.equal(rb.specialEvents?.triggerLog, undefined, `${f} defines no trigger log`);
  }
});

test('helpers', () => {
  assert.equal(Math.round(relVsBtcPct(-45, -10) * 100) / 100, -38.89); // -45% on a -10% BTC day is -38.9% vs BTC
  assert.equal(relVsBtcPct(null, 1), null);
  assert.equal(tvlChange48hPct(tvl(100, 40)), -60);
  assert.equal(tvlChange48hPct([[1, 5]]), null);
  const wk = { '2026-09-20': { excluded: 100, circulating: 1000 }, '2026-09-27': { excluded: 40, circulating: 1060 } };
  const o = weeklyControlOutflow(wk, '2026-10-01', 10);
  assert.equal(o.status, 'measured');
  assert.ok(Math.abs(o.fraction - 60 / 1060) < 1e-12);
  assert.equal(weeklyControlOutflow(wk, '2026-10-20', 10).status, 'stale');
});

test('a quiet day fires nothing and fetches nothing', async () => {
  const r = await evaluateSpecialSituation({
    ...base,
    held: ['AAA', 'BBB'],
    markets: mk({ BTC: { price: 1, priceChange24h: 1 }, AAA: { price: 2, priceChange24h: -3 }, BBB: { price: 3, priceChange24h: 2 } }),
  });
  assert.equal(r.evaluated, true);
  assert.equal(r.fired, false);
  const [A, B, C] = r.triggers;
  assert.equal(A.evaluated, true);
  assert.equal(A.checked, 2);
  assert.equal(A.worst.symbol, 'AAA');
  assert.equal(A.hits, undefined);
  assert.equal(B.evaluated, false); // no weekly series at all
  assert.deepEqual(B.notMeasured, { noSeries: ['AAA', 'BBB'] });
  assert.equal(C.fired, false);
});

test('A fires only when both price sources agree and TVL fell 50% in 48h', async () => {
  const markets = mk({ BTC: { price: 1, priceChange24h: 0 }, AAA: { price: 1, priceChange24h: -70 } });
  const fired = await evaluateSpecialSituation({
    ...base,
    held: ['AAA'],
    markets,
    fetchSecond24h: async () => mk({ BTC: 0.5, AAA: -68 }),
    fetchTvlSeries: async () => tvl(1000, 300),
  });
  assert.equal(fired.fired, true);
  assert.equal(fired.triggers[0].hits[0].met, true);
  assert.equal(fired.triggers[0].hits[0].tvl48hPct, -70);

  const tvlHeld = await evaluateSpecialSituation({
    ...base,
    held: ['AAA'],
    markets,
    fetchSecond24h: async () => mk({ BTC: 0, AAA: -69 }),
    fetchTvlSeries: async () => tvl(1000, 700), // -30%: a crash the protocol survived
  });
  assert.equal(tvlHeld.fired, false);
  assert.equal(tvlHeld.triggers[0].hits[0].met, false);

  const secondDisagrees = await evaluateSpecialSituation({
    ...base,
    held: ['AAA'],
    markets,
    fetchSecond24h: async () => mk({ BTC: 0, AAA: -12 }),
    fetchTvlSeries: noFetch, // not read once the price leg fails
  });
  assert.equal(secondDisagrees.fired, false);
  assert.equal(secondDisagrees.triggers[0].hits[0].met, false);
});

test('A never clears a flagged name it could not confirm', async () => {
  const r = await evaluateSpecialSituation({
    ...base,
    held: ['AAA'],
    markets: mk({ BTC: { price: 1, priceChange24h: 0 }, AAA: { price: 1, priceChange24h: -70 } }),
    fetchSecond24h: async () => {
      throw new Error('CoinPaprika down');
    },
    fetchTvlSeries: async () => tvl(1000, 100),
  });
  assert.equal(r.fired, false);
  assert.equal(r.needsReview, true);
  assert.equal(r.triggers[0].hits[0].met, null);
  assert.equal(r.triggers[0].hits[0].secondSourceError, 'CoinPaprika down');
});

test('B reads a fresh weekly snapshot and fires at 5% of circulating', async () => {
  const r = await evaluateSpecialSituation({
    ...base,
    held: ['AAA', 'BBB', 'CCC'],
    markets: mk({ BTC: { price: 1, priceChange24h: 0 }, AAA: { price: 1, priceChange24h: 0 }, BBB: { price: 1, priceChange24h: 0 }, CCC: { price: 1, priceChange24h: 0 } }),
    supplyWeekly: {
      AAA: { '2026-09-20': { excluded: 200, circulating: 800 }, '2026-09-27': { excluded: 140, circulating: 860 } }, // 6.98%
      BBB: { '2026-09-06': { excluded: 10, circulating: 90 }, '2026-09-13': { excluded: 0, circulating: 100 } }, // stale on 10/01
    },
    supplyRegistry: { CCC: { census_status: 'incomplete' } },
  });
  const B = r.triggers[1];
  assert.equal(B.evaluated, true);
  assert.equal(B.fired, true);
  assert.equal(B.hits[0].symbol, 'AAA');
  assert.deepEqual(B.notMeasured, { censusIncomplete: ['CCC'], stale: ['BBB'] });
  assert.equal(B.latestSnapshot, '2026-09-13');
  assert.equal(r.fired, true);
});

test('C fires on a held name without a price', async () => {
  const r = await evaluateSpecialSituation({
    ...base,
    held: ['AAA', 'GONE'],
    markets: mk({ BTC: { price: 1, priceChange24h: 0 }, AAA: { price: 1, priceChange24h: 0 } }),
  });
  assert.equal(r.triggers[2].fired, true);
  assert.deepEqual(r.triggers[2].noPrice, ['GONE']);
  assert.deepEqual(r.triggers[0].missing, ['GONE']);
});
