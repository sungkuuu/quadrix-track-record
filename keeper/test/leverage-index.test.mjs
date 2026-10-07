/**
 * keeper/leverage-index.mjs — the daily leg, end to end, offline.
 *
 * Every test runs the leg's own run() against a throwaway repository root
 * (tempRoot), a fake Binance (two endpoints, 1-minute bars held in memory)
 * and, where it signs, a fake GIWA node that accepts only RAW signed
 * transactions (the public endpoint holds no key) and models one
 * QuadrixIndexVault (navPerShare, keeper, owner, depositsPaused, ±25%).
 * The key is generated here and exists nowhere else. Each line the leg
 * appends has passed scripts/verify.mjs --recompute-only (the independent
 * implementation) in a child process — that is part of what is tested.
 *
 * THROWAWAY values (labelled): n = 120 · T = 2.2, 30 bp · 6% a year, and the
 * T = 9 used to force a model liquidation. None is a tested value.
 *
 *   node --test keeper/test/leverage-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { run } from '../leverage-index.mjs';
import { aggregate15, sha256, canonicalMinuteText, minuteGaps, ruleProblem } from '../leverage-step.mjs';
import {
  REPO, KEEPER_DIR, THROWAWAY_CHECK, THROWAWAY_LEVEL, synthMinutes, minutesFrom15, read15mFile, fakeBinance, fakeNode, tempRoot, readJsonl, listFiles, dayMs,
} from './leverage-helpers.mjs';

const VERIFY = path.join(REPO, 'scripts', 'verify.mjs');
const VAULT = getAddress('0x00000000000000000000000000000000000beef1');
const FILL = { check: THROWAWAY_CHECK, primary: THROWAWAY_LEVEL };
const I = '2030-05-02'; // inception of the throwaway series

/** Minutes for consecutive days starting at `first`, chained prices; `shock` per day index. */
function days(first, count, { shocks = {}, seed = 11, vol = 0.002 } = {}) {
  const out = [];
  let p0 = 30_000;
  for (let k = 0; k < count; k++) {
    const d = new Date(dayMs(first) + k * 86_400_000).toISOString().slice(0, 10);
    const ms = synthMinutes(d, { seed: seed + k, p0, vol, shock: shocks[k] ?? null });
    out.push(...ms);
    p0 = ms.at(-1).c;
  }
  return out;
}
/** A fall of ~ `pct` spread over minutes [a, b). */
const crash = (pct, a = 540, b = 660) => (m, r) => (m >= a && m < b ? r - pct / (b - a) : r);

function deps(root, { minutes, now, key = null, node = null, logs = [], extra = {} }) {
  const binance = fakeBinance({ BTCUSDT: minutes }, { serverTime: () => now() });
  return {
    binance,
    d: {
      root, now, binance, env: key ? { KEEPER_PK: key } : {}, log: (m) => logs.push(String(m)), wait: async () => {},
      transport: node ? () => node.transport : undefined, pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 }, ...extra,
    },
  };
}
const at = (iso) => () => Date.parse(iso);
const strip = (l) => {
  const { observedAt, late, keeper, hash, prevHash, ...rest } = l;
  return JSON.stringify({ ...rest, sources: { ...rest.sources, fetchedAt: null } });
};

// ---------------------------------------------------------------- T4 refusals

test('T4: an empty or invalid tested value, or a throwaway value outside a dry run, is refused with exit 2 — no file written, no exchange or chain request', async () => {
  const cases = [
    ['check.minutes null (the stage A placeholder)', { check: { minutes: null, trigger: null }, primary: null }, ['--index', 'qbtc2x', '--anchor']],
    ['check.trigger null', { check: { minutes: 120, trigger: null }, primary: THROWAWAY_LEVEL }, ['--index', 'qbtc2x', '--anchor']],
    ['level.primary null', { check: THROWAWAY_CHECK, primary: null }, ['--index', 'qbtc2x', '--anchor']],
    ['n = 20', { check: { minutes: 20, trigger: 2.2 }, primary: THROWAWAY_LEVEL }, ['--index', 'qbtc2x', '--anchor']],
    ['n = 1440', { check: { minutes: 1440, trigger: 2.2 }, primary: THROWAWAY_LEVEL }, ['--index', 'qbtc2x', '--anchor']],
    ['T = 2.0', { check: { minutes: 120, trigger: 2.0 }, primary: THROWAWAY_LEVEL }, ['--index', 'qbtc2x', '--anchor']],
    ['throwaway values on a live run', null, ['--index', 'qbtc2x', '--anchor', '--throwaway-check', '120:2.2', '--throwaway-level', '30:6']],
    ['replay on a live run', null, ['--index', 'qbtc2x', '--replay', '2030-01-01..2030-01-02', '--throwaway-check', '120:2.2']],
    ['--from without a local fork', null, ['--index', 'qbtc2x', '--rpc', 'https://sepolia-rpc.giwa.io', '--from', '0x0000000000000000000000000000000000000001']],
  ];
  for (const [label, fill, argv] of cases) {
    const root = tempRoot({ fill, inception: fill ? I : null });
    const before = listFiles(root);
    const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(generatePrivateKey()).address });
    const { d, binance } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:30:00Z'), key: generatePrivateKey(), node });
    const code = await run(argv, d);
    assert.equal(code, 2, `${label}: exit ${code}`);
    assert.deepEqual(listFiles(root), before, `${label}: a file changed`);
    assert.equal(binance.calls.length, 0, `${label}: Binance was called`);
    assert.equal(node.methods.length, 0, `${label}: the chain was called`);
  }
});

test('T4b: the two shipped rulebooks carry one level convention (level.primary, owner 2026-10-05) and record no management fee in stage A', () => {
  const [btc, eth] = ['qbtc2x', 'qeth2x'].map((index) => JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'rulebooks', `${index}.json`), 'utf8')));
  assert.deepEqual(btc.level.primary, eth.level.primary, 'qbtc2x and qeth2x must carry the same level.primary');
  assert.deepEqual(btc.level.primary, { costBp: 30, ratePct: 4.5 }, 'level.primary is the owner-confirmed 30 bp / 4.5% a year');
  for (const rb of [btc, eth]) assert.equal(rb.fees?.managementBps, 0, `${rb.ticker}: stage A records no management fee`);
});

test('T4: the shipped rulebooks (values filled 2026-10-05) pass the rule checks and stay NOT IN FORCE until their inception decision is in the ledger — exit 0, nothing written, no exchange or chain request', async () => {
  for (const index of ['qbtc2x', 'qeth2x']) {
    const shipped = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'rulebooks', `${index}.json`), 'utf8'));
    assert.equal(ruleProblem({ target: shipped.product.target, minutes: shipped.check.minutes, trigger: shipped.check.trigger, primary: shipped.level.primary }), null, `${index}: the shipped values are on the grid`);
    assert.ok(shipped.inception.date && shipped.inception.decision, `${index}: the shipped rulebook names its inception`);
    // a copy of the shipped files with an empty ledger (as on main between the push and the anchor)
    const root = tempRoot({ index });
    const before = listFiles(root);
    const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(generatePrivateKey()).address });
    const { d, binance } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:30:00Z'), key: generatePrivateKey(), node });
    const logs = [];
    d.log = (m) => logs.push(m);
    assert.equal(await run(['--index', index, '--anchor'], d), 0, `${index}: exit`);
    assert.match(logs.join('\n'), new RegExp(`NOT IN FORCE: .*${shipped.inception.decision} is not in trackrecord/decisions\\.jsonl`), index);
    assert.deepEqual(listFiles(root), before, `${index}: a file changed`);
    assert.equal(binance.calls.length, 0, `${index}: Binance was called`);
    assert.equal(node.methods.length, 0, `${index}: the chain was called`);
  }
});

test('not in force: no decision, a named decision not yet anchored, or before the inception date — exit 0, nothing written', async () => {
  // values filled, no decision
  let root = tempRoot({ fill: FILL });
  let { d } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:30:00Z') });
  const logs = [];
  d.log = (m) => logs.push(m);
  assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  assert.match(logs.join('\n'), /NOT IN FORCE: inception\.date/);
  assert.ok(!fs.existsSync(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl')));
  // the rulebook names its decision, which is not in the ledger yet (between the push and the anchor)
  root = tempRoot({ fill: FILL, inception: I });
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), '');
  ({ d } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:30:00Z') }));
  logs.length = 0;
  d.log = (m) => logs.push(m);
  assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  assert.match(logs.join('\n'), /NOT IN FORCE: .*is not in trackrecord\/decisions\.jsonl/);
  // before the inception date
  root = tempRoot({ fill: FILL, inception: I });
  ({ d } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-01T12:00:00Z') }));
  logs.length = 0;
  d.log = (m) => logs.push(m);
  assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  assert.match(logs.join('\n'), /NOT IN FORCE: inception 2030-05-02/);
});

test('review r1: once the series has lines, a rulebook edited after inception is a refusal (exit 2, the failure issue opens), not a silent NOT IN FORCE', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  const minutes = days('2030-05-01', 4);
  const rec = path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
  let r = deps(root, { minutes, now: at('2030-05-03T00:30:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 0);
  assert.equal(readJsonl(rec).length, 2);
  // an edit to the pinned JSON (any byte) after inception
  const rbPath = path.join(root, 'keeper', 'rulebooks', 'qbtc2x.json');
  fs.writeFileSync(rbPath, fs.readFileSync(rbPath, 'utf8').replace(/"asOf": "[^"]*"/, '"asOf": "2099-12-31"'));
  const before = listFiles(root);
  r = deps(root, { minutes, now: at('2030-05-04T00:30:00Z') });
  const errs = [];
  const origErr = console.error;
  console.error = (m) => errs.push(String(m));
  let code;
  try {
    code = await run(['--index', 'qbtc2x'], r.d);
  } finally {
    console.error = origErr;
  }
  assert.equal(code, 2);
  assert.match(errs.join('\n'), /REFUSED: .*already holds 2 line\(s\), so the series has started — NOT IN FORCE: .*does not contain the rulebook sha256/);
  assert.deepEqual(listFiles(root), before, 'nothing written');
  assert.equal(r.binance.calls.length, 0, 'Binance not called');
});

test('review r2: an ANCHORED inception decision that the files do not satisfy is a refusal before the genesis line too (exit 2, the failure issue opens) — not a silent NOT IN FORCE on the opening day', async () => {
  const cases = [
    ['the rulebook JSON edited after the decision pinned it', (root) => {
      const rbPath = path.join(root, 'keeper', 'rulebooks', 'qbtc2x.json');
      fs.writeFileSync(rbPath, fs.readFileSync(rbPath, 'utf8').replace(/"asOf": "[^"]*"/, '"asOf": "2099-12-31"'));
    }, /REFUSED: the inception decision 2030-05-02-qbtc2x-paper-inception is anchored, but .*does not contain the rulebook sha256/],
    ['the ledger entry effective from another date', (root) => {
      const p = path.join(root, 'trackrecord', 'decisions.jsonl');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"effectiveFrom":"2030-05-02"', '"effectiveFrom":"2030-05-03"'));
    }, /REFUSED: the inception decision .* is anchored, but decision .* is effective from 2030-05-03, rulebook inception\.date is 2030-05-02/],
    ['the decision document missing', (root) => {
      fs.rmSync(path.join(root, 'trackrecord', 'decisions', '2030-05-02-qbtc2x-paper-inception.md'));
    }, /REFUSED: the inception decision .* is anchored, but .*missing/],
  ];
  for (const [label, breakIt, pattern] of cases) {
    const root = tempRoot({ fill: FILL, inception: I });
    breakIt(root);
    const before = listFiles(root);
    const r = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-02T00:30:00Z') });
    const errs = [];
    const origErr = console.error;
    console.error = (m) => errs.push(String(m));
    let code;
    try {
      code = await run(['--index', 'qbtc2x', '--anchor'], r.d);
    } finally {
      console.error = origErr;
    }
    assert.equal(code, 2, label);
    assert.match(errs.join('\n'), pattern, label);
    assert.deepEqual(listFiles(root), before, `${label}: nothing written`);
    assert.equal(r.binance.calls.length, 0, `${label}: Binance not called`);
  }
});

// ---------------------------------------------------------------- T5 finality

test('T5: a day is not written before the next day\'s first 1-minute bar has closed', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  const minutes = days('2030-05-01', 3);
  const rec = path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
  for (const [now, lines] of [['2030-05-02T00:00:30Z', 0], ['2030-05-02T00:00:59.999Z', 0], ['2030-05-02T00:01:00.500Z', 1], ['2030-05-02T23:59:59Z', 1]]) {
    const { d } = deps(root, { minutes, now: at(now) });
    assert.equal(await run(['--index', 'qbtc2x'], d), 0);
    assert.equal(readJsonl(rec).length, lines, `at ${now}`);
  }
  // the minute at 00:00 of the next day is missing entirely (an exchange gap at midnight): the next bar, once closed, makes the day final
  const gapAtMidnight = minutes.filter((m) => m.openMs !== Date.parse('2030-05-03T00:00:00Z') && m.openMs !== Date.parse('2030-05-03T00:01:00Z'));
  const { d } = deps(root, { minutes: gapAtMidnight, now: at('2030-05-03T00:01:30Z') });
  assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  assert.equal(readJsonl(rec).length, 1, 'the 00:02 bar has not closed yet');
});

// ---------------------------------------------------------------- T6 catch-up

test('T6: a run that wakes late computes the missed days in order, from the same bars — only the timing fields differ; a second run writes nothing', async () => {
  const minutes = days('2030-05-01', 5, { shocks: { 2: crash(0.25) } });
  // on time: one run a day at 00:25 UTC
  const onTime = tempRoot({ fill: FILL, inception: I });
  for (const day of ['2030-05-02', '2030-05-03', '2030-05-04']) {
    const { d } = deps(onTime, { minutes, now: at(`${day}T00:25:00Z`) });
    assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  }
  // late: the first run on 2030-05-04 07:10 UTC
  const late = tempRoot({ fill: FILL, inception: I });
  const { d } = deps(late, { minutes, now: at('2030-05-04T07:10:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  const A = readJsonl(path.join(onTime, 'trackrecord', 'record-qbtc2x.jsonl'));
  const B = readJsonl(path.join(late, 'trackrecord', 'record-qbtc2x.jsonl'));
  assert.deepEqual(A.map((l) => l.date), ['2030-05-02', '2030-05-03', '2030-05-04']);
  assert.deepEqual(B.map((l) => l.date), A.map((l) => l.date));
  assert.deepEqual(A.map((l) => l.late ?? false), [false, false, false]);
  assert.deepEqual(B.map((l) => l.late ?? false), [true, true, false]);
  assert.equal(B[0].keeper.lagSeconds, 2 * 86400 + 7 * 3600 + 600);
  for (let k = 0; k < 3; k++) assert.equal(strip(B[k]), strip(A[k]), `line ${A[k].date} differs beyond its timing fields`);
  assert.ok(A[2].dayStats.triggers >= 1, 'the crash day triggered (the comparison covers a trigger trade)');
  // a second run at the same time writes nothing
  const before = fs.readFileSync(path.join(late, 'trackrecord', 'record-qbtc2x.jsonl'), 'utf8');
  const again = deps(late, { minutes, now: at('2030-05-04T07:10:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], again.d), 0);
  assert.equal(fs.readFileSync(path.join(late, 'trackrecord', 'record-qbtc2x.jsonl'), 'utf8'), before);
});

// ---------------------------------------------------------------- T7 missing bars

test('T7: 1,439 bars halt the series (exit 1, nothing written, later days neither); an accepted gap with the same sha256 is computed and recorded; a different sha256 or two differing fetches halt', async () => {
  const all = days('2030-05-01', 4);
  const missing = Date.parse('2030-05-02T13:07:00Z');
  const minutes = all.filter((m) => m.openMs !== missing);
  const root = tempRoot({ fill: FILL, inception: I });
  const rec = path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
  let r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 1);
  assert.deepEqual(readJsonl(rec).map((l) => l.date), ['2030-05-02'], 'genesis written, line 2030-05-03 (day 05-02, 1,439 bars) and 05-04 not');
  // accepted with the wrong sha256: still halted
  const dayMinutes = minutes.filter((m) => m.openMs >= dayMs('2030-05-02') && m.openMs < dayMs('2030-05-03'));
  const sha = sha256(canonicalMinuteText(dayMinutes));
  const gapsPath = path.join(root, 'keeper', 'leverage-gaps.json');
  const entry = { id: 'qbtc2x-2030-05-02', index: 'qbtc2x', day: '2030-05-02', sha256: 'f'.repeat(64), missing: minuteGaps(dayMinutes, '2030-05-02'), note: 'THROWAWAY test', confirmedAt: '2030-05-03' };
  fs.writeFileSync(gapsPath, JSON.stringify({ accepted: [entry] }));
  r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 1);
  assert.equal(readJsonl(rec).length, 1);
  // accepted with the exact sha256: computed, gaps recorded, then the next day too
  fs.writeFileSync(gapsPath, JSON.stringify({ accepted: [{ ...entry, sha256: sha }] }));
  r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 0);
  const lines = readJsonl(rec);
  assert.deepEqual(lines.map((l) => l.date), ['2030-05-02', '2030-05-03', '2030-05-04']);
  assert.deepEqual(lines[1].gaps, [{ from: '13:07', to: '13:07', minutes: 1 }]);
  assert.equal(lines[1].gapAccepted, 'qbtc2x-2030-05-02');
  assert.equal(lines[1].sources.rows, 1439);
  assert.equal(lines[1].bars.find((b) => b[0] === '13:00')[5], 14);
  // two fetches that differ: halted. The fake hands `mutate` minute OBJECTS ({openMs, o, h, l, c}); klines call 4 is
  // the first page of the second fetch of the genesis day. The close moves inside [low, high], so the bar stays
  // well-formed and only the comparison can stop it (red team F10: the earlier version raised a TypeError instead).
  const root2 = tempRoot({ fill: FILL, inception: I });
  const flaky = fakeBinance({ BTCUSDT: all }, { serverTime: Date.parse('2030-05-03T00:25:00Z'), mutate: (rows, n) => (n === 4 ? rows.map((x, i) => (i === 5 ? { ...x, c: x.c === x.l ? x.h : x.l } : x)) : rows) });
  const dd = { root: root2, now: at('2030-05-03T00:25:00Z'), binance: flaky, env: {}, log: () => {}, wait: async () => {} };
  const errs = [];
  const origErr = console.error;
  console.error = (m) => errs.push(String(m));
  let code;
  try {
    code = await run(['--index', 'qbtc2x'], dd);
  } finally {
    console.error = origErr;
  }
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /BTCUSDT 2030-05-01: two fetches of the same day differ/);
  assert.doesNotMatch(errs.join('\n'), /is not a function|TypeError/);
  assert.equal(readJsonl(path.join(root2, 'trackrecord', 'record-qbtc2x.jsonl')).length, 0);
  // an accepted gap entry without an id (the six fields the halt message used to list) stops before anything is written (red team F01)
  const root3 = tempRoot({ fill: FILL, inception: I });
  const rec3 = path.join(root3, 'trackrecord', 'record-qbtc2x.jsonl');
  let r3 = deps(root3, { minutes, now: at('2030-05-02T00:25:00Z') });
  assert.equal(await run(['--index', 'qbtc2x'], r3.d), 0);
  const { id: _drop, ...noId } = { ...entry, sha256: sha };
  fs.writeFileSync(path.join(root3, 'keeper', 'leverage-gaps.json'), JSON.stringify({ accepted: [noId] }));
  const errs3 = [];
  console.error = (m) => errs3.push(String(m));
  try {
    r3 = deps(root3, { minutes, now: at('2030-05-04T00:25:00Z') });
    assert.equal(await run(['--index', 'qbtc2x'], r3.d), 1);
  } finally {
    console.error = origErr;
  }
  assert.match(errs3.join('\n'), /the accepted gap of qbtc2x 2030-05-02 .* has no "id"/);
  assert.equal(readJsonl(rec3).length, 1, 'only the genesis line');
});

// ---------------------------------------------------------------- T8 anchors

test('T8: every line is anchored with calldata qxpi-qbtc2x:<hash>, signed locally (the node is never asked to sign); a line left unanchored is anchored first', async () => {
  const key = generatePrivateKey();
  const addr = privateKeyToAccount(key).address;
  const node = fakeNode({ vault: VAULT, keeper: addr });
  const minutes = days('2030-05-01', 4);
  const root = tempRoot({ fill: FILL, inception: I });
  // run 1 without the key: the genesis line is written unanchored
  let r = deps(root, { minutes, now: at('2030-05-02T00:25:00Z') });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  const recPath = path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
  const ancPath = path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl');
  assert.equal(readJsonl(recPath).length, 1);
  assert.equal(readJsonl(ancPath).length, 0);
  // run 2 with the key: the genesis line first, then the new lines
  const logs = [];
  r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z'), key, node, logs });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  const lines = readJsonl(recPath);
  const anchors = readJsonl(ancPath);
  assert.deepEqual(anchors.map((a) => a.seq), [0, 1, 2]);
  assert.ok(logs.findIndex((l) => /has no anchor — anchoring it first/.test(l)) < logs.findIndex((l) => /#1 2030-05-03 level/.test(l)));
  assert.deepEqual(node.anchorsOf(), lines.map((l) => `qxpi-qbtc2x:${l.hash}`));
  for (const a of anchors) assert.equal(a.headHash, lines[a.seq].hash);
  assert.ok(!node.methods.includes('eth_sendTransaction') && !node.methods.includes('wallet_sendTransaction'), node.methods.join(','));
  assert.ok(node.txs.every((t) => t.from === addr));
  // and the result verifies on its own (recompute only — the anchors are on a fake chain)
  const v = spawnSync(process.execPath, [VERIFY, '--dir', path.join(root, 'trackrecord'), '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
});

test('T8: when the independent recompute rejects the new line nothing is appended or anchored (exit 1)', async () => {
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
  const root = tempRoot({ fill: FILL, inception: I });
  const failing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lev-v-')), 'verify-fails.mjs');
  fs.writeFileSync(failing, "console.log('  FAIL  injected'); process.exit(1);\n");
  const r = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:25:00Z'), key, node, extra: { verifyScript: failing } });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 1);
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl')).length, 0);
  assert.equal(node.txs.length, 0);
});

// ---------------------------------------------------------------- T9 marks

function vaults(gate, address = VAULT) {
  return { qbtc2x: { chainId: 91342, address, gate, deployTx: null, block: null }, qeth2x: { chainId: 91342, address: null, gate: null } };
}

test('T9: after the anchor the vault is marked to round(E × 1e6) in contract-bounded steps; marks are skipped without an address or a gate', async () => {
  const minutes = days('2030-05-01', 4, { shocks: { 2: crash(0.45) } });
  for (const [label, v, expectMarks] of [['no address', vaults({ mode: 'step' }, null), false], ['no gate', vaults(null), false], ['step gate', vaults({ mode: 'step' }), true]]) {
    const key = generatePrivateKey();
    const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
    const root = tempRoot({ fill: FILL, inception: I, vaults: v });
    const logs = [];
    const r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z'), key, node, logs });
    assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0, label);
    const lines = readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl'));
    const marks = readJsonl(path.join(root, 'keeper', 'marks-qbtc2x.jsonl'));
    if (!expectMarks) {
      assert.equal(marks.length, 0, label);
      assert.match(logs.join('\n'), label === 'no address' ? /no vault — marks skipped/ : /mark gate not set — marks skipped/);
      continue;
    }
    const target = BigInt(Math.round(lines.at(-1).book.E * 1e6));
    assert.equal(node.state.nav, target);
    assert.ok(marks.length >= 2, `the crash needs steps (${marks.length})`);
    let cur = 1_000_000n;
    for (const m of marks) {
      const next = BigInt(m.nav);
      const dlt = (cur * 2500n) / 10000n;
      assert.ok(next >= cur - dlt && next <= cur + dlt);
      assert.equal(m.of, marks.length);
      assert.equal(m.seq, lines.at(-1).seq);
      cur = next;
    }
    // every setNav after every anchor
    const kinds = node.txs.map((t) => (t.to === t.from ? 'anchor' : 'mark'));
    assert.ok(kinds.lastIndexOf('anchor') < kinds.indexOf('mark'));
    // a run the next minute sends nothing more
    const n0 = node.txs.length;
    const again = deps(root, { minutes, now: at('2030-05-04T00:26:00Z'), key, node });
    assert.equal(await run(['--index', 'qbtc2x', '--anchor'], again.d), 0);
    assert.equal(node.txs.length, n0);
  }
});

test('review r1: T9 on a load-balanced endpoint — a node behind the last step answers the next simulation from the old navPerShare; the simulation runs at a block >= the last receipt, so the steps still go through', async () => {
  const minutes = days('2030-05-01', 4, { shocks: { 2: crash(0.45) } });
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address, lagAfterWrite: 8 });
  const root = tempRoot({ fill: FILL, inception: I, vaults: vaults({ mode: 'step' }) });
  const r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z'), key, node });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl'));
  const marks = readJsonl(path.join(root, 'keeper', 'marks-qbtc2x.jsonl'));
  assert.ok(marks.length >= 2, `the crash needs steps (${marks.length})`);
  assert.equal(node.state.nav, BigInt(Math.round(lines.at(-1).book.E * 1e6)));
  assert.ok(node.txs.every((t) => t.status === '0x1'), 'no reverted transaction');
  // the model-liquidation path on the same lagging endpoint: 46 steps to the floor, then the pause
  const minutesL = days('2030-05-01', 5, { shocks: { 2: crash(0.95, 540, 600) } });
  const keyL = generatePrivateKey();
  const nodeL = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(keyL).address, lagAfterWrite: 8 });
  const rootL = tempRoot({ fill: { check: { minutes: 120, trigger: 9 }, primary: THROWAWAY_LEVEL }, inception: I, vaults: vaults({ mode: 'step' }) });
  let rL = deps(rootL, { minutes: minutesL, now: at('2030-05-05T00:25:00Z'), key: keyL, node: nodeL });
  const [codeL, errL] = await runCapturing(['--index', 'qbtc2x', '--anchor'], rL.d);
  assert.equal(codeL, 1, 'the liquidation waits for a person (owner 2026-10-06)');
  const liqBar = /the bar (\d\d:\d\d) UTC/.exec(errL)[1];
  const liqLtv = Number(/debt ÷ collateral is (\d+(?:\.\d+)?)/.exec(errL)[1]);
  const liqSha = /canonical sha256 ([0-9a-f]{64})/.exec(errL)[1];
  fs.writeFileSync(path.join(rootL, 'keeper', 'leverage-gaps.json'), JSON.stringify({ accepted: [{ id: 'qbtc2x-2030-05-03-liquidation', index: 'qbtc2x', day: '2030-05-03', sha256: liqSha, liquidation: { bar: liqBar, ltvLow: liqLtv }, note: 'THROWAWAY test', confirmedAt: '2030-05-05' }] }));
  rL = deps(rootL, { minutes: minutesL, now: at('2030-05-05T00:40:00Z'), key: keyL, node: nodeL });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], rL.d), 0);
  assert.equal(nodeL.state.nav, 3n);
  assert.equal(nodeL.state.paused, true);
  assert.ok(nodeL.txs.every((t) => t.status === '0x1'), 'no reverted transaction');
});

test('review r2: --no-new-lines (lines pushed before anything goes on chain, keeper-clock G2) — a keyless run writes the lines, a second run with --anchor --no-new-lines anchors every unanchored line in order and marks, computes no line and calls no exchange even when another day has ended', async () => {
  const minutes = days('2030-05-01', 5, { shocks: { 2: crash(0.45) } });
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
  const root = tempRoot({ fill: FILL, inception: I, vaults: vaults({ mode: 'step' }) });
  const rec = path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
  const anc = path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl');
  // 1. no key, no --anchor: genesis 05-02, lines 05-03 and 05-04; nothing on chain
  let r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z'), node });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 0);
  assert.equal(readJsonl(rec).length, 3);
  assert.equal(readJsonl(anc).length, 0);
  assert.equal(node.txs.length, 0);
  // 2. (the lines are pushed here) — the next day has ended meanwhile, but this run writes no line
  const logs = [];
  r = deps(root, { minutes, now: at('2030-05-05T00:25:00Z'), key, node, logs });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor', '--no-new-lines'], r.d), 0);
  const lines = readJsonl(rec);
  const anchors = readJsonl(anc);
  assert.equal(lines.length, 3, 'no new line');
  assert.equal(r.binance.calls.length, 0, 'no exchange call');
  assert.deepEqual(anchors.map((a) => [a.seq, a.headHash]), lines.map((l) => [l.seq, l.hash]), 'every line anchored, in order');
  assert.equal(node.state.nav, BigInt(Math.round(lines.at(-1).book.E * 1e6)), 'marked to the last line');
  const kinds = node.txs.map((t) => (t.to === t.from ? 'anchor' : 'mark'));
  assert.ok(kinds.lastIndexOf('anchor') < kinds.indexOf('mark'), 'anchors before marks');
  assert.match(logs.join('\n'), /--no-new-lines: no line is computed/);
  // 3. the next keyless run writes the day that ended (05-05) — the same line a single run would have written
  r = deps(root, { minutes, now: at('2030-05-05T00:30:00Z'), node });
  assert.equal(await run(['--index', 'qbtc2x'], r.d), 0);
  assert.equal(readJsonl(rec).length, 4);
});

test('T9: a mark that fails keeps the line and its anchor and exits 1; the next run finishes the steps', async () => {
  const minutes = days('2030-05-01', 4, { shocks: { 2: crash(0.45) } });
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address, failSetNavAtStep: 2 });
  const root = tempRoot({ fill: FILL, inception: I, vaults: vaults({ mode: 'step' }) });
  let r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z'), key, node });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 1);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 3);
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl')).length, 3);
  r = deps(root, { minutes, now: at('2030-05-04T00:40:00Z'), key, node });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  assert.equal(node.state.nav, BigInt(Math.round(lines.at(-1).book.E * 1e6)));
});

test('T9: gate {mode: halt, pct: 15} stops a mark beyond 15% (exit 1, nothing sent) — the alternative the owner may choose', async () => {
  const minutes = days('2030-05-01', 4, { shocks: { 2: crash(0.45) } });
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
  const root = tempRoot({ fill: FILL, inception: I, vaults: vaults({ mode: 'halt', pct: 15 }) });
  const r = deps(root, { minutes, now: at('2030-05-04T00:25:00Z'), key, node });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 1);
  assert.ok(node.txs.every((t) => t.to === t.from), 'only anchors were sent');
  assert.equal(node.state.nav, 1_000_000n);
});

/** Runs the leg with console.error captured; returns [exit code, stderr text]. */
async function runCapturing(argv, d) {
  const errs = [];
  const origErr = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    return [await run(argv, d), errs.join('\n')];
  } finally {
    console.error = origErr;
  }
}

test('T9 (owner 2026-10-06): a model liquidation halts the series until a person accepts it — nothing written, anchored or marked (exit 1); an entry with another bar, LTV or sha256, a gap entry, or one without an id does not accept it', async () => {
  // THROWAWAY T = 9: no trigger can save the book, a ~60% fall liquidates it on day 2030-05-03 (line 2030-05-04)
  const minutes = days('2030-05-01', 5, { shocks: { 2: crash(0.95, 540, 600) } });
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
  const root = tempRoot({ fill: { check: { minutes: 120, trigger: 9 }, primary: THROWAWAY_LEVEL }, inception: I, vaults: vaults({ mode: 'step' }) });
  const rec = path.join(root, 'trackrecord', 'record-qbtc2x.jsonl');
  const anc = path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl');
  const gapsPath = path.join(root, 'keeper', 'leverage-gaps.json');
  // the day before: genesis 05-02 and line 05-03, anchored and marked
  let r = deps(root, { minutes, now: at('2030-05-03T00:25:00Z'), key, node });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  const before = readJsonl(rec);
  assert.equal(before.length, 2);
  const nav0 = node.state.nav;
  const tx0 = node.txs.length;
  const files0 = JSON.stringify(listFiles(root));
  // the liquidation day: halted
  r = deps(root, { minutes, now: at('2030-05-05T00:25:00Z'), key, node });
  let [code, err] = await runCapturing(['--index', 'qbtc2x', '--anchor'], r.d);
  assert.equal(code, 1);
  assert.match(err, /QBTC2X 2030-05-03: MODEL LIQUIDATION NOT WRITTEN — the bar \d\d:\d\d UTC has a low of [\d.]+ \(the 1-minute bar \d\d:\d\d\) at which debt ÷ collateral is \d+(?:\.\d+)?, at or above the line 0\.86; canonical sha256 [0-9a-f]{64}\. Halted: nothing written for 2030-05-04 or later, nothing anchored, the vault not marked/i);
  assert.match(err, /If it is not, add nothing: the series stays halted/);
  assert.equal(JSON.stringify(listFiles(root)), files0, 'no file changed');
  assert.equal(node.txs.length, tx0, 'nothing sent');
  assert.equal(node.state.nav, nav0);
  assert.equal(node.state.paused, false);
  const bar = /the bar (\d\d:\d\d) UTC/.exec(err)[1];
  const ltvLow = Number(/debt ÷ collateral is (\d+(?:\.\d+)?)/.exec(err)[1]);
  const sha = /canonical sha256 ([0-9a-f]{64})/.exec(err)[1];
  const dayMinutes = minutes.filter((m) => m.openMs >= dayMs('2030-05-03') && m.openMs < dayMs('2030-05-04'));
  assert.equal(sha, sha256(canonicalMinuteText(dayMinutes)));
  const entry = { id: 'qbtc2x-2030-05-03-liquidation', index: 'qbtc2x', day: '2030-05-03', sha256: sha, liquidation: { bar, ltvLow }, note: 'THROWAWAY test', confirmedAt: '2030-05-05' };
  // entries that do not accept this liquidation: still halted, nothing written
  const notIt = [
    ['another bar', { ...entry, liquidation: { bar: '00:00', ltvLow } }],
    ['another LTV', { ...entry, liquidation: { bar, ltvLow: 0.9 } }],
    ['another sha256', { ...entry, sha256: 'f'.repeat(64) }],
    ['a gap entry for the day (no liquidation field)', { id: 'qbtc2x-2030-05-03', index: 'qbtc2x', day: '2030-05-03', sha256: sha, missing: [], note: 'THROWAWAY test', confirmedAt: '2030-05-05' }],
  ];
  for (const [what, e] of notIt) {
    fs.writeFileSync(gapsPath, JSON.stringify({ accepted: [e] }));
    r = deps(root, { minutes, now: at('2030-05-05T00:25:00Z'), key, node });
    [code, err] = await runCapturing(['--index', 'qbtc2x', '--anchor'], r.d);
    assert.equal(code, 1, what);
    assert.match(err, /MODEL LIQUIDATION NOT WRITTEN/, what);
    assert.equal(readJsonl(rec).length, 2, what);
    assert.equal(node.txs.length, tx0, what);
  }
  const { id: _drop, ...noId } = entry;
  fs.writeFileSync(gapsPath, JSON.stringify({ accepted: [noId] }));
  r = deps(root, { minutes, now: at('2030-05-05T00:25:00Z'), key, node });
  [code, err] = await runCapturing(['--index', 'qbtc2x', '--anchor'], r.d);
  assert.equal(code, 1);
  assert.match(err, /the accepted model liquidation of qbtc2x 2030-05-03 .* has no "id"/);
  assert.equal(readJsonl(rec).length, 2);
  assert.equal(readJsonl(anc).length, 2);
  assert.equal(node.txs.length, tx0);
});

test('T9: an accepted model liquidation ends the series: level 0 with liquidationAccepted, anchored, the vault stepped to the floor (46 steps) and paused; the next run sends and writes nothing; verify fails the line without the id', async () => {
  // THROWAWAY T = 9: no trigger can save the book, a ~60% fall liquidates it
  const minutes = days('2030-05-01', 5, { shocks: { 2: crash(0.95, 540, 600) } });
  const key = generatePrivateKey();
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
  const root = tempRoot({ fill: { check: { minutes: 120, trigger: 9 }, primary: THROWAWAY_LEVEL }, inception: I, vaults: vaults({ mode: 'step' }) });
  let r = deps(root, { minutes, now: at('2030-05-05T00:25:00Z'), key, node });
  const [code1, err1] = await runCapturing(['--index', 'qbtc2x', '--anchor'], r.d);
  assert.equal(code1, 1, 'halted first');
  const bar = /the bar (\d\d:\d\d) UTC/.exec(err1)[1];
  const ltvLow = Number(/debt ÷ collateral is (\d+(?:\.\d+)?)/.exec(err1)[1]);
  const sha = /canonical sha256 ([0-9a-f]{64})/.exec(err1)[1];
  fs.writeFileSync(path.join(root, 'keeper', 'leverage-gaps.json'), JSON.stringify({ accepted: [{ id: 'qbtc2x-2030-05-03-liquidation', index: 'qbtc2x', day: '2030-05-03', sha256: sha, liquidation: { bar, ltvLow }, note: 'THROWAWAY test', confirmedAt: '2030-05-05' }] }));
  r = deps(root, { minutes, now: at('2030-05-05T00:40:00Z'), key, node });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 3, 'nothing after the liquidation line');
  assert.equal(lines.at(-1).level, 0);
  assert.ok(lines.at(-1).liquidated?.ltvLow >= 0.86);
  assert.deepEqual(lines.at(-1).liquidated, { bar, ltvLow });
  assert.equal(lines.at(-1).liquidationAccepted, 'qbtc2x-2030-05-03-liquidation');
  assert.ok(lines.slice(0, -1).every((l) => l.liquidationAccepted === undefined));
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl')).at(-1).headHash, lines.at(-1).hash);
  assert.equal(lines.at(-1).slots.at(-1).action, 'liquidated');
  const marks = readJsonl(path.join(root, 'keeper', 'marks-qbtc2x.jsonl'));
  assert.equal(marks.filter((m) => m.step).length, 46);
  assert.equal(node.state.nav, 3n);
  assert.equal(node.state.paused, true);
  assert.equal(marks.at(-1).action, 'pause');
  const n0 = node.txs.length;
  const logs = [];
  r = deps(root, { minutes, now: at('2030-05-05T06:00:00Z'), key, node, logs });
  assert.equal(await run(['--index', 'qbtc2x', '--anchor'], r.d), 0);
  assert.equal(node.txs.length, n0);
  assert.match(logs.join('\n'), /series ended/);
  const v = spawnSync(process.execPath, [VERIFY, '--dir', path.join(root, 'trackrecord'), '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /MODEL LIQUIDATION/);
  // the same series with the id taken out of the liquidation line (re-hashed) fails; an id on another line fails too
  const tamper = (edit, pattern) => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-liq-'));
    fs.cpSync(root, copy, { recursive: true });
    const t = structuredClone(lines);
    edit(t);
    for (let k = 1; k < t.length; k++) {
      t[k].prevHash = t[k - 1].hash;
      const { hash, ...rest } = t[k];
      t[k].hash = sha256(JSON.stringify(rest));
    }
    fs.writeFileSync(path.join(copy, 'trackrecord', 'record-qbtc2x.jsonl'), t.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const vt = spawnSync(process.execPath, [VERIFY, '--dir', path.join(copy, 'trackrecord'), '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
    assert.equal(vt.status, 1, vt.stdout);
    assert.match(vt.stdout, pattern);
  };
  tamper((t) => { delete t[2].liquidationAccepted; }, /#2 2030-05-04: a model liquidation without liquidationAccepted/);
  tamper((t) => {
    const { rule, keeper, prevHash, hash, ...head } = t[1];
    t[1] = { ...head, liquidationAccepted: 'x', rule, keeper, prevHash, hash };
  }, /#1 2030-05-03: liquidationAccepted on a line without a model liquidation/);
});

// ---------------------------------------------------------------- T2 verify vs leg

test('T2: scripts/verify.mjs recomputes 31 days of the leg\'s lines field for field; a tampered line fails it', async () => {
  const minutes = days('2030-06-30', 33, { shocks: { 5: crash(0.3), 12: crash(-0.2), 20: crash(0.4, 100, 140) }, vol: 0.003 });
  const root = tempRoot({ fill: FILL });
  const r = deps(root, { minutes, now: at('2030-08-05T00:00:00Z') });
  assert.equal(await run(['--index', 'qbtc2x', '--dry-run', '--replay', '2030-07-01..2030-08-01', '--throwaway-check', '120:2.2', '--throwaway-level', '30:6'], r.d), 0);
  const dir = path.join(root, 'keeper', 'dryrun');
  const lines = readJsonl(path.join(dir, 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 32);
  assert.ok(lines.every((l) => l.rehearsal === 'THROWAWAY n=120 T=2.2 costBp=30 ratePct=6'));
  assert.ok(lines.reduce((a, l) => a + l.dayStats.triggers, 0) >= 1);
  let v = spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
  // without --allow-rehearsal the same file is not a published series
  v = spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.match(v.stdout, /marked as a rehearsal/);
  // tamper: one slot's level, re-hashed so that only the recompute can see it
  const t = structuredClone(lines);
  t[6].slots[3].level += 0.000001;
  for (let k = 6; k < t.length; k++) {
    if (k > 6) t[k].prevHash = t[k - 1].hash;
    const { hash, ...rest } = t[k];
    t[k].hash = sha256(JSON.stringify(rest));
  }
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-t-'));
  fs.writeFileSync(path.join(tdir, 'record-qbtc2x.jsonl'), t.map((l) => JSON.stringify(l)).join('\n') + '\n');
  v = spawnSync(process.execPath, [VERIFY, '--dir', tdir, '--series', 'qbtc2x', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.match(v.stdout, /check log differs at entry 3/);
});

const V6_DIR = process.env.LEVERAGE_V6_DIR ?? (process.env.LEVERAGE_V6_ENGINE ? path.dirname(process.env.LEVERAGE_V6_ENGINE) : null);
test('T2 on real bars: 2020-03 (BTC, with the 2020-03-04 exchange gap accepted) through the leg and verify', { skip: V6_DIR && fs.existsSync(path.join(V6_DIR, 'btcusdt-15m.csv.gz')) ? false : 'real-bar comparison missing — set LEVERAGE_V6_DIR (or LEVERAGE_V6_ENGINE) to the sixth test directory' }, async () => {
  const bars = (await read15mFile(path.join(V6_DIR, 'btcusdt-15m.csv.gz'))).filter((b) => b.openMs >= dayMs('2020-02-29') && b.openMs < dayMs('2020-04-02'));
  const minutes = minutesFrom15(bars);
  assert.deepEqual(aggregate15(minutes).map((b) => JSON.stringify(b)), bars.map((b) => JSON.stringify(b)));
  const gapDay = minutes.filter((m) => m.openMs >= dayMs('2020-03-04') && m.openMs < dayMs('2020-03-05'));
  const root = tempRoot({ fill: FILL, gaps: [{ id: 'test-2020-03-04', index: 'qbtc2x', day: '2020-03-04', sha256: sha256(canonicalMinuteText(gapDay)), missing: minuteGaps(gapDay, '2020-03-04'), note: 'THROWAWAY test: the 128-minute gap of the sixth test data', confirmedAt: '2026-10-02' }] });
  const r = deps(root, { minutes, now: at('2020-04-02T00:30:00Z') });
  assert.equal(await run(['--index', 'qbtc2x', '--dry-run', '--replay', '2020-03-01..2020-04-01', '--throwaway-check', '120:2.2', '--throwaway-level', '30:6'], r.d), 0);
  const lines = readJsonl(path.join(root, 'keeper', 'dryrun', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 32);
  assert.equal(lines.find((l) => l.date === '2020-03-05').gapAccepted, 'test-2020-03-04');
  const d13 = lines.find((l) => l.date === '2020-03-13');
  const d12 = lines.find((l) => l.date === '2020-03-12');
  console.log(`2020-03-12 (line 2020-03-13): ${((d13.book.E / d12.book.E - 1) * 100).toFixed(2)}% · triggers ${d13.dayStats.triggers}`);
  const v = spawnSync(process.execPath, [VERIFY, '--dir', path.join(root, 'keeper', 'dryrun'), '--series', 'qbtc2x', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
});

// ---------------------------------------------------------------- review r1: verify additions

test('review r1: verify — between an anchored inception decision and the genesis line the series is "pending"; after that UTC day a missing file fails', () => {
  for (const [effective, code, pattern] of [['2099-01-01', 0, /\[QBTC2X\] pending — inception decision 2099-01-01-qbtc2x-paper-inception/], ['2020-01-01', 1, /FAIL .*2020-01-01-qbtc2x-paper-inception \(effective 2020-01-01\) is anchored but record-qbtc2x\.jsonl is missing/]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-pend-'));
    const id = `${effective}-qbtc2x-paper-inception`;
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ id, file: `decisions/${id}.md`, effectiveFrom: effective, sha256: '0'.repeat(64), txHash: `0x${'d'.repeat(64)}`, anchoredAt: `${effective}T00:00:00.000Z` }) + '\n');
    const v = spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
    assert.equal(v.status, code, v.stdout);
    assert.match(v.stdout, pattern);
  }
});

test('review r1: verify — a genesis line carrying checks, a renumbered seq, or a price host other than the rule\'s fails even when re-hashed', async () => {
  const minutes = days('2030-06-30', 5, { vol: 0.003 });
  const root = tempRoot({ fill: FILL });
  const r = deps(root, { minutes, now: at('2030-07-06T00:00:00Z') });
  assert.equal(await run(['--index', 'qbtc2x', '--dry-run', '--replay', '2030-07-01..2030-07-04', '--throwaway-check', '120:2.2', '--throwaway-level', '30:6'], r.d), 0);
  const lines = readJsonl(path.join(root, 'keeper', 'dryrun', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 4);
  const rehash = (t, from) => {
    for (let k = from; k < t.length; k++) {
      if (k > 0) t[k].prevHash = t[k - 1].hash;
      const { hash, ...rest } = t[k];
      t[k].hash = sha256(JSON.stringify(rest));
    }
    return t;
  };
  const check = (t, pattern) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-t-'));
    fs.writeFileSync(path.join(dir, 'record-qbtc2x.jsonl'), t.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const v = spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
    assert.equal(v.status, 1, v.stdout);
    assert.match(v.stdout, pattern);
  };
  // the untampered series passes
  const ok = spawnSync(process.execPath, [VERIFY, '--dir', path.join(root, 'keeper', 'dryrun'), '--series', 'qbtc2x', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  let t = structuredClone(lines);
  t[0].slots = [{ ...lines[1].slots[0] }];
  check(rehash(t, 0), /genesis line carries day statistics, checks or a liquidation/);
  t = structuredClone(lines);
  t[2].seq = 7;
  check(rehash(t, 2), /seq 7 at position 2/);
  t = structuredClone(lines);
  t[1].sources.host = 'api.binance.com';
  check(rehash(t, 1), /sources .* are not this day's Binance 1-minute bars/);
});
