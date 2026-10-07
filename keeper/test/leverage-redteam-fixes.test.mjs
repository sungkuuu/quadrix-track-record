/**
 * The fixes made after the red team of 2026-10-05 (R47, site docs/audits/leverage-launch-2026-10-05/red-team.md)
 * and the opening rehearsal (rehearsal.md §3), each with a control that passes.
 *
 *   F02  a day is never written before it began on the runner's clock; a source stuck a day behind is a failure
 *   F03  the verifier binds a line to the rulebook JSON, this index's inception decision, the day's last bar;
 *        an empty file after the opening fails; with an RPC an anchor older than its line's day fails, and an
 *        anchor a few seconds before observedAt (two clocks) is printed, not failed
 *   F05  a mark goes only to the vault whose symbol is the ticker; a target the contract cannot reach is a failure
 *   F09  every Binance request has a time limit, body included
 *   C1   a Binance failure names the host, the day and that nothing was written
 *   C2   the refusal for an anchored decision the files no longer match does not say "not anchored"
 *
 * THROWAWAY values as in leverage-index.test.mjs (n = 120, T = 2.2, 30 bp, 6%); none is a tested value.
 *
 *   node --test keeper/test/leverage-redteam-fixes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, toHex } from 'viem';
import { run, binanceRest } from '../leverage-index.mjs';
import { sha256 } from '../leverage-step.mjs';
import { REPO, THROWAWAY_CHECK, THROWAWAY_LEVEL, synthMinutes, fakeBinance, fakeNode, tempRoot, readJsonl, listFiles, dayMs } from './leverage-helpers.mjs';

const VERIFY = path.join(REPO, 'scripts', 'verify.mjs');
const VAULT = getAddress('0x00000000000000000000000000000000000beef1');
const FILL = { check: THROWAWAY_CHECK, primary: THROWAWAY_LEVEL };
const I = '2030-05-02';
const at = (iso) => () => Date.parse(iso);

function days(first, count, { seed = 11, vol = 0.002 } = {}) {
  const out = [];
  let p0 = 30_000;
  for (let k = 0; k < count; k++) {
    const d = new Date(dayMs(first) + k * 86_400_000).toISOString().slice(0, 10);
    const ms = synthMinutes(d, { seed: seed + k, p0, vol });
    out.push(...ms);
    p0 = ms.at(-1).c;
  }
  return out;
}
function deps(root, { minutes, now, serverTime = null, key = null, node = null, logs = [], binance = null }) {
  const b = binance ?? fakeBinance({ BTCUSDT: minutes }, { serverTime: serverTime ?? (() => now()) });
  return {
    binance: b,
    d: {
      root, now, binance: b, env: key ? { KEEPER_PK: key } : {}, log: (m) => logs.push(String(m)), wait: async () => {},
      transport: node ? () => node.transport : undefined, pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 },
    },
  };
}
async function capture(fn) {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    return { code: await fn(), err: errs.join('\n') };
  } finally {
    console.error = orig;
  }
}
const vaults = (gate = { mode: 'step' }) => ({ qbtc2x: { chainId: 91342, address: VAULT, gate, deployTx: null, block: null }, qeth2x: { chainId: 91342, address: null, gate: null } });
const recPath = (root) => path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
const verify = (dir, extra = []) => spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--recompute-only', ...extra], { encoding: 'utf8' });
const rehash = (t) => {
  for (let k = 0; k < t.length; k++) {
    t[k].prevHash = k ? t[k - 1].hash : null;
    const { hash, ...rest } = t[k];
    t[k].hash = sha256(JSON.stringify(rest));
  }
  return t;
};

// ------------------------------------------------------------------ F02

test('F02a: a source clock days ahead does not make the keeper write tomorrow — only the line of the day that began on the runner\'s clock', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  const minutes = days('2030-05-01', 8);
  const logs = [];
  const r = deps(root, { minutes, now: at(`${I}T00:25:00Z`), serverTime: Date.parse('2030-05-07T00:30:00Z'), logs });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 0);
  assert.deepEqual(readJsonl(recPath(root)).map((l) => l.date), [I]);
  assert.match(logs.join('\n'), /line 2030-05-03 not written: the runner's clock .* is before 2030-05-03T00:00Z/);
  // control: on the 2030-05-07 runner clock the same source gives every day up to 05-07
  const root2 = tempRoot({ fill: FILL, inception: I });
  const r2 = deps(root2, { minutes, now: at('2030-05-07T00:31:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r2.d), 0);
  assert.equal(readJsonl(recPath(root2)).length, 6);
});

test('F02b: a source that still calls the day open a full day after it ended is a failure (exit 1), not a quiet "not final"', async () => {
  const minutes = days('2030-05-01', 3);
  const stuck = Date.parse('2030-05-01T23:00:00Z');
  for (const [now, code, pattern] of [[`${I}T05:00:00Z`, 0, null], ['2030-05-03T00:10:00Z', 1, /Binance says 2030-05-01 has not ended .* more than a day later — the source is stuck; nothing written for 2030-05-02/]]) {
    const root = tempRoot({ fill: FILL, inception: I });
    const r = deps(root, { minutes, now: at(now), serverTime: stuck });
    const out = await capture(() => run(['--index', 'qbtc2x'], r.d));
    assert.equal(out.code, code, now);
    if (pattern) assert.match(out.err, pattern);
    assert.equal(readJsonl(recPath(root)).length, 0);
  }
});

// ------------------------------------------------------------------ C1, F09

test('C1: a Binance failure names the host and the day and says nothing was written; the next run writes the day', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  const minutes = days('2030-05-01', 3);
  const down = { host: 'data-api.binance.vision', calls: [], async time() { throw new Error('fetch failed'); }, async klines() { throw new Error('fetch failed'); } };
  const r = deps(root, { minutes, now: at(`${I}T00:25:00Z`), binance: down });
  const out = await capture(() => run(['--index', 'qbtc2x'], r.d));
  assert.equal(out.code, 1);
  assert.match(out.err, /Binance \(data-api\.binance\.vision\) failed while reading the server time for 2030-05-01: fetch failed — nothing written for 2030-05-02; the next run continues from the last line/);
  assert.doesNotMatch(out.err, /\((rehearsal|red team) /, 'no internal review label in the sentence (final review F-2)');
  assert.equal(readJsonl(recPath(root)).length, 0);
  const again = deps(root, { minutes, now: at(`${I}T06:25:00Z`) });
  assert.equal(await run(['--index', 'qbtc2x'], again.d), 0);
  assert.equal(readJsonl(recPath(root)).length, 1);
});

test('F09: every Binance request is bounded, body included — a source that never answers, or never finishes its body, ends in a failure, not a hang', async () => {
  const seen = [];
  const hang = (url, init) => {
    seen.push(init?.signal instanceof AbortSignal);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  // AbortSignal.timeout's timer does not hold the event loop open (a real request's socket does); this one stands in for it
  const keepAlive = setInterval(() => {}, 1000);
  const t0 = Date.now();
  try {
    await assert.rejects(binanceRest({ fetchImpl: hang, timeoutMs: 40, waitMs: 1 }).time(), /no complete answer within 0\.04 s/);
    assert.deepEqual(seen, [true, true, true, true], 'four attempts, each with a signal');
    const trickle = (url, init) => Promise.resolve({ status: 200, ok: true, json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    await assert.rejects(binanceRest({ fetchImpl: trickle, timeoutMs: 40, waitMs: 1 }).klines('BTCUSDT', 0, 1, 1), /no complete answer/);
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - t0 < 5000, 'bounded');
  // control: an answer inside the limit is returned
  const fine = () => Promise.resolve({ status: 200, ok: true, json: async () => ({ serverTime: 1_900_000_000_000 }) });
  assert.equal(await binanceRest({ fetchImpl: fine, timeoutMs: 40 }).time(), 1_900_000_000_000);
});

// ------------------------------------------------------------------ C2

test('C2: an anchored decision the rulebook JSON no longer matches is refused with what does not match — not "not anchored"', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  const p = path.join(root, 'keeper', 'rulebooks', 'qbtc2x.json');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n$/, ' \n'));
  const r = deps(root, { minutes: days('2030-05-01', 2), now: at(`${I}T00:25:00Z`) });
  const out = await capture(() => run(['--index', 'qbtc2x'], r.d));
  assert.equal(out.code, 2);
  assert.match(out.err, /REFUSED: the inception decision 2030-05-02-qbtc2x-paper-inception is anchored, but 2030-05-02-qbtc2x-paper-inception does not contain the rulebook sha256/);
  assert.doesNotMatch(out.err, /not anchored/);
});

// ------------------------------------------------------------------ F05

test('F05a: a registry entry that names another index\'s vault is refused before any mark (exit 1); the right symbol marks', async () => {
  for (const [symbol, code] of [['qETH2X', 1], ['qBTC2X', 0]]) {
    const key = generatePrivateKey();
    const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address, symbol });
    const root = tempRoot({ fill: FILL, inception: I, vaults: vaults() });
    const r = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:25:00Z'), key, node });
    const out = await capture(() => run(['--index', 'qbtc2x', '--anchor'], r.d));
    assert.equal(out.code, code, symbol);
    const sentMarks = node.txs.filter((t) => t.to !== t.from).length;
    if (code === 1) {
      assert.match(out.err, /is "qETH2X", not qBTC2X — keeper\/leverage-vaults\.json names the wrong vault; no mark sent/);
      assert.equal(sentMarks, 0);
    } else assert.ok(sentMarks >= 1);
    assert.equal(readJsonl(path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl')).length, 2, 'the lines are anchored either way');
  }
});

test('F05d: a vault at navPerShare 3 cannot move — a non-liquidated level is a failure (exit 1, nothing sent), not "already there"', async () => {
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address, nav: 3n });
  const root = tempRoot({ fill: FILL, inception: I, vaults: vaults() });
  const r = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:25:00Z'), key, node });
  const out = await capture(() => run(['--index', 'qbtc2x', '--anchor'], r.d));
  assert.equal(out.code, 1);
  assert.match(out.err, /cannot reach navPerShare \d+ from 3: the contract's 25% bound rounds to zero at 3 — nothing sent/);
  assert.equal(node.txs.filter((t) => t.to !== t.from).length, 0);
});

// ------------------------------------------------------------------ F03 (and F02 in the verifier)

async function publishedSeries() {
  const root = tempRoot({ fill: FILL, inception: I });
  const r = deps(root, { minutes: days('2030-05-01', 6), now: at('2030-05-05T06:00:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 0);
  return { root, lines: readJsonl(recPath(root)) };
}
function variant(root, lines, { ledger = null, rulebook = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-f03-'));
  fs.cpSync(path.join(root, 'trackrecord'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record-qbtc2x.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
  fs.copyFileSync(path.join(root, 'keeper', 'rulebooks', 'qbtc2x.json'), path.join(dir, 'rulebook-qbtc2x.json'));
  if (rulebook) fs.writeFileSync(path.join(dir, 'rulebook-qbtc2x.json'), rulebook);
  if (ledger) fs.writeFileSync(path.join(dir, 'decisions.jsonl'), ledger.map((d) => JSON.stringify(d)).join('\n') + '\n');
  return dir;
}

test('F03: the verifier fails a series under another rule, another decision, another genesis bar, an empty file, or a line written before its day — and passes the honest one', async () => {
  const { root, lines } = await publishedSeries();
  assert.equal(lines.length, 4);
  // control: the honest series, from the repository layout (../keeper/rulebooks) and from the mirror layout (rulebook-<index>.json)
  let v = verify(path.join(root, 'trackrecord'));
  assert.equal(v.status, 0, v.stdout);
  v = verify(variant(root, lines));
  assert.equal(v.status, 0, v.stdout);
  const fails = (dir, pattern) => {
    const out = verify(dir);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, pattern);
  };
  // A: other rule values with an empty rulebookSha256 (the red team's case), and other values with the true sha256
  let t = structuredClone(lines);
  for (const l of t) l.rule = { ...l.rule, rulebookSha256: '', checkMinutes: 720, trigger: 50, costBp: 0, ratePct: 0, lltv: 0.99 };
  fails(variant(root, rehash(t)), /rule\.rulebookSha256 … is not the rulebook JSON's|rule\.rulebookSha256 .* is not the rulebook JSON's/);
  t = structuredClone(lines);
  for (const l of t) l.rule = { ...l.rule, trigger: 2.3 };
  fails(variant(root, rehash(t)), /is not the rulebook JSON's \{/);
  // A: no rulebook JSON reachable
  const noJson = variant(root, lines);
  fs.rmSync(path.join(noJson, 'rulebook-qbtc2x.json'));
  fails(noJson, /rulebook JSON unavailable/);
  // B: another decision effective the same day, named as the inception
  const ledger = readJsonl(path.join(root, 'trackrecord', 'decisions.jsonl'));
  const other = { ...ledger[0], id: `${I}-qx20-something-else`, file: ledger[0].file };
  t = structuredClone(lines);
  t[0].inception = { ...t[0].inception, decision: other.id };
  fails(variant(root, rehash(t), { ledger: [...ledger, other] }), /inception\.decision 2030-05-02-qx20-something-else is not 2030-05-02-qbtc2x-paper-inception/);
  // C: genesis taken from another bar of the day before
  t = structuredClone(lines);
  const g = t[0];
  g.bars = [['14:15', ...g.bars[0].slice(1)]];
  g.book = { ...g.book, lastBar: `2030-05-01T14:15` };
  fails(variant(root, rehash(t)), /genesis bar 14:15 .* is not the full 23:45 bar of 2030-05-01/);
  // E: an empty record file after the opening day (the verifier reads today's date, so this ledger's opening is in the past)
  const past = { ...ledger[0], id: '2020-01-01-qbtc2x-paper-inception', effectiveFrom: '2020-01-01' };
  fails(variant(root, [], { ledger: [past] }), /2020-01-01-qbtc2x-paper-inception \(effective 2020-01-01\) is anchored but record-qbtc2x\.jsonl is missing/);
  // F02: a line whose observedAt is before its own day began
  t = structuredClone(lines);
  t[2].observedAt = `${t[2].date.slice(0, 8)}${String(Number(t[2].date.slice(8)) - 1).padStart(2, '0')}T23:00:00.000Z`;
  t[2].keeper = { ...t[2].keeper, lagSeconds: -3600 };
  fails(variant(root, rehash(t)), /observedAt .* is before 2030-05-04T00:00Z — a line is never written before its day began$/m);
});

test('F03 D: with an RPC, an anchor whose block is older than the line\'s day fails, a late anchor prints how late, and a block seconds before observedAt is printed, not failed', async () => {
  const { root, lines } = await publishedSeries();
  const dir = variant(root, lines);
  const ledger = readJsonl(path.join(dir, 'decisions.jsonl'));
  const txs = new Map();
  const anchors = lines.map((l) => {
    const txHash = `0x${sha256(`tx-${l.seq}`)}`;
    txs.set(txHash, { input: toHex(`qxpi-qbtc2x:${l.hash}`), block: 1000 + l.seq, time: Date.parse(l.observedAt) / 1000 + (l.seq === 3 ? 5 * 3600 : 60) });
    return { date: l.date, seq: l.seq, headHash: l.hash, txHash };
  });
  for (const d of ledger) txs.set(d.txHash, { input: toHex(`qxdec:${d.sha256}`), block: 900, time: Date.parse(`${d.effectiveFrom}T00:00:00Z`) / 1000 - 3600 });
  fs.writeFileSync(path.join(dir, 'anchors-qbtc2x.jsonl'), anchors.map((a) => JSON.stringify(a)).join('\n') + '\n');
  const blocks = new Map([...txs.values()].map((x) => [x.block, x.time]));
  let early = new Map(); // block number → seconds before its line's observedAt that the block answers
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      let result = null;
      const x = txs.get(params?.[0]);
      if (method === 'eth_getTransactionByHash' && x) result = { input: x.input, blockNumber: `0x${x.block.toString(16)}` };
      if (method === 'eth_getTransactionReceipt' && x) result = { status: '0x1', blockNumber: `0x${x.block.toString(16)}` };
      if (method === 'eth_getBlockByNumber') {
        const n = parseInt(params[0], 16);
        const tm = early.has(n) ? Date.parse(lines[n - 1000].observedAt) / 1000 - early.get(n) : blocks.get(n);
        result = { number: params[0], timestamp: `0x${Math.floor(tm).toString(16)}` };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  const runVerify = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--rpc', rpc], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (b) => (out += b));
      c.stderr.on('data', (b) => (out += b));
      c.on('close', (status) => resolve({ status, out }));
    });
  try {
    let v = await runVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, /seq 3 2030-05-05 anchored in .* — 5\.0 h after observedAt/);
    assert.doesNotMatch(v.out, /before observedAt/);
    // Two clocks a little apart: the chain's block time is before the runner's observedAt — printed, not failed.
    // Block 1000 is the case met on a fork (rehearsal 2, attempt 1): a block time in whole seconds that falls
    // in the second before observedAt (0.4 s earlier, rounded down to the second); block 1003 is three seconds.
    early = new Map([[1000, 0.4], [1003, 3]]);
    v = await runVerify();
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, /seq 0 2030-05-02 anchored in .* — 1 s before observedAt \(clock difference\)/);
    assert.match(v.out, /seq 3 2030-05-05 anchored in .* — 3 s before observedAt \(clock difference\)/);
    // A block before the line's own day began: the line was anchored before its day — a failure.
    early = new Map([[1003, 7 * 3600]]); // the lines were observed at 06:00 on 2030-05-05; seven hours earlier is 2030-05-04T23:00Z
    v = await runVerify();
    assert.equal(v.status, 1, v.out);
    assert.match(v.out, /anchor seq 3 2030-05-05: block time 2030-05-04T23:00:00\.000Z is before 2030-05-05T00:00Z — the line was anchored before its own day began/);
  } finally {
    server.close();
  }
});

test('the keeper\'s own recompute carries the rulebook JSON (a line under the shipped rule is accepted end to end, nothing else written)', async () => {
  const { root } = await publishedSeries();
  const files = listFiles(root);
  assert.ok(files.some(([f]) => f.endsWith('record-qbtc2x.jsonl')));
  assert.ok(!files.some(([f]) => /rulebook-qbtc2x\.json$/.test(f)), 'the copy lives only in the temporary recompute folder');
});
