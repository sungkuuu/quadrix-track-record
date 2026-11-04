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
 *    differently is REVISED, a failure with --strict-source (named: the line,
 *    the day, both sha256); a line whose sha256 the exchange still serves but
 *    whose close is not those bars' fails always.
 * V2 the anchors' sender: with an RPC every qVOL anchor must be a self-send
 *    from the address that sent the inception decision's anchor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toHex } from 'viem';
import { canonicalMinuteText, sha256, realizedFromWindow, buildRealizedLine } from '../vol-realized.mjs';
import { readJsonl } from './vol-helpers.mjs';
import { BARS, DECISION, H, honestRecord, copyRoot, exchangeServer, rpcServer, rpcTxsOf, verifyQvol, writeJsonl, keyed } from './qvol-inforce.mjs';

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

test('V1 --refetch-bars for qVOL (red team R47 F2): every day a line names is fetched again from the exchange; a day served differently is REVISED and, with --strict-source, fails that line naming the day and both sha256; a line whose sha256 the exchange still serves but whose close is not those bars\' fails always; the same bars pass', async () => {
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

    // other bars for two recorded days: REVISED, not a failure without --strict-source …
    const old0203 = L[2].source.sha256;
    const new0203 = daySha(swapLast(BARS['2099-02-03']));
    const old0120 = L[0].sources[18][2];
    const new0120 = daySha(swapLast(BARS['2099-01-20']));
    assert.equal(L[0].sources[18][0], '2099-01-20');
    assert.equal(old0203, daySha(BARS['2099-02-03']));
    assert.notEqual(new0203, old0203);
    v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars'], { exchange: other.url });
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, new RegExp(`REVISED qvol #2 2099-02-04: source\\.day 2099-02-03 — Binance now serves 1440 row\\(s\\), close ${BARS['2099-02-03'].at(-1).o}, sha256 ${new0203}; the line records 1440 row\\(s\\), close ${L[2].window[30][1]}, sha256 ${old0203}`));
    assert.match(v.out, new RegExp(`REVISED qvol #0 2099-02-02: sources\\[18\\] 2099-01-20 — .* sha256 ${new0120}; .* sha256 ${old0120}`));
    assert.match(v.out, /re-fetched 31 day\(s\) unchanged/);
    assert.match(v.out, /VERIFIED .* 2 REVISED day\(s\)/);
    // … and a failure of those two lines with --strict-source, each naming its day and both sha256
    v = await verifyQvol(x.tr, ['--recompute-only', '--refetch-bars', '--strict-source'], { exchange: other.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [
      `FAIL  QVOL #0 2099-02-02: sources[18] 2099-01-20 revised (--strict-source): Binance now serves sha256 ${new0120}, the line records ${old0120}`,
      `FAIL  QVOL #2 2099-02-04: source.day 2099-02-03 revised (--strict-source): Binance now serves sha256 ${new0203}, the line records ${old0203}`,
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
    assert.deepEqual(fails(v.out), [`FAIL  QVOL #2 2099-02-04: source.day 2099-02-03 revised (--strict-source): Binance now serves sha256 ${old0203}, the line records ${new0203}`]);

    // a line appended by hand, self-consistent (red team PoC 4 a): a made-up close and a made-up sha256 → REVISED, a failure with --strict-source
    const a = copyRoot(x);
    const forged = handLine(L[2], { close: L[2].window[30][1] * 1.5, sha: H('bars that never existed') });
    writeJsonl(a.rec, [...L, forged]);
    v = await verifyQvol(a.tr, ['--recompute-only']);
    assert.equal(v.code, 0, v.out); // the record alone cannot tell
    v = await verifyQvol(a.tr, ['--recompute-only', '--refetch-bars', '--strict-source'], { exchange: honest.url });
    assert.equal(v.code, 1, v.out);
    assert.deepEqual(fails(v.out), [`FAIL  QVOL #3 2099-02-05: source.day 2099-02-04 revised (--strict-source): Binance now serves sha256 ${daySha(BARS['2099-02-04'])}, the line records ${H('bars that never existed')}`]);
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
