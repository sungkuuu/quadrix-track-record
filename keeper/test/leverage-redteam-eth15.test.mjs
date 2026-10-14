/**
 * Red team of the qETH1.5X (series id qeth15) changes to the stage A leg — offline, 2026-10-14.
 *
 * What changed and is attacked here: the target leverage is no longer fixed at 2 (TARGETS = [1.5, 2];
 * scripts/verify.mjs holds each series' target in its own table), a rulebook JSON that still lists
 * `pendingOwner` entries is a draft the keeper refuses outside a rehearsal and the verifier refuses
 * under a published line, the qeth15 series entry, and the wiring of qeth15 into paper-index.yml,
 * leverage-dryrun.yml and the freshness watchdog.
 *
 * Each test states what the code does today. A test that shows a weakness is marked `todo` and
 * asserts the behaviour that would close it, so it fails until the code changes and the run stays
 * green meanwhile. Controls (the same input with the attack removed) sit next to each refusal, so
 * that a refusal is never shown by an input that could not have passed anyway.
 *
 * THROWAWAY values (n = 120 · T = 1.7 for a 1.5 book, n = 120 · T = 2.2 for a 2 book, 30 bp · 6% a
 * year) stand in for the tested values where a dry run needs them; none is a tested value. The live
 * runs use the shipped rulebook values of qeth15 (15 · 2.3 · 30 bp · 4.5%).
 *
 *   node --test keeper/test/leverage-redteam-eth15.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { run, parseArgs, isLocalRpc, INDEXES } from '../leverage-index.mjs';
import { sha256, TARGETS, runDay, rulebookShapeProblem } from '../leverage-step.mjs';
import { checkSeries, SERIES as WATCHED } from '../../scripts/watchdog-series.mjs';
import { REPO, KEEPER_DIR, synthMinutes, fakeBinance, fakeNode, tempRoot, readJsonl, listFiles, dayMs } from './leverage-helpers.mjs';

const VERIFY = path.join(REPO, 'scripts', 'verify.mjs');
const VAULT = getAddress('0x00000000000000000000000000000000000beef1');
const I = '2030-05-02'; // a throwaway inception date for the pinned test roots
const at = (iso) => () => Date.parse(iso);
const T15 = ['--throwaway-check', '120:1.7', '--throwaway-level', '30:6'];
const T2 = ['--throwaway-check', '120:2.2', '--throwaway-level', '30:6'];
const DRAFT_ENTRY = { key: 'fees.managementBps', value: null, decision: 'THROWAWAY test entry, not an owner decision' };
const ANCHORED_TX = `0x${'d'.repeat(64)}`;

/** `count` UTC days of 1-minute ETH bars from `first` (a seeded walk; `shocks[k]` bends day k). */
function days(first, count, { shocks = {}, seed = 41, vol = 0.002 } = {}) {
  const out = [];
  let p0 = 2_500;
  for (let k = 0; k < count; k++) {
    const d = new Date(dayMs(first) + k * 86_400_000).toISOString().slice(0, 10);
    const ms = synthMinutes(d, { seed: seed + k, p0, vol, shock: shocks[k] ?? null });
    out.push(...ms);
    p0 = ms.at(-1).c;
  }
  return out;
}
function deps(root, { minutes, now, key = null, node = null }) {
  const binance = fakeBinance({ ETHUSDT: minutes, BTCUSDT: minutes }, { serverTime: () => now() });
  const logs = [];
  return {
    binance,
    logs,
    d: {
      root, now, binance, env: key ? { KEEPER_PK: key } : {}, log: (m) => logs.push(String(m)), wait: async () => {},
      transport: node ? () => node.transport : undefined, pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 },
    },
  };
}
/** run() with console.error captured (refusals and failures are printed there). */
async function runQuiet(argv, d) {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    return { code: await run(argv, d), err: errs.join('\n') };
  } finally {
    console.error = orig;
  }
}
const rulebookPath = (root, index) => path.join(root, 'keeper', 'rulebooks', `${index}.json`);
const readRulebook = (root, index) => JSON.parse(fs.readFileSync(rulebookPath(root, index), 'utf8'));
const writeRulebook = (root, index, rb) => fs.writeFileSync(rulebookPath(root, index), JSON.stringify(rb, null, 2) + '\n');
/** A stand-in for an anchored decision `id`, effective `date`, whose document pins the rulebook as it is on disk now. */
function pin(root, index, { id = `${I}-${index}-paper-inception`, date = I } = {}) {
  const rbSha = sha256(fs.readFileSync(rulebookPath(root, index)));
  const doc = `# THROWAWAY test decision\n\nPins keeper/rulebooks/${index}.json sha256 ${rbSha}.\n`;
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions', `${id}.md`), doc);
  const entry = { id, file: `decisions/${id}.md`, effectiveFrom: date, sha256: sha256(Buffer.from(doc)), txHash: ANCHORED_TX, anchoredAt: `${date}T00:00:00.000Z` };
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), JSON.stringify(entry) + '\n');
  return { rbSha, entry, doc };
}
const verify = (dir, series, extra = []) => spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', series, '--recompute-only', ...extra], { encoding: 'utf8' });
const rehash = (t) => {
  for (let k = 0; k < t.length; k++) {
    t[k].prevHash = k ? t[k - 1].hash : null;
    const { hash, ...rest } = t[k];
    t[k].hash = sha256(JSON.stringify(rest));
  }
  return t;
};
/** A verify.mjs directory holding `lines` as record-<series>.jsonl (plus optional rulebook / ledger / document). */
function mirror(series, lines, { rulebook = null, ledger = null, doc = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-rt15-'));
  fs.writeFileSync(path.join(dir, `record-${series}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (rulebook) fs.writeFileSync(path.join(dir, `rulebook-${series}.json`), rulebook);
  if (ledger) fs.writeFileSync(path.join(dir, 'decisions.jsonl'), ledger.map((d) => JSON.stringify(d)).join('\n') + '\n');
  if (doc) {
    fs.mkdirSync(path.join(dir, path.dirname(doc.file)), { recursive: true });
    fs.writeFileSync(path.join(dir, doc.file), doc.text);
  }
  return dir;
}
/** Dry-run lines of `index` over 2030-05-02 … 05-04 with THROWAWAY values. */
async function dryLines(index, throwaway, minutes) {
  const root = tempRoot({ index });
  const { d } = deps(root, { minutes, now: at('2030-05-05T00:30:00Z') });
  assert.equal(await run(['--index', index, '--dry-run', '--replay', '2030-05-02..2030-05-04', ...throwaway], d), 0);
  const lines = readJsonl(path.join(root, 'keeper', 'dryrun', `record-${index}.jsonl`));
  assert.equal(lines.length, 3);
  return lines;
}

// ------------------------------------------------------------- the shipped files, as they are

test('shipped files: a ledger entry for the qeth15 inception decision whose document does not name the rulebook sha256 stalls the opening with a refusal (exit 2), not a quiet NOT IN FORCE; once the document names it, the day before is NOT IN FORCE and 2026-10-16 writes the genesis line that verify.mjs accepts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-rt15-real-'));
  fs.mkdirSync(path.join(root, 'keeper'), { recursive: true });
  fs.cpSync(path.join(KEEPER_DIR, 'rulebooks'), path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.copyFileSync(path.join(KEEPER_DIR, 'leverage-gaps.json'), path.join(root, 'keeper', 'leverage-gaps.json'));
  fs.mkdirSync(path.join(root, 'trackrecord', 'decisions'), { recursive: true });
  const id = '2026-10-16-qeth15-paper-inception';
  const docFile = `decisions/${id}.md`;
  const docSrc = fs.readFileSync(path.join(REPO, 'trackrecord', docFile), 'utf8');
  const rb = readRulebook(root, 'qeth15');
  const rbSha = sha256(fs.readFileSync(rulebookPath(root, 'qeth15')));
  assert.equal(rulebookShapeProblem(rb), null);
  assert.deepEqual([rb.inception.date, rb.inception.decision, rb.product.target, rb.pendingOwner], ['2026-10-16', id, 1.5, undefined]);
  // The same test holds before and after the document is pinned: the unpinned form is the shipped text with the
  // rulebook sha256 taken out, the pinned form is the shipped text with it present (added as a stand-in line if absent).
  const unpinned = docSrc.split(rbSha).join('(sha256 not filled)');
  const pinned = docSrc.includes(rbSha) ? docSrc : `${docSrc}\nStand-in pin for this test: keeper/rulebooks/qeth15.json sha256 ${rbSha}\n`;
  assert.ok(!unpinned.includes(rbSha) && pinned.includes(rbSha));

  const ledgerWith = (text) => {
    fs.writeFileSync(path.join(root, 'trackrecord', docFile), text);
    const entry = { id, file: docFile, effectiveFrom: '2026-10-16', sha256: sha256(Buffer.from(text)), txHash: ANCHORED_TX, anchoredAt: '2026-10-14T12:00:00.000Z' };
    fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), JSON.stringify(entry) + '\n');
  };
  const minutes = days('2026-10-15', 2, { seed: 77 });

  // (a) the ledger names a document that does not name the rulebook sha256: refused, nothing written
  ledgerWith(unpinned);
  let before = listFiles(root);
  let r = deps(root, { minutes, now: at('2026-10-16T00:30:00Z'), key: generatePrivateKey() });
  let out = await runQuiet(['--index', 'qeth15', '--anchor'], r.d);
  assert.equal(out.code, 2, out.err);
  assert.match(out.err, new RegExp(`REFUSED: the inception decision ${id} is anchored, but ${id} does not contain the rulebook sha256 ${rbSha} — the series cannot start`));
  assert.deepEqual(listFiles(root), before, 'a file changed');
  assert.equal(r.binance.calls.length, 0, 'the exchange was asked');

  // (b) the pin filled: the day before the inception is NOT IN FORCE (exit 0), nothing written
  ledgerWith(pinned);
  before = listFiles(root);
  r = deps(root, { minutes, now: at('2026-10-15T12:00:00Z') });
  out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 0, out.err);
  assert.match(r.logs.join('\n'), /NOT IN FORCE: inception 2026-10-16/);
  assert.deepEqual(listFiles(root), before, 'a file changed');

  // (c) 2026-10-16 00:30 UTC: the genesis line — a 1.5 book at the last close of 10-15, the shipped rule, the right decision
  r = deps(root, { minutes, now: at('2026-10-16T00:30:00Z') });
  out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 0, out.err);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qeth15.jsonl'));
  assert.equal(lines.length, 1);
  const g = lines[0];
  assert.equal(g.index, 'qETH1.5X');
  assert.equal(g.date, '2026-10-16');
  assert.deepEqual([g.book.A, g.book.C, g.book.E, g.level], [1.5, -0.5, 1, 100]);
  assert.deepEqual(g.rule, { rulebookSha256: rbSha, target: 1.5, reset: 'daily-00:00-utc', checkMinutes: 15, trigger: 2.3, barMinutes: 15, lltv: 0.86, costBp: 30, ratePct: 4.5 });
  assert.equal(g.inception.decision, id);
  assert.equal(g.rehearsal, undefined, 'a published line, no rehearsal mark');
  assert.equal(g.bars[0][0], '23:45');
  const v = verify(path.join(root, 'trackrecord'), 'qeth15');
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /VERIFIED \(recompute only/);
});

// ------------------------------------------------------------- cross-series

test('cross-series: qeth15 lines offered as qETH2X or qBTC2X fail the verifier on index and target; re-labelled as a 2x series they fail on the 1.5 genesis book; qETH2X lines offered as qeth15 fail the same way', async () => {
  const minutes = days('2030-05-01', 4);
  const l15 = await dryLines('qeth15', T15, minutes);
  for (const other of ['qeth2x', 'qbtc2x']) {
    const v = verify(mirror(other, l15), other, ['--allow-rehearsal']);
    assert.equal(v.status, 1, `${other}: ${v.stdout}`);
    assert.match(v.stdout, /index qETH1\.5X, expected q(ETH|BTC)2X/);
    assert.match(v.stdout, /is not a daily-reset 2x rule on 15-minute bars/);
  }
  // re-labelled: index and target say 2x, the book and every slot were computed at 1.5
  const t = structuredClone(l15);
  for (const l of t) {
    l.index = 'qETH2X';
    l.rule = { ...l.rule, target: 2 };
  }
  let v = verify(mirror('qeth2x', rehash(t)), 'qeth2x', ['--allow-rehearsal']);
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stdout, /genesis book .*"A":1\.5,"C":-0\.5.* is not \{A: 2, C: -1, E: 1\}/);
  assert.match(v.stdout, /#1 2030-05-03: (level|book) .*recomputed/);
  // the other way round
  const l2 = await dryLines('qeth2x', T2, minutes);
  v = verify(mirror('qeth15', l2), 'qeth15', ['--allow-rehearsal']);
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stdout, /index qETH2X, expected qETH1\.5X/);
  assert.match(v.stdout, /is not a daily-reset 1\.5x rule on 15-minute bars/);
  // controls: each set under its own series id passes
  assert.equal(verify(mirror('qeth15', l15), 'qeth15', ['--allow-rehearsal']).status, 0);
  assert.equal(verify(mirror('qeth2x', l2), 'qeth2x', ['--allow-rehearsal']).status, 0);
});

test('cross-rulebook: keeper/rulebooks/qeth15.json holding the qETH2X rulebook (ticker qETH2X, target 2) passes the keeper\'s own checks and a decision that pins it, and is stopped only by the recompute (exit 1, nothing written)', async () => {
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const swapped = readRulebook(root, 'qeth2x');
  swapped.inception = { date: I, decision: `${I}-qeth15-paper-inception` };
  writeRulebook(root, 'qeth15', swapped);
  pin(root, 'qeth15');
  const minutes = days('2030-05-01', 2);
  const r = deps(root, { minutes, now: at(`${I}T00:30:00Z`) });
  const out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 1, out.err);
  assert.match(out.err, /independent recompute .* rejected line 2030-05-02 — nothing appended/);
  assert.match(out.err, /index qETH2X, expected qETH1\.5X/);
  assert.match(out.err, /is not a daily-reset 1\.5x rule/);
  assert.equal(fs.existsSync(path.join(root, 'trackrecord', 'record-qeth15.jsonl')), false);
  assert.ok(r.binance.calls.length > 0, 'the keeper had already fetched the day (the ticker is not checked before the recompute)');
  // control: the shipped qeth15 rulebook under the same pin writes the genesis line
  const root2 = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const r2 = deps(root2, { minutes, now: at(`${I}T00:30:00Z`) });
  assert.equal((await runQuiet(['--index', 'qeth15'], r2.d)).code, 0);
  assert.equal(readJsonl(path.join(root2, 'trackrecord', 'record-qeth15.jsonl')).length, 1);
});

test('cross-decision: a qeth15 rulebook whose inception.decision names another index\'s decision (…-qeth2x-paper-inception) passes the keeper\'s ledger check and is stopped by the recompute (exit 1, nothing written)', async () => {
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const rb = readRulebook(root, 'qeth15');
  rb.inception.decision = `${I}-qeth2x-paper-inception`;
  writeRulebook(root, 'qeth15', rb);
  pin(root, 'qeth15', { id: rb.inception.decision });
  const r = deps(root, { minutes: days('2030-05-01', 2), now: at(`${I}T00:30:00Z`) });
  const out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 1, out.err);
  assert.match(out.err, /inception\.decision 2030-05-02-qeth2x-paper-inception is not 2030-05-02-qeth15-paper-inception/);
  assert.equal(fs.existsSync(path.join(root, 'trackrecord', 'record-qeth15.jsonl')), false);
});

// ------------------------------------------------------------- the draft guard

test('pendingOwner, keeper: every non-array form is a shape refusal (exit 2) before the ledger or the exchange is read; an empty array is "nothing pending" and the pinned rulebook runs', async () => {
  const minutes = days('2030-05-01', 2);
  for (const bad of [{}, { 'fees.managementBps': null }, 'fees.managementBps', null, 0, true]) {
    const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
    const rb = readRulebook(root, 'qeth15');
    rb.pendingOwner = bad;
    writeRulebook(root, 'qeth15', rb);
    pin(root, 'qeth15');
    const before = listFiles(root);
    const r = deps(root, { minutes, now: at(`${I}T00:30:00Z`), key: generatePrivateKey() });
    const out = await runQuiet(['--index', 'qeth15', '--anchor'], r.d);
    assert.equal(out.code, 2, `${JSON.stringify(bad)}: exit ${out.code} ${out.err}`);
    assert.match(out.err, /REFUSED: keeper\/rulebooks\/qeth15\.json: pendingOwner must be an array/);
    assert.deepEqual(listFiles(root), before);
    assert.equal(r.binance.calls.length, 0);
  }
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const rb = readRulebook(root, 'qeth15');
  rb.pendingOwner = [];
  writeRulebook(root, 'qeth15', rb);
  pin(root, 'qeth15');
  const r = deps(root, { minutes, now: at(`${I}T00:30:00Z`) });
  assert.equal((await runQuiet(['--index', 'qeth15'], r.d)).code, 0);
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'record-qeth15.jsonl')).length, 1);
});

test('pendingOwner, keeper: an entry that is not an object ([null]) is refused as a shape error (exit 2, naming the file) with nothing written and no request (finding F3, fixed)', async () => {
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const rb = readRulebook(root, 'qeth15');
  rb.pendingOwner = [null];
  writeRulebook(root, 'qeth15', rb);
  pin(root, 'qeth15');
  const before = listFiles(root);
  const r = deps(root, { minutes: days('2030-05-01', 2), now: at(`${I}T00:30:00Z`) });
  const out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.deepEqual(listFiles(root), before, 'a file changed');
  assert.equal(r.binance.calls.length, 0);
  assert.notEqual(out.code, 0);
  // before the fix: exit 1, "Cannot read properties of null"
  assert.equal(out.code, 2);
  assert.match(out.err, /REFUSED: keeper\/rulebooks\/qeth15\.json: pendingOwner entries must be objects with a string key/);
});

test('pendingOwner, verifier: a published qeth15 genesis line pinned to a rulebook with pendingOwner entries fails ("is a draft"); the same rulebook with pendingOwner as an object — which the keeper refuses as a shape error — is refused by the verifier too (finding F4, fixed)', async () => {
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const { d } = deps(root, { minutes: days('2030-05-01', 2), now: at(`${I}T00:30:00Z`) });
  assert.equal(await run(['--index', 'qeth15'], d), 0);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qeth15.jsonl'));
  assert.equal(lines.length, 1);
  const [d0] = readJsonl(path.join(root, 'trackrecord', 'decisions.jsonl'));
  const pinnedTo = (pendingOwner) => {
    const rb = readRulebook(root, 'qeth15');
    rb.pendingOwner = pendingOwner;
    const rbBytes = Buffer.from(JSON.stringify(rb, null, 2) + '\n');
    const text = `# THROWAWAY test decision\n\nPins keeper/rulebooks/qeth15.json sha256 ${sha256(rbBytes)}.\n`;
    const ledger = [{ ...d0, sha256: sha256(Buffer.from(text)) }];
    const t = structuredClone(lines);
    for (const l of t) {
      l.rule = { ...l.rule, rulebookSha256: sha256(rbBytes) };
      l.inception = { ...l.inception, decisionSha256: ledger[0].sha256 };
    }
    return verify(mirror('qeth15', rehash(t), { rulebook: rbBytes, ledger, doc: { file: d0.file, text } }), 'qeth15');
  };
  // control: the shipped rulebook (no pendingOwner) passes
  let v = verify(mirror('qeth15', lines, { rulebook: fs.readFileSync(rulebookPath(root, 'qeth15')), ledger: [d0], doc: { file: d0.file, text: fs.readFileSync(path.join(root, 'trackrecord', d0.file), 'utf8') } }), 'qeth15');
  assert.equal(v.status, 0, v.stdout);
  // an array with an entry: the draft is refused, and for that reason only
  v = pinnedTo([DRAFT_ENTRY]);
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stdout, /FAIL {2}QETH1\.5X #0 2030-05-02: rulebook JSON is a draft — it still lists 1 pending owner decision\(s\)/);
  assert.match(v.stdout, /FAILED — 1 check\(s\) failed/);
  // the object form: the keeper refuses it (shape), and so does the verifier (before the fix: VERIFIED)
  const root2 = tempRoot({ index: 'qeth15' });
  const rb2 = readRulebook(root2, 'qeth15');
  rb2.pendingOwner = { 'fees.managementBps': null };
  assert.match(rulebookShapeProblem(rb2), /pendingOwner must be an array/);
  v = pinnedTo({ 'fees.managementBps': null });
  assert.equal(v.status, 1, `the verifier accepted a rulebook the keeper refuses:\n${v.stdout}`);
  assert.match(v.stdout, /rulebook JSON is a draft/);
});

test('rehearsal flag: isLocalRpc reads the host as a URL parser does — a URL whose userinfo is 127.0.0.1 or localhost while its host is elsewhere is not local, so --rpc http://127.0.0.1:1@host/ --from 0x… is refused (finding F5, fixed)', () => {
  const from = privateKeyToAccount(generatePrivateKey()).address;
  for (const rpc of ['http://127.0.0.1:1@rpc.example/', 'http://localhost:1@rpc.example/']) {
    assert.equal(new URL(rpc).hostname, 'rpc.example');
    assert.equal(isLocalRpc(rpc), false, rpc);
    assert.throws(() => parseArgs(['--index', 'qeth15', '--rpc', rpc, '--from', from]), /--from is for an unlocked account on a local fork/);
  }
  // control: a local fork URL is still local
  for (const rpc of ['http://127.0.0.1:8545', 'http://localhost:8545/', 'http://[::1]:8545']) {
    assert.equal(isLocalRpc(rpc), true, rpc);
    const o = parseArgs(['--index', 'qeth15', '--rpc', rpc, '--from', from]);
    assert.equal(o.fork, true);
    assert.equal(o.rehearsalMode, true);
  }
});

// ------------------------------------------------------------- opening before time

test('NOT IN FORCE edges: the second before the inception day, and a source that has not closed the first bar of the day, write nothing (exit 0); an inception.date edited away from the anchored decision is a refusal (exit 2); a ledger without the decision is NOT IN FORCE (exit 0)', async () => {
  const minutes = days('2030-05-01', 2);
  // (a) one second before I 00:00 UTC
  let root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  let before = listFiles(root);
  let r = deps(root, { minutes, now: at('2030-05-01T23:59:59Z') });
  let out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 0, out.err);
  assert.match(r.logs.join('\n'), /NOT IN FORCE: inception 2030-05-02/);
  assert.deepEqual(listFiles(root), before);
  assert.equal(r.binance.calls.length, 0);
  // (b) I 00:00:30 on the runner, but the source has no closed bar at or after I 00:00 yet
  r = deps(root, { minutes: minutes.filter((m) => m.openMs < dayMs(I)), now: at(`${I}T00:00:30Z`) });
  out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 0, out.err);
  assert.match(r.logs.join('\n'), /2030-05-01 not final .* line 2030-05-02 not written/);
  assert.deepEqual(listFiles(root), before);
  // (c) inception.date moved a day earlier than the anchored decision's effectiveFrom
  root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const rb = readRulebook(root, 'qeth15');
  rb.inception.date = '2030-05-01';
  writeRulebook(root, 'qeth15', rb);
  const { entry, doc } = pin(root, 'qeth15'); // re-pinned so that the sha256 matches and only the date differs
  assert.equal(entry.effectiveFrom, I);
  assert.ok(doc.includes(sha256(fs.readFileSync(rulebookPath(root, 'qeth15')))));
  before = listFiles(root);
  r = deps(root, { minutes, now: at('2030-05-01T00:30:00Z') });
  out = await runQuiet(['--index', 'qeth15'], r.d);
  assert.equal(out.code, 2, out.err);
  assert.match(out.err, /is anchored, but decision .* is effective from 2030-05-02, rulebook inception.date is 2030-05-01 — the series cannot start/);
  assert.deepEqual(listFiles(root), before);
  // (d) no ledger entry at all
  root = tempRoot({ index: 'qeth15' });
  before = listFiles(root);
  r = deps(root, { minutes, now: at('2030-05-03T00:30:00Z') });
  out = await runQuiet(['--index', 'qeth15', '--anchor'], r.d);
  assert.equal(out.code, 0, out.err);
  assert.match(r.logs.join('\n'), /NOT IN FORCE: decision not anchored/);
  assert.deepEqual(listFiles(root), before);
  // control: at I 00:30 with the first bar of I closed, the genesis line is written
  root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  r = deps(root, { minutes, now: at(`${I}T00:30:00Z`) });
  assert.equal((await runQuiet(['--index', 'qeth15'], r.d)).code, 0);
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'record-qeth15.jsonl')).length, 1);
});

// ------------------------------------------------------------- the target

test('target: the trigger must sit above the series\' own target (1.7 for qeth15 is accepted, 1.5 is not; 1.7 for qbtc2x is not); an index id in another spelling is refused', async () => {
  const minutes = days('2030-05-01', 4);
  const root = tempRoot({ index: 'qeth15' });
  const { d } = deps(root, { minutes, now: at('2030-05-05T00:30:00Z') });
  let out = await runQuiet(['--index', 'qeth15', '--dry-run', '--replay', '2030-05-02..2030-05-02', '--throwaway-check', '120:1.5', '--throwaway-level', '30:6'], d);
  assert.equal(out.code, 2);
  assert.match(out.err, /REFUSED: check\.trigger — must be a number above product\.target 1\.5 \(got 1\.5\)/);
  out = await runQuiet(['--index', 'qbtc2x', '--dry-run', '--replay', '2030-05-02..2030-05-02', '--throwaway-check', '120:1.7', '--throwaway-level', '30:6'], d);
  assert.equal(out.code, 2);
  assert.match(out.err, /above product\.target 2 \(got 1\.7\)/);
  for (const id of ['QETH15', 'qeth1.5x', 'qETH1.5X', 'qeth1']) {
    out = await runQuiet(['--index', id, '--dry-run', '--replay', '2030-05-02..2030-05-02', ...T15], d);
    assert.equal(out.code, 2, id);
    assert.match(out.err, /--index must be one of qbtc2x, qeth2x, qeth15/);
  }
  assert.equal(fs.existsSync(path.join(root, 'keeper', 'dryrun')), false, 'nothing written by the refused runs');
});

test('target: a qETH2X rulebook that says 1.5 and a qeth15 rulebook that says 2 both pass the keeper\'s shape check (TARGETS) and are stopped by the verifier\'s table — no line written (exit 1)', async () => {
  assert.deepEqual(TARGETS, [1.5, 2]);
  const minutes = days('2030-05-01', 4);
  for (const [index, target, throwaway, want] of [['qeth2x', 1.5, T15, /is not a daily-reset 2x rule/], ['qeth15', 2, T2, /is not a daily-reset 1\.5x rule/]]) {
    const root = tempRoot({ index });
    const rb = readRulebook(root, index);
    rb.product.target = target;
    writeRulebook(root, index, rb);
    assert.equal(rulebookShapeProblem(rb), null, `${index} at ${target} passes the shape check`);
    const { d } = deps(root, { minutes, now: at('2030-05-05T00:30:00Z') });
    const out = await runQuiet(['--index', index, '--dry-run', '--replay', '2030-05-02..2030-05-04', ...throwaway], d);
    assert.equal(out.code, 1, `${index}: ${out.err}`);
    assert.match(out.err, /rejected line 2030-05-02 — nothing appended/);
    assert.match(out.err, want);
    assert.equal(readJsonl(path.join(root, 'keeper', 'dryrun', `record-${index}.jsonl`)).length, 0);
  }
});

test('arithmetic at 1.5: the trigger and the model liquidation follow from the target, nothing is fixed at 2 — the same bar liquidates a 2 book and only triggers a 1.5 book; a 1.5 book liquidates at a deeper low', () => {
  const p = { minutes: 15, trigger: 2.3, lltv: 0.86, costBp: 0, ratePct: 0 };
  const book = (target) => ({ A: target, C: 1 - target, E: 1, lastBar: '2030-05-01T23:45', lastClose: 100 });
  const bar = (hhmm, { o, h, l, c }) => ({ openMs: Date.parse(`2030-05-02T${hhmm}:00Z`), o, h, l, c, n1m: 15 });
  // low 58 (−42%), close 60, then a flat bar to the day's end
  const barsA = [bar('00:00', { o: 100, h: 100, l: 58, c: 60 }), bar('00:15', { o: 60, h: 60, l: 60, c: 60 })];
  const two = runDay(book(2), barsA, { ...p, target: 2 });
  assert.ok(two.liquidated, 'a 2 book: debt 1 against 2 × 0.58 = 1.16 → LTV 0.862 ≥ 0.86');
  assert.equal(two.liquidated.ltvLow, 0.862069);
  const onehalf = runDay(book(1.5), barsA, { ...p, target: 1.5 });
  assert.equal(onehalf.liquidated, null, 'a 1.5 book: debt 0.5 against 1.5 × 0.58 = 0.87 → LTV 0.575');
  // after the close at 60: A = 0.9, E = 0.4, λ = 2.25 — just under T; at the day's end it is reset to 1.5
  assert.equal(onehalf.slots[0].action, 'none');
  assert.equal(onehalf.slots[0].lambdaBefore, 2.25);
  assert.equal(onehalf.slots.at(-1).action, 'reset');
  assert.equal(onehalf.slots.at(-1).lambdaAfter, 1.5);
  // close 59: A = 0.885, E = 0.385, λ = 2.2987… still none; close 58: A = 0.87, E = 0.37, λ = 2.3514 → trigger back to 1.5
  const barsB = [bar('00:00', { o: 100, h: 100, l: 58, c: 58 }), bar('00:15', { o: 58, h: 58, l: 58, c: 58 })];
  const trig = runDay(book(1.5), barsB, { ...p, target: 1.5 });
  assert.equal(trig.liquidated, null);
  assert.equal(trig.slots[0].action, 'trigger');
  assert.equal(trig.slots[0].lambdaBefore, 2.351351);
  assert.equal(trig.slots[0].lambdaAfter, 1.5);
  assert.equal(trig.stats.triggers, 1);
  // a 1.5 book liquidates at a low of 38 (−62%): debt 0.5 against 1.5 × 0.38 = 0.57 → LTV 0.877
  const barsC = [bar('00:00', { o: 100, h: 100, l: 38, c: 40 }), bar('00:15', { o: 40, h: 40, l: 40, c: 40 })];
  const liq = runDay(book(1.5), barsC, { ...p, target: 1.5 });
  assert.ok(liq.liquidated);
  assert.equal(liq.liquidated.ltvLow, 0.877193);
  assert.equal(liq.E, 0);
});

// ------------------------------------------------------------- watching and wiring

test('watchdog: qeth15 is watched — pending until 16 h after its inception day begins, then "no record" is a problem; a written series goes stale after 40 h; the qeth2x pattern does not claim the qeth15 decision', () => {
  assert.ok(WATCHED.includes('qeth15'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-rt15-wd-'));
  const id = '2026-10-16-qeth15-paper-inception';
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ id, file: `decisions/${id}.md`, effectiveFrom: '2026-10-16', sha256: 'e'.repeat(64), txHash: ANCHORED_TX, anchoredAt: '2026-10-14T12:00:00.000Z' }) + '\n');
  let r = checkSeries({ dir, now: Date.parse('2026-10-16T10:00:00Z'), series: ['qeth15', 'qeth2x'] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, ['qeth15 pending (inception 2026-10-16)', 'qeth2x not started']);
  r = checkSeries({ dir, now: Date.parse('2026-10-16T17:00:00Z'), series: ['qeth15'] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^qeth15: no record-qeth15\.jsonl 17\.0h after its inception 2026-10-16 00:00 UTC \(decision 2026-10-16-qeth15-paper-inception\)/);
  const lines = [{ seq: 0, date: '2026-10-16', hash: 'a'.repeat(64) }, { seq: 1, date: '2026-10-17', hash: 'b'.repeat(64) }];
  fs.writeFileSync(path.join(dir, 'record-qeth15.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'anchors-qeth15.jsonl'), lines.map((l) => JSON.stringify({ date: l.date, seq: l.seq, headHash: l.hash, txHash: ANCHORED_TX })).join('\n') + '\n');
  r = checkSeries({ dir, now: Date.parse('2026-10-18T15:00:00Z'), series: ['qeth15'] });
  assert.deepEqual(r.problems, [], '39 h after 10-17 began');
  r = checkSeries({ dir, now: Date.parse('2026-10-18T17:00:00Z'), series: ['qeth15'] });
  assert.match(r.problems[0], /^qeth15: stale — latest line is 2026-10-17 \(seq 1\), 41\.0h/);
});

test('verifier states for qeth15: no file and no decision = not started (exit 0); a decision effective in the future and no file = pending (exit 0); a decision effective in the past and no file = FAIL (exit 1)', () => {
  const ledger = (date) => [{ id: `${date}-qeth15-paper-inception`, file: `decisions/${date}-qeth15-paper-inception.md`, effectiveFrom: date, sha256: 'e'.repeat(64), txHash: ANCHORED_TX, anchoredAt: `${date}T00:00:00.000Z` }];
  let dir = mirror('qeth15', []);
  fs.rmSync(path.join(dir, 'record-qeth15.jsonl'));
  let v = verify(dir, 'qeth15');
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /\[QETH1\.5X\] not started — no record-qeth15\.jsonl and no inception decision/);
  dir = mirror('qeth15', [], { ledger: ledger('2099-01-01') });
  fs.rmSync(path.join(dir, 'record-qeth15.jsonl'));
  v = verify(dir, 'qeth15');
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /\[QETH1\.5X\] pending — inception decision 2099-01-01-qeth15-paper-inception/);
  dir = mirror('qeth15', [], { ledger: ledger('2020-01-01') });
  fs.rmSync(path.join(dir, 'record-qeth15.jsonl'));
  v = verify(dir, 'qeth15');
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stdout, /FAIL {2}QETH1\.5X: inception decision 2020-01-01-qeth15-paper-inception \(effective 2020-01-01\) is anchored but record-qeth15\.jsonl is missing/);
  // an empty file after the decision is the same failure (not "0 records VERIFIED")
  dir = mirror('qeth15', [], { ledger: ledger('2020-01-01') });
  v = verify(dir, 'qeth15');
  assert.equal(v.status, 1, v.stdout);
});

test('wiring: paper-index.yml runs the qeth15 leg after qBTC2X with its own 20-minute limit on the same not-cancelled condition, stages its three files in "Commit records", and tails its log in the failure alert; leverage-dryrun.yml offers qeth15; the three tables (keeper INDEXES, verify.mjs, watchdog) and the rulebook agree', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'paper-index.yml'), 'utf8');
  const steps = [...wf.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  const idx = (re) => steps.findIndex((s) => re.test(s));
  const iBtc = idx(/^qBTC2X — compute/), iEth2 = idx(/^qETH2X — held/), iEth15 = idx(/^qETH1\.5X — compute/), iX20 = idx(/^qX20 — mark/), iCommit = idx(/^Commit records/), iAlert = idx(/Alert on failure|failure/i);
  assert.ok(iBtc >= 0 && iEth2 > iBtc && iEth15 > iEth2 && iX20 > iEth15 && iCommit > iX20 && iAlert > iCommit, `step order: ${steps.join(' | ')}`);
  const eth15 = wf.slice(wf.indexOf('- name: qETH1.5X — compute'), wf.indexOf('- name: qX20 — mark'));
  assert.match(eth15, /if: \$\{\{ !cancelled\(\) && steps\.deps\.outcome == 'success' \}\}/);
  assert.match(eth15, /timeout-minutes: 20/);
  assert.match(eth15, /node keeper\/leverage-index\.mjs --index qeth15 --anchor 2>&1 \| tee pi-qeth15\.log/);
  assert.match(eth15, /KEEPER_PK: \$\{\{ secrets\.KEEPER_PK \}\}/);
  assert.doesNotMatch(eth15, /--dry-run|--replay|--throwaway|--rpc|--from/);
  const eth2 = wf.slice(wf.indexOf('- name: qETH2X — held'), wf.indexOf('- name: qETH1.5X — compute'));
  assert.match(eth2, /if: \$\{\{ false \}\}/, 'qETH2X stays switched off');
  const commit = wf.slice(wf.indexOf('- name: Commit records'), wf.indexOf('- name:', wf.indexOf('- name: Commit records') + 10));
  assert.match(commit, /trackrecord\/record-qeth15\.jsonl trackrecord\/anchors-qeth15\.jsonl keeper\/marks-qeth15\.jsonl/);
  assert.match(commit, /git rebase origin\/main/);
  assert.match(wf, /tail -n 40 pi-qeth15\.log/);
  assert.match(wf, /group: keeper-key/);
  const dry = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'leverage-dryrun.yml'), 'utf8');
  assert.match(dry, /options: \[qbtc2x, qeth2x, qeth15\]/);
  assert.match(dry, /KEEPER_PK is set — a dry run must not be able to sign/);
  // the tables
  assert.deepEqual(INDEXES, ['qbtc2x', 'qeth2x', 'qeth15']);
  assert.deepEqual(WATCHED.slice(-3), INDEXES);
  const src = fs.readFileSync(VERIFY, 'utf8');
  const table = Object.fromEntries([...src.matchAll(/^ {2}(q\w+): \{ label: '([^']+)', records: 'record-(\w+)\.jsonl'.*leverage: \{ index: '(\w+)', ticker: '([^']+)', symbol: '(\w+)', target: ([\d.]+) \} \},$/gm)].map((m) => [m[1], { label: m[2], file: m[3], index: m[4], ticker: m[5], symbol: m[6], target: Number(m[7]) }]));
  assert.deepEqual(Object.keys(table), INDEXES);
  for (const ix of INDEXES) {
    const rb = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'rulebooks', `${ix}.json`), 'utf8'));
    assert.equal(table[ix].index, ix);
    assert.equal(table[ix].file, ix);
    assert.deepEqual([table[ix].ticker, table[ix].symbol, table[ix].target], [rb.ticker, rb.underlying.symbol, rb.product.target], ix);
    assert.ok(TARGETS.includes(rb.product.target));
    assert.equal(rb.inception?.decision, rb.inception?.date ? `${rb.inception.date}-${ix}-paper-inception` : rb.inception?.decision, ix);
  }
  assert.equal(table.qeth15.label, 'QETH1.5X');
});

// ------------------------------------------------------------- qBTC2X under the changed files

test('qBTC2X under the changed files: the qBTC2X inception decision pins keeper/leverage-index.mjs, keeper/leverage-step.mjs and scripts/verify.mjs by sha256 at a commit; the files at that commit and the files here give the same 2x book, check log and level on the same bars, both verifiers accept the series, and the recorded qBTC2X lines verify under the files here', async (t) => {
  const doc = fs.readFileSync(path.join(REPO, 'trackrecord', 'decisions', '2026-10-13-qbtc2x-paper-inception.md'), 'utf8').replace(/\s+/g, ' ');
  const pinOf = (file) => new RegExp('`' + file.replace(/[./]/g, (c) => `\\${c}`) + '` \\(sha256 `([0-9a-f]{64})`\\)').exec(doc)?.[1];
  const files = ['keeper/leverage-index.mjs', 'keeper/leverage-step.mjs', 'scripts/verify.mjs'];
  const pins = Object.fromEntries(files.map((f) => [f, pinOf(f)]));
  const commit = /`scripts\/verify\.mjs` \(sha256 `[0-9a-f]{64}`\), at commit `([0-9a-f]{40})`/.exec(doc)?.[1];
  assert.ok(commit && files.every((f) => pins[f]), 'the decision names the three files and the commit');
  for (const f of files) {
    const now = sha256(fs.readFileSync(path.join(REPO, f)));
    t.diagnostic(`${f}: pinned ${pins[f].slice(0, 12)}…, here ${now.slice(0, 12)}…${now === pins[f] ? ' (same)' : ' (changed)'}`);
  }
  const show = (f) => spawnSync('git', ['-C', REPO, 'show', `${commit}:${f}`], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const probe = show('keeper/leverage-step.mjs');
  if (probe.status !== 0) {
    t.skip(`commit ${commit.slice(0, 12)} is not in this checkout (a shallow clone)`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-rt15-pinned-'));
  for (const f of ['keeper/leverage-step.mjs', 'scripts/verify.mjs']) {
    const bytes = show(f).stdout;
    assert.equal(sha256(bytes), pins[f], `${f} at ${commit.slice(0, 12)} is the pinned file`);
    fs.writeFileSync(path.join(dir, path.basename(f)), bytes);
  }
  const oldStep = await import(new URL(`file://${path.join(dir, 'leverage-step.mjs')}`).href);
  const newStep = await import('../leverage-step.mjs');

  // a qBTC2X series in a throwaway root under the shipped qBTC2X values (120 minutes · 2.2 · 30 bp · 4.5%),
  // four days, the third with a fall of about a tenth between 09:00 and 11:00 UTC (triggers at 2.2)
  const minutes = days('2030-05-01', 5, { shocks: { 3: (m, r) => (m >= 540 && m < 660 ? r - 0.12 / 120 : r) } });
  const root = tempRoot({ index: 'qbtc2x', fill: {}, inception: I });
  const r = deps(root, { minutes, now: at('2030-05-05T00:30:00Z') });
  assert.equal((await runQuiet(['--index', 'qbtc2x'], r.d)).code, 0);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 4);
  assert.ok(lines.some((l) => l.dayStats.triggers > 0), 'a trigger day is in the series');
  for (let k = 1; k < lines.length; k++) {
    const day = new Date(dayMs(lines[k].date) - 86_400_000).toISOString().slice(0, 10);
    const bars = lines[k].bars.map(([hm, o, h, l, c, n1m]) => ({ openMs: Date.parse(`${day}T${hm}:00Z`), o, h, l, c, n1m }));
    const a = oldStep.computeDay(lines[k - 1], bars, lines[k].rule);
    const b = newStep.computeDay(lines[k - 1], bars, lines[k].rule);
    assert.deepEqual(b, a, `${lines[k].date}: the day differs between the pinned and the changed files`);
    assert.equal(newStep.levelOf(b.primary.E), lines[k].level);
  }
  assert.deepEqual(newStep.genesisBook(2, { openMs: dayMs(I) - 900_000, c: 100 }), oldStep.genesisBook(2, { openMs: dayMs(I) - 900_000, c: 100 }));
  // both verifiers accept the series; both reject it with one level changed
  const tr = path.join(root, 'trackrecord');
  const oldVerify = (d) => spawnSync(process.execPath, [path.join(dir, 'verify.mjs'), '--dir', d, '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
  const newVerify = (d) => spawnSync(process.execPath, [VERIFY, '--dir', d, '--series', 'qbtc2x', '--recompute-only'], { encoding: 'utf8' });
  assert.equal(oldVerify(tr).status, 0, oldVerify(tr).stdout);
  assert.equal(newVerify(tr).status, 0, newVerify(tr).stdout);
  const bent = structuredClone(lines);
  bent[2].level = Number((bent[2].level + 0.000001).toFixed(6));
  fs.writeFileSync(path.join(tr, 'record-qbtc2x.jsonl'), rehash(bent).map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(oldVerify(tr).status, 1);
  assert.equal(newVerify(tr).status, 1);
  // the qBTC2X lines recorded in this repository verify under the files here
  if (fs.existsSync(path.join(REPO, 'trackrecord', 'record-qbtc2x.jsonl'))) {
    const v = newVerify(path.join(REPO, 'trackrecord'));
    assert.equal(v.status, 0, v.stdout);
    t.diagnostic(`recorded qBTC2X lines: ${readJsonl(path.join(REPO, 'trackrecord', 'record-qbtc2x.jsonl')).length}`);
  }
});

test('qBTC2X pins: every file the qBTC2X inception decision pins by sha256 either still has that sha256 here, or an anchored decision in trackrecord/decisions.jsonl names both the pinned and the current sha256 (a stated re-pin)', { todo: 'medium: the three shared files change under a running series; the anchored qBTC2X text names the earlier bytes and no anchored decision names the new ones yet' }, () => {
  const doc = fs.readFileSync(path.join(REPO, 'trackrecord', 'decisions', '2026-10-13-qbtc2x-paper-inception.md'), 'utf8').replace(/\s+/g, ' ');
  const ledger = readJsonl(path.join(REPO, 'trackrecord', 'decisions.jsonl')).filter((d) => /^0x[0-9a-f]{64}$/i.test(d.txHash ?? ''));
  const texts = ledger.map((d) => {
    try {
      return fs.readFileSync(path.join(REPO, 'trackrecord', d.file), 'utf8');
    } catch {
      return '';
    }
  });
  const open = [];
  for (const f of ['keeper/leverage-index.mjs', 'keeper/leverage-step.mjs', 'scripts/verify.mjs', 'keeper/rulebooks/qbtc2x.json']) {
    const pinned = new RegExp('`' + f.replace(/[./]/g, (c) => `\\${c}`) + '` \\(sha256 `([0-9a-f]{64})`\\)').exec(doc)?.[1];
    assert.ok(pinned, `${f} is pinned by the qBTC2X inception decision`);
    const here = sha256(fs.readFileSync(path.join(REPO, f)));
    if (here !== pinned && !texts.some((t) => t.includes(pinned) && t.includes(here))) open.push(`${f}: pinned ${pinned.slice(0, 12)}…, here ${here.slice(0, 12)}…`);
  }
  assert.deepEqual(open, []);
});

// ------------------------------------------------------------- the copy the website serves

/** A static server shaped like the website's mirror: a missing file is answered with the app page at HTTP 200. */
async function staticMirror(dir) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/trackrecord\//, '');
    const p = path.join(dir, name);
    if (p.startsWith(dir + path.sep) && fs.existsSync(p) && fs.statSync(p).isFile()) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(p));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>app</title></head><body></body></html>');
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}
const verifyBase = (base, series) =>
  new Promise((ok) => {
    const child = spawn(process.execPath, [VERIFY, '--base', base, '--series', series, '--recompute-only'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (status) => ok({ status, stdout: out }));
  });

test('the website copy: verify.mjs --base needs record-qeth15.jsonl and rulebook-qeth15.json next to decisions.jsonl — without the rulebook every published line fails as "a rulebook changed after inception", without the record the series fails once its inception day has passed; with both it passes', async () => {
  // an inception day already in the past on the verifier's own clock (it reads the real date)
  const P = '2026-09-02';
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: P });
  const r = deps(root, { minutes: days('2026-09-01', 3), now: at('2026-09-03T00:30:00Z') });
  assert.equal((await runQuiet(['--index', 'qeth15'], r.d)).code, 0);
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'record-qeth15.jsonl')).length, 2);
  const site = (omit) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-rt15-site-'));
    fs.cpSync(path.join(root, 'trackrecord'), dir, { recursive: true });
    fs.copyFileSync(rulebookPath(root, 'qeth15'), path.join(dir, 'rulebook-qeth15.json'));
    for (const f of omit) fs.rmSync(path.join(dir, f));
    return dir;
  };
  for (const [omit, status, want] of [
    [[], 0, /VERIFIED \(recompute only/],
    [['rulebook-qeth15.json'], 1, /FAIL {2}QETH1\.5X #0 2026-09-02: rule\.rulebookSha256 [0-9a-f]{12}… is not the rulebook JSON's [0-9a-f]{12}… \(a rulebook changed after inception needs its own decision\)/],
    [['record-qeth15.jsonl'], 1, /FAIL {2}QETH1\.5X: inception decision 2026-09-02-qeth15-paper-inception \(effective 2026-09-02\) is anchored but record-qeth15\.jsonl is missing/],
  ]) {
    const m = await staticMirror(site(omit));
    try {
      const v = await verifyBase(m.base, 'qeth15');
      assert.equal(v.status, status, `${omit.join(', ') || 'complete copy'}: ${v.stdout}`);
      assert.match(v.stdout, want);
    } finally {
      await m.close();
    }
  }
});

// ------------------------------------------------------------- what the live leg writes, and a draft before its day

test('the live leg writes only files that "Commit records" stages (a tracked file outside that list would stop the push of every series); a draft qeth15 rulebook before any decision is a refusal (exit 2) every run, not NOT IN FORCE; draft dry-run lines placed in trackrecord/ fail the public verifier', async () => {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'paper-index.yml'), 'utf8');
  const start = wf.indexOf('- name: Commit records');
  const commit = wf.slice(start, wf.indexOf('- name:', start + 10));
  const key = generatePrivateKey();
  const root = tempRoot({ index: 'qeth15', fill: {}, inception: I });
  const before = new Map(listFiles(root));
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address, symbol: 'qETH1.5X' });
  const r = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:30:00Z'), key, node });
  const out = await runQuiet(['--index', 'qeth15', '--anchor'], r.d);
  assert.equal(out.code, 0, out.err);
  const changed = listFiles(root).filter(([p, body]) => before.get(p) !== body).map(([p]) => p.split(path.sep).join('/'));
  assert.deepEqual(changed.sort(), ['trackrecord/anchors-qeth15.jsonl', 'trackrecord/record-qeth15.jsonl']);
  for (const p of changed) assert.ok(commit.includes(p), `${p} is not staged by "Commit records"`);
  assert.equal(node.anchorsOf().filter((a) => a.startsWith('qxpi-qeth15:')).length, 2);

  // a draft rulebook, no decision in the ledger, before its date: exit 2 (the job fails) on every run
  const root2 = tempRoot({ index: 'qeth15' });
  const rb = readRulebook(root2, 'qeth15');
  rb.pendingOwner = [DRAFT_ENTRY];
  writeRulebook(root2, 'qeth15', rb);
  const before2 = listFiles(root2);
  for (const now of ['2026-10-14T00:25:00Z', '2026-10-15T00:25:00Z']) {
    const r2 = deps(root2, { minutes: days('2030-05-01', 2), now: at(now) });
    const o2 = await runQuiet(['--index', 'qeth15', '--anchor'], r2.d);
    assert.equal(o2.code, 2, now);
    assert.match(o2.err, /qeth15\.json is a draft/);
    assert.equal(r2.binance.calls.length, 0);
  }
  assert.deepEqual(listFiles(root2), before2);
  // the same draft in a dry run writes rehearsal lines; placed in trackrecord/ they fail without --allow-rehearsal
  const r3 = deps(root2, { minutes: days('2030-05-01', 3), now: at('2030-05-04T00:30:00Z') });
  assert.equal(await run(['--index', 'qeth15', '--dry-run', '--replay', '2030-05-02..2030-05-03', ...T15], r3.d), 0);
  const dry = readJsonl(path.join(root2, 'keeper', 'dryrun', 'record-qeth15.jsonl'));
  assert.equal(dry.length, 2);
  const v = verify(mirror('qeth15', dry), 'qeth15');
  assert.equal(v.status, 1);
  assert.match(v.stdout, /marked as a rehearsal \("THROWAWAY n=120 T=1\.7 costBp=30 ratePct=6"\) — not a published series line/);
});

test('README: the --series list of scripts/verify.mjs names every series the verifier knows, qeth15 included (finding F6, fixed)', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const listed = new Set([...readme.slice(readme.indexOf('--series')).slice(0, 600).matchAll(/`(\w+)`/g)].map((m) => m[1]));
  const known = [...fs.readFileSync(VERIFY, 'utf8').matchAll(/^ {2}(\w+): \{ label: /gm)].map((m) => m[1]);
  assert.ok(known.includes('qeth15'));
  assert.deepEqual(known.filter((k) => !listed.has(k)), []);
});
