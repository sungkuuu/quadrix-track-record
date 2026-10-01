/**
 * Option K (red-team RT17, 2026-10-01): a removal remnant under the plan's $1
 * trade minimum is PENDING — reported, not a failure — and every other drift
 * rule is unchanged. The chain side (finalize right after the drain, re-drain
 * at once, five tries, then PENDING) is exercised on an anvil fork by
 * keeper/rehearse-day7.mjs; this file pins the pure classification the
 * auctions stage and verify read.
 *
 *   node --test keeper/test/recon-k.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residual, MAX_DRAIN_ATTEMPTS } from '../basket-recon.mjs';

const E18 = 10n ** 18n;
// refs are USD × 1e18 per base unit; a token at $1 with 0 decimals has ref 1e18.
const plan = {
  policy: { tolerancePoints: 5, minTradeUsd: 1 },
  targets: [
    { symbol: 'A', traded: true },
    { symbol: 'B', traded: false },
    { symbol: 'X', traded: true },
  ],
};
const ctx = { plan };
const row = (symbol, balance, ref, targetWeight, isRemove = false) => ({ symbol, balance, ref, targetWeight, isRemove });

test('five re-drains before PENDING (review 2.7 K-2)', () => {
  assert.equal(MAX_DRAIN_ATTEMPTS, 5);
});

test('a drained removal is ok; a 1-unit remnant worth under $1 is PENDING, not ok', () => {
  const drained = residual(ctx, [row('A', 600n, E18, 0.6), row('B', 400n, E18, 0.4), row('X', 0n, E18, 0, true)]);
  assert.deepEqual(drained.map((r) => [r.symbol, r.ok, r.pending]), [['A', true, false], ['B', true, false], ['X', true, false]]);
  const dust = residual(ctx, [row('A', 600n, E18, 0.6), row('B', 400n, E18, 0.4), row('X', 1n, E18 / 1000n, 0, true)]);
  const x = dust.find((r) => r.symbol === 'X');
  assert.equal(x.ok, false);
  assert.equal(x.pending, true);
  assert.ok(dust.every((r) => r.ok || r.pending), 'the auctions stage ends without failing');
});

test('a remnant worth $1 or more is neither ok nor PENDING (it is traded, or the stage fails)', () => {
  const res = residual(ctx, [row('A', 600n, E18, 0.6), row('B', 400n, E18, 0.4), row('X', 1n, E18, 0, true)]);
  const x = res.find((r) => r.symbol === 'X');
  assert.equal(x.ok, false);
  assert.equal(x.pending, false);
});

test('PENDING never covers a held name: a traded name outside tolerance stays OUTSIDE', () => {
  const res = residual(ctx, [row('A', 500n, E18, 0.6), row('B', 500n, E18, 0.4), row('X', 0n, E18, 0, true)]);
  const a = res.find((r) => r.symbol === 'A');
  assert.equal(a.ok, false);
  assert.equal(a.pending, false);
});
