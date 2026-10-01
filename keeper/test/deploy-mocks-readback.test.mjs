/**
 * The read-back after a mock deployment (2026-10-01, qX20 mZEC, run
 * 36868474573): a node behind the receipt's block answers "no code", which
 * must count as "not yet", not as a disagreement; a code of another shape, or
 * values that differ once the code is there, are still reported once the
 * bounded wait runs out. No network: the reader is a fake and the clock is a
 * counter that the fake sleep advances.
 *
 *   node --test keeper/test/deploy-mocks-readback.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBackUntilAgrees, readBackVerdict, READBACK_WAIT_MS } from '../deploy-mocks.mjs';

const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = JSON.parse(fs.readFileSync(path.join(KEEPER, 'artifacts', 'MockConstituent.json'), 'utf8'));

// The deployed runtime differs from the artifact only in the two immutables
// and the metadata tail; write values into both so the test shows they are
// ignored.
function deployedCode() {
  const b = ARTIFACT.deployedBytecode.replace(/^0x/, '').split('');
  for (const r of Object.values(ARTIFACT.immutableReferences).flat()) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = 'a';
  for (let i = b.length - ARTIFACT.metadataBytes * 2; i < b.length; i++) b[i] = 'b';
  return '0x' + b.join('');
}
const CODE = deployedCode();
// One opcode changed outside the immutables and the metadata: another contract.
const OTHER_CODE = '0x61' + CODE.slice(4);

const want = { name: 'Mock Zcash', symbol: 'mZEC', decimals: 12, faucetAmount: 8_884_370_000n, genesisAmount: 20_444_792_760_291n };
const right = { code: CODE, name: 'Mock Zcash', symbol: 'mZEC', decimals: 12, faucetAmount: 8_884_370_000n, balance: 20_444_792_760_291n };

function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return { now: () => t, wait: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, elapsed: () => t - 1_000_000 };
}

function scripted(answers) {
  let i = 0;
  const reader = async () => {
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  reader.calls = () => i;
  return reader;
}

test('the artifact shape survives immutables and metadata; one changed opcode does not', () => {
  assert.equal(readBackVerdict(right, want).state, 'ok');
  assert.deepEqual(readBackVerdict({ ...right, code: OTHER_CODE }, want), { state: 'differs', bad: ['runtime code differs from the artifact'] });
});

test('no code, "0x" or a missing answer is "not yet", never a disagreement', () => {
  for (const got of [{ code: '0x' }, { code: undefined }, { code: null }, null, undefined]) assert.equal(readBackVerdict(got, want).state, 'pending');
});

test('nothing twice, then the right values: passes at the third read', async () => {
  const clock = fakeClock();
  const reader = scripted([{ code: '0x' }, { code: undefined }, right]);
  const r = await readBackUntilAgrees(reader, want, { now: clock.now, wait: clock.wait, stepMs: 2_000 });
  assert.equal(r.ok, true);
  assert.equal(r.reads, 3);
  assert.equal(reader.calls(), 3);
  assert.deepEqual(clock.sleeps, [2_000, 2_000]);
});

test('code present but the view calls revert (a node that has not yet run the block): retried, then passes', async () => {
  const clock = fakeClock();
  const noData = new Error('The contract function "name" returned no data ("0x").');
  const reader = scripted([noData, { code: '0x' }, { ...right, balance: 0n }, right]);
  const r = await readBackUntilAgrees(reader, want, { now: clock.now, wait: clock.wait });
  assert.equal(r.ok, true);
  assert.equal(r.reads, 4);
});

test('a code of another shape keeps failing: reported after the bound, not before', async () => {
  const clock = fakeClock();
  const reader = scripted([{ ...right, code: OTHER_CODE }]);
  const r = await readBackUntilAgrees(reader, want, { now: clock.now, wait: clock.wait, waitMs: 30_000, stepMs: 2_000 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.bad, ['runtime code differs from the artifact']);
  assert.equal(clock.elapsed(), 30_000); // waited the whole bound, and no longer
  assert.equal(r.reads, 16); // t = 0, 2, …, 30 s
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 2_000));
});

test('values that differ once the code is present are reported after the bound', async () => {
  const clock = fakeClock();
  const reader = scripted([{ code: '0x' }, { ...right, decimals: 8, symbol: 'mZCASH' }]);
  const r = await readBackUntilAgrees(reader, want, { now: clock.now, wait: clock.wait, waitMs: 10_000, stepMs: 3_000 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.bad, ['symbol mZCASH', 'decimals 8']);
  assert.equal(clock.elapsed(), 10_000);
});

test('no code for the whole bound: reported as "not yet" after it', async () => {
  const clock = fakeClock();
  const r = await readBackUntilAgrees(scripted([{ code: '0x' }]), want, { now: clock.now, wait: clock.wait });
  assert.equal(r.ok, false);
  assert.equal(clock.elapsed(), READBACK_WAIT_MS);
  assert.match(r.bad.join(), /^not yet — no runtime code/);
});

test('a read that keeps throwing is "not yet" and is reported with its message after the bound', async () => {
  const clock = fakeClock();
  const r = await readBackUntilAgrees(scripted([new Error('HTTP request failed. Status: 429')]), want, { now: clock.now, wait: clock.wait, waitMs: 6_000 });
  assert.equal(r.ok, false);
  assert.match(r.bad.join(), /not yet — read failed: HTTP request failed\. Status: 429/);
});
