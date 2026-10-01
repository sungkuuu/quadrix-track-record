/**
 * Announce-stage checks (review of 2026-10-01, §6-1): a duplicate address in
 * the tuple is accepted by announceRegistryChange and refused by
 * executeRegistryChange for good, and a wrong mock address shows up as a
 * chain symbol that is not m{SYMBOL}. Both refuse before anything is sent.
 *
 *   node --test keeper/test/recon-announce.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tupleProblems, mockSymbolMismatch } from '../basket-recon.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

test('a clean tuple has no problems', () => {
  assert.deepEqual(tupleProblems({ adds: [A, B], removes: [C] }), []);
  assert.deepEqual(tupleProblems({ adds: [A], removes: [] }), []);
});

test('a duplicate add, a duplicate remove (any letter case) and an address in both are each refused', () => {
  assert.match(tupleProblems({ adds: [A, B, A.toUpperCase().replace('0X', '0x')], removes: [] }).join(), /duplicate address in adds/);
  assert.match(tupleProblems({ adds: [], removes: [C, C] }).join(), /duplicate address in removes/);
  assert.match(tupleProblems({ adds: [A], removes: [A] }).join(), /in both adds and removes/);
});

test('chain symbol must be m + the plan symbol', () => {
  assert.equal(mockSymbolMismatch('NEAR', 'mNEAR'), false);
  assert.equal(mockSymbolMismatch('NEAR', 'mICP'), true);
  assert.equal(mockSymbolMismatch('NEAR', 'NEAR'), true);
  assert.equal(mockSymbolMismatch('NEAR', 'mnear'), true);
});
