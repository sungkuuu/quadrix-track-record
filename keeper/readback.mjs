/**
 * Reads made right after a transaction, on a load-balanced RPC.
 *
 * GIWA's public endpoint (https://sepolia-rpc.giwa.io) is load-balanced: the
 * node that returned a receipt is not necessarily the node that answers the
 * next request. On 2026-10-01 one eth_getCode right after a deployment
 * receipt came back empty (keeper/deploy-mocks.mjs, 7f932cd). A node that has
 * not yet seen the receipt's block answers a read in one of three ways:
 *   - an error: "header not found", "unknown block", a null block
 *     (viem BlockNotFoundError);
 *   - an empty answer: "0x" from eth_call or eth_getCode;
 *   - at `latest`, the state from BEFORE the transaction — a stale answer
 *     that looks exactly like a real one.
 *
 * Two rules remove all three (keeper/basket-recon.mjs, keeper/set-bidder.mjs):
 *   1. A read after a write names its block: either the receipt's own block
 *      (exact — what the transaction did), or `blockAtLeast(pc, floor)`: the
 *      newest block number the RPC reports, raised to `floor`, the highest
 *      receipt block the run has seen. The answer at a named block is the
 *      same on every node that has that block; a node without it errors or
 *      answers empty. It cannot answer stale.
 *   2. Such a read is repeated while it fails (`retryRead`), for at most
 *      READ_WAIT_MS, and then throws a message that names the block. An
 *      error and an empty answer are both "not yet"; the bound is what turns
 *      a node that never catches up into a stop instead of a hang.
 *
 * Nothing here sends a transaction.
 */
import { parseEventLogs } from 'viem';
import { MULTICALL3, sleep } from './basket-plan.mjs';

/** Same bound as deploy-mocks.mjs READBACK_WAIT_MS. */
export const READ_WAIT_MS = 30_000;
export const READ_STEP_MS = 1_000;
/** The defaults retryRead uses; the unit tests shorten them (and only they). */
export const READ_TIMING = { waitMs: READ_WAIT_MS, stepMs: READ_STEP_MS };

const NOT_YET = [
  /header not found/i,
  /unknown block/i,
  /block (?:not found|could not be found|is not available)/i,
  /could not be found/i, // viem BlockNotFoundError: 'Block at number "…" could not be found.'
  /BlockNotFound/,
  /BlockOutOfRange/i,
  /block height is/i, // anvil: "BlockOutOfRangeError: block height is X but requested was Y"
  /block number .* (?:is )?(?:greater|higher|ahead)/i,
  /returned no data \("0x"\)/i, // viem ContractFunctionZeroDataError: an eth_call answered "0x"
  /zero data \("0x"\)/i, // viem AbiDecodingZeroDataError (a Multicall3 batch answered "0x")
];

/** Why an error looks like a node that has not got the block yet (or answered empty), else null. */
export function notYetReason(e) {
  let cur = e;
  for (let i = 0; cur && i < 10; i++) {
    if (cur.name === 'BlockNotFoundError') return 'block not found';
    const text = `${cur.name ?? ''} ${cur.shortMessage ?? ''} ${cur.details ?? ''} ${cur.message ?? ''}`;
    const hit = NOT_YET.find((re) => re.test(text));
    if (hit) return (cur.shortMessage ?? cur.details ?? cur.message ?? String(cur)).split('\n')[0].slice(0, 160);
    cur = cur.cause;
  }
  return null;
}

/** retryRead gave up: `what` never got an answer inside the bound. */
export class ReadTimeout extends Error {
  constructor(what, reads, elapsedMs, last) {
    super(`${what}: no answer after ${reads} read(s) over ${(elapsedMs / 1000).toFixed(0)} s — last: ${last}`);
    this.name = 'ReadTimeout';
    this.reads = reads;
    this.elapsedMs = elapsedMs;
  }
}

const short = (e) => (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0].slice(0, 200);

/**
 * Repeat `readOnce()` until it returns, at most `waitMs` (checked between
 * reads, so one slow RPC call can stretch it). `retryIf(error)` decides
 * whether an error is worth another read (default: every error — a read has
 * no side effect); an error it rejects is rethrown at once.
 * Returns { value, reads, elapsedMs }.
 */
export async function retryRead(readOnce, { what = 'read', waitMs = READ_TIMING.waitMs, stepMs = READ_TIMING.stepMs, now = Date.now, wait = sleep, retryIf = () => true, onRetry = null } = {}) {
  const t0 = now();
  for (let reads = 1; ; reads++) {
    try {
      return { value: await readOnce(reads), reads, elapsedMs: now() - t0 };
    } catch (e) {
      if (!retryIf(e)) throw e;
      const elapsedMs = now() - t0;
      if (elapsedMs >= waitMs) throw new ReadTimeout(what, reads, elapsedMs, short(e));
      if (onRetry) onRetry(e, reads);
      await wait(Math.min(stepMs, waitMs - elapsedMs));
    }
  }
}

/** The plain reader (basket-plan.mjs makeReader), plus `read(contract)`: every read at `latest`. */
export function latestReader(reader) {
  return { ...reader, blockNumber: null, read: (c) => reader.publicClient.readContract(c) };
}

/** Batches made by pinned readers in this process (they share one pace). */
let pinnedBatches = 0;

/**
 * A reader of the same shape as basket-plan.mjs makeReader's — `batch`,
 * `publicClient.getBlock()`, so readVault(reader, vault) works unchanged —
 * plus `read(contract)`, with every read at `blockNumber`. Its batches are
 * paced like the plain reader's (`reader.pace` before every batch but the
 * first; the public endpoint rate-limits); `read` is a single direct call.
 */
export function pinnedReader(reader, blockNumber) {
  const pc = reader.publicClient;
  async function batch(contracts) {
    if (contracts.length === 0) return [];
    if (pinnedBatches++ > 0 && reader.pace > 0) await sleep(reader.pace);
    if (reader.hasMulticall) return pc.multicall({ contracts, multicallAddress: MULTICALL3, allowFailure: false, batchSize: 0, blockNumber });
    const out = [];
    for (const c of contracts) out.push(await pc.readContract({ ...c, blockNumber }));
    return out;
  }
  const publicClient = Object.create(pc, {
    getBlock: { value: (args = {}) => pc.getBlock(args.blockNumber != null || args.blockHash || args.blockTag ? args : { ...args, blockNumber }) },
  });
  return { ...reader, publicClient, batch, blockNumber, read: (c) => pc.readContract({ ...c, blockNumber }) };
}

/** The block to read at after a write: the newest the RPC reports, never below `floor`. */
export async function blockAtLeast(pc, floor) {
  const head = await pc.getBlockNumber({ cacheTime: 0 });
  return head > floor ? head : floor;
}

/** Decoded events of `eventName` in a receipt, emitted by `address`. */
export function eventsIn(receipt, abi, eventName, address) {
  const a = address.toLowerCase();
  return parseEventLogs({ abi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === a), eventName });
}
