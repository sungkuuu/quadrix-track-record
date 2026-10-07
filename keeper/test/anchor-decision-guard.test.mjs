/**
 * scripts/anchor-decision.mjs refuses an unfinished decision before it reads
 * the key (review r2, Opus 검수(Fable 한도)): the leverage inception drafts
 * open their comment box as "<!-- ===== DRAFT …" and mark unfilled values
 * ⟦…⟧ — neither matched the guard, so a draft anchored with its box left in
 * would have gone through. Offline: the script stops before KEEPER_PK and the
 * chain; a finished document reaches "KEEPER_PK not set" (the control).
 *
 *   node --test keeper/test/anchor-decision-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './leverage-helpers.mjs';

const SCRIPT = path.join(REPO, 'scripts', 'anchor-decision.mjs');
function attempt(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-guard-'));
  const file = path.join(dir, '2099-01-01-qbtc2x-paper-inception.md');
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, err: `${r.stdout}${r.stderr}` };
}
const FINAL = '# qBTC2X synthetic level — inception, 2099-01-01\n\n**Effective:** 2099-01-01 (UTC).\n';

test('review r2: a draft box opened as "<!-- ===== DRAFT", a TO FILL box, or any ⟦ / ⟧ is refused before the key is read', () => {
  for (const [label, body] of [
    ['draft box with a rule before DRAFT', `<!-- ===================== DRAFT — NOT A DECISION =====\nnotes\n===== -->\n${FINAL}`],
    ['TO FILL box with a rule before it', `${FINAL}\n<!-- ============================ TO FILL — cut before anchoring ====\nx\n==== -->\n`],
    ['an unfilled placeholder', FINAL.replace('2099-01-01 (UTC)', '⟦DATE⟧ (UTC)')],
    ['a stray closing bracket', `${FINAL}\nrule n = 120⟧\n`],
  ]) {
    const r = attempt(body);
    assert.notEqual(r.code, 0, label);
    assert.match(r.err, /is not final/, label);
    assert.doesNotMatch(r.err, /KEEPER_PK not set/, `${label}: refused before the key`);
  }
});

test('review r2: a finished document passes the guard (control: it stops at the missing key, nothing sent)', () => {
  const r = attempt(FINAL);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /KEEPER_PK not set/);
  assert.doesNotMatch(r.err, /is not final/);
});

test('review r2: every decision already in the ledger still passes the new guard (none carries a draft box or a placeholder)', () => {
  const dir = path.join(REPO, 'trackrecord');
  const ledger = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(ledger.length >= 20);
  for (const d of ledger) {
    const t = fs.readFileSync(path.join(dir, d.file), 'utf8');
    assert.ok(!/<!--(?:(?!-->)[\s\S])*?\b(?:DRAFT|TO FILL)\b/i.test(t) && !/[⟦⟧]/.test(t), d.id);
  }
});
