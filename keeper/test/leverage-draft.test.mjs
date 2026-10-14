/**
 * A draft rulebook on the stage A leg, and the target each series holds — offline, on qBTC2X's rulebook
 * with THROWAWAY values (n = 120, T = 2.2, 30 bp, 6%; none is a tested value).
 *
 * A rulebook that still lists owner decisions in `pendingOwner` is a draft.
 * (1) The keeper refuses every run of a draft that is not a rehearsal (exit 2): nothing is written and
 *     neither the exchange nor the chain is asked. A dry run of the same file still runs.
 * (2) scripts/verify.mjs fails a published series (no rehearsal mark) whose pinned rulebook JSON is a
 *     draft — and for that reason only: the same series pinned to the same JSON without `pendingOwner`
 *     passes.
 * (3) The keeper accepts any target in TARGETS, but scripts/verify.mjs holds each series' target itself:
 *     a qBTC2X rulebook that says 1.5 gives lines the verifier rejects as not a 2x rule, so the keeper
 *     (which runs the verifier before it appends a line) writes none (exit 1).
 *
 *   node --test keeper/test/leverage-draft.test.mjs
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
import { sha256, TARGETS } from '../leverage-step.mjs';
import { REPO, THROWAWAY_CHECK, THROWAWAY_LEVEL, synthMinutes, fakeBinance, fakeNode, tempRoot, readJsonl, listFiles, dayMs } from './leverage-helpers.mjs';

const VERIFY = path.join(REPO, 'scripts', 'verify.mjs');
const VAULT = getAddress('0x00000000000000000000000000000000000beef1');
const FILL = { check: THROWAWAY_CHECK, primary: THROWAWAY_LEVEL };
const I = '2030-05-02';
const at = (iso) => () => Date.parse(iso);
const DRAFT_ENTRY = { key: 'fees.managementBps', value: null, decision: 'THROWAWAY test entry, not an owner decision' };

function days(first, count, { seed = 31, vol = 0.002 } = {}) {
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
function deps(root, { minutes, now, key = null, node = null }) {
  const binance = fakeBinance({ BTCUSDT: minutes }, { serverTime: () => now() });
  return {
    binance,
    d: {
      root, now, binance, env: key ? { KEEPER_PK: key } : {}, log: () => {}, wait: async () => {},
      transport: node ? () => node.transport : undefined, pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 },
    },
  };
}
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
const rulebookPath = (root) => path.join(root, 'keeper', 'rulebooks', 'qbtc2x.json');
const editRulebook = (root, edit) => {
  const rb = JSON.parse(fs.readFileSync(rulebookPath(root), 'utf8'));
  edit(rb);
  fs.writeFileSync(rulebookPath(root), JSON.stringify(rb, null, 2) + '\n');
};
const verify = (dir, extra = []) => spawnSync(process.execPath, [VERIFY, '--dir', dir, '--series', 'qbtc2x', '--recompute-only', ...extra], { encoding: 'utf8' });
const rehash = (t) => {
  for (let k = 0; k < t.length; k++) {
    t[k].prevHash = k ? t[k - 1].hash : null;
    const { hash, ...rest } = t[k];
    t[k].hash = sha256(JSON.stringify(rest));
  }
  return t;
};
/** The mirror layout (rulebook-<index>.json next to the records), with the record lines, rulebook bytes and decision given. */
function mirror(root, lines, { rulebook, ledger = null, doc = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-draft-'));
  fs.cpSync(path.join(root, 'trackrecord'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record-qbtc2x.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'rulebook-qbtc2x.json'), rulebook);
  if (ledger) fs.writeFileSync(path.join(dir, 'decisions.jsonl'), ledger.map((d) => JSON.stringify(d)).join('\n') + '\n');
  if (doc) fs.writeFileSync(path.join(dir, doc.file), doc.text);
  return dir;
}

test('keeper: a rulebook that lists pendingOwner is refused outside a rehearsal (exit 2), nothing written, no exchange or chain request; a dry run still runs', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  editRulebook(root, (rb) => { rb.pendingOwner = [DRAFT_ENTRY]; });
  for (const [label, argv, withKey] of [['live', ['--index', 'qbtc2x'], false], ['live, --anchor with a key', ['--index', 'qbtc2x', '--anchor'], true]]) {
    const before = listFiles(root);
    const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(generatePrivateKey()).address });
    const { d, binance } = deps(root, { minutes: days('2030-05-01', 3), now: at(`${I}T06:00:00Z`), key: withKey ? generatePrivateKey() : null, node });
    const { code, err } = await runQuiet(argv, d);
    assert.equal(code, 2, `${label}: exit ${code}`);
    assert.match(err, /keeper\/rulebooks\/qbtc2x\.json is a draft — it still waits for 1 owner decision\(s\) \(pendingOwner: fees\.managementBps\)/, label);
    assert.deepEqual(listFiles(root), before, `${label}: a file changed`);
    assert.equal(binance.calls.length, 0, `${label}: Binance was called`);
    assert.equal(node.methods.length, 0, `${label}: the chain was called`);
  }
  const { d } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-04T00:30:00Z') });
  assert.equal(await run(['--index', 'qbtc2x', '--dry-run', '--replay', '2030-05-02..2030-05-03'], d), 0);
  const lines = readJsonl(path.join(root, 'keeper', 'dryrun', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.rehearsal === 'DRY RUN'));
  assert.equal(readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl')).length, 0, 'nothing in the published record');
});

test('verify: a published genesis line pinned to a draft rulebook JSON fails ("is a draft"), and for that reason only', async () => {
  const root = tempRoot({ fill: FILL, inception: I });
  const { d } = deps(root, { minutes: days('2030-05-01', 3), now: at(`${I}T06:00:00Z`) });
  assert.equal(await run(['--index', 'qbtc2x'], d), 0);
  const lines = readJsonl(path.join(root, 'trackrecord', 'record-qbtc2x.jsonl'));
  assert.equal(lines.length, 1, 'the genesis line only');
  assert.equal(lines[0].rehearsal ?? null, null, 'no rehearsal mark: a published line');

  // control: the series as written, pinned to the rulebook without pendingOwner
  let v = verify(mirror(root, lines, { rulebook: fs.readFileSync(rulebookPath(root)) }));
  assert.equal(v.status, 0, v.stdout);

  // the same rulebook plus one pendingOwner entry, pinned by its own sha256 in the line, the decision document and the ledger
  const rb = JSON.parse(fs.readFileSync(rulebookPath(root), 'utf8'));
  rb.pendingOwner = [DRAFT_ENTRY];
  const rbBytes = Buffer.from(JSON.stringify(rb, null, 2) + '\n');
  const rbSha = sha256(rbBytes);
  const [d0] = readJsonl(path.join(root, 'trackrecord', 'decisions.jsonl'));
  const text = `# THROWAWAY test decision\n\nPins keeper/rulebooks/qbtc2x.json sha256 ${rbSha}.\n`;
  const ledger = [{ ...d0, sha256: sha256(Buffer.from(text)) }];
  const t = structuredClone(lines);
  for (const l of t) {
    l.rule = { ...l.rule, rulebookSha256: rbSha };
    l.inception = { ...l.inception, decisionSha256: ledger[0].sha256 };
  }
  v = verify(mirror(root, rehash(t), { rulebook: rbBytes, ledger, doc: { file: d0.file, text } }));
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stdout, /FAIL {2}QBTC2X #0 2030-05-02: rulebook JSON is a draft — it still lists 1 pending owner decision\(s\) \(pendingOwner\); a published line cannot rest on it/);
  assert.match(v.stdout, /FAILED — 1 check\(s\) failed/, 'the draft is the only failure');
});

test('target: a qBTC2X rulebook that says 1.5 passes the keeper\'s shape check (1.5 is in TARGETS), but the verifier holds qBTC2X at 2 — no line is written (exit 1)', async () => {
  assert.deepEqual(TARGETS, [1.5, 2]);
  const root = tempRoot({ fill: FILL });
  editRulebook(root, (rb) => { rb.product.target = 1.5; });
  const { d } = deps(root, { minutes: days('2030-05-01', 3), now: at('2030-05-04T00:30:00Z') });
  const { code, err } = await runQuiet(['--index', 'qbtc2x', '--dry-run', '--replay', '2030-05-02..2030-05-03'], d);
  assert.equal(code, 1);
  assert.match(err, /rejected line 2030-05-02 — nothing appended:\n.*"target":1\.5,.* is not a daily-reset 2x rule on 15-minute bars/);
  assert.equal(readJsonl(path.join(root, 'keeper', 'dryrun', 'record-qbtc2x.jsonl')).length, 0);
  // control: the same days at the rulebook's own target 2 are written and pass
  const root2 = tempRoot({ fill: FILL });
  const r2 = deps(root2, { minutes: days('2030-05-01', 3), now: at('2030-05-04T00:30:00Z') });
  assert.equal(await run(['--index', 'qbtc2x', '--dry-run', '--replay', '2030-05-02..2030-05-03'], r2.d), 0);
  const v2 = verify(path.join(root2, 'keeper', 'dryrun'), ['--allow-rehearsal']);
  assert.equal(v2.status, 0, v2.stdout);
});
