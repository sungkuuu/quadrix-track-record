/**
 * scripts/anchor-decision.mjs refuses every placeholder and draft-banner form
 * a hand-written draft uses (review of 2026-10-15): the guard knew only ⟦…⟧,
 * TO FILL and DRAFT inside an HTML comment, while drafts marked unfilled
 * values ⟨…⟩, 〔…〕 or ［…］, wrote YYYY-MM-DD for the date, and said DRAFT in
 * a quote-block banner. A draft with its banner cut and one placeholder left
 * would have been anchored, and an anchor cannot be undone.
 *
 * Each case takes an anchored decision, puts one marker on line 4, and runs
 * the script offline (KEEPER_PK removed): it must refuse before the key and
 * name line 4 and the marker. The same anchored decision unchanged reaches
 * "KEEPER_PK not set" (the control), and every decision already in
 * trackrecord/decisions/ passes the guard (no false refusal).
 *
 *   node --test keeper/test/anchor-decision-placeholders.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './leverage-helpers.mjs';
import { findUnfinished } from '../../scripts/decision-guard.mjs';

const SCRIPT = path.join(REPO, 'scripts', 'anchor-decision.mjs');
const DECISIONS = path.join(REPO, 'trackrecord', 'decisions');
// An anchored decision with truncated hashes (`aecd53c1…`), ellipses and the
// word "draft" in running text: all of that must still pass.
const BASE = fs.readFileSync(path.join(DECISIONS, '2026-09-28-qrev-d24-thresholds.md'), 'utf8');

function attempt(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-placeholders-'));
  const file = path.join(dir, '2099-01-01-guard-placeholder-case.md');
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, err: `${r.stdout}${r.stderr}` };
}

function withLine4(marker) {
  const lines = BASE.split('\n');
  lines.splice(3, 0, marker);
  return lines.join('\n');
}

const CASES = [
  ['angle brackets ⟨ ⟩', '**Decided:** ⟨date⟩ (UTC), by the owner.'],
  ['CJK angle brackets 〈 〉', '**Decided:** 〈date〉 (UTC), by the owner.'],
  ['tortoise-shell brackets 〔 〕', '| HEAD before the commit | 〔HEAD before the commit〕 |'],
  ['full-width square brackets ［ ］', '| sha256 of the rulebook | ［new sha256］ |'],
  ['template braces {{ }}', '**Effective:** {{effective_date}} (UTC).'],
  ['TODO', 'The rank buffer is 17. TODO: confirm against the grid.'],
  ['TBD, lower case', 'Effective from: tbd.'],
  ['DRAFT in upper case, mid-sentence', 'This section is a DRAFT until the owner signs it.'],
  ['quote-block banner', '> **draft · not anchored.** Placeholders are filled when the owner sets the date.'],
  ['heading that says draft', '# Correction bundle — draft'],
  ['line that opens with Draft', 'Draft — not a decision until anchored.'],
  ['Status: draft', '**Status:** draft'],
  ['date placeholder YYYY-MM-DD', 'File: `trackrecord/decisions/YYYY-MM-DD-qrev-correction.md`.'],
  ['date placeholder 2026-10-XX', '**Decided:** 2026-10-XX (UTC).'],
  ['date placeholder 2026-MM-DD', '**Effective:** 2026-MM-DD.'],
  ['empty sha256, 64 zeros', `| rulebook sha256 | \`${'0'.repeat(64)}\` |`],
  ['empty sha256, 0000…', '| rulebook sha256 | `0000…` |'],
  ['empty sha256, ellipsis alone', '| rulebook | sha256 `…` |'],
  ['⟦ ⟧ (kept from the earlier guard)', '**Decided:** ⟦DATE⟧ (UTC).'],
  ['placeholder XXX', '| deploy tx | XXX |'],
  ['placeholder xxx, lower case', '| deploy tx | xxx |'],
  ['placeholder 0x…', '| timelock | `0x…` |'],
  ['placeholder 0xXXXX', '| timelock | 0xXXXX |'],
  ['placeholder 0x____', '| timelock | `0x____` |'],
  ['bare 0x in code', '| timelock | `0x` |'],
  ['empty hash beside the word bytes32', `| decision hash (bytes32) | \`0x${'0'.repeat(64)}\` |`],
  ['empty hash beside the word execute', `| rulebook hash | \`${'0'.repeat(64)}\` | execute after the anchor |`],
  ['empty hash beside the word schedule', `| rebalance schedule hash | \`0x${'0'.repeat(64)}\` |`],
  ['empty hash after a bare schedule( in code', `| rebalance | \`schedule(quarterly) 0x${'0'.repeat(64)}\` |`],
  ['empty document hash in a cast send to the anchor', `| anchor | \`cast send <anchor> "anchor(bytes32)" 0x${'0'.repeat(64)}\` |`],
  ['empty hash in a cast call that is not a timelock call', `| read | \`cast call <anchor> "decisions(bytes32)(uint256)" 0x${'0'.repeat(64)}\` |`],
  ['empty hash in a bare execute( in code', `| run | \`execute(0x${'0'.repeat(64)})\` |`],
  ['64 zeros labelled sha256 on a call line', `\`cast call <timelock> "hashOperation(...)"\` — rulebook sha256 \`${'0'.repeat(64)}\``],
];

test('a bytes32 zero passed to a timelock call is a value, not an empty sha256 (anchored 2026-10-23 decision, line 74)', () => {
  const line = `3. The operation: \`cast call <timelock> "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" <vault> 0 0x79ba5097 0x${'0'.repeat(64)} 0x27e4\``;
  assert.deepEqual(findUnfinished(line), []);
  assert.deepEqual(findUnfinished(`\`cast send <timelock> "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" <vault> 0 0x79ba5097 0x${'0'.repeat(64)} 0x01 172800\``), []);
  assert.equal(findUnfinished(`predecessor of schedule(...): 0x${'0'.repeat(64)}`).length, 1, 'outside a code span the call words do not exempt it');
  assert.equal(findUnfinished(`\`cast call <timelock> getMinDelay()\` and \`0x${'0'.repeat(64)}\``).length, 1, 'a separate code span is not a call argument');
  assert.equal(findUnfinished(`| rulebook | \`${'0'.repeat(64)}\` |`).length, 1, 'outside a call line, 64 zeros are still an empty sha256');
  assert.deepEqual(findUnfinished('the vault 0x5F1F…19F6 and the timelock 0x8c23…7902'), [], 'a shortened real address passes');
  assert.deepEqual(findUnfinished('the vault 0x…19F6 (tail only)'), [], 'a shortened value with its tail passes');
});

for (const [label, marker] of CASES) {
  test(`refused before the key, with line and text: ${label}`, () => {
    const r = attempt(withLine4(marker));
    assert.notEqual(r.code, 0, label);
    assert.match(r.err, /is not final/, label);
    assert.doesNotMatch(r.err, /KEEPER_PK not set/, `${label}: refused before the key`);
    assert.ok(r.err.includes(`line 4 [`), `${label}: names line 4\n${r.err}`);
    assert.ok(r.err.includes(marker.trim().slice(0, 40)), `${label}: quotes the line\n${r.err}`);
  });
}

test('control: the anchored decision unchanged passes the guard and stops at the missing key', () => {
  const r = attempt(BASE);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /KEEPER_PK not set/);
  assert.doesNotMatch(r.err, /is not final/);
});

test('every decision in trackrecord/decisions/ passes the guard (no false refusal)', () => {
  const files = fs.readdirSync(DECISIONS).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 20, `${files.length} decisions`);
  for (const f of files) {
    const hits = findUnfinished(fs.readFileSync(path.join(DECISIONS, f), 'utf8'));
    assert.deepEqual(hits, [], f);
  }
});

test('a multi-line draft comment box is reported on the line that carries DRAFT', () => {
  const hits = findUnfinished('# Title\n\n<!-- ==========\n  DRAFT — not a decision\n========== -->\n');
  assert.ok(hits.some((h) => h.line === 4 && /DRAFT/.test(h.text)), JSON.stringify(hits));
});
