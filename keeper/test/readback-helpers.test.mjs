/**
 * keeper/readback.mjs — the read-after-write helpers (2026-10-01: an
 * eth_getCode right after a receipt came back empty from the load-balanced
 * public RPC). No network: fake clients and a fake clock.
 *
 *   node --test keeper/test/readback-helpers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockNotFoundError } from 'viem';
import { retryRead, notYetReason, pinnedReader, latestReader, blockAtLeast, ReadTimeout, READ_WAIT_MS } from '../readback.mjs';

function clock() {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
}
const rpc = (details) => Object.assign(new Error(`RPC Request failed.\n\nDetails: ${details}`), { shortMessage: 'RPC Request failed.', details });
const wrapped = (inner) => Object.assign(new Error('The contract function "pendingRegistryChange" reverted.'), { shortMessage: 'wrapped', cause: { shortMessage: 'call failed', cause: inner } });

test('notYetReason: a node without the block, or an empty answer, is "not yet"; a revert is not', () => {
  assert.ok(notYetReason(new BlockNotFoundError({ blockNumber: 7n })));
  assert.ok(notYetReason(rpc('header not found')));
  assert.ok(notYetReason(wrapped(rpc('header not found'))), 'found down the cause chain');
  assert.ok(notYetReason(rpc('unknown block')));
  assert.ok(notYetReason(new Error('BlockOutOfRangeError: block height is 10 but requested was 11')));
  assert.ok(notYetReason(new Error('The contract function "owner" returned no data ("0x").')));
  assert.ok(notYetReason(new Error('Cannot decode zero data ("0x") with ABI parameters.')));
  const rev = Object.assign(new Error('reverted'), { shortMessage: 'The contract function "fill" reverted with the following reason:\nAuctionClosed', cause: { name: 'ContractFunctionRevertedError', reason: 'AuctionClosed', shortMessage: 'AuctionClosed' } });
  assert.equal(notYetReason(rev), null);
  assert.equal(notYetReason(new Error('nonce too low')), null);
});

test('retryRead: answers at the first read that succeeds', async () => {
  const c = clock();
  let n = 0;
  const r = await retryRead(async () => { n++; if (n < 4) throw rpc('header not found'); return 42; }, { ...c, stepMs: 1000 });
  assert.deepEqual([r.value, r.reads, r.elapsedMs], [42, 4, 3000]);
});

test('retryRead: bounded — a node that never catches up throws ReadTimeout naming the read', async () => {
  const c = clock();
  let n = 0;
  await assert.rejects(
    retryRead(async () => { n++; throw new BlockNotFoundError({ blockNumber: 99n }); }, { ...c, what: 'pending change at block 99' }),
    (e) => e instanceof ReadTimeout && /pending change at block 99: no answer after 31 read\(s\) over 30 s/.test(e.message) && /could not be found/.test(e.message),
  );
  assert.equal(n, 31); // reads at 0, 1, …, 30 s
  assert.equal(READ_WAIT_MS, 30_000);
});

test('retryRead: an error retryIf rejects is thrown at once (a revert is final)', async () => {
  const c = clock();
  let n = 0;
  const rev = new Error('reverted: NoPendingChange');
  await assert.rejects(retryRead(async () => { n++; throw rev; }, { ...c, retryIf: (e) => notYetReason(e) != null }), (e) => e === rev);
  assert.equal(n, 1);
});

/** A fake public client that records the block every call names. */
function fakePc({ head = 100n } = {}) {
  const calls = [];
  return {
    calls,
    async multicall(p) { calls.push(['multicall', p.blockNumber, p.contracts.length]); return p.contracts.map((c) => `${c.functionName}@${p.blockNumber ?? 'latest'}`); },
    async readContract(p) { calls.push(['readContract', p.blockNumber, p.functionName]); return `${p.functionName}@${p.blockNumber ?? 'latest'}`; },
    async getBlock(p = {}) { calls.push(['getBlock', p.blockNumber]); return { number: p.blockNumber ?? head, timestamp: 1n }; },
    async getBlockNumber(p) { calls.push(['getBlockNumber', p?.cacheTime]); return head; },
  };
}

test('pinnedReader: batch, read and getBlock() all name the block; a getBlock with its own block passes through', async () => {
  const pc = fakePc();
  const r = pinnedReader({ publicClient: pc, hasMulticall: true, pace: 0 }, 77n);
  assert.deepEqual(await r.batch([{ functionName: 'owner' }, { functionName: 'keeper' }]), ['owner@77', 'keeper@77']);
  assert.equal(await r.read({ functionName: 'refPrice' }), 'refPrice@77');
  assert.equal((await r.publicClient.getBlock()).number, 77n);
  assert.equal((await r.publicClient.getBlock({ blockNumber: 5n })).number, 5n);
  assert.deepEqual(pc.calls.map((c) => c[1]), [77n, 77n, 77n, 5n]);
  // Without Multicall3 (a fresh anvil) each read is a readContract at the block.
  const pc2 = fakePc();
  const r2 = pinnedReader({ publicClient: pc2, hasMulticall: false, pace: 0 }, 9n);
  assert.deepEqual(await r2.batch([{ functionName: 'a' }, { functionName: 'b' }]), ['a@9', 'b@9']);
  // latestReader names no block (the path before a run's first receipt).
  const pc3 = fakePc();
  assert.equal(await latestReader({ publicClient: pc3 }).read({ functionName: 'owner' }), 'owner@latest');
});

test('blockAtLeast: the RPC head, never below the floor (a lagging head is raised to it)', async () => {
  assert.equal(await blockAtLeast(fakePc({ head: 120n }), 100n), 120n);
  assert.equal(await blockAtLeast(fakePc({ head: 99n }), 100n), 100n);
  const pc = fakePc();
  await blockAtLeast(pc, 0n);
  assert.deepEqual(pc.calls[0], ['getBlockNumber', 0], 'uncached head');
});

test('eventsIn: only the named emitter\'s events — a same-signature event from another contract in the receipt is not ours', async () => {
  const { encodeEventTopics, encodeAbiParameters, parseAbi } = await import('viem');
  const { eventsIn } = await import('../readback.mjs');
  const abi = parseAbi(['event AuctionOpened(uint256 indexed id, address indexed sellAsset, address indexed buyAsset, uint256 sellAmount, uint64 duration)']);
  const VAULT = '0x88D3b5f638fE0d331797C612a5496bD8f0491FD4';
  const OTHER = '0x1111111111111111111111111111111111111111';
  const A = '0x2222222222222222222222222222222222222222';
  const B = '0x3333333333333333333333333333333333333333';
  const log = (address, id) => ({
    address, topics: encodeEventTopics({ abi, eventName: 'AuctionOpened', args: { id, sellAsset: A, buyAsset: B } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [5n, 1800n]), blockNumber: 1n, logIndex: 0, transactionHash: `0x${'a'.repeat(64)}`,
  });
  // The other contract's log comes FIRST, so taking [0] of an unfiltered parse would name its id.
  const receipt = { logs: [log(OTHER, 99n), log(VAULT.toLowerCase(), 7n)] };
  const got = eventsIn(receipt, abi, 'AuctionOpened', VAULT);
  assert.equal(got.length, 1);
  assert.equal(got[0].args.id, 7n);
});
