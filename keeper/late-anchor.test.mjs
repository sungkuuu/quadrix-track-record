// node --test keeper/late-anchor.test.mjs
//
// Late anchors (keeper/late-anchor.mjs): which lines are picked, the entry
// written, and that the entry has the shape the two checkers read. No network
// and no real key: a throwaway key and a fake node
// (keeper/test/nonce-race-node.mjs). What this does NOT show is chain state —
// that a real anchor transaction exists; scripts/verify.mjs reads that from
// the chain, and only a real run can satisfy it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWalletClient, createPublicClient, parseTransaction, recoverTransactionAddress, getAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { unanchoredLines, anchorEntry, anchorUnanchored, readJsonl } from './late-anchor.mjs';
import { nonceRaceNode, chain } from './test/nonce-race-node.mjs';
import { checkSeries } from '../scripts/watchdog-series.mjs';

const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
const line = (seq, date) => ({ seq, date, observedAt: `${date}T06:49:10.000Z`, level: 100 + seq, hash: h(`line ${seq}`), prevHash: seq > 1 ? h(`line ${seq - 1}`) : null });
const entry = (l, n) => ({ date: l.date, seq: l.seq, headHash: l.hash, txHash: `0x${String(n).padStart(64, '0')}` });
const writeJsonl = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r) + '\n').join(''));

// Triens on 2026-11-16: #51 and #52 anchored, #53 written without its anchor.
const L51 = line(51, '2026-11-14');
const L52 = line(52, '2026-11-15');
const L53 = line(53, '2026-11-16');

test('selection: the last line without an anchor entry is picked, with its own date; nothing when every line is anchored', () => {
  assert.deepEqual(unanchoredLines([L51, L52, L53], [entry(L51, 1), entry(L52, 2)]), [L53]);
  assert.equal(unanchoredLines([L51, L52, L53], [entry(L51, 1), entry(L52, 2)])[0].date, '2026-11-16');
  assert.deepEqual(unanchoredLines([L51, L52, L53], [entry(L51, 1), entry(L52, 2), entry(L53, 3)]), []);
  assert.deepEqual(unanchoredLines([], []), []);
  // a gap in the middle is picked too, oldest first; anchors out of order are fine
  assert.deepEqual(unanchoredLines([L51, L52, L53], [entry(L53, 3), entry(L51, 1)]), [L52]);
  // the entry carries the line's date, seq and hash
  assert.deepEqual(anchorEntry(L53, '0xab'), { date: '2026-11-16', seq: 53, headHash: L53.hash, txHash: '0xab' });
});

test('anchorUnanchored: #53 is anchored once, after a nonce race, as a self-send of qxpi-triens:<hash>; the entry is dated 2026-11-16 and both checkers accept its shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-anchor-'));
  const recordsPath = path.join(dir, 'record-triens.jsonl');
  const anchorsPath = path.join(dir, 'anchors-triens.jsonl');
  writeJsonl(recordsPath, [L51, L52, L53]);
  writeJsonl(anchorsPath, [entry(L51, 1), entry(L52, 2)]);

  // Before: the watchdog's series check reports #53 (scripts/watchdog-series.mjs).
  const now = Date.parse('2026-11-16T12:00:00Z');
  const before = checkSeries({ dir, now, series: ['triens'] }).problems;
  assert.deepEqual(before, ['triens: line seq 53 (2026-11-16) has no anchor txHash']);

  const account = privateKeyToAccount(generatePrivateKey()); // throwaway
  const node = nonceRaceNode({ steal: 1 });
  const wallet = createWalletClient({ account, chain, transport: node.transport });
  const publicClient = createPublicClient({ chain, transport: node.transport, pollingInterval: 5 });
  const waits = [];
  const logs = [];
  const written = await anchorUnanchored({
    recordsPath, anchorsPath, prefix: 'qxpi-triens:', wallet, publicClient, address: account.address,
    log: (m) => logs.push(m), wait: async (ms) => { waits.push(ms); },
  });

  // one race, one resend under the next nonce, one landed transaction
  assert.deepEqual(node.raws.map((r) => r.accepted), [false, true]);
  assert.equal(node.raws[1].nonce, node.raws[0].nonce + 1);
  assert.deepEqual(waits, [4000]);
  const landed = node.raws[1];
  const tx = parseTransaction(landed.raw);
  assert.equal(getAddress(tx.to), account.address, 'a self-send');
  assert.equal(await recoverTransactionAddress({ serializedTransaction: landed.raw }), account.address);
  assert.equal(tx.value ?? 0n, 0n);

  // the entry: the line's own date, seq and hash, the landed transaction
  assert.deepEqual(written, [{ date: '2026-11-16', seq: 53, headHash: L53.hash, txHash: landed.hash }]);
  const anchors = readJsonl(anchorsPath);
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors.at(-1), written[0]);
  assert.deepEqual(Object.keys(anchors.at(-1)), Object.keys(anchors[0]), 'same fields, same order as the entries written on time');

  // scripts/verify.mjs, paper series (lines 363-443 at d9b0c20), file-shape part
  // only: the entry's seq names a record, its headHash is that record's hash,
  // the calldata is 0x + hex(anchorPrefix + headHash), and every record has an
  // entry. The receipt status and the transaction itself are chain reads.
  const records = readJsonl(recordsPath);
  for (const a of anchors) {
    const rec = records.find((r) => r.seq === a.seq);
    assert.ok(rec, `anchor seq ${a.seq}: no matching record`);
    assert.equal(rec.hash, a.headHash);
  }
  for (const rec of records) assert.ok(anchors.some((a) => a.seq === rec.seq), `#${rec.seq}: no anchor`);
  const expected = '0x' + Buffer.from('qxpi-triens:' + anchors.at(-1).headHash, 'utf8').toString('hex');
  assert.equal(tx.data.toLowerCase(), expected.toLowerCase());

  // After: the watchdog's series check is clean.
  assert.deepEqual(checkSeries({ dir, now, series: ['triens'] }).problems, []);

  // A second call has nothing to do and sends nothing.
  const sends = node.raws.length;
  assert.deepEqual(await anchorUnanchored({ recordsPath, anchorsPath, prefix: 'qxpi-triens:', wallet, publicClient, address: account.address, log: () => {}, wait: async () => {} }), []);
  assert.equal(node.raws.length, sends);
  assert.match(logs[0], /#53 2026-11-16 has no anchor/);
});

test('anchorUnanchored: a send that keeps failing writes no entry and throws; the line stays unanchored for the next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-anchor-'));
  const recordsPath = path.join(dir, 'record-triens.jsonl');
  const anchorsPath = path.join(dir, 'anchors-triens.jsonl');
  writeJsonl(recordsPath, [L52, L53]);
  writeJsonl(anchorsPath, [entry(L52, 2)]);
  const account = privateKeyToAccount(generatePrivateKey());
  const node = nonceRaceNode({ fail: 'execution reverted' });
  const wallet = createWalletClient({ account, chain, transport: node.transport });
  const publicClient = createPublicClient({ chain, transport: node.transport, pollingInterval: 5 });
  await assert.rejects(anchorUnanchored({ recordsPath, anchorsPath, prefix: 'qxpi-triens:', wallet, publicClient, address: account.address, log: () => {}, wait: async () => {} }));
  assert.equal(node.raws.length, 1);
  assert.deepEqual(unanchoredLines(readJsonl(recordsPath), readJsonl(anchorsPath)), [L53]);
});
