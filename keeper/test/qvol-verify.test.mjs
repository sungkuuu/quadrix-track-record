/**
 * scripts/verify.mjs --series qvol against the exchange and the chain (red team
 * R47 F2 and F3), on records the keeper writes in force from SYNTHETIC bars, a
 * fake exchange and a fake node, with a key generated here. No network: the
 * child verifier's requests to data-api.binance.vision go to a local fake
 * exchange, its RPC is a local server (keeper/test/qvol-inforce.mjs).
 *
 *   node --test keeper/test/qvol-verify.test.mjs
 *
 * V1 --refetch-bars: every day a line names is fetched again and its 1-minute
 *    text's sha256 and close compared with the line: a day the exchange serves
 *    differently fails (named: the line, the day, both sha256), REVISED only
 *    with --allow-source-revision; a line whose sha256 the exchange still
 *    serves but whose close is not those bars' fails always.
 * V2 the anchors' sender: with an RPC every qVOL anchor must be a self-send
 *    from the address that sent the inception decision's anchor.
 * V3 --keeper: the key from outside the repository — a forger who anchors the
 *    decision and every line again with a key of their own fails.
 * V4 the decision's anchor in time: no later than its effective day, and
 *    before the first line's anchor.
 * V5 the sender cannot be read (no decision in the ledger, no decision
 *    transaction on chain): a failure, not a pass.
 * V6 --allow-rehearsal binds a first line that is not a dry-run line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toHex } from 'viem';
import { canonicalMinuteText, sha256, realizedFromWindow, buildRealizedLine } from '../vol-realized.mjs';
import { readJsonl } from './vol-helpers.mjs';
import { BARS, DECISION, E, H, honestRecord, copyRoot, exchangeServer, rpcServer, rpcTxsOf, verifyQvol, writeJsonl, keyed, rechain } from './qvol-inforce.mjs';

const daySha = (minutes) => sha256(canonicalMinuteText(minutes));
/** A day's bars with the open and the close of its 23:59 bar swapped (red team PoC 1 c): the day's close changes. */
const swapLast = (minutes) => minutes.map((m, i) => (i === minutes.length - 1 ? { ...m, o: m.c, c: m.o } : m));
const fails = (out) => out.split('\n').filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim());
const AFTER = Date.parse('2099-02-06T00:30:00Z'); // the exchange's clock when a reader fetches again: every recorded day has ended

/** A line #3 for 2099-02-05 appended by hand on top of `prev`, self-consistent: value from the window it carries. */
function handLine(prev, { close, sha }) {
  const window = [...prev.window.slice(1), ['2099-02-04', close]];
  const { variance, value, returns } = realizedFromWindow(window, null, { windowDays: 30, yearDays: 365 });
  return buildRealizedLine({
    prev, date: '2099-02-05', observedAt: '2099-02-05T00:25:00.000Z', value, variance, window, carriedFrom: null, returns,
    source: { host: 'data-api.binance.vision', symbol: 'BTCUSDT', interval: '1m', day: '2099-02-04', rows: 1440, sha256: sha, lastBar: '23:59', finalBy: '2099-02-05T00:00', fetchedAt: '2099-02-05T00:25:00.000Z' },
    sources: null, gaps: null, gapAccepted: null, rule: prev.rule, run: 'local', shadow: false, inception: null,
  });
}

test('V1 --refetch-bars for qVOL (red team R47 F2): every day a line names is fetched again from the exchange; a day served differently fails that line naming the day and both sha256 (REVISED only with --allow-source-revision); a line whose sha256 the exchange still serves but whose close is not those bars\' fails always; the same bars pass', async () => {
  const x = await honestRecord(3, { anchor: false }); // 2099-02-02 … 02-04, from BARS
  const L = x.lines;
  const honest = await exchangeServer(BARS, AFTER);
  // 02-03 (the day of line #2) and 01-20 (a window day of the first line, sources[18]) served with the 23:59 open and close swapped
  const other = await exchangeServer({ ...BARS, '2099-02-03': swapLast(BARS['2099-02-03']), '2099-01-20': swapLast(BARS['2099-01-20']) }, AFTER);
  try {
    // the same bars: every day unchanged — 31 days of the first line and the day of each later line
    let v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars', '--strict-source'], { exchange: honest.url });
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /re-fetched 33 day\(s\) unchanged/);
    assert.equal(honest.calls.filter((c) => c.startsWith('/api/v3/klines')).length, 33 * 2); // each day once, in the keeper's two pages
    assert.doesNotMatch(v.out, /REVISED/);

    // other bars for two recorded days: REVISED, not a failure, only with --allow-source-revision …
    const old0203 = L[2].source.sha256;
    const new0203 = daySha(swapLast(BARS['2099-02-03']));
    const old0120 = L[0].sources[18][2];
    const new0120 = daySha(swapLast(BARS['2099-01-20']));
    assert.equal(L[0].sources[18][0], '2099-01-20');
    assert.equal(old0203, daySha(BARS['2099-02-03']));
    assert.notEqual(new0203, old0203);
    v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars', '--allow-source-revision'], { exchange: other.url });
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, new RegExp(`REVISED qvol #2 2099-02-04: source\\.day 2099-02-03 — Binance now serves 1440 row\\(s\\), close ${BARS['2099-02-03'].at(-1).o}, sha256 ${new0203}; the line records 1440 row\\(s\\), close ${L[2].window[30][1]}, sha256 ${old0203}`));
    assert.match(v.out, new RegExp(`REVISED qvol #0 2099-02-02: sources\\[18\\] 2099-01-20 — .* sha256 ${new0120}; .* sha256 ${old0120}`));
    assert.match(v.out, /re-fetched 31 day\(s\) unchanged/);
    assert.match(v.out, /VERIFIED .* 2 REVISED day\(s\)/);
    // … and a failure of those two lines with --strict-source, each naming its day and both sha256
    v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars', '--strict-source'], { exchange: other.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [
      `FAIL  QVOL #0 2099-02-02: sources[18] 2099-01-20 revised: Binance now serves sha256 ${new0120}, the line records ${old0120} (--strict-source)`,
      `FAIL  QVOL #2 2099-02-04: source.day 2099-02-03 revised: Binance now serves sha256 ${new0203}, the line records ${old0203} (--strict-source)`,
    ]);
    // … and without either flag: for qVOL a source difference fails by default (red team M5: a forged sha256 is not "REVISED")
    v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars'], { exchange: other.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [
      `FAIL  QVOL #0 2099-02-02: sources[18] 2099-01-20 revised: Binance now serves sha256 ${new0120}, the line records ${old0120} (a failure for qVOL unless --allow-source-revision)`,
      `FAIL  QVOL #2 2099-02-04: source.day 2099-02-03 revised: Binance now serves sha256 ${new0203}, the line records ${old0203} (a failure for qVOL unless --allow-source-revision)`,
    ]);

    // a record written from false bars (02-03 served with the 23:59 open and close swapped on both fetches): the record alone
    // passes — recomputation from a line's own closes cannot see them — the exchange's bars do not
    const falseBars = { ...BARS, '2099-02-03': swapLast(BARS['2099-02-03']) };
    const y = await honestRecord(3, { anchor: false, bars: falseBars });
    assert.notEqual(y.lines[2].value, L[2].value);
    v = await verifyQvol(y.tr, ['--recompute-only']);
    assert.equal(v.code, 0, v.out);
    v = await verifyQvol(y.tr, ['--recompute-only', '--refetch-bars', '--strict-source'], { exchange: honest.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [`FAIL  QVOL #2 2099-02-04: source.day 2099-02-03 revised: Binance now serves sha256 ${old0203}, the line records ${new0203} (--strict-source)`]);

    // a line appended by hand, self-consistent (red team PoC 4 a): a made-up close and a made-up sha256 → REVISED, a failure with --strict-source
    const a = copyRoot(x);
    const forged = handLine(L[2], { close: L[2].window[30][1] * 1.5, sha: H('bars that never existed') });
    writeJsonl(a.rec, [...L, forged]);
    v = await verifyQvol(a.tr, ['--recompute-only']);
    assert.equal(v.code, 0, v.out); // the record alone cannot tell
    v = await verifyQvol(a.tr, ['--recompute-only', '--refetch-bars', '--strict-source'], { exchange: honest.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [`FAIL  QVOL #3 2099-02-05: source.day 2099-02-04 revised: Binance now serves sha256 ${daySha(BARS['2099-02-04'])}, the line records ${H('bars that never existed')} (--strict-source)`]);
    // … and the true sha256 of the day kept with a made-up close: the line contradicts the bars it names — a failure even without --strict-source
    const b = copyRoot(x);
    const forged2 = handLine(L[2], { close: L[2].window[30][1] * 1.5, sha: daySha(BARS['2099-02-04']) });
    writeJsonl(b.rec, [...L, forged2]);
    v = await verifyQvol(b.tr, ['--recompute-only']);
    assert.equal(v.code, 0, v.out);
    v = await verifyQvol(b.tr, ['--recompute-only', '--refetch-bars'], { exchange: honest.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [`FAIL  QVOL #3 2099-02-05: source.day 2099-02-04: Binance serves the bars whose sha256 the line records (${daySha(BARS['2099-02-04'])}) — 1440 row(s), close ${BARS['2099-02-04'].at(-1).c} — but the line says 1440 row(s), close ${forged2.window[30][1]}: the line contradicts the bars it names`]);
    assert.doesNotMatch(v.out, /REVISED/);
  } finally {
    await honest.close();
    await other.close();
  }
  // without the exchange (the child is offline): every day is a failure, never a pass
  const v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars']);
  assert.equal(v.code, 1);
  assert.match(fails(v.out)[0], /^FAIL {2}QVOL #0 2099-02-02: --refetch-bars: offline \(test\)/);
});

test('V2 the anchors\' sender (red team R47 F3): with an RPC every qVOL anchor must be a self-send from the address that sent the inception decision\'s anchor — another sender, a transaction to another address or an answer without a sender fails, naming the anchor and both addresses; the keeper\'s own anchors pass', async () => {
  const x = await honestRecord(3); // anchored on the fake node by the keeper's key
  const L = x.lines;
  const other = keyed().address.toLowerCase();
  const run = async (txs, records = null) => {
    const y = copyRoot(x);
    if (records) {
      writeJsonl(y.rec, records.lines);
      writeJsonl(y.anc, records.anchors);
    }
    const rpc = await rpcServer(txs);
    try {
      return await verifyQvol(y.tr, ['--rpc', rpc.url]);
    } finally {
      await rpc.close();
    }
  };
  const label = `the sender of decision ${DECISION}'s anchor 0xdddddddddddd…`;
  const anchors = readJsonl(x.anc);
  // the keeper's anchors, the decision anchored by the same key: PASS, each anchor printed with its sender
  let v = await run(rpcTxsOf(x));
  assert.equal(v.code, 0, v.out);
  for (const a of anchors) assert.match(v.out, new RegExp(`ok {4}seq ${a.seq} ${a.date} anchored in ${a.txHash.slice(0, 14)}… \\(block ${1000 + a.seq}, .*, self-send from ${x.address}\\)`));
  // the decision anchored by another key: every line's anchor fails, naming both addresses
  v = await run(rpcTxsOf(x, { decisionFrom: other }));
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), anchors.map((a) => `FAIL  anchor seq ${a.seq} ${a.date} (${a.txHash.slice(0, 14)}…): sent by ${x.address}, not by ${other}, ${label}`));
  // a self-consistent line appended by hand and anchored by the forger's own key (red team PoC 4 a): only that anchor fails
  const forger = keyed().address.toLowerCase();
  const forged = handLine(L[2], { close: L[2].window[30][1] * 1.5, sha: H('bars that never existed') });
  const forgedTx = `0x${H(`forged anchor ${forged.hash}`)}`;
  const txs = rpcTxsOf(x);
  txs.set(forgedTx, { input: toHex(`qxpi-qvol:${forged.hash}`), block: 1003, time: Date.parse(forged.observedAt) / 1000 + 60, from: forger, to: forger });
  v = await run(txs, { lines: [...L, forged], anchors: [...anchors, { date: forged.date, seq: 3, headHash: forged.hash, txHash: forgedTx }] });
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [`FAIL  anchor seq 3 2099-02-05 (${forgedTx.slice(0, 14)}…): sent by ${forger}, not by ${x.address}, ${label}`]);
  // the keeper's address, but not a self-send; and an answer that names no sender
  const t1 = rpcTxsOf(x);
  t1.get(anchors[1].txHash).to = other;
  delete t1.get(anchors[2].txHash).from;
  v = await run(t1);
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [
    `FAIL  anchor seq 1 2099-02-03 (${anchors[1].txHash.slice(0, 14)}…): sent by ${x.address} to ${other} — a qVOL anchor is a self-send from ${x.address}`,
    `FAIL  anchor seq 2 2099-02-04 (${anchors[2].txHash.slice(0, 14)}…): sent by no sender to ${x.address} — a qVOL anchor is a self-send from ${x.address}`,
  ]);
  // the decision's anchor answered without a sender: the anchors' sender cannot be checked — a failure, not a pass
  const t2 = rpcTxsOf(x);
  delete t2.get(x.entry.txHash).from;
  v = await run(t2);
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [`FAIL  QVOL: decision ${DECISION}: the answer for ${x.entry.txHash} names no sender — the anchors' sender cannot be checked`]);
  // --recompute-only reads no chain: the sender is not checked there (and the record passes)
  v = await verifyQvol(x.tr, ['--recompute-only']);
  assert.equal(v.code, 0, v.out);
  assert.ok(fs.existsSync(x.anc));
});

/** verify.mjs --rpc on a copy of `x` with the chain `txs`; `edit(y)` may change the copy's files first. */
async function onChain(x, txs, args = [], edit = null) {
  const y = copyRoot(x);
  if (edit) edit(y);
  const rpc = await rpcServer(txs);
  try {
    return await verifyQvol(y.tr, ['--rpc', rpc.url, ...args]);
  } finally {
    await rpc.close();
  }
}
/**
 * The forger's chain (final review F-V1): the decision anchored again by another key, later, and every line
 * anchored again by that key — calldata, self-sends and block order all as the keeper's would be. The copy's
 * decisions.jsonl and anchors file name the forger's transactions.
 */
function forgedWorld(x, forger) {
  const lines = readJsonl(x.rec);
  const decTx = `0x${H(`forged decision ${x.entry.sha256}`)}`;
  const txs = new Map([[decTx, { input: toHex(`qxdec:${x.entry.sha256}`), block: 2000, time: Date.parse('2099-02-06T00:00:00Z') / 1000, from: forger, to: forger }]]);
  const anchors = lines.map((l) => {
    const txHash = `0x${H(`forged anchor ${l.hash}`)}`;
    txs.set(txHash, { input: toHex(`qxpi-qvol:${l.hash}`), block: 2001 + l.seq, time: Date.parse('2099-02-06T00:00:00Z') / 1000 + 60 * (l.seq + 1), from: forger, to: forger });
    return { date: l.date, seq: l.seq, headHash: l.hash, txHash };
  });
  const edit = (y) => {
    writeJsonl(path.join(y.tr, 'decisions.jsonl'), [{ ...x.entry, txHash: decTx }]);
    writeJsonl(y.anc, anchors);
  };
  return { txs, edit, decTx };
}
const notices = (out) => out.split('\n').filter((l) => l.startsWith('notice: '));

test('V3 --keeper (final review F-V1): the keeper key from outside the repository — a forger who anchors the decision and every line again with a key of their own passes the sender check without it (the decision anchor named in the repository is theirs) and fails with it; the keeper\'s own record passes with it; without --keeper one notice line on stderr says where the key came from', async () => {
  const x = await honestRecord(3);
  const anchors = readJsonl(x.anc);
  // the keeper's record, pinned: PASS, no notice
  let v = await onChain(x, rpcTxsOf(x), ['--keeper', x.address]);
  assert.equal(v.code, 0, v.out);
  assert.deepEqual(notices(v.out), []);
  // the same record, not pinned: PASS, and exactly one notice line
  v = await onChain(x, rpcTxsOf(x));
  assert.equal(v.code, 0, v.out);
  assert.deepEqual(notices(v.out), [`notice: QVOL: the keeper address is taken from the anchor of decision ${DECISION} named in this repository's decisions.jsonl; pass --keeper <the address printed on the decision page> to pin it`]);
  // pinned to another key: the decision's anchor and every line anchor fail, naming both addresses
  const other = keyed().address.toLowerCase();
  v = await onChain(x, rpcTxsOf(x), ['--keeper', other]);
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [
    `FAIL  QVOL: decision ${DECISION}: its anchor ${x.entry.txHash} was sent by ${x.address}, not by the keeper ${other} given with --keeper`,
    ...anchors.map((a) => `FAIL  anchor seq ${a.seq} ${a.date} (${a.txHash.slice(0, 14)}…): sent by ${x.address}, not by ${other}, the keeper key given with --keeper`),
  ]);
  // the forger's world: with --keeper every anchor is someone else's
  const forger = keyed().address.toLowerCase();
  const w = forgedWorld(x, forger);
  v = await onChain(x, w.txs, ['--keeper', x.address], w.edit);
  assert.equal(v.code, 1);
  const f = fails(v.out);
  assert.ok(f.includes(`FAIL  QVOL: decision ${DECISION}: its anchor ${w.decTx} was sent by ${forger}, not by the keeper ${x.address} given with --keeper`), f.join('\n'));
  for (const l of x.lines) assert.ok(f.some((s) => s.startsWith(`FAIL  anchor seq ${l.seq} ${l.date} `) && s.endsWith(`sent by ${forger}, not by ${x.address}, the keeper key given with --keeper`)), `#${l.seq}: ${f.join('\n')}`);
  // … and a bad --keeper value is refused before anything is read
  v = await onChain(x, rpcTxsOf(x), ['--keeper', '0x1234']);
  assert.equal(v.code, 2);
  assert.match(v.out, /--keeper must be a 20-byte 0x address/);
});

test('V4 the decision\'s anchor in time (final review F-V1): with an RPC it must be in a block no later than the end of the decision\'s effective day and before the first line\'s anchor — a decision anchored again later fails even without --keeper', async () => {
  const x = await honestRecord(3);
  const anchors = readJsonl(x.anc);
  // the forger's world without --keeper: every sender agrees with the (forged) decision anchor, but that anchor is late
  const forger = keyed().address.toLowerCase();
  const w = forgedWorld(x, forger);
  let v = await onChain(x, w.txs, [], w.edit);
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [`FAIL  QVOL: decision ${DECISION}: its anchor is in block 2000 at 2099-02-06T00:00:00.000Z, after its effective day ${E} ended — a decision is anchored on or before its effective day`]);
  // anchored on the last second of its effective day: still on time
  let txs = rpcTxsOf(x);
  txs.get(x.entry.txHash).time = Date.parse(`${E}T23:59:59Z`) / 1000;
  v = await onChain(x, txs);
  assert.equal(v.code, 0, v.out);
  // one second later: late
  txs = rpcTxsOf(x);
  txs.get(x.entry.txHash).time = Date.parse(`${E}T23:59:59Z`) / 1000 + 1;
  v = await onChain(x, txs);
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [`FAIL  QVOL: decision ${DECISION}: its anchor is in block 900 at 2099-02-02T00:00:00.000Z, after its effective day ${E} ended — a decision is anchored on or before its effective day`]);
  // on time, but in a block after the first line's anchor
  txs = rpcTxsOf(x);
  txs.get(x.entry.txHash).block = 1000 + anchors.length + 5;
  v = await onChain(x, txs);
  assert.equal(v.code, 1);
  assert.deepEqual(fails(v.out), [`FAIL  anchor seq 0 ${anchors[0].date} (${anchors[0].txHash.slice(0, 14)}…): block 1000 is not after the decision's anchor (block ${1000 + anchors.length + 5}) — the decision is anchored before the first line`]);
});

test('V5 the anchors\' sender cannot be read — the first line\'s decision missing from decisions.jsonl, or its anchor transaction not on chain: each fails closed, never a pass', async () => {
  const x = await honestRecord(3);
  // no decision in the ledger
  let v = await onChain(x, rpcTxsOf(x), [], (y) => fs.writeFileSync(path.join(y.tr, 'decisions.jsonl'), ''));
  assert.equal(v.code, 1);
  assert.ok(fails(v.out).includes(`FAIL  QVOL: the anchors' sender cannot be checked — the first line's decision ${DECISION} is not in decisions.jsonl`), v.out);
  // the decision's anchor transaction not on chain
  const txs = rpcTxsOf(x);
  txs.delete(x.entry.txHash);
  v = await onChain(x, txs);
  assert.equal(v.code, 1);
  assert.ok(fails(v.out).includes(`FAIL  QVOL: decision ${DECISION}: anchor tx ${x.entry.txHash} not found on chain — the anchors' sender cannot be checked`), v.out);
  // the same with --keeper: still a failure
  v = await onChain(x, txs, ['--keeper', x.address]);
  assert.equal(v.code, 1);
  assert.ok(fails(v.out).includes(`FAIL  QVOL: decision ${DECISION}: anchor tx ${x.entry.txHash} not found on chain — the anchors' sender cannot be checked`), v.out);
});

test('V6 --allow-rehearsal binds every first line that is not a dry-run line: "shadow": false is bound to its decision and rulebook (a wrong effective date fails); "shadow": true is a dry run and is not', async () => {
  const x = await honestRecord(3, { anchor: false });
  const wrongDate = (y) => {
    const led = readJsonl(path.join(y.tr, 'decisions.jsonl'));
    writeJsonl(path.join(y.tr, 'decisions.jsonl'), [{ ...led[0], effectiveFrom: '2099-02-02' }]);
  };
  const run = async (shadow) => {
    const y = copyRoot(x);
    writeJsonl(y.rec, rechain(x.lines.map((l) => ({ ...l, shadow }))));
    wrongDate(y);
    return verifyQvol(y.tr, ['--recompute-only', '--allow-rehearsal']);
  };
  const v = await run(false);
  assert.equal(v.code, 1);
  assert.ok(fails(v.out).some((s) => s.includes('inception decision is effective from 2099-02-02, so the first line is dated 2099-02-03, not 2099-02-02')), v.out);
  const d = await run(true);
  assert.ok(!fails(d.out).some((s) => s.includes('inception decision is effective from')), d.out);
});
