/**
 * keeper/gen-recon-decision.mjs: the auction-policy sentence about share
 * value covers our own fills, and the open-bidding sentence is printed only
 * when the plan's vault state has biddingOpen true, with the curve's ends
 * read from that state (premiumBps, maxFillLossBps), not typed in the text.
 *
 *   node --test keeper/test/gen-recon-decision-bidding.test.mjs
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
const SOURCE_PLAN = path.join(KEEPER, 'plans', 'qrev', '2026-10-12.json');

function draft(dir, name, vaultState) {
  const plan = loadPlan(SOURCE_PLAN);
  Object.assign(plan.vaultState, vaultState);
  const planFile = path.join(dir, `${name}.json`);
  const out = path.join(dir, `${name}.md`);
  savePlan(planFile, plan);
  const r = spawnSync(process.execPath, [path.join(KEEPER, 'gen-recon-decision.mjs'), '--index', 'qrev', '--plan', planFile, '--recon-date', plan.date, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out, 'utf8').split('\n').find((l) => l.startsWith('- Fills by our own bidder'));
}

test('open bidding is stated only when biddingOpen is true, with the curve read from the vault state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-recon-bidding-'));
  try {
    const closed = draft(dir, 'closed', { biddingOpen: false });
    assert.match(closed, /so our own fills leave share value at reference prices unchanged and give no gift either way\./);
    assert.doesNotMatch(closed, /Bidding on this vault is open/);

    const open = draft(dir, 'open', { biddingOpen: true, premiumBps: '150', maxFillLossBps: '75' });
    assert.match(open, /so our own fills leave share value at reference prices unchanged and give no gift either way\./);
    assert.ok(open.endsWith(' Bidding on this vault is open: any address may fill these auctions anywhere on the contract\'s curve (+1.5% to −0.75% of the reference), so a fill by another bidder can raise or lower share value at reference prices — below the reference by at most the per-fill floor and the daily budget; each such fill is recorded with its bidder and factor.'), open);

    // A value that is not the boolean true (e.g. a string) does not open bidding in the text.
    assert.doesNotMatch(draft(dir, 'string', { biddingOpen: 'false' }), /Bidding on this vault is open/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
