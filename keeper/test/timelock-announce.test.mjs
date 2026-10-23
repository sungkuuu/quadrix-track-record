/**
 * Owner = timelock: the announce stage can only write the call for the
 * timelock's proposer (--timelock-out, a dry run), and the decision draft
 * says where the first reference price is fixed and how long the lag is
 * (--owner-delay-hours). No network: the guards run before any read.
 *
 *   node --test keeper/test/timelock-announce.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlan, savePlan } from '../basket-plan.mjs';

const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PLAN = path.join(KEEPER, 'plans', 'qx20', '2026-10-02.json');
const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

test('--timelock-out is refused with --live and outside the announce stage', () => {
  const recon = path.join(KEEPER, 'basket-recon.mjs');
  const live = node([recon, '--index', 'qx20', '--stage', 'announce', '--live', '--timelock-out', path.join(os.tmpdir(), 'x.json')]);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /sends nothing/);
  const exec = node([recon, '--index', 'qx20', '--stage', 'execute', '--timelock-out', path.join(os.tmpdir(), 'x.json')]);
  assert.equal(exec.status, 2);
  assert.match(exec.stderr, /announce stage only/);
});

function draft(dir, name, extra) {
  const plan = loadPlan(SOURCE_PLAN);
  plan.announce = null;
  plan.vaultAbi = 'priced-adds';
  const planFile = path.join(dir, `${name}.json`);
  const out = path.join(dir, `${name}.md`);
  savePlan(planFile, plan);
  const r = node([path.join(KEEPER, 'gen-recon-decision.mjs'), '--index', 'qx20', '--plan', planFile, '--recon-date', plan.date, '--out', out, ...extra]);
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out, 'utf8');
}

test('the decision draft names the timelock schedule day and the longer lag only with --owner-delay-hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-recon-timelock-'));
  try {
    const key = draft(dir, 'key', []);
    assert.match(key, /only from a plan made on the day of the announcement\./);
    assert.match(key, /announced after this document is anchored/);
    assert.doesNotMatch(key, /owner's timelock|owner is a timelock/);

    const tl = draft(dir, 'tl', ['--owner-delay-hours', '72']);
    assert.match(tl, /only from a plan made on the day the announcement is scheduled on the owner's timelock\./);
    assert.match(tl, /scheduled on the owner's timelock after this document is anchored, and announced when the timelock executes it, no earlier than 72 hours later/);
    assert.match(tl, /the committed price is at least 72 hours old when the announcement lands/);
    assert.match(tl, /72 hours plus 7 days at the least/);
    assert.match(tl, /from the timelock's execution of the announcement \+ 7 days/);
    assert.doesNotMatch(tl, /made on the day of the announcement/);

    const bad = node([path.join(KEEPER, 'gen-recon-decision.mjs'), '--index', 'qx20', '--plan', path.join(dir, 'tl.json'), '--owner-delay-hours', '1.5', '--out', path.join(dir, 'bad.md')]);
    assert.equal(bad.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
