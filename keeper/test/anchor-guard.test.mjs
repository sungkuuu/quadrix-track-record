/**
 * scripts/anchor-decision.mjs refuses a decision document that is not final.
 * Post-review of 2026-10-05 (A1 M1): with the two draft comment lines
 * removed, a body that still marked its unfilled values TO FILL / TO-FILL-…
 * passed every guard. The marker is now refused anywhere in the document.
 *
 * The script runs in a child process with KEEPER_PK and BIDDER_PK removed
 * from its environment: a document that passes every guard stops at
 * "KEEPER_PK not set", before the script builds a client or sends anything.
 * The file is dated 2099-12-31 so that the date guard passes, and its id is
 * in no ledger.
 *
 *   node --test keeper/test/anchor-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'anchor-decision.mjs');

function anchor(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-guard-'));
  const file = path.join(dir, '2099-12-31-anchor-guard-test.md');
  fs.writeFileSync(file, body);
  const env = { ...process.env };
  delete env.KEEPER_PK;
  delete env.BIDDER_PK;
  const r = spawnSync(process.execPath, [SCRIPT, file], { env, encoding: 'utf8', timeout: 60_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const FINAL = '# Basket session method\n\nEffective: 2099-12-31.\n\nThe bidder holds enough of each name to fill the auction.\n';

test('a final document passes every guard (stops only at the missing key; nothing is sent)', () => {
  const r = anchor(FINAL);
  assert.equal(r.status, 1);
  assert.match(r.out, /KEEPER_PK not set/);
  assert.doesNotMatch(r.out, /is not final/);
});

test('a TO FILL / TO-FILL-… marker in the body is refused although the draft comment lines are gone (A1 M1)', () => {
  for (const marker of ['Counts: (TO FILL: counts at the tool commit).', 'Anchored on TO-FILL-DATE.', '| qX20 | TO FILL | 0.00 pt |']) {
    const r = anchor(`${FINAL}\n${marker}\n`);
    assert.equal(r.status, 1, marker);
    assert.match(r.out, /is not final \(.*\\bTO\[- \]FILL\\b.*\)/, marker);
    assert.doesNotMatch(r.out, /KEEPER_PK not set/, marker);
  }
});

test('the guards that were there still refuse (DRAFT and TO FILL comments, _to be deployed_)', () => {
  for (const marker of ['<!-- DRAFT — not anchored -->', '<!-- TO FILL: the counts -->', 'Address: _to be deployed_']) {
    const r = anchor(`${marker}\n${FINAL}`);
    assert.equal(r.status, 1, marker);
    assert.match(r.out, /is not final/, marker);
  }
});
