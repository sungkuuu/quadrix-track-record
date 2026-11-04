/**
 * The operating values of the qVOL realized line do not change its record line
 * (rulebook appendix O). Each case runs the keeper in force (no anchor) on a
 * scratch root from SYNTHETIC bars, served by the fake exchange of vol-helpers
 * through a wrapper that fails, hangs or times the calls, and compares the line
 * the run writes, byte for byte, with the line of a run whose exchange answers
 * at once (keeper/test/qvol-inforce.mjs). No network.
 *
 *   node --test keeper/test/qvol-operating-values.test.mjs
 *
 * The values live in keeper/vol-sources.mjs and are not passed in by the
 * keeper, so they are tested at their real values: the keeper's waits go
 * through its injectable wait (O1 runs the real 2 s + 4 s once, about 6 s), and
 * the time limit is the 30,000 ms each attempt asks for — run here with the
 * abort timer at 1/1000 of that; QVOL_REAL_TIMEOUT=1 also runs one real 30 s
 * hang (O3b, about 30 s).
 *
 *   O1 retries: at most 3 attempts per call, waits 2 s then 4 s (RETRY_WAITS_MS)
 *   O2 the spacing of Binance calls, 250 ms (BINANCE_SPACING_MS)
 *   O3 the time limit of one attempt, 30 s (FETCH_TIMEOUT_MS)
 *   O4 the two fetches of a day compared: T7 in keeper/test/vol-realized.test.mjs
 *      (two fetches that differ → exit 1, nothing written); not repeated here
 *   O5 display.decimals: the record line and the vault mark do not read it; the
 *      keeper refuses any value but 2 (exit 2, nothing read or written)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RETRY_WAITS_MS, BINANCE_SPACING_MS, FETCH_TIMEOUT_MS } from '../vol-sources.mjs';
import { markUnits } from '../vol-index.mjs';
import { readJsonl, tmpDir, dayMs, KEEPER, REPO } from './vol-helpers.mjs';
import { honestRecord, copyRoot, inForce, inForceRoot, D1 } from './qvol-inforce.mjs';

const D2 = '2099-02-03'; // line #1, from the bars of D1 = 2099-02-02
const PAGE1 = `startTime=${dayMs(D1)}&limit=1000`; // the first page of the day line #1 adds (both fetches ask for it)
const CALLS = 9; // the Binance calls of a run that writes line #1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gaps = (t) => t.slice(1).map((x, i) => x - t[i]);

// line #0 is written once; every case writes line #1 on its own copy
const base = honestRecord(1, { anchor: false });
async function second(opts = {}) {
  const y = copyRoot(await base);
  const t0 = Date.now();
  const r = await inForce(y.root, `${D2}T00:25:00Z`, { argv: [], ...opts });
  return { ...r, ms: Date.now() - t0, file: fs.readFileSync(y.rec), lines: readJsonl(y.rec) };
}
const control = (async () => {
  const r = await second();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.length, 2);
  // server time, the finality probe, the last line's day read again (two pages), two fetches of two pages, the daily candle
  assert.equal(r.calls.length, CALLS);
  return r.file;
})();

test('O1 retries (at most 3 attempts per call, waits 2 s then 4 s): an exchange that fails twice and then answers gives the line, byte for byte, of one that answers at once — with the real waits (about 6 s) and with none; a third failure is exit 1 and nothing written', async (t) => {
  assert.deepEqual(RETRY_WAITS_MS, [2000, 4000]);
  const want = await control;
  let attempts = 0;
  /** The first `n` requests for PAGE1 fail: HTTP 503, then a network error, then 503 … */
  const flaky = (n) => (fetch) => async (url, init) => {
    if (url.includes(PAGE1) && ++attempts <= n) {
      if (attempts % 2 === 1) return new Response('busy', { status: 503 });
      throw new TypeError('fetch failed');
    }
    return fetch(url, init);
  };
  const waits = [];
  let r = await second({ wrap: flaky(2), wait: (ms) => (waits.push(ms), sleep(ms)) });
  assert.equal(r.code, 0, r.err);
  assert.equal(attempts, 4); // the first fetch: 3 attempts; the second fetch: 1
  assert.deepEqual(waits.filter((w) => w > BINANCE_SPACING_MS), [2000, 4000]);
  assert.ok(r.ms >= 6000, `${r.ms} ms`);
  assert.ok(r.file.equals(want), 'the line differs from the line of an exchange that answers at once');
  t.diagnostic(`real waits: ${r.ms} ms, retry waits ${waits.filter((w) => w > BINANCE_SPACING_MS).join(' + ')} ms`);
  attempts = 0;
  r = await second({ wrap: flaky(2) });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.file.equals(want), 'the line differs (no waits)');
  // a third failure: the call fails, the run stops before anything is written
  attempts = 0;
  const w3 = [];
  r = await second({ wrap: flaky(3), wait: async (ms) => void w3.push(ms) });
  assert.equal(r.code, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(w3.filter((w) => w > BINANCE_SPACING_MS), [2000, 4000]);
  assert.match(r.err, /^qvol: Binance \(data-api\.binance\.vision\) failed while fetching the 1-minute bars up to 2099-02-02: HTTP 503 from https:\/\/data-api\.binance\.vision\/api\/v3\/klines — nothing written for 2099-02-03; the next run continues from the last line$/m);
  assert.equal(r.lines.length, 1);
});

test('O2 call spacing (250 ms between Binance calls): the spacing measured at its real value, at none and at twice that gives the same line', async (t) => {
  assert.equal(BINANCE_SPACING_MS, 250);
  const want = await control;
  // the keeper waits 250 ms less the time since its last call; a timer may fire a few ms early, and a doubled
  // wait doubles only the part the keeper waited: the floors leave that room (the measured gaps are printed)
  for (const [label, wait, floor] of [['250 ms (real)', sleep, BINANCE_SPACING_MS - 10], ['about 500 ms', (ms) => sleep(2 * ms), BINANCE_SPACING_MS + 100], ['0 ms', null, 0]]) {
    const at = [];
    const timed = (fetch) => async (url, init) => {
      at.push(Date.now());
      return fetch(url, init);
    };
    const r = await second({ wrap: timed, ...(wait ? { wait } : {}) });
    assert.equal(r.code, 0, r.err);
    assert.equal(at.length, CALLS, label);
    assert.ok(Math.min(...gaps(at)) >= floor, `${label}: gaps ${gaps(at).join(', ')} ms`);
    assert.ok(r.file.equals(want), `${label}: the line differs`);
    t.diagnostic(`spacing ${label}: gaps between the ${CALLS} calls ${gaps(at).join(', ')} ms`);
  }
});

/** The first `n` requests for PAGE1 hang until their abort signal fires. */
const hanging = (n, hung) => (fetch) => async (url, init) => {
  if (url.includes(PAGE1) && hung.length < n) {
    hung.push(Date.now());
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }
  return fetch(url, init);
};

test('O3 time limit of one attempt (30 s): every attempt asks for 30,000 ms; an attempt that outlives it is cut and retried and gives the same line; when all three attempts outlive it: exit 1, nothing written (the abort timer runs at 1/1000 of the length asked for)', async (t) => {
  assert.equal(FETCH_TIMEOUT_MS, 30000);
  const want = await control;
  const real = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => (asked.push(ms), real.call(AbortSignal, ms / 1000));
  const hold = setInterval(() => {}, 1000); // an abort timer does not hold the event loop open (a real socket does)
  try {
    let hung = [];
    let r = await second({ wrap: hanging(1, hung) });
    assert.equal(r.code, 0, r.err);
    assert.equal(hung.length, 1);
    assert.equal(asked.length, CALLS + 1); // every call + 1 retry
    assert.ok(asked.every((ms) => ms === FETCH_TIMEOUT_MS), `asked ${asked.join(', ')}`);
    assert.ok(r.file.equals(want), 'the line differs');
    hung = [];
    asked.length = 0;
    r = await second({ wrap: hanging(3, hung) });
    assert.equal(r.code, 1);
    assert.equal(hung.length, 3);
    assert.ok(asked.every((ms) => ms === FETCH_TIMEOUT_MS));
    assert.match(r.err, /^qvol: Binance \(data-api\.binance\.vision\) failed while fetching the 1-minute bars up to 2099-02-02: The operation was aborted due to timeout — nothing written for 2099-02-03/m);
    assert.equal(r.lines.length, 1);
    t.diagnostic(`time limit asked per attempt: ${FETCH_TIMEOUT_MS} ms (run at ${FETCH_TIMEOUT_MS / 1000} ms)`);
  } finally {
    clearInterval(hold);
    AbortSignal.timeout = real;
  }
});

test('O3b time limit at its real length: a first attempt that hangs is cut after 30 s and retried, and gives the same line', { skip: process.env.QVOL_REAL_TIMEOUT === '1' ? false : 'about 30 s: QVOL_REAL_TIMEOUT=1 node --test keeper/test/qvol-operating-values.test.mjs' }, async (t) => {
  const want = await control;
  const hung = [];
  const hold = setInterval(() => {}, 1000);
  try {
    const r = await second({ wrap: hanging(1, hung) });
    assert.equal(r.code, 0, r.err);
    assert.equal(hung.length, 1);
    assert.ok(r.ms >= FETCH_TIMEOUT_MS, `${r.ms} ms`);
    assert.ok(r.file.equals(want), 'the line differs');
    t.diagnostic(`a real hang cut and retried: ${r.ms} ms`);
  } finally {
    clearInterval(hold);
  }
});

const REFUSAL = "if (rb.display?.decimals !== 2) return 'display.decimals: only 2 is implemented';";
/** Source lines with comments blanked (line numbers kept). */
const codeLines = (file) =>
  fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:\\'"`])\/\/.*$/, '$1'));
const matching = (lines, re) => lines.flatMap((l, i) => (re.test(l) ? [{ n: i + 1, text: l.trim() }] : []));

test('O5 display.decimals: neither keeper/vol-realized.mjs nor the record or mark code of keeper/vol-index.mjs reads it — its one read is the rulebook check, which refuses any value but 2 (exit 2, nothing read or written); with that check taken out of a scratch copy of the keeper, decimals 3 and 0 give the same lines and the same mark n6 (only the sha256 of the rulebook and of its decision differ)', async (t) => {
  // the source scan (comments left out)
  const realized = codeLines(path.join(KEEPER, 'vol-realized.mjs'));
  assert.deepEqual(matching(realized, /\bdisplay\b|\bdecimals\b/), []);
  assert.deepEqual(matching(codeLines(path.join(REPO, 'scripts', 'verify-vol.mjs')), /\bdisplay\b|\bdecimals\b/), []);
  const index = codeLines(path.join(KEEPER, 'vol-index.mjs'));
  const reads = matching(index, /\.display\b|\bdisplay\?\.|\bdecimals\b/).filter((m) => !m.text.includes("nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }"));
  assert.deepEqual(reads.map((m) => m.text), [REFUSAL]);
  const from = index.findIndex((l) => l.startsWith('export function rulebookProblem('));
  const to = index.findIndex((l, i) => i > from && l === '}');
  assert.ok(from >= 0 && reads[0].n - 1 > from && reads[0].n - 1 < to, 'the one read is inside rulebookProblem');
  t.diagnostic(`keeper/vol-index.mjs:${reads[0].n} (rulebookProblem) is the only read of display`);

  // the keeper as it is: any other value is refused before anything is read
  for (const dec of [3, 0, '2']) {
    const x = inForceRoot({ mutate: (rb) => void (rb.display.decimals = dec) });
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { argv: [] });
    assert.equal(r.code, 2, `decimals ${JSON.stringify(dec)}`);
    assert.match(r.err, /keeper\/rulebooks\/qvol\.json: display\.decimals: only 2 is implemented/);
    assert.equal(r.calls.length, 0);
    assert.ok(!fs.existsSync(x.rec));
  }

  // a scratch copy of the keeper without that check: the value reaches nothing else
  const dir = path.join(tmpDir('vol-keeper-copy'), 'keeper');
  fs.mkdirSync(dir);
  for (const f of ['vol-index.mjs', 'vol-realized.mjs', 'vol-implied.mjs', 'vol-sources.mjs', 'leverage-step.mjs']) fs.copyFileSync(path.join(KEEPER, f), path.join(dir, f));
  const src = fs.readFileSync(path.join(dir, 'vol-index.mjs'), 'utf8');
  assert.equal(src.split(REFUSAL).length, 2);
  fs.writeFileSync(path.join(dir, 'vol-index.mjs'), src.replace(REFUSAL, '/* the display check, taken out of this scratch copy */'));
  const copy = await import(pathToFileURL(path.join(dir, 'vol-index.mjs')).href);
  const twoLines = async (x, runFn) => {
    for (const d of [D1, D2]) {
      const r = await inForce(x.root, `${d}T00:25:00Z`, { argv: [], ...(runFn ? { runFn } : {}), extra: { verifyScript: path.join(REPO, 'scripts', 'verify-vol.mjs') } });
      assert.equal(r.code, 0, r.err);
    }
    return readJsonl(x.rec);
  };
  const A = await twoLines(inForceRoot(), null); // the keeper as it is, decimals 2
  const ids = ({ hash, prevHash, rule, inception, ...rest }) => ({ ...rest, rule: { ...rule, rulebookSha256: '-' }, ...(inception ? { inception: { ...inception, decisionSha256: '-' } } : {}) });
  for (const dec of [3, 0]) {
    const B = await twoLines(inForceRoot({ mutate: (rb) => void (rb.display.decimals = dec) }), copy.run);
    assert.equal(B.length, 2);
    for (let k = 0; k < 2; k++) {
      assert.deepEqual(ids(B[k]), ids(A[k]), `decimals ${dec}, line #${k}`);
      assert.notEqual(B[k].rule.rulebookSha256, A[k].rule.rulebookSha256);
      assert.equal(markUnits(B[k].value), markUnits(A[k].value));
    }
    assert.notEqual(B[0].inception.decisionSha256, A[0].inception.decisionSha256);
  }
  t.diagnostic(`n6 of the two lines: ${A.map((l) => markUnits(l.value)).join(', ')} for decimals 2, 3 and 0`);
});
