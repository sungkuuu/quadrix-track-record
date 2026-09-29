// node --test keeper/source-reconciliation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconciledListingAge, reconcileIssuance, proxyAgeDays } from './source-reconciliation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rb = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', `${f}.json`), 'utf8'));

test('the rulebooks that adopt the rule say so, and the others do not', () => {
  assert.equal(rb('triens').eligibility.listingAgeRule, 'earlier-of-cmc-and-proxy');
  assert.equal(rb('qai').eligibility.listingAgeRule, 'earlier-of-cmc-and-proxy');
  assert.equal(rb('triens').eligibility.listingDisagreementDays, 90);
  assert.equal(rb('qai').eligibility.listingDisagreementDays, 90);
  assert.equal(rb('qrev').eligibility.listingAgeRule, undefined); // value-capture.md §2: the proxy
  assert.equal(rb('qdefi').eligibility.listingAgeRule, undefined); // qdefi.md §2: the proxy
  assert.equal(rb('qrev').issuance.issuanceDisagreementFraction, 0.05);
  assert.equal(rb('triens').issuance.issuanceDisagreementFraction, 0.05);
});

test('listing age: the earlier date wins, from either source', () => {
  const d = '2026-10-01';
  // VVV on 2026-09-22: proxy says young, CMC says old -> CMC
  const vvv = reconciledListingAge({ athDate: '2025-12-01T00:00:00Z', atlDate: '2026-03-01T00:00:00Z' }, { dateAdded: '2025-01-28' }, d);
  assert.equal(vvv.source, 'cmc-date-added');
  assert.equal(Math.round(vvv.days), 611);
  assert.equal(vvv.listingDisagreement, true);
  assert.equal(vvv.listingDateCmc, '2025-01-28');
  assert.equal(vvv.listingDateGecko, '2025-12-01');
  // proxy older than CMC's record -> proxy
  const old = reconciledListingAge({ athDate: '2021-01-01T00:00:00Z', atlDate: '2020-06-01T00:00:00Z' }, { dateAdded: '2026-01-01' }, d);
  assert.equal(old.source, 'ath-atl-proxy');
  assert.equal(old.days, proxyAgeDays({ athDate: '2021-01-01T00:00:00Z', atlDate: '2020-06-01T00:00:00Z' }, d));
  // within 90 days: no disclosure fields
  const close = reconciledListingAge({ athDate: '2024-03-01T00:00:00Z', atlDate: '2024-02-01T00:00:00Z' }, { dateAdded: '2024-01-15' }, d);
  assert.equal(close.listingDisagreement, undefined);
  // one source missing
  assert.equal(reconciledListingAge({}, { dateAdded: '2024-01-15' }, d).source, 'cmc-date-added');
  assert.equal(reconciledListingAge({ athDate: '2024-01-15T00:00:00Z' }, null, d).source, 'ath-atl-proxy');
  assert.equal(reconciledListingAge({}, null, d).days, null);
});

test('issuance: the larger of the two, disclosed past 5%', () => {
  const r = reconcileIssuance({ gecko: { s0: 100, s1: 110 }, cmc: { s0: 100, s1: 120 }, price: 2 });
  assert.equal(r.value, 40);
  assert.equal(r.source, 'cmc');
  assert.equal(r.issuanceGecko, 20);
  assert.equal(r.issuanceCmc, 40);
  assert.equal(r.issuanceDisagreement, true);

  const near = reconcileIssuance({ gecko: { s0: 100, s1: 120 }, cmc: { s0: 100, s1: 119.5 }, price: 1 });
  assert.equal(near.source, 'coingecko');
  assert.equal(near.issuanceDisagreement, false); // 0.5 of 20 = 2.5%

  const shrink = reconcileIssuance({ gecko: { s0: 100, s1: 90 }, cmc: { s0: 100, s1: 95 }, price: 1 });
  assert.equal(shrink.value, 0); // supply fell on both: issuance 0, not negative
  assert.equal(shrink.issuanceDisagreement, false);

  assert.equal(reconcileIssuance({ gecko: null, cmc: { s0: 1, s1: 2 }, price: 1 }).source, 'cmc');
  assert.equal(reconcileIssuance({ gecko: { s0: 1, s1: 2 }, cmc: null, price: 1, censusIncomplete: true }).source, 'coingecko-census-incomplete');
  const none = reconcileIssuance({ gecko: null, cmc: null, price: 1, censusIncomplete: true });
  assert.equal(none.value, null);
  assert.equal(none.source, 'unavailable-census-incomplete');
});
