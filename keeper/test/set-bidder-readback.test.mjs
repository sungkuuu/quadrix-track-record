/**
 * keeper/set-bidder.mjs after a mined setBidder (2026-10-01): isBidder and
 * the block's time are read AT the receipt's block, repeated while a lagging
 * node lacks it, and a read that never answers comes back null instead of
 * throwing — the caller writes keeper/bidder-log.jsonl first, then stops.
 *
 *   node --test keeper/test/set-bidder-readback.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { READ_TIMING } from '../readback.mjs';
import { readBackAfterReceipt } from '../set-bidder.mjs';
import { FakeChain } from './fake-chain.mjs';

READ_TIMING.stepMs = 2;
READ_TIMING.waitMs = 300;

const V = getAddress('0x88d3b5f638fe0d331797c612a5496bd8f0491fd4');
const OWNER = getAddress('0x8c23d05ea268a9c183ee033cf07cfec38d0f7902');
const BIDDER = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');

test('a lagging node: isBidder at the receipt block reads true after retries (at latest it would still say false)', async () => {
  const chain = new FakeChain({ vault: V, owner: OWNER });
  chain.lagReads = 3;
  const reader = chain.reader();
  const { receipt } = chain.send(OWNER, { address: V, functionName: 'setBidder', args: [BIDDER, true] });
  // What the old code did — readContract at latest — on the node one block behind:
  assert.equal(await reader.publicClient.readContract({ address: V, functionName: 'isBidder', args: [BIDDER] }), false);
  chain.lagNow(3);
  const rb = await readBackAfterReceipt(reader, { vault: V, bidder: BIDDER, receipt });
  assert.equal(rb.isBidderAfter, true);
  assert.equal(rb.at, new Date(Number(chain.head.timestamp) * 1000).toISOString());
  assert.deepEqual(rb.problems, []);
});

test('a node that never serves the block: nulls with the reason, no throw (the log line is still written)', async () => {
  const chain = new FakeChain({ vault: V, owner: OWNER });
  const reader = chain.reader();
  const { receipt } = chain.send(OWNER, { address: V, functionName: 'setBidder', args: [BIDDER, true] });
  chain.neverHas = receipt.blockNumber;
  const rb = await readBackAfterReceipt(reader, { vault: V, bidder: BIDDER, receipt });
  assert.equal(rb.isBidderAfter, null);
  assert.equal(rb.at, null);
  assert.equal(rb.problems.length, 2);
  assert.match(rb.problems[0], /isBidder at block \d+: no answer after/);
});
