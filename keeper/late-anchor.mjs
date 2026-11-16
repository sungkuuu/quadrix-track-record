/**
 * Late anchors for the paper-index series (keeper/paper-index.mjs).
 *
 * A record line is appended and committed before its anchor is sent, so a
 * failed anchor send leaves a line without an entry in the anchors file
 * (Triens #53, 2026-11-16). Nothing sent it again: the anchor ran only right
 * after a new line was written. Now every anchoring run first anchors each
 * line whose seq has no anchor entry, the way keeper/leverage-index.mjs does
 * ("a line written by an earlier run but not anchored is anchored first").
 *
 * The entry has the shape of every other entry, {date, seq, headHash,
 * txHash}, with `date` the LINE's own date, not the run's. scripts/verify.mjs
 * matches an entry to its line by seq, then checks headHash against the
 * line's hash and the transaction's calldata against `{prefix}{headHash}`;
 * scripts/watchdog-series.mjs looks for a txHash under each line's seq.
 */
import fs from 'node:fs';
import { toHex } from 'viem';
import { sendNonceSafe } from './nonce-race.mjs';

export function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The record lines whose seq has no entry in `anchors`, in file order. */
export function unanchoredLines(records, anchors) {
  const done = new Set(anchors.map((a) => a.seq));
  return records.filter((r) => !done.has(r.seq));
}

/** The anchors-file entry for a line anchored in `txHash`. */
export function anchorEntry(line, txHash) {
  return { date: line.date, seq: line.seq, headHash: line.hash, txHash };
}

/**
 * Anchors every unanchored line of `recordsPath`, oldest first, as a 0-value
 * self-send carrying `{prefix}{line.hash}` — the same transaction as the
 * anchor of a new line — and appends its entry once the receipt is in.
 * Returns the entries written. A send or receipt error is thrown; the lines
 * already anchored in this call keep their entries.
 */
export async function anchorUnanchored({ recordsPath, anchorsPath, prefix, wallet, publicClient, address, log = console.log, wait }) {
  const todo = unanchoredLines(readJsonl(recordsPath), readJsonl(anchorsPath));
  const written = [];
  for (const line of todo) {
    log(`#${line.seq} ${line.date} has no anchor — anchoring it first (late anchor)`);
    const hash = await sendNonceSafe(
      () => wallet.sendTransaction({ to: address, value: 0n, data: toHex(prefix + line.hash) }),
      wait ? { wait } : {}
    );
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`late anchor of #${line.seq} ${line.date} reverted on chain (tx ${hash})`);
    const entry = anchorEntry(line, hash);
    fs.appendFileSync(anchorsPath, JSON.stringify(entry) + '\n');
    written.push(entry);
    log(`  anchored #${line.seq} ${line.date} on GIWA Sepolia: ${hash} (block ${rc.blockNumber})`);
  }
  return written;
}
