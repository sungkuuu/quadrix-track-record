/**
 * The ETH 1.5x series (qETH1.5X, index qeth15) on the stage A leg — offline.
 *
 * (1) The shipped rulebook carries the owner's values (15 minutes, 2.3,
 *     30 bp · 4.5%, fee 1%, inception 2026-10-16) and no pending decision;
 *     until its inception decision is in the ledger a live run stops with
 *     NOT IN FORCE (exit 0) — no file written, no exchange or chain request.
 *     The draft guard itself is covered by leverage-draft.test.mjs.
 * (2) A dry run with THROWAWAY values (n = 120 · T = 1.7, 30 bp · 6% a year;
 *     none is a tested value) on synthetic ETH days: λ* = 1.5 reaches the book
 *     from the rulebook alone — genesis {A: 1.5, C: −0.5, E: 1}, every reset
 *     and trigger trades back to 1.5, a trigger fires at λ ≥ T on the crash
 *     day. scripts/verify.mjs accepts the lines as qeth15 and rejects them
 *     once their rule says target 2 (it holds each series' target itself).
 *     With 0 bp · 0% and no trigger, each day's level is the previous level ×
 *     (1 + 1.5 × the day's ETH close-to-close return).
 *
 *   node --test keeper/test/leverage-eth15.test.mjs
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
import { rulebookShapeProblem, ruleProblem, sha256 } from '../leverage-step.mjs';
import { REPO, KEEPER_DIR, synthMinutes, fakeBinance, fakeNode, tempRoot, readJsonl, listFiles, dayMs } from './leverage-helpers.mjs';

const VERIFY = path.join(REPO, 'scripts', 'verify.mjs');
const VAULT = getAddress('0x00000000000000000000000000000000000beef1');
const at = (iso) => () => Date.parse(iso);

function days(first, count, { shocks = {}, seed = 21, vol = 0.002 } = {}) {
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
const crash = (pct, a = 540, b = 660) => (m, r) => (m >= a && m < b ? r - pct / (b - a) : r);

function deps(root, { minutes, now, key = null, node = null }) {
  const binance = fakeBinance({ ETHUSDT: minutes }, { serverTime: () => now() });
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

/** run() with console.error captured (a refusal is printed there). */
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

test('qeth15: the shipped rulebook has the owner values and no pending decision; before its inception decision is anchored a live run stops with NOT IN FORCE (exit 0), nothing written, no exchange or chain request', async () => {
  const rb = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'rulebooks', 'qeth15.json'), 'utf8'));
  assert.equal(rulebookShapeProblem(rb), null, 'the rulebook has the shape the code relies on');
  assert.equal(rb.ticker, 'qETH1.5X');
  assert.equal(rb.product.target, 1.5);
  assert.deepEqual([rb.check.minutes, rb.check.trigger, rb.level.primary, rb.fees.managementBps, rb.inception.date, rb.inception.decision], [15, 2.3, { costBp: 30, ratePct: 4.5 }, 100, '2026-10-16', '2026-10-16-qeth15-paper-inception']);
  assert.equal(ruleProblem({ target: rb.product.target, minutes: rb.check.minutes, trigger: rb.check.trigger, primary: rb.level.primary }), null);
  assert.equal(rb.pendingOwner, undefined, 'no owner decision is pending');

  const root = tempRoot({ index: 'qeth15' }); // decisions.jsonl is empty: the inception decision is not anchored
  const before = listFiles(root);
  const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(generatePrivateKey()).address, symbol: 'qETH1.5X' });
  const { d, binance, logs } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-03T00:30:00Z'), key: generatePrivateKey(), node });
  const { code, err } = await runQuiet(['--index', 'qeth15', '--anchor'], d);
  assert.equal(code, 0, err);
  assert.match([err, ...logs].join('\n'), /NOT IN FORCE: decision not anchored/);
  assert.deepEqual(listFiles(root), before, 'a file changed');
  assert.equal(binance.calls.length, 0, 'Binance was called');
  assert.equal(node.methods.length, 0, 'the chain was called');
});

test('qeth15 dry run (THROWAWAY n = 120 · T = 1.7): target 1.5 comes from the rulebook alone; verify.mjs holds the target of the series', async () => {
  // four days of bars (2030-05-01 … 05-04); on 2030-05-03 (shock index 2) the minute returns of 09:00–11:00 UTC
  // lose 0.3 / 120 each (a fall of about a quarter);
  // the replay 05-02 … 05-04 writes three lines, and the third (dated 05-04) carries the bars of the fall
  const minutes = days('2030-05-01', 4, { shocks: { 2: crash(0.3) } });
  const root = tempRoot({ index: 'qeth15' });
  const { d } = deps(root, { minutes, now: at('2030-05-05T00:30:00Z') });
  assert.equal(await run(['--index', 'qeth15', '--dry-run', '--replay', '2030-05-02..2030-05-04', '--throwaway-check', '120:1.7', '--throwaway-level', '30:6'], d), 0);
  const dir = path.join(root, 'keeper', 'dryrun');
  const lines = readJsonl(path.join(dir, 'record-qeth15.jsonl'));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.index === 'qETH1.5X' && l.rule.target === 1.5 && l.rehearsal === 'THROWAWAY n=120 T=1.7 costBp=30 ratePct=6'));
  assert.deepEqual([lines[0].book.A, lines[0].book.C, lines[0].book.E], [1.5, -0.5, 1], 'genesis: 1.5 of collateral against 0.5 of debt');
  const trades = lines.flatMap((l) => l.slots.filter((s) => s.action !== 'none'));
  assert.ok(trades.length >= 3 && trades.every((s) => s.lambdaAfter === 1.5), 'every reset and trigger trades back to 1.5');
  const triggers = trades.filter((s) => s.action === 'trigger');
  assert.ok(triggers.length >= 1 && triggers.every((s) => s.lambdaBefore >= 1.7), 'the crash day triggers at λ ≥ T');
  assert.ok(lines.flatMap((l) => l.slots).filter((s) => s.action === 'none').every((s) => s.lambdaBefore < 1.7));

  let v = spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qeth15', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
  // the same lines, re-hashed with a rule that says target 2: the verifier's own table says 1.5
  const t = structuredClone(lines);
  for (let k = 0; k < t.length; k++) {
    t[k].rule.target = 2;
    if (k > 0) t[k].prevHash = t[k - 1].hash;
    const { hash, ...rest } = t[k];
    t[k].hash = sha256(JSON.stringify(rest));
  }
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-eth15-'));
  fs.writeFileSync(path.join(tdir, 'record-qeth15.jsonl'), t.map((l) => JSON.stringify(l)).join('\n') + '\n');
  v = spawnSync(process.execPath, [VERIFY, '--dir', tdir, '--series', 'qeth15', '--recompute-only', '--allow-rehearsal'], { encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.match(v.stdout, /is not a daily-reset 1\.5x rule on 15-minute bars/);

  // 0 bp · 0% and a trigger that cannot fire: level = previous level × (1 + 1.5 × the day's return), price space
  const root2 = tempRoot({ index: 'qeth15' });
  const calm = days('2030-05-01', 4);
  const r2 = deps(root2, { minutes: calm, now: at('2030-05-05T00:30:00Z') });
  assert.equal(await run(['--index', 'qeth15', '--dry-run', '--replay', '2030-05-02..2030-05-04', '--throwaway-check', '120:9', '--throwaway-level', '0:0'], r2.d), 0);
  const calmLines = readJsonl(path.join(root2, 'keeper', 'dryrun', 'record-qeth15.jsonl'));
  const closeOf = (day) => calm.filter((m) => m.openMs < dayMs(day) + 86_400_000).at(-1).c;
  let level = 100;
  for (const l of calmLines.slice(1)) {
    const day = new Date(dayMs(l.date) - 86_400_000).toISOString().slice(0, 10);
    const prevDay = new Date(dayMs(day) - 86_400_000).toISOString().slice(0, 10);
    level *= 1 + 1.5 * (closeOf(day) / closeOf(prevDay) - 1);
    assert.equal(l.dayStats.triggers, 0);
    assert.ok(Math.abs(l.level - level) < 2e-6, `${l.date}: level ${l.level}, price space ${level}`);
  }
});
