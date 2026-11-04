/**
 * keeper/vol-index.mjs as a CLI — fake Binance / Deribit, no network, SYNTHETIC
 * data only: the six "cannot compute" reasons (T12), hash chain and key order
 * (T13), the not-in-force path (T14), no key in the new files (T15), Deribit
 * failures (T17), --collect-only (T18), and agreement with the independent
 * scripts/verify-vol.mjs (T19). The last section tests the realized line in
 * force (a stand-in inception decision in a scratch ledger, a fake GIWA node,
 * a key generated here): the decision check, the line, the verifier, the
 * anchor, the display vault's mark and the refusal of open-deposits for qvol;
 * its fork rehearsal (--rpc, --from: T-IF14 to T-IF16), against the same
 * fake node standing in for a local fork that holds the --from account
 * unlocked; and the keeper's guards added after the red-team run of
 * 2026-11-04 (T-IF17 to T-IF25: F1, F2, the daily-candle gate, F4, F6, F7,
 * F8, F9, F10) with two idempotency cases (T-IF26, T-IF27).
 *
 *   node --test keeper/test/vol-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { custom, decodeFunctionData, getAddress, hexToString, isAddress, parseTransaction, toFunctionSelector, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { run, parseArgs, rulebookProblem, markUnits, isLocalRpc, GIWA_RPC, RECEIPT_TIMEOUT_MS } from '../vol-index.mjs';
import { markSteps } from '../leverage-step.mjs';
import { VAULT_ABI } from '../leverage-index.mjs';
import { NAMES, DISPLAY_ONLY } from '../deploy-mark-vault.mjs';
import { fakeNode } from './leverage-helpers.mjs';
import { quotesSha256 } from '../vol-implied.mjs';
import { realizedFromWindow, sha256 as shaOf, canonicalMinuteText } from '../vol-realized.mjs';
import { handTable, syntheticTable, syntheticDays, writeOffline, writeSnapshot, fakeDeribit, fakeBinance, timeless, tmpDir, readJsonl, cli, KEEPER, REPO, addDays, rulebookPath, impliedOnRoot } from './vol-helpers.mjs';

const IMP = 'record-volbtc-implied.jsonl';
const REA = 'record-qvol.jsonl';
const H = (b) => crypto.createHash('sha256').update(b).digest('hex');
const q = (mid) => [mid - 1 / 1024, mid + 1 / 1024];
const US = 4102444800000000; // 2100-01-01T00:00:00Z, synthetic
const VERIFY = path.join(REPO, 'scripts', 'verify-vol.mjs');
// the implied line is off in the repository; its code runs from a root where it is on
const ON = impliedOnRoot();
const ON_RB = path.join(ON, 'keeper', 'rulebooks', 'volbtc-implied.json');
const icli = (argv, deps = {}) => cli(run, argv, { root: ON, ...deps });
const verify = (dir, ...extra) => spawnSync(process.execPath, [VERIFY, '--dir', dir, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH } });
/**
 * A scratch root in the state before the inception decision, whatever state
 * the repository is in: the repository's realized rulebook with inception
 * null, an empty decision ledger, no record. (Tests of that state must not
 * read the repository's own rulebook, ledger or registry: those change when
 * the decision is anchored.)
 */
function notInForceRoot() {
  const root = tmpDir('vol-notinforce');
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  rb.inception = { date: null, decision: null };
  fs.mkdirSync(path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', 'qvol.json'), JSON.stringify(rb, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'trackrecord'), { recursive: true });
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), '');
  return root;
}

const good = () => [
  [60, ...q(0.4), ...q(1 / 128)],
  [70, ...q(0.3), ...q(1 / 64)],
  [80, ...q(0.25), ...q(1 / 64)],
  [90, ...q(5 / 32), ...q(1 / 32)],
  [100, ...q(1 / 16), ...q(1 / 16)],
  [110, ...q(1 / 32), ...q(0.125)],
  [120, ...q(1 / 64), ...q(0.25)],
  [130, ...q(1 / 64), ...q(0.3)],
  [140, ...q(1 / 128), ...q(0.4)],
];
const setP = (rows, K, b, a) => rows.map((r) => (r[0] === K ? [r[0], r[1], r[2], b, a] : r));
const setC = (rows, K, b, a) => rows.map((r) => (r[0] === K ? [r[0], b, a, r[3], r[4]] : r));

async function snapshotLine(table, extra = [], out = tmpDir('vol-imp')) {
  const s = writeSnapshot(path.join(out, 'snap'), table);
  const r = await icli(['--line', 'implied', '--dry-run', '--from-snapshot', s.book, '--instruments', s.inst, '--out', out, ...extra], { now: () => table.usOut / 1000 + 60000 });
  return { r, out, lines: readJsonl(path.join(out, IMP)) };
}

// ---------------------------------------------------------------------- T12
const twoTerms = (nearRows, minutes = [30000, 50000]) => handTable([{ rows: nearRows }, { rows: good() }], US, { minutes });
const T12 = {
  'no-bracket': handTable([{ rows: good() }, { rows: good() }], US, { minutes: [20000, 40000] }),
  'no-atm-pair': twoTerms(good().map((r) => [r[0], null, r[2], r[3], r[4]])),
  'k0-quote-invalid': twoTerms(setC(setC(setP(good(), 110, ...q(0.0625)), 110, ...q(1 / 32)), 100, null, 0.07)),
  'no-otm-puts': twoTerms(setP(setP(good(), 90, null, null), 80, null, 0.01)),
  'no-otm-calls': twoTerms(setC(setC(good(), 110, null, null), 120, 0, 0.01)),
  'non-positive-variance': twoTerms([
    [50, 0.49, 0.51, 0.00009, 0.00011],
    [100, 0.19, 0.21, 0.00009, 0.00011],
    [200, 0.009, 0.011, 0.0616, 0.0636],
  ]),
};
for (const [reason, table] of Object.entries(T12)) {
  test(`T12 cannot compute: ${reason} → the line is written with value null and that reason`, async () => {
    const { r, lines } = await snapshotLine(table);
    assert.equal(r.code, 0, r.err);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].value, null);
    assert.equal(lines[0].variance30, null);
    assert.equal(lines[0].reason, reason);
    if (reason === 'no-bracket') assert.deepEqual(lines[0].terms, []);
    else assert.deepEqual(lines[0].terms.map((t) => t.role), ['near', 'next']);
  });
}

// ---------------------------------------------------------------------- T13
test('T13 hash chain and key order', async () => {
  const out = tmpDir('vol-t13');
  const a = await snapshotLine(handTable([{ rows: good() }, { rows: good() }], US, { minutes: [30000, 50000] }), [], out);
  assert.equal(a.r.code, 0, a.r.err);
  const b = await snapshotLine(handTable([{ rows: good() }, { rows: good() }], US + 86400e6, { minutes: [29000, 49000] }), [], out);
  assert.equal(b.r.code, 0, b.r.err);
  const lines = readJsonl(path.join(out, IMP));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]), ['seq', 'date', 'observedAt', 'index', 'value', 'variance30', 'snapshot', 'terms', 'quotes', 'rule', 'keeper', 'shadow', 'prevHash', 'hash']);
  assert.deepEqual(Object.keys(lines[0].terms[0]), ['role', 'expiry', 'minutes', 'atm', 'forward', 'k0', 'putsUsed', 'callsUsed', 'variance', 'exchangeForward']);
  assert.deepEqual(Object.keys(lines[0].snapshot), ['at', 'usOut', 'host', 'rows', 'expiries', 'rawSha256']);
  assert.deepEqual(lines[0].snapshot.expiries, lines[0].terms.map((t) => t.expiry));
  assert.deepEqual(Object.keys(lines[0].rule), ['rulebookSha256', 'constantMaturityMinutes', 'yearMinutes', 'price', 'validQuote', 'cutoff', 'forward']);
  assert.equal(lines[0].prevHash, null);
  assert.equal(lines[1].prevHash, lines[0].hash);
  assert.deepEqual(lines.map((l) => l.seq), [0, 1]);
  for (const l of lines) {
    const { hash, ...rest } = l;
    assert.equal(H(JSON.stringify(rest)), hash);
  }
  assert.equal(lines[0].rule.cutoff, 'consecutive-invalid:2');
  assert.equal(lines[0].rule.rulebookSha256, H(fs.readFileSync(ON_RB)));
  // the same snapshot day again: nothing to do
  const again = await snapshotLine(handTable([{ rows: good() }, { rows: good() }], US + 86400e6 + 5e6, { minutes: [29000, 49000] }), [], out);
  assert.equal(again.r.code, 0);
  assert.match(again.r.out, /exists — nothing to do/);
  assert.equal(readJsonl(path.join(out, IMP)).length, 2);
  // realized key order
  const ro = tmpDir('vol-t13r');
  const { days } = syntheticDays('2099-01-01', 33);
  writeOffline(path.join(ro, 'bars'), days);
  const rr = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(ro, 'bars'), '--out', ro, '--replay', '2099-02-01..2099-02-02'], { now: () => Date.parse('2099-02-03T01:00:00Z') });
  assert.equal(rr.code, 0, rr.err);
  const [r0, r1] = readJsonl(path.join(ro, REA));
  assert.deepEqual(Object.keys(r0), ['seq', 'date', 'observedAt', 'index', 'value', 'variance', 'late', 'window', 'returns', 'source', 'sources', 'rule', 'keeper', 'shadow', 'prevHash', 'hash']);
  assert.deepEqual(Object.keys(r1), ['seq', 'date', 'observedAt', 'index', 'value', 'variance', 'late', 'window', 'returns', 'source', 'rule', 'keeper', 'shadow', 'prevHash', 'hash']);
  assert.deepEqual(Object.keys(r0.source), ['host', 'symbol', 'interval', 'day', 'rows', 'sha256', 'lastBar', 'finalBy', 'fetchedAt', 'via']);
  assert.deepEqual(Object.keys(r0.rule), ['rulebookSha256', 'windowDays', 'yearDays', 'sampling', 'mean']);
  assert.deepEqual(r1.window.slice(0, 30), r0.window.slice(1));
});

// ---------------------------------------------------------------------- T14
test('T14 without --dry-run and inception null: NOT IN FORCE, exit 0, no file, no request', async () => {
  for (const [line, root] of [['realized', notInForceRoot()], ['implied', ON]]) {
    const out = path.join(tmpDir('vol-t14'), 'never');
    let calls = 0;
    const r = await cli(run, ['--line', line, '--out', out], { root, fetch: async () => (calls++, new Response('[]')) });
    assert.equal(r.code, 0);
    assert.match(r.out, /NOT IN FORCE/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(out), false);
  }
});

test('the switch: the implied line is off in the repository — every mode prints INACTIVE, exit 0, no request, nothing written', async () => {
  const realized = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  const implied = JSON.parse(fs.readFileSync(rulebookPath('implied'), 'utf8'));
  assert.ok(!('active' in realized)); // the realized line has no switch: in force = inception only
  assert.equal(implied.active, false);
  const t = handTable([{ rows: good() }, { rows: good() }], US, { minutes: [30000, 50000] });
  const s = writeSnapshot(path.join(tmpDir('vol-off-snap'), 'snap'), t);
  for (const extra of [[], ['--dry-run'], ['--dry-run', '--from-snapshot', s.book, '--instruments', s.inst], ['--collect-only']]) {
    const out = path.join(tmpDir('vol-off'), 'never');
    let calls = 0;
    const r = await cli(run, ['--line', 'implied', ...extra, '--out', out], { fetch: async () => (calls++, new Response('{}')), now: () => US / 1000 + 60000 });
    assert.equal(r.code, 0, `${extra.join(' ')}: ${r.err}`);
    assert.match(r.out, /volbtc-implied: INACTIVE/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(out), false);
  }
  // the code is not removed: the same rulebook with active true runs (from the scratch root)
  const out = tmpDir('vol-on');
  const r = await icli(['--line', 'implied', '--dry-run', '--from-snapshot', s.book, '--instruments', s.inst, '--out', out], { now: () => US / 1000 + 60000 });
  assert.equal(r.code, 0, r.err);
  assert.equal(readJsonl(path.join(out, IMP)).length, 1);
  // the realized line is not touched by the implied switch
  const ro = tmpDir('vol-off-r');
  const { days } = syntheticDays('2099-01-01', 33);
  writeOffline(path.join(ro, 'bars'), days);
  const rr = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(ro, 'bars'), '--out', ro, '--replay', '2099-02-01..2099-02-01'], { now: () => Date.parse('2099-02-03T01:00:00Z') });
  assert.equal(rr.code, 0, rr.err);
  assert.equal(readJsonl(path.join(ro, REA))[0].rule.rulebookSha256, H(fs.readFileSync(rulebookPath('realized'))));
});

test('configuration refusals exit 2 before anything is read from the network', async () => {
  const bad = [
    ['--line', 'realized', '--replay', '2019-03-04..2019-03-31'], // replay without --dry-run
    ['--line', 'realized', '--gaps', 'x.json'], // gaps without --dry-run
    ['--line', 'realized', '--dry-run', '--quotes', 'hash'], // implied option
    ['--line', 'implied', '--dry-run', '--from-snapshot', 'a.gz'], // no --instruments
    ['--line', 'implied', '--quotes', 'raw'],
    ['--line', 'implied', '--collect-only', '--dry-run'],
    ['--line', 'both'],
    ['--line', 'realized', '--dry-run', '--replay', '2019-03-31..2019-03-04'],
    ['--line', 'realized', '--dry-run', '--anchor'], // a dry run never anchors
    ['--line', 'implied', '--anchor'], // the implied line has no in-force path
    ['--line', 'realized', '--anchor', '--anchor'],
  ];
  for (const argv of bad) {
    let calls = 0;
    const r = await cli(run, argv, { fetch: async () => (calls++, new Response('[]')) });
    assert.equal(r.code, 2, `${argv.join(' ')} → ${r.code} ${r.err}`);
    assert.equal(calls, 0);
  }
  assert.equal(parseArgs(['--line', 'implied']).quotes, 'embed');
  // empty dry-run record and no --replay: the first date is undefined
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--out', tmpDir('vol-empty')], { fetch: async () => new Response('[]') });
  assert.equal(r.code, 2);
});

test('rulebook shape: what the code does not implement is refused (exit 2)', async () => {
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  const ib = JSON.parse(fs.readFileSync(rulebookPath('implied'), 'utf8'));
  assert.equal(rulebookProblem(rb, 'realized'), null);
  assert.equal(rulebookProblem(ib, 'implied'), null);
  const mutate = (base, line, f) => {
    const c = structuredClone(base);
    f(c);
    return rulebookProblem(c, line);
  };
  assert.match(mutate(rb, 'realized', (c) => (c.windowDays = '30')), /windowDays/);
  assert.match(mutate(rb, 'realized', (c) => (c.source.fallback = 'https://example.com')), /no fallback/);
  assert.match(mutate(rb, 'realized', (c) => (c.mean = 'sample')), /mean/);
  assert.match(mutate(ib, 'implied', (c) => (c.cutoff.count = 0)), /cutoff/);
  assert.match(mutate(ib, 'implied', (c) => (c.price = 'depth-weighted')), /price/);
  assert.match(mutate(rb, 'realized', (c) => (c.display.decimals = 4)), /decimals/);
  // the realized line: id and series "qvol", no "active" key
  assert.equal(rb.id, 'qvol');
  assert.equal(rb.series, 'qvol');
  assert.match(mutate(rb, 'realized', (c) => (c.id = 'volbtc')), /id must be "qvol"/);
  assert.match(mutate(rb, 'realized', (c) => (c.series = 'volbtc-realized')), /series must be "qvol"/);
  assert.match(mutate(rb, 'realized', (c) => (c.active = true)), /no switch/);
  assert.match(mutate(rb, 'realized', (c) => (c.active = false)), /no switch/);
  assert.match(mutate(ib, 'implied', (c) => (c.id = 'qvol')), /id must be "volbtc"/);
  // one line's file is not the other's
  assert.match(rulebookProblem(rb, 'implied'), /line must be "implied"/);
  assert.match(rulebookProblem(ib, 'realized'), /line must be "realized"/);
  // the switch and the owner-pending list
  assert.match(mutate(ib, 'implied', (c) => (c.active = 'no')), /active must be true or false/);
  assert.match(mutate(ib, 'implied', (c) => (c.inception = { date: '2099-01-01', decision: 'x' })), /inactive line .* cannot have an inception date/);
  assert.match(mutate(rb, 'realized', (c) => delete c.pendingOwner), /pendingOwner must be a list/);
  assert.match(mutate(rb, 'realized', (c) => c.pendingOwner.push({ path: 'window', what: 'x' })), /"window" is not a key/);
  assert.match(mutate(rb, 'realized', (c) => c.pendingOwner.push({ path: 'source.symbol' })), /\{path, what\}/);
  assert.match(mutate(rb, 'realized', (c) => {
    c.pendingOwner = [{ path: 'windowDays', what: 'x' }];
    c.inception = { date: '2099-01-01', decision: 'x' };
  }), /cannot have values pending the owner/);
  // what waits for the owner: before the inception decision these keys of the realized rulebook are
  // marked pendingOwner (every mark names a key); with an inception date nothing can be (checked above)
  const marked = rb.pendingOwner.map((e) => e.path);
  if (rb.inception.date === null) for (const p of ['source', 'windowDays', 'sampling', 'mean', 'display.decimals']) assert.ok(marked.includes(p), `${p} not marked pendingOwner`);
  else assert.deepEqual(marked, [], 'a rulebook with an inception date has nothing pending the owner');
  // the realized line's name (qVOL) and series id (qvol) are decided: not pending
  for (const p of ['name', 'series']) assert.ok(!marked.includes(p), `${p} still marked pendingOwner`);
  const markedImplied = ib.pendingOwner.map((e) => e.path);
  for (const p of ['active', 'name', 'series', 'source']) assert.ok(markedImplied.includes(p), `implied ${p} not marked pendingOwner`);
  // through the CLI, from a scratch root
  const root = tmpDir('vol-rb');
  const dir = path.join(root, 'keeper', 'rulebooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'qvol.json'), JSON.stringify({ ...rb, id: 'other' }));
  const r = await cli(run, ['--line', 'realized'], { root });
  assert.equal(r.code, 2);
  // no rulebook file for the line: refused
  assert.equal((await cli(run, ['--line', 'implied'], { root })).code, 2);
  // an inception set on an active line with nothing pending: this build has no in-force path → refused, not run
  fs.writeFileSync(path.join(dir, 'volbtc-implied.json'), JSON.stringify({ ...ib, active: true, pendingOwner: [], inception: { date: '2099-01-01', decision: 'x' } }));
  let calls = 0;
  const r2 = await cli(run, ['--line', 'implied'], { root, fetch: async () => (calls++, new Response('{}')) });
  assert.equal(r2.code, 2);
  assert.match(r2.err, /no in-force path/);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------- T15
test('T15 no key: the calculation files, the verifier and the test helpers read no signing key and import no wallet client; keeper/vol-index.mjs reads KEEPER_PK only in the signer of its in-force path and loads viem only there', () => {
  // keeper/vol-index.mjs (the CLI, with the in-force path) and this file (which tests that path with a key generated here) are not in the list
  const files = [
    ...fs.readdirSync(KEEPER).filter((f) => /^vol-.*\.mjs$/.test(f) && f !== 'vol-index.mjs').map((f) => path.join(KEEPER, f)),
    ...fs.readdirSync(path.join(KEEPER, 'test')).filter((f) => /^vol-.*\.mjs$/.test(f) && f !== 'vol-index.test.mjs').map((f) => path.join(KEEPER, 'test', f)),
    VERIFY,
  ];
  assert.ok(files.length >= 8, files.join(','));
  const needles = ['KEEPER' + '_PK', 'BIDDER' + '_PK', "from 'vi" + "em", 'privateKey' + 'ToAccount', 'createWallet' + 'Client', 'process.env.KEE' + 'PER'];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const n of needles) assert.ok(!src.includes(n), `${path.basename(f)} contains ${n}`);
  }
  // keeper/vol-index.mjs: the key only through deps.env, in makeSigner, called once (in the in-force path);
  // no static import of viem — a dry run loads Node built-ins and local modules only
  const cliSrc = fs.readFileSync(path.join(KEEPER, 'vol-index.mjs'), 'utf8');
  assert.ok(!cliSrc.includes('process.env.KEE' + 'PER'));
  assert.equal(cliSrc.split('deps.env.KEEPER' + '_PK').length - 1, 1);
  const signerFn = cliSrc.slice(cliSrc.indexOf('async function makeSigner('), cliSrc.indexOf('async function sendNonceSafe('));
  assert.ok(signerFn.includes('deps.env.KEEPER' + '_PK'));
  assert.equal(cliSrc.split('makeSigner(deps)').length - 1, 2, 'makeSigner: its definition and one call');
  const inForce = cliSrc.slice(cliSrc.indexOf('async function runRealizedInForce('));
  assert.ok(inForce.includes('await makeSigner(deps)'));
  assert.ok(!/^import [^;]*from 'vi[e]m/m.test(cliSrc), 'no static import of viem');
});

// ---------------------------------------------------------------------- T17
test('T17 Deribit error or missing field → exit 1, no line; one-sided instruments are dropped', async () => {
  const table = handTable([{ rows: good() }, { rows: good() }], US, { minutes: [30000, 50000] });
  const now = () => US / 1000 + 60000;
  const cases = {
    http400: { get_book_summary_by_currency: () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: 10000, message: 'synthetic' } }), { status: 400 }) },
    errorBody: { get_instruments: () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: 1, message: 'synthetic' }, usOut: US })) },
    notJson: { get_book_summary_by_currency: () => new Response('<html>') },
    noResult: { get_book_summary_by_currency: () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { x: 1 }, usOut: US })) },
  };
  for (const [name, breakWith] of Object.entries(cases)) {
    const out = tmpDir('vol-t17');
    const fd = fakeDeribit(table, { breakWith });
    const r = await icli(['--line', 'implied', '--dry-run', '--out', out], { fetch: fd.fetch, now });
    assert.equal(r.code, 1, `${name}: ${r.err}`);
    assert.equal(fs.existsSync(path.join(out, IMP)), false, name);
  }
  // a quote row without its bid_price field
  const broken = structuredClone(table);
  delete broken.book[3].bid_price;
  const out = tmpDir('vol-t17b');
  const r = await icli(['--line', 'implied', '--dry-run', '--out', out], { fetch: fakeDeribit(broken).fetch, now });
  assert.equal(r.code, 1);
  assert.match(r.err, /bid_price/);
  assert.equal(fs.existsSync(path.join(out, IMP)), false);
  // instruments in only one of the two calls are dropped
  const extra = structuredClone(table);
  extra.instruments.push({ instrument_name: 'BTC-ONLY-INST', expiration_timestamp: extra.instruments[0].expiration_timestamp, strike: 95, option_type: 'put' });
  extra.book.push({ instrument_name: 'BTC-ONLY-BOOK', bid_price: 0.01, ask_price: 0.02, underlying_price: 100 });
  const o2 = tmpDir('vol-t17c');
  const fd = fakeDeribit(extra);
  const r2 = await icli(['--line', 'implied', '--dry-run', '--out', o2], { fetch: fd.fetch, now });
  assert.equal(r2.code, 0, r2.err);
  const [line] = readJsonl(path.join(o2, IMP));
  assert.equal(line.quotes.length, 36);
  assert.ok(!line.quotes.some((x) => x[1] === 95));
  assert.equal(line.snapshot.rows, extra.book.length);
  assert.deepEqual(fd.calls, ['/api/v2/public/get_instruments', '/api/v2/public/get_book_summary_by_currency']);
  // a line for today exists: nothing to do, no request
  const fd2 = fakeDeribit(extra);
  const r3 = await icli(['--line', 'implied', '--dry-run', '--out', o2], { fetch: fd2.fetch, now });
  assert.equal(r3.code, 0);
  assert.equal(fd2.calls.length, 0);
});

// ---------------------------------------------------------------------- T18
test('T18 --collect-only: two gz files, sha256 of raw and gz, one manifest line, no value, no record', async () => {
  const table = handTable([{ rows: good() }, { rows: good() }], US + 1234567, { minutes: [30000, 50000] });
  const out = tmpDir('vol-t18');
  const fd = fakeDeribit(table);
  const r = await icli(['--line', 'implied', '--collect-only', '--out', out], { fetch: fd.fetch });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fd.calls, ['/api/v2/public/get_instruments', '/api/v2/public/get_book_summary_by_currency']);
  const m = readJsonl(path.join(out, 'collect-manifest.jsonl'));
  assert.equal(m.length, 1);
  assert.deepEqual(Object.keys(m[0]), ['at', 'usOut', 'files', 'sha256Raw', 'sha256Gz', 'rows']);
  assert.deepEqual(m[0].files, ['deribit-instruments-btc-option-21000101T000001Z.json.gz', 'deribit-book-summary-btc-option-21000101T000001Z.json.gz']);
  assert.equal(m[0].usOut, US + 1234567);
  assert.equal(m[0].at, '2100-01-01T00:00:01.234Z');
  m[0].files.forEach((f, i) => {
    const gz = fs.readFileSync(path.join(out, f));
    assert.equal(H(gz), m[0].sha256Gz[i]);
    assert.equal(H(zlib.gunzipSync(gz)), m[0].sha256Raw[i]);
  });
  assert.deepEqual(m[0].rows, [table.instruments.length, table.book.length]);
  assert.equal(fs.existsSync(path.join(out, IMP)), false);
  assert.deepEqual(fs.readdirSync(out).sort(), ['collect-manifest.jsonl', ...m[0].files].sort());
  // a non-array result: nothing written, exit 1
  const o2 = tmpDir('vol-t18b');
  const fb = fakeDeribit(table, { breakWith: { get_book_summary_by_currency: () => new Response(JSON.stringify({ result: null, usOut: US })) } });
  const r2 = await icli(['--line', 'implied', '--collect-only', '--out', o2], { fetch: fb.fetch });
  assert.equal(r2.code, 1);
  assert.deepEqual(fs.readdirSync(o2), []);
  // the saved pair runs through --from-snapshot
  const r3 = await icli(['--line', 'implied', '--dry-run', '--from-snapshot', path.join(out, m[0].files[1]), '--instruments', path.join(out, m[0].files[0]), '--out', out], { now: () => Date.parse('2100-01-01T00:05:00Z') });
  assert.equal(r3.code, 0, r3.err);
  const [line] = readJsonl(path.join(out, IMP));
  assert.deepEqual([line.snapshot.rawSha256.instruments, line.snapshot.rawSha256.bookSummary], m[0].sha256Raw);
});

// ---------------------------------------------- determinism (same input twice)
test('determinism: the same saved snapshot twice, at different times → lines byte-identical apart from observedAt and hash', async () => {
  const t = syntheticTable({ F: 60000, sigma: 0.45, days: [20, 40] });
  const s = writeSnapshot(path.join(tmpDir('vol-det'), 'snap'), t);
  const lines = [];
  for (const now of [t.usOut / 1000 + 60000, t.usOut / 1000 + 9 * 3600000]) {
    const out = tmpDir('vol-det-out');
    const r = await icli(['--line', 'implied', '--dry-run', '--from-snapshot', s.book, '--instruments', s.inst, '--out', out], { now: () => now });
    assert.equal(r.code, 0, r.err);
    lines.push(readJsonl(path.join(out, IMP))[0]);
  }
  const strip = ({ observedAt, hash, ...rest }) => rest;
  assert.notEqual(lines[0].observedAt, lines[1].observedAt);
  assert.equal(JSON.stringify(strip(lines[0])), JSON.stringify(strip(lines[1])));
  // keeper.lagSeconds is measured from the snapshot time, not the run time
  assert.equal(lines[0].keeper.lagSeconds, lines[1].keeper.lagSeconds);
});

// ---------------------------------------------------------------------- T19
test('T19 scripts/verify-vol.mjs (separate code) agrees with the module on every field; a changed field fails it', async () => {
  // implied: the synthetic flat-vol table, embed and hash
  const t = syntheticTable({ F: 60000, sigma: 0.6, days: [20, 40] });
  const a = await snapshotLine(t);
  assert.equal(a.r.code, 0, a.r.err);
  assert.equal(verify(a.out).status, 0);
  const h = await snapshotLine(t, ['--quotes', 'hash']);
  assert.equal(h.r.code, 0, h.r.err);
  const hl = h.lines[0];
  assert.ok(!('quotes' in hl));
  assert.equal(hl.quotesSha256, quotesSha256(a.lines[0].quotes));
  assert.ok(hl.terms.every((x) => !('exchangeForward' in x)));
  assert.equal(hl.value, a.lines[0].value);
  assert.ok(fs.existsSync(path.join(h.out, 'quotes', `${hl.quotesSha256}.json`)));
  const vh = verify(h.out);
  assert.equal(vh.status, 0, vh.stdout);
  assert.match(vh.stdout, /"hashedNotRecomputed": 0/);
  // tamper an implied line (and fix its hash so only the recompute can catch it)
  const bad = a.lines[0];
  bad.terms[0].putsUsed += 1;
  delete bad.hash;
  bad.hash = H(JSON.stringify(bad));
  const tdir = tmpDir('vol-t19i');
  fs.writeFileSync(path.join(tdir, IMP), JSON.stringify(bad) + '\n');
  const vi = verify(tdir);
  assert.equal(vi.status, 1);
  assert.match(vi.stdout, /putsUsed/);
  // realized: synthetic bars, offline
  const ro = tmpDir('vol-t19r');
  const { days } = syntheticDays('2099-01-01', 36);
  writeOffline(path.join(ro, 'bars'), days);
  const rr = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(ro, 'bars'), '--out', ro, '--replay', `2099-02-01..${addDays('2099-02-01', 4)}`], { now: () => Date.parse('2099-03-01T00:00:00Z') });
  assert.equal(rr.code, 0, rr.err);
  const vr = verify(ro, '--line', 'realized');
  assert.equal(vr.status, 0, vr.stdout);
  const lines = readJsonl(path.join(ro, REA));
  assert.equal(lines.length, 5);
  const t2 = lines.map((l) => ({ ...l }));
  t2[3].value = t2[3].value * (1 + 1e-6); // beyond the relative 1e-9
  for (let i = 3; i < t2.length; i++) {
    t2[i].prevHash = i === 0 ? null : t2[i - 1].hash;
    delete t2[i].hash;
    t2[i].hash = H(JSON.stringify(t2[i]));
  }
  const tr = tmpDir('vol-t19rr');
  fs.writeFileSync(path.join(tr, REA), t2.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const vt = verify(tr);
  assert.equal(vt.status, 1);
  assert.match(vt.stdout, /value .* vs recomputed/);
});

// ------- expiry re-check, forward edge, --rulebook, --tail, fetch time-out
const rehash = (line) => {
  const { hash, ...rest } = line;
  return { ...rest, hash: H(JSON.stringify(rest)) };
};
const writeLines = (file, lines) => {
  const d = tmpDir('vol-more');
  fs.writeFileSync(path.join(d, file), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return d;
};

test('expiry choice is re-made from snapshot.expiries: a wrong near term or empty terms with a bracket fail the verifier, hashed lines included', async () => {
  // listed expiries at 20,000 · 30,000 · 50,000 minutes: near = 30,000, next = 50,000
  const t = handTable([{ rows: good() }, { rows: good() }, { rows: good() }], US, { minutes: [20000, 30000, 50000] });
  const a = await snapshotLine(t);
  assert.equal(a.r.code, 0, a.r.err);
  const L = a.lines[0];
  assert.equal(L.snapshot.expiries.length, 3);
  assert.deepEqual(L.terms.map((x) => x.expiry), L.snapshot.expiries.slice(1));
  assert.equal(verify(a.out).status, 0);
  // an expiry at 40,000 minutes listed but not chosen: the keeper would have picked it as near
  const e40 = new Date(US / 1000 + 40000 * 60000).toISOString();
  const wrongNear = rehash({ ...L, snapshot: { ...L.snapshot, expiries: [...L.snapshot.expiries.slice(0, 2), e40, L.snapshot.expiries[2]] } });
  const v1 = verify(writeLines(IMP, [wrongNear]));
  assert.equal(v1.status, 1);
  assert.match(v1.stdout, /the listed expiries give/);
  // terms [] (no-bracket) although the listed expiries bracket 30 days
  const { hash, ...o } = L;
  const nb = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'value') nb.value = null;
    else if (k === 'variance30') Object.assign(nb, { variance30: null, reason: 'no-bracket' });
    else if (k === 'terms' || k === 'quotes') nb[k] = [];
    else nb[k] = v;
  }
  const v2 = verify(writeLines(IMP, [rehash(nb)]));
  assert.equal(v2.status, 1);
  assert.match(v2.stdout, /no terms, but the listed expiries bracket/);
  // a hashed line without its quotes file still has its expiry choice checked
  const h = await snapshotLine(t, ['--quotes', 'hash']);
  assert.equal(h.r.code, 0, h.r.err);
  const hl = h.lines[0];
  const okHashed = verify(writeLines(IMP, [hl]));
  assert.equal(okHashed.status, 0, okHashed.stdout);
  assert.match(okHashed.stdout, /"hashedNotRecomputed": 1/);
  const badHashed = rehash({ ...hl, snapshot: { ...hl.snapshot, expiries: [...hl.snapshot.expiries.slice(0, 2), e40, hl.snapshot.expiries[2]] } });
  const v3 = verify(writeLines(IMP, [badHashed]));
  assert.equal(v3.status, 1);
  assert.match(v3.stdout, /the listed expiries give/);
});

test('forward: 1 - (c* - p*) <= 0 gives no forward → a line with k0-quote-invalid (was an exit 1 when the difference was exactly 1)', async () => {
  const noFwd = (c) => [
    [90, ...q(1.25), null, null],
    [100, ...q(c), ...q(0.0625)],
    [110, ...q(1.0), null, null],
  ];
  for (const c of [1.0625, 1.5625]) {
    const { r, out, lines } = await snapshotLine(twoTerms(noFwd(c)));
    assert.equal(r.code, 0, r.err);
    assert.equal(lines[0].value, null);
    assert.equal(lines[0].reason, 'k0-quote-invalid');
    assert.deepEqual(Object.keys(lines[0].terms[0]), ['role', 'expiry', 'minutes', 'atm', 'exchangeForward']);
    assert.equal(lines[0].terms[0].atm, 100);
    const v = verify(out);
    assert.equal(v.status, 0, v.stdout);
  }
});

test('--rulebook: the rule of every line is checked against its line\'s rulebook JSON (sha256 and values)', async () => {
  const ro = tmpDir('vol-rb-chk');
  const { days } = syntheticDays('2099-01-01', 34);
  writeOffline(path.join(ro, 'bars'), days);
  const rr = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(ro, 'bars'), '--out', ro, '--replay', '2099-02-01..2099-02-02'], { now: () => Date.parse('2099-03-01T00:00:00Z') });
  assert.equal(rr.code, 0, rr.err);
  const rbFile = rulebookPath('realized');
  const ok = verify(ro, '--rulebook', rbFile);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, new RegExp(`"realized": "${H(fs.readFileSync(rbFile))}"`));
  assert.match(ok.stdout, /"implied": "not checked"/);
  const other = JSON.parse(fs.readFileSync(rbFile, 'utf8'));
  other.windowDays = 10;
  const otherFile = path.join(ro, 'other.json');
  fs.writeFileSync(otherFile, JSON.stringify(other));
  const bad = verify(ro, '--rulebook', otherFile);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /rule differs from the rulebook/);
  assert.equal(verify(ro).status, 0); // without --rulebook: not checked
  // a change in the implied rulebook (switching it on) does not touch the realized line's check
  const on = verify(ro, '--rulebook', rbFile, '--rulebook', ON_RB);
  assert.equal(on.status, 0, on.stdout);
  // usage: two rulebooks for one line, a rulebook for the other --line, a flag as the value
  assert.equal(verify(ro, '--rulebook', rbFile, '--rulebook', otherFile).status, 2);
  assert.equal(verify(ro, '--line', 'implied', '--rulebook', rbFile).status, 2);
  assert.equal(verify(ro, '--rulebook', '--tail').status, 2);
});

test('--tail: the record’s last line is context, the new line is checked against it; a changed new line fails', async () => {
  const ro = tmpDir('vol-tail');
  const { days } = syntheticDays('2099-01-01', 36);
  writeOffline(path.join(ro, 'bars'), days);
  const rr = await cli(run, ['--line', 'realized', '--dry-run', '--offline', path.join(ro, 'bars'), '--out', ro, '--replay', '2099-02-01..2099-02-05'], { now: () => Date.parse('2099-03-01T00:00:00Z') });
  assert.equal(rr.code, 0, rr.err);
  const lines = readJsonl(path.join(ro, REA));
  assert.equal(lines.length, 5);
  const ok = verify(writeLines(REA, [lines[2], lines[3]]), '--tail');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /"lines": 1/);
  const changed = rehash({ ...lines[3], value: lines[3].value * (1 + 1e-6) });
  const bad = verify(writeLines(REA, [lines[2], changed]), '--tail');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /value .* vs recomputed/);
  // without --tail the same two lines are not a record (seq 2 first)
  assert.equal(verify(writeLines(REA, [lines[2], lines[3]])).status, 1);
  // a gap in the chain is caught in tail mode too
  assert.equal(verify(writeLines(REA, [lines[1], lines[3]]), '--tail').status, 1);
});

test('fetch time-out: each attempt gets an abort signal; a time-out is retried, then the call fails', async () => {
  const { binanceRest, deribitRest, FETCH_TIMEOUT_MS } = await import('../vol-sources.mjs');
  assert.equal(FETCH_TIMEOUT_MS, 30000);
  let calls = 0;
  const hang = (url, opts) => {
    calls++;
    assert.ok(opts?.signal instanceof AbortSignal);
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  };
  // AbortSignal.timeout's timer does not hold the event loop open (a real request's socket does): hold it here
  const hold = setInterval(() => {}, 1000);
  try {
    const b = binanceRest({ host: 'https://binance.invalid', fetchImpl: hang, wait: async () => {}, timeoutMs: 20 });
    await assert.rejects(() => b.time(), (e) => e.name === 'TimeoutError');
    assert.equal(calls, 3);
    calls = 0;
    const d = deribitRest({ host: 'https://deribit.invalid', calls: ['/a', '/b'], fetchImpl: hang, wait: async () => {}, timeoutMs: 20 });
    await assert.rejects(() => d.instruments(), (e) => e.name === 'TimeoutError');
    assert.equal(calls, 3);
  } finally {
    clearInterval(hold);
  }
});

// =================================================== the realized line in force
//
// A scratch repository root holds the realized rulebook with a stand-in
// inception (THROWAWAY: the decision below is not a decision and was never
// anchored; the values of the rule are the repository's), an empty gap
// acceptance file, a ledger line and a decision file that pins the rulebook's
// sha256. Bars are SYNTHETIC (syntheticDays), served by the fake Binance of
// vol-helpers; the chain is the fake GIWA node of leverage-helpers (raw signed
// transactions only, one QuadrixIndexVault with the ±25% bound); the key is
// generated here and holds nothing anywhere.

const E = '2099-02-01'; // the stand-in decision's effective (anchor) day
const D1 = '2099-02-02'; // its first line: the next UTC day = inception.date
const DECISION = `${E}-qvol-inception`;
const QVAULT = getAddress('0x00000000000000000000000000000000000beef5');
const BARS = syntheticDays('2099-01-01', 45).days; // closes for 2098-12-31 … 2099-02-14
const ANC = 'anchors-qvol.jsonl';
const readJsonlText = (buf) => buf.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
/** A child process, without blocking this process (a local server answers meanwhile). */
const runChild = (args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env: { PATH: process.env.PATH } });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });

function inForceRoot({ effective = E, first = D1, pin = true, vaults = null, ledger = true, id: decisionId = null } = {}) {
  const root = tmpDir('vol-inforce');
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  rb.status = 'TEST ONLY — a stand-in inception for the in-force tests; not a decision';
  rb.inception = { date: first, decision: decisionId ?? `${effective}-qvol-inception` };
  rb.pendingOwner = [];
  fs.mkdirSync(path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'trackrecord', 'decisions'), { recursive: true });
  const rbBytes = Buffer.from(JSON.stringify(rb, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', 'qvol.json'), rbBytes);
  fs.writeFileSync(path.join(root, 'keeper', 'vol-index-gaps.json'), '[]\n');
  if (vaults) fs.writeFileSync(path.join(root, 'keeper', 'leverage-vaults.json'), JSON.stringify(vaults, null, 2) + '\n');
  const id = decisionId ?? `${effective}-qvol-inception`;
  const doc = `# TEST ONLY — stand-in decision\n\nPins keeper/rulebooks/qvol.json sha256 ${pin ? H(rbBytes) : '0'.repeat(64)}.\n`;
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions', `${id}.md`), doc);
  const entry = { id, file: `decisions/${id}.md`, effectiveFrom: effective, sha256: H(Buffer.from(doc)), txHash: `0x${'d'.repeat(64)}`, anchoredAt: `${effective}T09:00:00.000Z` };
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), ledger ? JSON.stringify(entry) + '\n' : '');
  return { root, rbFile: path.join(root, 'keeper', 'rulebooks', 'qvol.json'), entry, rec: path.join(root, 'trackrecord', REA), anc: path.join(root, 'trackrecord', ANC), marks: path.join(root, 'keeper', 'marks-qvol.jsonl') };
}
/** The display vault's stand-in deployment: a contract creation in block 60 (chainExtras answers it as the signer's). */
const DEPLOY_TX = `0x${'e'.repeat(64)}`;
const qvolVaults = (gate = { mode: 'step' }, address = QVAULT) => ({ qvol: { chainId: 91342, address, gate, deployTx: address ? DEPLOY_TX : null, block: address ? 60 : null } });

const DEPOSIT_CAP = toFunctionSelector('function depositCap()');
const hexN = (n) => `0x${BigInt(n).toString(16)}`;
/** A transaction as eth_getTransactionByHash answers it. */
const rpcTx = ({ hash, from, to = null, input = '0x', block = null }) => ({
  hash, from, to, input, value: '0x0', nonce: '0x0', gas: '0xea60', type: '0x2', chainId: hexN(91342), maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x1',
  accessList: [], v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', transactionIndex: block == null ? null : '0x0',
  blockNumber: block == null ? null : hexN(block), blockHash: block == null ? null : `0x${BigInt(block).toString(16).padStart(64, '0')}`,
});
/**
 * What GIWA would answer for transactions the fake node did not see, stand-ins
 * read from a scratch root: the inception decision's anchor (the ledger's
 * txHash: a self-send from `from` with calldata qxdec:<sha256>, as
 * scripts/anchor-decision.mjs sends it) and the display vault's deployment
 * (the registry's deployTx: a contract creation by `from` whose receipt names
 * the registry's address). hash → {from, to, input, block, contractAddress}.
 */
function chainExtras(root, from, { fork = false } = {}) {
  const m = new Map();
  if (!root || !from) return m;
  for (const e of readJsonl(path.join(root, 'trackrecord', 'decisions.jsonl'))) {
    if (/^0x[0-9a-fA-F]{64}$/.test(e.txHash ?? '')) m.set(e.txHash.toLowerCase(), { from, to: from, input: toHex(`qxdec:${e.sha256}`), block: 50 });
  }
  const reg = path.join(root, 'keeper', ...(fork ? ['dryrun'] : []), 'leverage-vaults.json');
  const v = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, 'utf8')).qvol : null;
  if (v?.address && /^0x[0-9a-fA-F]{64}$/.test(v.deployTx ?? '')) m.set(v.deployTx.toLowerCase(), { from, to: null, input: '0x6080604052', block: 60, contractAddress: getAddress(v.address) });
  return m;
}
/**
 * eth_getTransactionByHash (which the fake node does not answer) for the
 * node's own transactions and the stand-ins of chainExtras, and
 * eth_getTransactionReceipt for the stand-ins; a hash in `forget` is unknown
 * (a reorg dropped it). undefined: the node answers the request itself.
 */
function txView(node, req, { root = null, from = null, fork = false, forget = null } = {}) {
  if (req.method !== 'eth_getTransactionByHash' && req.method !== 'eth_getTransactionReceipt') return undefined;
  const h = String(req.params?.[0] ?? '').toLowerCase();
  if (forget?.has(h)) return null;
  const own = node.txs.find((t) => t.hash.toLowerCase() === h);
  const x = own ? null : chainExtras(root, from, { fork }).get(h);
  if (req.method === 'eth_getTransactionByHash') return own ? rpcTx({ ...own, input: own.data }) : x ? rpcTx({ hash: h, ...x }) : null;
  if (!x) return undefined;
  return {
    transactionHash: h, blockNumber: hexN(x.block), blockHash: `0x${BigInt(x.block).toString(16).padStart(64, '0')}`, transactionIndex: '0x0', status: x.status ?? '0x1', gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca01', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: x.contractAddress ?? null, from: x.from, to: x.to,
  };
}
/**
 * The fake node as viem's transport, without retries. viem first asks a node to
 * fill a transaction (eth_fillTransaction); the fake node, like a node without
 * that method, refuses it, and viem then fills it itself — answered here at once
 * as "method not found" instead of after viem's retry delays. The vault's
 * depositCap() (which the fake node does not model) answers `cap` (0 unless a
 * test sets it). `refuse(req)` may throw for a request (an injected failure);
 * `answer(req)` may answer one itself. Transactions are looked up through
 * txView (`chain`: {root, from, fork, forget}).
 */
const quick = (node, refuse = null, { cap = 0n, answer = null, ...chain } = {}) =>
  custom(
    {
      async request(req) {
        if (req.method === 'eth_fillTransaction') throw Object.assign(new Error('the method eth_fillTransaction does not exist'), { code: -32601 });
        if (req.method === 'eth_call' && String(req.params?.[0]?.data ?? '').startsWith(DEPOSIT_CAP)) return `0x${cap.toString(16).padStart(64, '0')}`;
        if (refuse) refuse(req);
        const given = answer?.(req); // a test's own answer to a request (undefined: none)
        if (given !== undefined) return given;
        const seen = txView(node, req, chain);
        if (seen !== undefined) return seen;
        return node.transport({ retryCount: 0 }).request(req);
      },
    },
    { retryCount: 0 }
  );

/**
 * The fake Binance of vol-helpers answers every klines call with 1-minute rows
 * (it does not read `interval`). Daily candles (interval=1d) are answered
 * here from the same bars, as Binance's are: a closed day's candle opens at
 * 00:00 UTC and closes at the day's last 1-minute close. `daily(day, close)`
 * may change a candle's close (undefined: unchanged; null: no candle).
 */
function withDaily(bin, days, serverTime, { daily = null } = {}) {
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname !== '/api/v3/klines' || u.searchParams.get('interval') !== '1d') return bin.fetch(url, init);
    bin.calls.push(u.pathname + u.search);
    const rows = dailyKlines(days, { daily, from: Number(u.searchParams.get('startTime')), to: Number(u.searchParams.get('endTime')), serverTime });
    return new Response(JSON.stringify(rows.slice(0, Number(u.searchParams.get('limit')))), { status: 200 });
  };
  return { fetch, calls: bin.calls };
}
/** Daily candles (klines rows, as Binance's REST API answers interval=1d) of the closed days of `days` that open in [from, to]. */
function dailyKlines(days, { daily = null, from = -Infinity, to = Infinity, serverTime = Infinity } = {}) {
  const rows = [];
  for (const d of Object.keys(days).sort()) {
    const open = Date.parse(`${d}T00:00:00Z`);
    const mins = days[d];
    if (open < from || open > to || !mins.length || open + 86_400_000 - 1 >= serverTime) continue;
    let c = mins.at(-1).c;
    if (daily) {
      const x = daily(d, c);
      if (x === null) continue;
      if (x !== undefined) c = x;
    }
    const hi = Math.max(c, ...mins.map((m) => m.h));
    const lo = Math.min(c, ...mins.map((m) => m.l));
    rows.push([open, mins[0].o.toFixed(8), hi.toFixed(8), lo.toFixed(8), c.toFixed(8), '1440.00000000', open + 86_400_000 - 1, '1.0', 1440, '0.5', '0.5', '0']);
  }
  return rows;
}

/** One in-force run at `iso` (the runner's clock; the fake Binance's server time is 5 minutes later). */
async function inForce(root, iso, { key = null, node = null, transport = null, argv = ['--anchor'], extra = {}, bars = BARS, tamper = null, daily = null, chain = {} } = {}) {
  const now = Date.parse(iso);
  const bin = withDaily(fakeBinance(bars, now + 300_000, tamper ? { tamper } : {}), bars, now + 300_000, { daily });
  const from = key ? privateKeyToAccount(key).address : null;
  const r = await cli(run, ['--line', 'realized', ...argv], {
    root, now: () => now, fetch: bin.fetch, env: key ? { KEEPER_PK: key } : {},
    transport: transport ? () => transport : node ? () => quick(node, null, { root, from, ...chain }) : () => { throw new Error('no chain call expected'); },
    pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 }, ...extra,
  });
  return { ...r, binanceCalls: bin.calls.length, calls: bin.calls };
}
const listAll = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out.sort();
};
const keyed = () => {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
};

test('in force T-IF1: NOT IN FORCE while inception is null, while the decision is not in the ledger, and before inception.date 00:00 UTC — exit 0, nothing written, no request to Binance or the chain, the key not read', async () => {
  // the repository's rulebook with inception null (a scratch copy: the state the daily step runs in before the anchor)
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  let calls = 0;
  const r0 = await cli(run, ['--line', 'realized', '--anchor'], { root: notInForceRoot(), env: { KEEPER_PK: key }, fetch: async () => (calls++, new Response('[]')), transport: () => node.transport });
  assert.equal(r0.code, 0, r0.err);
  assert.match(r0.out, /qvol: NOT IN FORCE \(keeper\/rulebooks\/qvol\.json inception is null\) — nothing read, nothing written/);
  assert.equal(calls, 0);
  assert.equal(node.methods.length, 0);
  // the rulebook names its decision, which is not in the ledger yet (between the push and the anchor)
  const a = inForceRoot({ ledger: false });
  const before = listAll(a.root);
  const r1 = await inForce(a.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, new RegExp(`NOT IN FORCE: decision not anchored or does not pin this rulebook \\(${DECISION} is not in trackrecord/decisions\\.jsonl\\)`));
  assert.deepEqual(listAll(a.root), before);
  assert.equal(r1.binanceCalls, 0);
  assert.equal(node.methods.length, 0);
  // anchored on E: the 00:25 run of E itself is before the first line's day
  const b = inForceRoot();
  const before2 = listAll(b.root);
  const r2 = await inForce(b.root, `${E}T23:59:00Z`, { key, node });
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, new RegExp(`NOT IN FORCE: the first line is dated ${D1} \\(inception\\.date\\) and is not written before ${D1}T00:00Z`));
  assert.deepEqual(listAll(b.root), before2);
  assert.equal(r2.binanceCalls, 0);
  assert.equal(node.methods.length, 0);
});

test('in force T-IF2: an anchored decision that the files do not satisfy is refused (exit 2) — no rulebook sha256 in it, a changed decision file, an effective date other than the day before inception.date; once the record has a line, a missing decision is refused too', async () => {
  const cases = [
    ['the decision does not carry the rulebook sha256', () => inForceRoot({ pin: false }), /does not contain the rulebook sha256 [0-9a-f]{64}/],
    ['the decision file changed after its anchor', () => {
      const x = inForceRoot();
      fs.appendFileSync(path.join(x.root, 'trackrecord', 'decisions', `${DECISION}.md`), 'edited\n');
      return x;
    }, /no longer hashes to the ledger's value/],
    ['effective on the first line\'s day (inception.date = effectiveFrom)', () => inForceRoot({ effective: D1, first: D1 }), new RegExp(`is effective from ${D1}, so the first line is dated 2099-02-03, but the rulebook's inception\\.date is ${D1}`)],
    ['effective two days before the first line', () => inForceRoot({ effective: '2099-01-31', first: D1 }), /so the first line is dated 2099-02-01, but the rulebook's inception\.date is 2099-02-02/],
  ];
  for (const [label, make, why] of cases) {
    const x = make();
    const before = listAll(x.root);
    const r = await inForce(x.root, '2099-02-03T00:25:00Z');
    assert.equal(r.code, 2, `${label}: exit ${r.code} ${r.err}`);
    assert.match(r.err, /the series cannot start/, label);
    assert.match(r.err, why, label);
    assert.deepEqual(listAll(x.root), before, `${label}: a file changed`);
    assert.equal(r.binanceCalls, 0, `${label}: Binance was called`);
  }
  // started: the record has a line, then the ledger loses the decision — a refusal, not a quiet exit 0
  const s = inForceRoot();
  assert.equal((await inForce(s.root, `${D1}T00:25:00Z`, { argv: [] })).code, 0);
  fs.writeFileSync(path.join(s.root, 'trackrecord', 'decisions.jsonl'), '');
  const r = await inForce(s.root, '2099-02-03T00:25:00Z', { argv: [] });
  assert.equal(r.code, 2);
  assert.match(r.err, /already holds 1 line\(s\), so the series has started — NOT IN FORCE: decision not anchored/);
  assert.equal(readJsonl(s.rec).length, 1);
  // --out is for a dry run
  const o = await cli(run, ['--line', 'realized', '--out', tmpDir('vol-if-out')], { root: inForceRoot().root, now: () => Date.parse(`${D1}T00:25:00Z`) });
  assert.equal(o.code, 2);
  assert.match(o.err, /--out is for --dry-run and --collect-only/);
});

test('in force T-IF3: the first line is dated inception.date (the day after the decision\'s effective date) and written at 00:25 UTC that day without "late"; it carries inception {decision, decisionSha256} and no "shadow", and otherwise the dry run\'s fields, values and order; scripts/verify-vol.mjs agrees; it is anchored with calldata qxpi-qvol:<line hash>, signed here and sent raw', async () => {
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(r.code, 0, r.err);
  const lines = readJsonl(x.rec);
  assert.equal(lines.length, 1);
  const L0 = lines[0];
  assert.equal(L0.date, D1);
  assert.equal(L0.seq, 0);
  assert.equal(L0.observedAt, `${D1}T00:25:00.000Z`);
  assert.ok(!('late' in L0) && !('shadow' in L0));
  assert.deepEqual(L0.inception, { decision: DECISION, decisionSha256: x.entry.sha256 });
  assert.deepEqual(Object.keys(L0), ['seq', 'date', 'observedAt', 'index', 'value', 'variance', 'window', 'returns', 'source', 'sources', 'rule', 'keeper', 'inception', 'prevHash', 'hash']);
  assert.equal(L0.rule.rulebookSha256, H(fs.readFileSync(x.rbFile)));
  assert.equal(L0.keeper.lagSeconds, 25 * 60);
  // the same day as a dry run from the same bars: the same values and fields
  const dry = tmpDir('vol-if-dry');
  const d = await cli(run, ['--line', 'realized', '--dry-run', '--out', dry, '--replay', `${D1}..${D1}`], { root: x.root, now: () => Date.parse(`${D1}T00:25:00Z`), fetch: fakeBinance(BARS, Date.parse(`${D1}T00:30:00Z`)).fetch });
  assert.equal(d.code, 0, d.err);
  const [dl] = readJsonl(path.join(dry, REA));
  const { inception: _i, ...a } = timeless(L0);
  const { shadow: _s, ...b } = timeless(dl);
  assert.deepEqual(a, b);
  assert.equal(L0.value, dl.value);
  // no line for the decision's own day or before it
  assert.ok(!lines.some((l) => l.date <= E));
  // scripts/verify-vol.mjs on the record, the rule against the rulebook JSON
  const v = verify(path.join(x.root, 'trackrecord'), '--line', 'realized', '--rulebook', x.rbFile);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  // the anchor
  const anchors = readJsonl(x.anc);
  assert.deepEqual(anchors.map((y) => [y.date, y.seq, y.headHash]), [[D1, 0, L0.hash]]);
  assert.deepEqual(node.anchorsOf(), [`qxpi-qvol:${L0.hash}`]);
  assert.ok(node.txs.every((t) => t.from === address && t.to === address));
  assert.ok(!node.methods.includes('eth_sendTransaction') && !node.methods.includes('wallet_sendTransaction'), node.methods.join(','));
  assert.equal(anchors[0].txHash, node.txs[0].hash);
  // no vault in the registry: no mark
  assert.match(r.out, /qvol: no vault — marks skipped/);
  assert.equal(fs.existsSync(x.marks), false);
  // the same minute again: nothing new, nothing sent
  const again = await inForce(x.root, `${D1}T00:26:00Z`, { key, node });
  assert.equal(again.code, 0, again.err);
  assert.equal(readJsonl(x.rec).length, 1);
  assert.equal(node.txs.length, 1);
});

test('in force T-IF4 late: a day the earlier runs missed is written by a later run from the same closed bars and carries "late": true, the day of the run does not; days before the first line are never written; line D is not written before D 00:00 UTC', async () => {
  const x = inForceRoot();
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { argv: [] })).code, 0);
  // two scheduled runs missed; the run of 2099-02-05 writes 02-03 and 02-04 late, then 02-05 on time
  const r = await inForce(x.root, '2099-02-05T00:25:00Z', { argv: [] });
  assert.equal(r.code, 0, r.err);
  const lines = readJsonl(x.rec);
  assert.deepEqual(lines.map((l) => [l.date, l.late === true]), [[D1, false], ['2099-02-03', true], ['2099-02-04', true], ['2099-02-05', false]]);
  assert.match(r.out, /qvol #1 2099-02-03 .* \(late\)/);
  // the late values are those of the same days computed from the same bars (a dry-run replay)
  const dry = tmpDir('vol-if-late');
  const d = await cli(run, ['--line', 'realized', '--dry-run', '--out', dry, '--replay', `${D1}..2099-02-05`], { root: x.root, now: () => Date.parse('2099-03-01T00:00:00Z'), fetch: fakeBinance(BARS, Date.parse('2099-02-05T00:30:00Z')).fetch });
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(lines.map((l) => [l.value, l.variance]), readJsonl(path.join(dry, REA)).map((l) => [l.value, l.variance]));
  assert.equal(verify(path.join(x.root, 'trackrecord'), '--line', 'realized', '--rulebook', x.rbFile).status, 0);
  // the runner's clock before the next day: nothing written for it
  const early = await inForce(x.root, '2099-02-05T23:59:00Z', { argv: [] });
  assert.equal(early.code, 0, early.err);
  assert.match(early.out, /line 2099-02-06 not written: the runner's clock .* is before 2099-02-06T00:00Z/);
  assert.equal(readJsonl(x.rec).length, 4);
  // a source that still calls the day open a full day later is stuck: exit 1, nothing written
  const stuck = await cli(run, ['--line', 'realized'], { root: x.root, now: () => Date.parse('2099-02-07T01:00:00Z'), fetch: fakeBinance(BARS, Date.parse('2099-02-05T23:00:00Z')).fetch });
  assert.equal(stuck.code, 1);
  assert.match(stuck.err, /the source is stuck; nothing written for 2099-02-06/);
  assert.equal(readJsonl(x.rec).length, 4);
});

test('in force T-IF5: when scripts/verify-vol.mjs rejects the new line, nothing is appended, anchored or marked (exit 1)', async () => {
  const failing = path.join(tmpDir('vol-if-v'), 'verify-fails.mjs');
  fs.writeFileSync(failing, "console.log('FAIL injected'); process.exit(1);\n");
  const x = inForceRoot({ vaults: qvolVaults() });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node, extra: { verifyScript: failing } });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`independent recompute \\(scripts/verify-vol\\.mjs\\) rejected line ${D1} — nothing appended, nothing anchored, no mark`));
  assert.equal(readJsonl(x.rec).length, 0);
  assert.equal(node.txs.length, 0);
  assert.equal(fs.existsSync(x.marks), false);
  // with a line on the record: the next line is rejected, the record keeps its line and nothing more is sent
  // (the injected verifier fails the new line's check, --tail, and runs the real one on the record as a whole)
  const failingTail = path.join(tmpDir('vol-if-v'), 'verify-fails-tail.mjs');
  fs.writeFileSync(failingTail, `import { spawnSync } from 'node:child_process';\nif (process.argv.includes('--tail')) { console.log('FAIL injected'); process.exit(1); }\nprocess.exit(spawnSync(process.execPath, [${JSON.stringify(VERIFY)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status);\n`);
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  const sent = node.txs.length;
  const r2 = await inForce(x.root, '2099-02-03T00:25:00Z', { key, node, extra: { verifyScript: failingTail } });
  assert.equal(r2.code, 1, r2.err);
  assert.match(r2.err, /independent recompute \(scripts\/verify-vol\.mjs\) rejected line 2099-02-03 — nothing appended, nothing anchored, no mark/);
  assert.equal(readJsonl(x.rec).length, 1);
  assert.equal(node.txs.length, sent);
});

test('in force T-IF6: no mark before the anchor — a line whose anchor fails stays written (exit 1, nothing marked) and the next run anchors it first, then marks; without the key lines are written unanchored and nothing is marked', async () => {
  const { key, address } = keyed();
  // without the key: written, not anchored, no mark
  const x = inForceRoot({ vaults: qvolVaults() });
  const r0 = await inForce(x.root, `${D1}T00:25:00Z`, { argv: ['--anchor'] });
  assert.equal(r0.code, 0, r0.err);
  assert.match(r0.out, /--anchor requested but KEEPER_PK is not set — lines are written unanchored/);
  assert.match(r0.out, /qvol: no signer — marks skipped/);
  assert.equal(readJsonl(x.rec).length, 1);
  assert.equal(fs.existsSync(x.anc), false);
  // the node refuses the anchor: the line stays written, nothing is marked
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const refusing = quick(node, (req) => {
    if (req.method === 'eth_sendRawTransaction' && getAddress(parseTransaction(req.params[0]).to) !== QVAULT) throw new Error('injected: the node refused the anchor');
  }, { root: x.root, from: address });
  const r1 = await inForce(x.root, '2099-02-03T00:25:00Z', { key, transport: refusing });
  assert.equal(r1.code, 1);
  assert.match(r1.err, new RegExp(`line #0 ${D1} is written but its anchor failed: .* — no mark; the next run anchors it first`));
  assert.equal(readJsonl(x.rec).length, 1, 'the run stops at the first anchor: no new line after it');
  assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0, 'no setNav');
  assert.equal(fs.existsSync(x.marks), false);
  // the next run with a working node: the unanchored line first, then the new line and its anchor, then the mark
  const r2 = await inForce(x.root, '2099-02-03T00:25:00Z', { key, node });
  assert.equal(r2.code, 0, r2.err);
  const out = r2.out.split('\n');
  const first = out.findIndex((l) => /#0 2099-02-02 has no anchor — anchoring it first/.test(l));
  const newLine = out.findIndex((l) => /^qvol #1 2099-02-03 /.test(l));
  const mark = out.findIndex((l) => /vault .*: navPerShare 1000000 → target/.test(l));
  assert.ok(first >= 0 && first < newLine && newLine < mark, r2.out);
  const lines = readJsonl(x.rec);
  assert.deepEqual(readJsonl(x.anc).map((a) => a.seq), [0, 1]);
  assert.deepEqual(node.anchorsOf(), lines.map((l) => `qxpi-qvol:${l.hash}`));
  const kinds = node.txs.map((t) => (t.to === t.from ? 'anchor' : 'mark'));
  assert.ok(kinds.lastIndexOf('anchor') < kinds.indexOf('mark'), kinds.join(','));
});

test('in force T-IF7 mark: after the anchor the display vault is marked to n6 = floor(value x 1e6) — navPerShare and indexLevel both n6 — in setNav steps within the contract\'s 25% bound (markSteps); a vault whose symbol() is not the rulebook\'s ticker gets no mark (exit 1); no address or no gate: no mark', async () => {
  for (const [label, vaults, expect] of [['no address', qvolVaults({ mode: 'step' }, null), /qvol: no vault — marks skipped/], ['no gate', qvolVaults(null), /qvol: mark gate not set — marks skipped/]]) {
    const x = inForceRoot({ vaults });
    const { key, address } = keyed();
    const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
    assert.equal(r.code, 0, `${label}: ${r.err}`);
    assert.match(r.out, expect, label);
    assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0, label);
  }
  const x = inForceRoot({ vaults: qvolVaults() });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(r.code, 0, r.err);
  const [L0] = readJsonl(x.rec);
  const n6 = BigInt(Math.floor(L0.value * 1e6));
  assert.equal(n6, markUnits(L0.value));
  assert.equal(node.state.nav, n6);
  const marks = readJsonl(x.marks);
  assert.deepEqual(marks.map((m) => BigInt(m.nav)), markSteps(1_000_000n, n6));
  assert.ok(marks.length >= 2, `from 1.000000 to ${n6} needs steps (${marks.length})`);
  let cur = 1_000_000n;
  for (const m of marks) {
    const next = BigInt(m.nav);
    const dlt = (cur * 2500n) / 10000n;
    assert.ok(next >= cur - dlt && next <= cur + dlt, `${cur} → ${next}`);
    assert.equal(m.indexLevel, Number(n6));
    assert.equal(m.of, marks.length);
    assert.deepEqual([m.date, m.seq], [D1, 0]);
    cur = next;
  }
  // every setNav carries (step, n6), after the anchor
  const setNavs = node.txs.filter((t) => t.to === QVAULT).map((t) => decodeFunctionData({ abi: VAULT_ABI, data: t.data }));
  assert.ok(setNavs.every((c) => c.functionName === 'setNav' && c.args[1] === n6));
  assert.deepEqual(setNavs.map((c) => c.args[0]), markSteps(1_000_000n, n6));
  const kinds = node.txs.map((t) => (t.to === t.from ? 'anchor' : 'mark'));
  assert.ok(kinds.lastIndexOf('anchor') < kinds.indexOf('mark'));
  // a run the next minute sends nothing more
  const n0 = node.txs.length;
  assert.equal((await inForce(x.root, `${D1}T00:26:00Z`, { key, node })).code, 0);
  assert.equal(node.txs.length, n0);
  // another vault's symbol: the line is written and anchored, no setNav is sent, exit 1
  const y = inForceRoot({ vaults: qvolVaults() });
  const other = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qETH1.5X' });
  const ry = await inForce(y.root, `${D1}T00:25:00Z`, { key, node: other });
  assert.equal(ry.code, 1);
  assert.match(ry.err, /qVOL vault marks FAILED after line #0 was written and anchored: vault .* is "qETH1\.5X", not qVOL — keeper\/leverage-vaults\.json names the wrong vault; no mark sent/);
  assert.equal(readJsonl(y.rec).length, 1);
  assert.equal(readJsonl(y.anc).length, 1);
  assert.equal(other.txs.filter((t) => t.to === QVAULT).length, 0);
  // a vault whose keeper is not the signer: no setNav either
  const z = inForceRoot({ vaults: qvolVaults() });
  const notMine = fakeNode({ vault: QVAULT, keeper: keyed().address, symbol: 'qVOL' });
  const rz = await inForce(z.root, `${D1}T00:25:00Z`, { key, node: notMine });
  assert.equal(rz.code, 1);
  assert.match(rz.err, /keeper is .*, not the signer .* — no mark sent/);
  assert.equal(notMine.txs.filter((t) => t.to === QVAULT).length, 0);
});

test('in force T-IF8 mark steps: n6 = floor(x x 1e6) cuts and never rounds; markSteps (keeper/leverage-step.mjs) keeps every step inside the contract bound, up from 1.000000 and back down', () => {
  assert.equal(markUnits(28.423831824760406), 28_423_831n);
  assert.equal(markUnits(12.3456789999), 12_345_678n);
  assert.equal(markUnits(43.80731634522769), 43_807_316n);
  assert.equal(markUnits(0.0000009), 0n);
  assert.equal(markUnits(0), 0n);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '28.4', null]) assert.throws(() => markUnits(bad), /not a finite number >= 0/);
  for (const [from, to] of [[1_000_000n, 28_423_831n], [1_000_000n, 150_000_000n], [150_000_000n, 9_000_000n], [28_423_831n, 28_423_831n], [5_000_000n, 4_000_000n]]) {
    const steps = markSteps(from, to);
    let cur = from;
    for (const s of steps) {
      const dlt = (cur * 2500n) / 10000n;
      assert.ok(s >= cur - dlt && s <= cur + dlt, `${cur} → ${s}`);
      cur = s;
    }
    assert.equal(steps.length ? steps.at(-1) : from, to);
  }
  assert.equal(markSteps(1_000_000n, 28_423_831n).length, 16); // 15 steps of +25% reach 28,421,691; the 16th reaches the target
});

test('in force T-IF9 the mark method does not change the record: gate {"mode":"step"} and {"mode":"halt","pct":15} write byte-identical lines; the halt only stops the mark (exit 1, no setNav)', async () => {
  const res = [];
  for (const gate of [{ mode: 'step' }, { mode: 'halt', pct: 15 }]) {
    const x = inForceRoot({ vaults: qvolVaults(gate) });
    const { key, address } = keyed();
    const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
    const r1 = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
    const r2 = await inForce(x.root, '2099-02-04T00:25:00Z', { key, node });
    res.push({ gate, codes: [r1.code, r2.code], file: fs.readFileSync(x.rec), setNavs: node.txs.filter((t) => t.to === QVAULT).length, err: r1.err });
  }
  assert.deepEqual(res[0].codes, [0, 0]);
  assert.ok(res[0].setNavs > 0);
  assert.deepEqual(res[1].codes, [1, 1]);
  assert.match(res[1].err, /MARK HALTED: the value moves the vault .* beyond the ±15% gate — nothing sent/);
  assert.equal(res[1].setNavs, 0);
  assert.ok(res[0].file.equals(res[1].file), 'the record lines differ between the two mark methods');
  assert.equal(readJsonlText(res[0].file).length, 3);
});

test('in force T-IF10 DISPLAY_ONLY: keeper/deploy-mark-vault.mjs refuses open-deposits for qvol before any RPC call (exit 2); qvol is the display vault "Quadrix BTC Realized Volatility Vault" whose symbol is the rulebook ticker; its registry entry has no address yet and the mark method step', async () => {
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  assert.deepEqual(NAMES.qvol, ['Quadrix BTC Realized Volatility Vault', rb.ticker]);
  assert.equal(rb.ticker, 'qVOL');
  assert.ok(DISPLAY_ONLY.has('qvol'));
  // the repository's registry entry: chain 91342, mark method step; before the deployment no address, deployTx or block,
  // after it all three (the address, the 32-byte deployment transaction, its block)
  const reg = JSON.parse(fs.readFileSync(path.join(KEEPER, 'leverage-vaults.json'), 'utf8'));
  assert.deepEqual(Object.keys(reg.qvol).sort(), ['address', 'block', 'chainId', 'deployTx', 'gate']);
  assert.equal(reg.qvol.chainId, 91342);
  assert.deepEqual(reg.qvol.gate, { mode: 'step' });
  if (reg.qvol.address === null) assert.deepEqual([reg.qvol.deployTx, reg.qvol.block], [null, null]);
  else {
    assert.ok(isAddress(reg.qvol.address), reg.qvol.address);
    assert.match(reg.qvol.deployTx, /^0x[0-9a-fA-F]{64}$/);
    assert.ok(Number.isSafeInteger(reg.qvol.block) && reg.qvol.block > 0, String(reg.qvol.block));
  }
  // an RPC that counts every request
  let requests = 0;
  const srv = http.createServer((req, res) => {
    requests++;
    res.end('{}');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const extra of [[], ['--live', '--confirm', 'EXECUTE', '--from', '0x0000000000000000000000000000000000000001']]) {
      const r = await runChild([path.join(KEEPER, 'deploy-mark-vault.mjs'), '--index', 'qvol', '--action', 'open-deposits', '--cap', '1', '--rpc', url, ...extra]);
      assert.equal(r.code, 2, r.out + r.err);
      assert.match(r.err, /REFUSED: qvol is a display vault: it takes no deposits by definition \(deposit cap 0\)/);
    }
  } finally {
    srv.close();
  }
  assert.equal(requests, 0, 'the refusal comes before any RPC call');
});

test('in force T-IF11: a dry run reads no key and sends nothing even with KEEPER_PK in its environment — its lines carry "shadow" and no inception, and no anchors file is written', async () => {
  const x = inForceRoot({ vaults: qvolVaults() });
  const out = tmpDir('vol-if-nokey');
  const r = await cli(run, ['--line', 'realized', '--dry-run', '--out', out, '--replay', `${D1}..2099-02-03`], {
    root: x.root, now: () => Date.parse('2099-02-03T00:25:00Z'), fetch: fakeBinance(BARS, Date.parse('2099-02-03T00:30:00Z')).fetch,
    env: { KEEPER_PK: generatePrivateKey() }, transport: () => { throw new Error('a dry run must not reach the chain'); },
  });
  assert.equal(r.code, 0, r.err);
  const lines = readJsonl(path.join(out, REA));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.shadow === true && !('inception' in l)));
  assert.deepEqual(fs.readdirSync(out).sort(), [REA]);
  assert.equal(fs.existsSync(x.rec), false);
});

test('in force T-IF12 cap invariant: a display vault whose depositCap() is not 0 is not marked — the line is written and anchored, no setNav is sent, exit 1; with cap 0 the next run marks it', async () => {
  const x = inForceRoot({ vaults: qvolVaults() });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, transport: quick(node, null, { cap: 1n, root: x.root, from: address }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /qVOL vault marks FAILED after line #0 was written and anchored: REFUSED: vault .* has deposit cap 1, not 0 — a display vault takes no deposits; no mark sent/);
  assert.equal(readJsonl(x.rec).length, 1);
  assert.equal(readJsonl(x.anc).length, 1);
  assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0, 'no setNav');
  assert.equal(fs.existsSync(x.marks), false);
  // cap back at 0: the next run (no new day) marks the anchored line
  const r2 = await inForce(x.root, `${D1}T00:40:00Z`, { key, node });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(node.state.nav, markUnits(readJsonl(x.rec)[0].value));
});

// scripts/verify.mjs (the public verifier) on the qVOL record: --series qvol
const VERIFY_ALL = path.join(REPO, 'scripts', 'verify.mjs');
const verifyAll = (dir, ...extra) => runChild([VERIFY_ALL, '--dir', dir, '--series', 'qvol', ...extra]);

test('in force T-IF13 scripts/verify.mjs --series qvol: not started, pending, then the published record VERIFIED — recomputed by scripts/verify-vol.mjs (run as a child, not repeated), bound to its decision effective the day before the first line, and with an RPC every anchor checked; a changed value, a dry-run line, another effective date or another rulebook fails', async () => {
  // before the inception decision (a scratch root: the rulebook with inception null, an empty ledger): no record and no decision
  let v = await verifyAll(path.join(notInForceRoot(), 'trackrecord'), '--recompute-only');
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, /\[QVOL\] not started — no record-qvol\.jsonl and no inception decision/);
  // anchored decision, no line yet: pending until the end of the first line's day
  const p = inForceRoot();
  v = await verifyAll(path.join(p.root, 'trackrecord'), '--recompute-only');
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, new RegExp(`\\[QVOL\\] pending — inception decision ${DECISION} is effective from ${E}; the first line is written by the first keeper run after ${D1}T00:00Z`));
  // the published record: three lines, anchored on the fake node
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  assert.equal((await inForce(x.root, '2099-02-04T00:25:00Z', { key, node })).code, 0);
  const lines = readJsonl(x.rec);
  assert.equal(lines.length, 3);
  const tr = path.join(x.root, 'trackrecord');
  v = await verifyAll(tr, '--recompute-only');
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, /\[QVOL\] recompute — 3 line\(s\) by verify-vol\.mjs/);
  assert.match(v.out, /ok {4}3 line\(s\) recomputed by verify-vol\.mjs — value and variance within a relative 1e-9 \(largest 0\), windows, sources and dates continue; every rule is the rulebook JSON's/);
  assert.match(v.out, new RegExp(`ok {4}${DECISION} document hashes to the ledger's value`));
  assert.match(v.out, /VERIFIED \(recompute only — no anchor checked\) — 3 records/);
  // with an RPC: each anchor's calldata, receipt and block time, and the decision's own anchor
  const txs = new Map();
  for (const a of readJsonl(x.anc)) {
    const rec = lines.find((l) => l.seq === a.seq);
    txs.set(a.txHash, { input: toHex(`qxpi-qvol:${a.headHash}`), block: 1000 + a.seq, time: Date.parse(rec.observedAt) / 1000 + 60 });
  }
  txs.set(x.entry.txHash, { input: toHex(`qxdec:${x.entry.sha256}`), block: 900, time: Date.parse(`${E}T09:00:00Z`) / 1000 });
  let early = null; // [block, unix seconds] answered instead of the block's own time
  const blocks = new Map([...txs.values()].map((t) => [t.block, t.time]));
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const t = txs.get(params?.[0]);
      let result = null;
      if (method === 'eth_getTransactionByHash' && t) result = { input: t.input, blockNumber: `0x${t.block.toString(16)}`, from: address, to: address };
      if (method === 'eth_getTransactionReceipt' && t) result = { status: '0x1', blockNumber: `0x${t.block.toString(16)}` };
      if (method === 'eth_getBlockByNumber') {
        const n = parseInt(params[0], 16);
        const tm = early && early[0] === n ? early[1] : blocks.get(n);
        result = { number: params[0], timestamp: `0x${Math.floor(tm).toString(16)}` };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const rpc = `http://127.0.0.1:${srv.address().port}`;
  try {
    v = await verifyAll(tr, '--rpc', rpc);
    assert.equal(v.code, 0, v.out + v.err);
    assert.match(v.out, /\[QVOL\] anchors — 3 on-chain commitment\(s\)/);
    assert.match(v.out, new RegExp(`seq 2 2099-02-04 anchored in 0x[0-9a-f]+… \\(block 1002, `));
    assert.match(v.out, new RegExp(`${DECISION} anchored ${E}T09:00:00\\.000Z`));
    // an anchor block before its line's day began: the line was anchored before its day
    early = [1001, Date.parse('2099-02-02T23:00:00Z') / 1000];
    v = await verifyAll(tr, '--rpc', rpc);
    assert.equal(v.code, 1);
    assert.match(v.out, /anchor seq 1 2099-02-03: block time 2099-02-02T23:00:00\.000Z is before 2099-02-03T00:00Z — the line was anchored before its own day began/);
  } finally {
    srv.close();
  }
  // tampering, each on a copy of the trackrecord folder (the rulebook JSON beside it, as in the repository)
  const copy = (edit) => {
    const root = tmpDir('vol-if-verify');
    fs.cpSync(x.root, root, { recursive: true });
    edit(root);
    return path.join(root, 'trackrecord');
  };
  const writeRec = (root, ls) => fs.writeFileSync(path.join(root, 'trackrecord', REA), ls.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const cases = [
    ['a changed value (re-hashed)', (root) => writeRec(root, [...lines.slice(0, 2), rehash({ ...lines[2], value: lines[2].value * (1 + 1e-6) })]), /QVOL #0 2099-02-02: verify-vol\.mjs: qvol seq 2: value .* vs recomputed/],
    ['a dry-run line', (root) => writeRec(root, [...lines.slice(0, 2), rehash({ ...lines[2], shadow: true, prevHash: lines[2].prevHash })]), /QVOL #2 2099-02-04: a dry-run line \("shadow": true\)/],
    ['the decision effective on the first line\'s day', (root) => {
      const led = readJsonl(path.join(root, 'trackrecord', 'decisions.jsonl'));
      fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), JSON.stringify({ ...led[0], effectiveFrom: D1 }) + '\n');
    }, new RegExp(`inception decision is effective from ${D1}, so the first line is dated 2099-02-03, not ${D1}`)],
    ['another rulebook JSON', (root) => {
      const f = path.join(root, 'keeper', 'rulebooks', 'qvol.json');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"windowDays": 30', '"windowDays": 31'));
    }, /rule\.rulebookSha256 [0-9a-f]{12}… is not the rulebook JSON's/],
  ];
  for (const [label, edit, why] of cases) {
    const r = await verifyAll(copy(edit), '--recompute-only');
    assert.equal(r.code, 1, `${label}: ${r.out}`);
    assert.match(r.out, why, label);
  }
});

// ------------------------------------------------- the fork rehearsal (--rpc, --from)
const FORK_RPC = 'http://127.0.0.1:8599';
/**
 * A local fork node for viem: the fake GIWA node, plus eth_sendTransaction from
 * the one account it holds unlocked — signed here with that account's test key
 * and passed on as a raw transaction, as anvil signs for an impersonated
 * account. `calls` lists every method the keeper asked this node for (before a
 * send becomes a signed transaction); depositCap() answers `cap`.
 */
function forkNode(node, unlocked, { cap = 0n, root = null } = {}) {
  const calls = [];
  const account = privateKeyToAccount(unlocked.key);
  const inner = node.transport({ retryCount: 0 });
  const transport = custom(
    {
      async request(req) {
        calls.push(req.method);
        if (req.method === 'eth_fillTransaction') throw Object.assign(new Error('the method eth_fillTransaction does not exist'), { code: -32601 });
        if (req.method === 'eth_call' && String(req.params?.[0]?.data ?? '').startsWith(DEPOSIT_CAP)) return `0x${cap.toString(16).padStart(64, '0')}`;
        const seen = txView(node, req, { root, from: unlocked.address, fork: true });
        if (seen !== undefined) return seen;
        if (req.method === 'eth_sendTransaction') {
          const [tx] = req.params;
          if (getAddress(tx.from) !== account.address) throw Object.assign(new Error('unknown account'), { code: -32000 });
          const nonce = Number(await inner.request({ method: 'eth_getTransactionCount', params: [tx.from, 'pending'] }));
          const raw = await account.signTransaction({ chainId: 91342, type: 'eip1559', to: tx.to, data: tx.data ?? '0x', value: 0n, gas: BigInt(tx.gas), nonce, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n });
          return inner.request({ method: 'eth_sendRawTransaction', params: [raw] });
        }
        return inner.request(req);
      },
    },
    { retryCount: 0 }
  );
  return { transport, calls };
}
/** An in-force root whose fork registry (keeper/dryrun/leverage-vaults.json) names `vault`, and whose own registry names `realVault`. */
function forkRoot({ vault = QVAULT, realVault = getAddress('0x00000000000000000000000000000000000dead1'), ledger = true } = {}) {
  const x = inForceRoot({ vaults: qvolVaults({ mode: 'step' }, realVault), ledger });
  const dry = path.join(x.root, 'keeper', 'dryrun');
  fs.mkdirSync(dry, { recursive: true });
  fs.writeFileSync(path.join(dry, 'leverage-vaults.json'), JSON.stringify(qvolVaults({ mode: 'step' }, vault), null, 2) + '\n');
  return { ...x, dry, frec: path.join(dry, REA), fanc: path.join(dry, ANC), fmarks: path.join(dry, 'marks-qvol.jsonl'), realReg: path.join(x.root, 'keeper', 'leverage-vaults.json') };
}
/** One fork-rehearsal run at `iso`: --anchor --rpc FORK_RPC --from <unlocked>, the transport factory recording the URL it is asked for. */
async function forkRun(x, iso, { unlocked, fork, env = {}, argv = null, urls = [] }) {
  return inForce(x.root, iso, { argv: argv ?? ['--anchor', '--rpc', FORK_RPC, '--from', unlocked.address], extra: { env, transport: (url) => (urls.push(url), fork.transport) } });
}

test('in force T-IF14 fork rehearsal flags: --rpc and --from only together, a local node only (the host as a URL parser reads it), an address, never with --dry-run, --line implied or --out, never under GitHub Actions — refused (exit 2) before any Binance or chain request, nothing written', async () => {
  assert.ok(isLocalRpc('http://127.0.0.1:8599') && isLocalRpc('http://localhost:8545/') && isLocalRpc('http://[::1]:8545'));
  for (const u of [GIWA_RPC, 'http://127.0.0.1:1@sepolia-rpc.giwa.io/', 'http://127.0.0.1.example.com:8599', 'ws://127.0.0.1:8545', 'http://user:pw@localhost:8545', '127.0.0.1:8545', '']) assert.equal(isLocalRpc(u), false, u);
  const x = forkRoot();
  const from = keyed().address;
  const cases = [
    [['--anchor', '--from', from], {}, /--rpc and --from go together/],
    [['--anchor', '--rpc', FORK_RPC], {}, /--rpc and --from go together/],
    [['--anchor', '--rpc', GIWA_RPC, '--from', from], {}, /--rpc https:\/\/sepolia-rpc\.giwa\.io is not a local node/],
    [['--anchor', '--rpc', 'http://127.0.0.1:1@sepolia-rpc.giwa.io/', '--from', from], {}, /is not a local node/],
    [['--anchor', '--rpc', 'http://127.0.0.1.example.com:8599', '--from', from], {}, /is not a local node/],
    [['--anchor', '--rpc', FORK_RPC, '--from', '0x1234'], {}, /--from 0x1234 is not an address/],
    [['--dry-run', '--replay', `${D1}..${D1}`, '--rpc', FORK_RPC, '--from', from], {}, /a dry run never reaches a chain/],
    [['--anchor', '--rpc', FORK_RPC, '--from', from, '--out', tmpDir('vol-if-fork-out')], {}, /--out is for --dry-run and --collect-only; the line in force is written to keeper\/dryrun\/record-qvol\.jsonl/],
    [['--anchor', '--rpc', FORK_RPC, '--from', from], { GITHUB_ACTIONS: 'true' }, /a fork rehearsal \(--rpc, --from\) runs on a local machine only, never in a workflow/],
  ];
  const before = listAll(x.root);
  for (const [argv, env, why] of cases) {
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { argv, extra: { env, transport: () => { throw new Error('a refused fork rehearsal must not reach a node'); } } });
    assert.equal(r.code, 2, `${argv.join(' ')}: exit ${r.code} ${r.err}`);
    assert.match(r.err, why, argv.join(' '));
    assert.equal(r.binanceCalls, 0, `${argv.join(' ')}: Binance was called`);
    assert.deepEqual(listAll(x.root), before, `${argv.join(' ')}: a file changed`);
  }
  // the implied line has no in-force path, so no rehearsal of one
  let calls = 0;
  const ri = await cli(run, ['--line', 'implied', '--rpc', FORK_RPC, '--from', from], { root: ON, env: {}, fetch: async () => (calls++, new Response('{}')) });
  assert.equal(ri.code, 2);
  assert.match(ri.err, /--rpc is for --line realized/);
  assert.equal(calls, 0);
  // the rulebook with inception null (a scratch copy): the rehearsal of a line not in force is NOT IN FORCE too, nothing read
  const rr = await cli(run, ['--line', 'realized', '--anchor', '--rpc', FORK_RPC, '--from', from], { root: notInForceRoot(), env: {}, fetch: async () => (calls++, new Response('[]')), transport: () => { throw new Error('no node expected'); } });
  assert.equal(rr.code, 0, rr.err);
  assert.match(rr.out, /qvol: NOT IN FORCE \(keeper\/rulebooks\/qvol\.json inception is null\)/);
  assert.equal(calls, 0);
});

test('in force T-IF15 a fork rehearsal never writes the record or registry of the line in force and never signs: its line, anchor and marks go under keeper/dryrun/ (nothing under trackrecord/, no keeper/marks-qvol.jsonl, keeper/leverage-vaults.json unread for the mark and unchanged); every request goes to the --rpc node, every transaction is eth_sendTransaction from --from, KEEPER_PK in the environment is not used; the line is byte for byte the line the keeper key writes', async () => {
  const x = forkRoot();
  const unlocked = keyed();
  const live = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: unlocked.address, symbol: 'qVOL' });
  const fork = forkNode(node, unlocked, { root: x.root });
  const urls = [];
  const trBefore = listAll(path.join(x.root, 'trackrecord'));
  const regBefore = fs.readFileSync(x.realReg);
  const r = await forkRun(x, `${D1}T00:25:00Z`, { unlocked, fork, env: { KEEPER_PK: live.key }, urls });
  assert.equal(r.code, 0, r.err);
  // where it wrote
  const lines = readJsonl(x.frec);
  assert.deepEqual(lines.map((l) => [l.seq, l.date]), [[0, D1]]);
  assert.deepEqual(readJsonl(x.fanc).map((a) => [a.seq, a.date, a.headHash, a.txHash]), [[0, D1, lines[0].hash, node.txs[0].hash]]);
  const marks = readJsonl(x.fmarks);
  assert.deepEqual(marks.map((m) => BigInt(m.nav)), markSteps(1_000_000n, markUnits(lines[0].value)));
  assert.deepEqual(listAll(path.join(x.root, 'trackrecord')), trBefore, 'a file under trackrecord/ changed');
  assert.equal(fs.existsSync(x.rec) || fs.existsSync(x.anc) || fs.existsSync(x.marks), false);
  assert.ok(fs.readFileSync(x.realReg).equals(regBefore));
  // where it sent: the --rpc node only, no transaction signed by the keeper itself, all from --from, the mark to the fork registry's vault
  assert.ok(urls.length > 0 && urls.every((u) => u === FORK_RPC), urls.join(','));
  assert.ok(fork.calls.includes('eth_sendTransaction') && !fork.calls.includes('eth_sendRawTransaction'), fork.calls.join(','));
  assert.ok(node.txs.length > 1 && node.txs.every((t) => t.from === unlocked.address), 'a transaction not from --from');
  assert.ok(!node.txs.some((t) => t.from === live.address || t.to === live.address));
  assert.deepEqual(node.anchorsOf(), [`qxpi-qvol:${lines[0].hash}`]);
  assert.ok(node.txs.filter((t) => t.to !== t.from).every((t) => t.to === QVAULT));
  assert.equal(node.state.nav, markUnits(lines[0].value));
  // the same day with the keeper key, from the same bars and clock: the same bytes
  const k = inForceRoot({ vaults: qvolVaults() });
  const kn = fakeNode({ vault: QVAULT, keeper: live.address, symbol: 'qVOL' });
  assert.equal((await inForce(k.root, `${D1}T00:25:00Z`, { key: live.key, node: kn })).code, 0);
  assert.ok(fs.readFileSync(k.rec).equals(fs.readFileSync(x.frec)), 'the rehearsal line differs from the line in force');
  assert.equal(kn.state.nav, node.state.nav);
  // the next run the same minute sends nothing
  const n0 = node.txs.length;
  assert.equal((await forkRun(x, `${D1}T00:26:00Z`, { unlocked, fork })).code, 0);
  assert.equal(node.txs.length, n0);
  // a node that does not hold --from unlocked (as GIWA Sepolia's public endpoint): no anchor, nothing signed here — the line stays written, exit 1
  const y = forkRoot();
  const stranger = fakeNode({ vault: QVAULT, keeper: unlocked.address, symbol: 'qVOL' });
  const ry = await inForce(y.root, `${D1}T00:25:00Z`, { argv: ['--anchor', '--rpc', FORK_RPC, '--from', unlocked.address], extra: { env: { KEEPER_PK: live.key }, transport: () => quick(stranger, null, { root: y.root, from: unlocked.address, fork: true }) } });
  assert.equal(ry.code, 1);
  assert.match(ry.err, new RegExp(`line #0 ${D1} is written but its anchor failed: .* — no mark; the next run anchors it first`));
  assert.equal(stranger.txs.length, 0);
  assert.ok(!stranger.methods.includes('eth_sendRawTransaction'));
  assert.equal(readJsonl(y.frec).length, 1);
  assert.equal(fs.existsSync(y.rec), false);
});

test('in force T-IF16 a fork rehearsal prints each step\'s result in order — the rehearsal line, the decision, each line, its recompute by scripts/verify-vol.mjs, its anchor, the mark and every mark step; each refusal prints what stopped and what stays: no decision → no line; a deposit cap above 0 or another vault\'s symbol → the line written and anchored, no mark, exit 1', async () => {
  const x = forkRoot();
  const unlocked = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: unlocked.address, symbol: 'qVOL' });
  const fork = forkNode(node, unlocked, { root: x.root });
  const r1 = await forkRun(x, `${D1}T00:25:00Z`, { unlocked, fork });
  assert.equal(r1.code, 0, r1.err);
  const [L0] = readJsonl(x.frec);
  const n6 = markUnits(L0.value);
  const steps = markSteps(1_000_000n, n6);
  const out = r1.out.split('\n');
  const at = (re) => {
    const i = out.findIndex((l) => re.test(l));
    assert.ok(i >= 0, `missing ${re} in\n${r1.out}`);
    return i;
  };
  const order = [
    at(new RegExp(`^qvol: FORK REHEARSAL — node ${FORK_RPC.replace(/\./g, '\\.')}, signer ${unlocked.address} \\(unlocked on that node; KEEPER_PK is not read\\); record, anchors, marks and the vault registry under keeper/dryrun/, nothing written under trackrecord/$`)),
    at(new RegExp(`^qVOL \\(qvol\\) in force: decision ${DECISION} · first line ${D1} · rulebook [0-9a-f]{12}… · 0 line\\(s\\) in keeper/dryrun/record-qvol\\.jsonl$`)),
    at(new RegExp(`^qvol #0 ${D1} ${String(L0.value).replace('.', '\\.')} · head ${L0.hash.slice(0, 16)}…$`)),
    at(new RegExp(`^  #0 ${D1} recomputed by scripts/verify-vol\\.mjs before it was appended — agrees$`)),
    at(new RegExp(`^  anchored #0 ${D1} in ${node.txs[0].hash} \\(block \\d+\\)$`)),
    at(new RegExp(`^  vault ${QVAULT}: navPerShare 1000000 → target ${n6} \\(n6 of the value ${String(L0.value).replace('.', '\\.')}\\) in ${steps.length} step\\(s\\)$`)),
  ];
  for (let k = 0; k < steps.length; k++) order.push(at(new RegExp(`^    step ${k + 1}/${steps.length}: navPerShare ${steps[k]} tx=0x[0-9a-f]{64} block \\d+`)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), r1.out);
  // the next day: one line, its recompute, its anchor, the mark from the last value
  const r2 = await forkRun(x, '2099-02-03T00:25:00Z', { unlocked, fork });
  assert.equal(r2.code, 0, r2.err);
  const L1 = readJsonl(x.frec)[1];
  assert.match(r2.out, new RegExp(`qVOL \\(qvol\\) in force: .* · 1 line\\(s\\) in keeper/dryrun/record-qvol\\.jsonl`));
  assert.match(r2.out, /  #1 2099-02-03 recomputed by scripts\/verify-vol\.mjs before it was appended — agrees/);
  assert.match(r2.out, /  anchored #1 2099-02-03 in 0x[0-9a-f]{64} \(block \d+\)/);
  assert.match(r2.out, new RegExp(`vault ${QVAULT}: navPerShare ${n6} → target ${markUnits(L1.value)} `));
  assert.equal(node.state.nav, markUnits(L1.value));
  // refusals, each its own run
  // (a) the decision is not anchored (not in the ledger): NOT IN FORCE, exit 0, no line, no request
  const a = forkRoot({ ledger: false });
  const na = fakeNode({ vault: QVAULT, keeper: unlocked.address, symbol: 'qVOL' });
  const ra = await forkRun(a, `${D1}T00:25:00Z`, { unlocked, fork: forkNode(na, unlocked, { root: a.root }) });
  assert.equal(ra.code, 0, ra.err);
  assert.match(ra.out, /qvol: FORK REHEARSAL — /);
  assert.match(ra.out, new RegExp(`qvol: NOT IN FORCE: decision not anchored or does not pin this rulebook \\(${DECISION} is not in trackrecord/decisions\\.jsonl\\)`));
  assert.equal(fs.existsSync(a.frec), false);
  assert.equal(ra.binanceCalls, 0);
  assert.equal(na.methods.length, 0);
  // (b) a deposit cap above 0: the line written, recomputed and anchored, no setNav, exit 1
  const b = forkRoot();
  const nb = fakeNode({ vault: QVAULT, keeper: unlocked.address, symbol: 'qVOL' });
  const rb = await forkRun(b, `${D1}T00:25:00Z`, { unlocked, fork: forkNode(nb, unlocked, { cap: 1_000_000_000_000n, root: b.root }) });
  assert.equal(rb.code, 1);
  assert.match(rb.out, /  #0 2099-02-02 recomputed by scripts\/verify-vol\.mjs before it was appended — agrees/);
  assert.match(rb.out, /  anchored #0 2099-02-02 in 0x/);
  assert.match(rb.err, /qVOL vault marks FAILED after line #0 was written and anchored: REFUSED: vault .* has deposit cap 1000000000000, not 0 — a display vault takes no deposits; no mark sent/);
  assert.deepEqual([readJsonl(b.frec).length, readJsonl(b.fanc).length, fs.existsSync(b.fmarks)], [1, 1, false]);
  assert.equal(nb.txs.filter((t) => t.to === QVAULT).length, 0);
  assert.equal(nb.state.nav, 1_000_000n);
  // (c) the fork registry names a vault whose symbol is not qVOL: the line written and anchored, no setNav, exit 1
  const c = forkRoot();
  const nc = fakeNode({ vault: QVAULT, keeper: unlocked.address, symbol: 'qBTC2X' });
  const rc = await forkRun(c, `${D1}T00:25:00Z`, { unlocked, fork: forkNode(nc, unlocked, { root: c.root }) });
  assert.equal(rc.code, 1);
  assert.match(rc.err, /vault .* is "qBTC2X", not qVOL — keeper\/dryrun\/leverage-vaults\.json names the wrong vault; no mark sent/);
  assert.deepEqual([readJsonl(c.frec).length, readJsonl(c.fanc).length, fs.existsSync(c.fmarks)], [1, 1, false]);
  assert.equal(nc.txs.filter((t) => t.to === QVAULT).length, 0);
});

// ============================== the keeper's guards (red-team run R47, 2026-11-04)
//
// T-IF17 … T-IF27: what the keeper checks before it anchors, appends or marks
// (F1 … F10 of the run, and the daily-candle gate), each case beside a control
// that passes. Same scratch roots, synthetic bars, fake Binance and fake GIWA
// node as above.

/** A copy of an in-force root (the same chain: the fake node is shared by the caller). */
function copyRoot(x) {
  const root = tmpDir('vol-if-copy');
  fs.cpSync(x.root, root, { recursive: true });
  return { ...x, root, rbFile: path.join(root, 'keeper', 'rulebooks', 'qvol.json'), rec: path.join(root, 'trackrecord', REA), anc: path.join(root, 'trackrecord', ANC), marks: path.join(root, 'keeper', 'marks-qvol.jsonl') };
}
const writeJsonl = (file, lines) => fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// F1: a line without an anchor is anchored only after (1) the whole-record recompute of this
// run (F4, T-IF20: a per-line recompute before the anchor could reject nothing that check
// passed, so the keeper has none) and (2) a fetch of the bars it records. The forged line
// below is fully self-consistent — built by the keeper itself from false bars — so only (2)
// can refuse it.
test('in force T-IF17 (F1): a line without an anchor is anchored only after the whole-record recompute and a fetch of the bars it records — a hand-appended line that scripts/verify-vol.mjs rejects (a date that does not follow, a second line for a day, a changed value, a broken hash) is refused (exit 2, nothing sent); a fully self-consistent line built from false bars is refused by the fetch (exit 1, nothing sent); an unanchored line before an anchored one, or an anchor entry that names another hash, is refused (exit 2); an honest unanchored line is anchored (control)', async () => {
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  assert.equal((await inForce(x.root, '2099-02-03T00:25:00Z', { key, node })).code, 0);
  const honest = readJsonl(x.rec);
  assert.equal(honest.length, 2);
  // the honest #2: what a run without the key writes on a copy (unanchored)
  const w = copyRoot(x);
  assert.equal((await inForce(w.root, '2099-02-04T00:25:00Z', { argv: [] })).code, 0);
  const L2 = readJsonl(w.rec)[2];
  assert.deepEqual([L2.seq, L2.date], [2, '2099-02-04']);
  const sent = node.txs.length;
  const bad = [
    ['a date that does not follow #1 (2099-02-01)', rehash({ ...L2, date: '2099-02-01' }), /date 2099-02-01 does not follow 2099-02-03/],
    ['a second line for 2099-02-03', rehash({ ...honest[1], seq: 2, prevHash: honest[1].hash }), /date 2099-02-03 does not follow 2099-02-03/],
    ['a value the window does not give (re-hashed)', rehash({ ...L2, value: L2.value * 1.5 }), /value .* vs recomputed/],
    ['a hash that is not the line\'s', { ...L2, value: L2.value * 1.5 }, /hash does not match the line/],
  ];
  for (const [label, line, why] of bad) {
    const y = copyRoot(x);
    fs.appendFileSync(y.rec, JSON.stringify(line) + '\n');
    const before = listAll(y.root);
    const r = await inForce(y.root, '2099-02-04T00:25:00Z', { key, node });
    assert.equal(r.code, 2, `${label}: exit ${r.code} ${r.err}`);
    assert.match(r.err, /the record does not verify: scripts\/verify-vol\.mjs rejects it/, label);
    assert.match(r.err, /nothing sent/, label);
    assert.match(r.err, why, label);
    assert.equal(node.txs.length, sent, `${label}: a transaction was sent`);
    assert.deepEqual(listAll(y.root), before, `${label}: a file changed`);
  }
  // a fully self-consistent line from false bars: the keeper itself builds it on a copy from bars whose
  // 2099-02-03 close is 1% higher (hash chain, window and arithmetic all correct, verify-vol passes)
  const falseBars = alterBar(BARS, '2099-02-03', 1439, (m) => { const c = Math.round(m.c * 1.01 * 100) / 100; return { ...m, c, h: Math.max(m.h, c) }; });
  const f = copyRoot(x);
  assert.equal((await inForce(f.root, '2099-02-04T00:25:00Z', { argv: [], bars: falseBars })).code, 0);
  const forged = readJsonl(f.rec)[2];
  assert.notEqual(forged.value, L2.value);
  const z = copyRoot(x);
  fs.appendFileSync(z.rec, JSON.stringify(forged) + '\n');
  assert.equal(verify(path.join(z.root, 'trackrecord'), '--line', 'realized', '--rulebook', z.rbFile).status, 0, 'verify-vol accepts the forged line');
  const beforeZ = listAll(z.root);
  const rz = await inForce(z.root, '2099-02-04T00:25:00Z', { key, node });
  assert.equal(rz.code, 1, rz.err);
  assert.match(rz.err, /SOURCE CHANGED — line #2 2099-02-04 was built from the bars of 2099-02-03 .* — #2 has no anchor and is not anchored: nothing sent/);
  assert.match(rz.out, /trackrecord\/record-qvol\.jsonl: 3 line\(s\) recomputed as a whole by scripts\/verify-vol\.mjs — agrees/);
  assert.equal(node.txs.length, sent, 'a transaction was sent');
  assert.deepEqual(listAll(z.root), beforeZ, 'a file changed');
  // an unanchored line before an anchored one: refused, nothing sent
  const g = copyRoot(x);
  writeJsonl(g.anc, readJsonl(g.anc).filter((a) => a.seq !== 0));
  const rg = await inForce(g.root, '2099-02-04T00:25:00Z', { key, node });
  assert.equal(rg.code, 2, rg.err);
  assert.match(rg.err, /line #0 2099-02-02 has no anchor in trackrecord\/anchors-qvol\.jsonl, but line #1 after it has one — only the last lines of the record can be unanchored/);
  assert.equal(node.txs.length, sent);
  // an anchor entry that names another hash (#1 changed after its anchor, in a field the recompute does not read: keeper.run)
  const h = copyRoot(x);
  writeJsonl(h.rec, [honest[0], rehash({ ...honest[1], keeper: { ...honest[1].keeper, run: 'https://github.com/example/example/actions/runs/1' } })]);
  const rh = await inForce(h.root, '2099-02-04T00:25:00Z', { key, node });
  assert.equal(rh.code, 2, rh.err);
  assert.match(rh.err, /the anchor of #1 in trackrecord\/anchors-qvol\.jsonl names 2099-02-03 with head [0-9a-f]{64}, but line #1 is 2099-02-03 with hash [0-9a-f]{64} — the line changed after it was anchored; nothing sent/);
  assert.equal(node.txs.length, sent);
  // control: the honest #2, written without the key, is anchored by the next run with the key
  assert.equal((await inForce(x.root, '2099-02-04T00:25:00Z', { argv: [] })).code, 0);
  const rc = await inForce(x.root, '2099-02-04T00:30:00Z', { key, node });
  assert.equal(rc.code, 0, rc.err);
  assert.match(rc.out, /#2 2099-02-04 has no anchor — anchoring it first/);
  assert.match(rc.out, /#2 2099-02-04: the bars it records read again from Binance \(2099-02-03\) — the same/);
  assert.deepEqual(readJsonl(x.anc).map((a) => a.seq), [0, 1, 2]);
  assert.equal(node.txs.length, sent + 1);
  assert.deepEqual(node.anchorsOf().at(-1), `qxpi-qvol:${readJsonl(x.rec)[2].hash}`);
});

/** The bars with minute k of `day` changed by f (a new object; BARS is not touched). */
const alterBar = (days, day, k, f) => ({ ...days, [day]: days[day].map((m, i) => (i === k ? f(m) : m)) });
/** +0.01 on the close of a minute (its high follows), so the day's canonical text changes and the bar stays consistent. */
const nudge = (m) => ({ ...m, c: Math.round((m.c + 0.01) * 100) / 100, h: Math.max(m.h, Math.round((m.c + 0.01) * 100) / 100) });
const RB_REPO = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
const CHECKS = (x) => path.join(x.root, 'keeper', 'vol-index-source-checks.json');
const entryIn = (text, check) => JSON.parse(new RegExp(`(\\{"series":"qvol","day":"[^"]+","check":"${check}"[^}]*\\})`).exec(text)[1]);

test('in force T-IF18 (F2): before the series continues from its last line, the bars of that line\'s day are read again from Binance (one more fetch) — other bars than the line records stop the run (exit 1; nothing written, anchored or marked; the message names the day and both sha256) and the same bars let it continue (control); an anchored line whose day the source changed later goes on once a person confirms that change; a line without an anchor is never anchored on bars the source does not serve (a self-consistent line appended by hand: PoC 4 a2); a dry run that continues a record reads that day again too', async () => {
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  const [L0] = readJsonl(x.rec);
  assert.equal(L0.source.day, E);
  const firstPage = (calls, day) => calls.filter((c) => c.includes('interval=1m') && c.includes(`startTime=${Date.parse(`${day}T00:00:00Z`)}&`)).length;
  // control: the same bars — the line's day is fetched once more, then line #1 is written and anchored
  const c = copyRoot(x);
  const sent0 = node.txs.length;
  const ok = await inForce(c.root, '2099-02-03T00:25:00Z', { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`#0 ${D1}: the bars of ${E} read again from Binance — the same as the line records`));
  assert.equal(firstPage(ok.calls, E), 1, 'the recorded day is fetched once more');
  assert.equal(readJsonl(c.rec).length, 2);
  assert.equal(node.txs.length, sent0 + 1);
  // the source now serves other bars for 2099-02-01 (one close +0.01 at 10:00; the day close is the same)
  const changed = alterBar(BARS, E, 600, nudge);
  const y = copyRoot(x);
  const before = listAll(y.root);
  const r = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, bars: changed });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`qvol: SOURCE CHANGED — line #0 ${D1} was built from the bars of ${E} \\(1440 rows, close ${String(L0.window[30][1]).replace('.', '\\.')} \\(bar 23:59\\), canonical text sha256 ${L0.source.sha256}\\), but the source now serves 1440 rows, close ${String(L0.window[30][1]).replace('.', '\\.')} \\(bar 23:59\\), canonical text sha256 (?!${L0.source.sha256})[0-9a-f]{64} — nothing written, nothing anchored, no mark\\. The line is anchored: a person checks the day at the source`));
  const entry = entryIn(r.err, 'refetch');
  assert.deepEqual([entry.day, entry.recorded], [E, L0.source.sha256]);
  assert.deepEqual(listAll(y.root), before, 'a file changed');
  assert.equal(node.txs.length, sent0 + 1, 'a transaction was sent');
  // an entry that names other bars does not let it go on; a malformed file is refused (exit 2)
  fs.writeFileSync(CHECKS(y), JSON.stringify([{ id: 'qvol-revised-2099-02-01', ...entry, served: 'f'.repeat(64), note: 'TEST ONLY', confirmedAt: '2099-02-03' }]));
  assert.equal((await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, bars: changed })).code, 1);
  fs.writeFileSync(CHECKS(y), JSON.stringify([{ id: 'x', series: 'qvol', day: E, check: 'refetch', recorded: entry.recorded }]));
  const bad = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, bars: changed });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /source check file .* needs id, series "qvol", day, and check "refetch" with recorded and served/);
  // the printed entry, confirmed: the next run goes on; the line stays as written
  fs.writeFileSync(CHECKS(y), JSON.stringify([{ id: 'qvol-revised-2099-02-01', ...entry, note: 'TEST ONLY — a stand-in confirmation', confirmedAt: '2099-02-03' }], null, 2) + '\n');
  const go = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, bars: changed });
  assert.equal(go.code, 0, go.err);
  assert.match(go.out, new RegExp(`#0 ${D1}: the bars of ${E} changed after the line was written \\(sha256 ${L0.source.sha256} → ${entry.served}\\) — confirmed by qvol-revised-2099-02-01 in keeper/vol-index-source-checks\\.json; the line stays as written`));
  const ly = readJsonl(y.rec);
  assert.equal(ly.length, 2);
  assert.deepEqual(ly[0], L0);
  // a line without an anchor (written without the key) whose day the source no longer serves: never anchored, the entry notwithstanding
  const u = inForceRoot();
  assert.equal((await inForce(u.root, `${D1}T00:25:00Z`, { argv: [] })).code, 0);
  fs.writeFileSync(CHECKS(u), fs.readFileSync(CHECKS(y)));
  const n1 = node.txs.length;
  const ru = await inForce(u.root, `${D1}T00:40:00Z`, { key, node, bars: changed });
  assert.equal(ru.code, 1, ru.err);
  assert.match(ru.err, new RegExp(`SOURCE CHANGED — line #0 ${D1} was built from the bars of ${E} .* — #0 has no anchor and is not anchored: nothing sent, nothing appended, no mark\\. If the source never served those bars, the line did not come from it`));
  assert.equal(node.txs.length, n1);
  assert.equal(fs.existsSync(path.join(u.root, 'trackrecord', ANC)), false);
  // PoC 4 a2: a self-consistent line appended by hand — a made-up 2099-02-02 close, the value computed from it,
  // a made-up source sha256 (or the real one) — passes scripts/verify-vol.mjs, but its day is not what Binance serves
  const w = copyRoot(x);
  assert.equal((await inForce(w.root, '2099-02-03T00:25:00Z', { argv: [] })).code, 0);
  const L1 = readJsonl(w.rec)[1];
  const win = L1.window.map((e, k) => (k === 30 ? [e[0], e[1] * 1.5] : e));
  const made = realizedFromWindow(win, null, { windowDays: RB_REPO.windowDays, yearDays: RB_REPO.yearDays });
  for (const [label, src] of [['a made-up sha256', { ...L1.source, sha256: 'ab'.repeat(32) }], ['the real sha256', L1.source]]) {
    const f = copyRoot(x);
    const forged = rehash({ ...L1, value: made.value, variance: made.variance, window: win, source: src });
    fs.appendFileSync(f.rec, JSON.stringify(forged) + '\n');
    const v = verify(path.join(f.root, 'trackrecord'), '--line', 'realized', '--rulebook', f.rbFile);
    assert.equal(v.status, 0, `${label}: verify-vol accepts the forged line (${v.stdout})`);
    const n = node.txs.length;
    const rf = await inForce(f.root, '2099-02-04T00:25:00Z', { key, node });
    assert.equal(rf.code, 1, `${label}: ${rf.err}`);
    assert.match(rf.err, /SOURCE CHANGED — line #1 2099-02-03 was built from the bars of 2099-02-02 .* — #1 has no anchor and is not anchored: nothing sent/, label);
    assert.equal(node.txs.length, n, `${label}: a transaction was sent`);
    assert.equal(readJsonl(f.rec).length, 2, label);
  }
  // a dry run that continues a record: the last line's day is read again (offline: its file; REST: one more fetch)
  const dir = tmpDir('vol-if18-dry');
  writeOffline(path.join(dir, 'bars'), BARS);
  const dry = (out, extra = [], deps = {}) => cli(run, ['--line', 'realized', '--dry-run', '--out', out, ...extra], { root: x.root, now: () => Date.parse('2099-02-10T00:25:00Z'), ...deps });
  const out = path.join(dir, 'out');
  assert.equal((await dry(out, ['--offline', path.join(dir, 'bars'), '--replay', `${D1}..2099-02-03`])).code, 0);
  const last = readJsonl(path.join(out, REA)).at(-1);
  writeOffline(path.join(dir, 'bars'), alterBar(BARS, last.source.day, 600, nudge));
  const rd = await dry(out, ['--offline', path.join(dir, 'bars'), '--replay', `${D1}..2099-02-05`]);
  assert.equal(rd.code, 1);
  assert.match(rd.err, new RegExp(`SOURCE CHANGED — line #1 2099-02-03 was built from the bars of ${last.source.day} .* — nothing written: the dry run does not continue from a line whose day the source no longer confirms`));
  assert.equal(readJsonl(path.join(out, REA)).length, 2);
  const rest = await dry(out, [], { fetch: fakeBinance(alterBar(BARS, last.source.day, 600, nudge), Date.parse('2099-02-06T00:30:00Z')).fetch });
  assert.equal(rest.code, 1);
  assert.match(rest.err, /SOURCE CHANGED/);
  writeOffline(path.join(dir, 'bars'), BARS);
  const rgo = await dry(out, ['--offline', path.join(dir, 'bars'), '--replay', `${D1}..2099-02-05`]);
  assert.equal(rgo.code, 0, rgo.err);
  assert.equal(readJsonl(path.join(out, REA)).length, 4);
});

test('in force T-IF19 (F12): before line D is written, Binance\'s daily candle of D-1 (on the first line: of every window day, in one request) must close where the 1-minute bars close the day — another close or no candle stops the run (exit 1; nothing written, anchored or marked; the message names both closes) and the same close lets it write (control); a person who finds the 1-minute bars right confirms the difference and the next run writes the line from them; a dry run checks it only with --daily <file>', async () => {
  const dms = (d) => Date.parse(`${d}T00:00:00Z`);
  const c0 = BARS[E].at(-1).c; // the close of 2099-02-01, the first line's newest window day
  const req1 = `/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${dms('2099-01-02')}&endTime=${dms(D1) - 1}&limit=31`;
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const cases = [
    ['the candle of 2099-02-01 closes 1 higher', (d, c) => (d === E ? c + 1 : undefined), new RegExp(`qvol: DAILY CLOSE DIFFERS — the 1-minute bars close ${E} at ${c0}, Binance's daily candle closes it at ${c0 + 1}; nothing written for line ${D1}, nothing anchored, no mark\\. A person compares the two at the source`)],
    ['an older window day (2099-01-15) differs', (d, c) => (d === '2099-01-15' ? c - 1 : undefined), /DAILY CLOSE DIFFERS — the 1-minute bars close 2099-01-15 at .*, Binance's daily candle closes it at /],
    ['no daily candle of 2099-02-01', (d) => (d === E ? null : undefined), new RegExp(`DAILY CLOSE DIFFERS — the 1-minute bars close ${E} at ${c0}, Binance's daily candle has no closed daily candle of that day`)],
  ];
  for (const [label, daily, why] of cases) {
    const x = inForceRoot();
    const before = listAll(x.root);
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node, daily });
    assert.equal(r.code, 1, `${label}: ${r.err}`);
    assert.match(r.err, why, label);
    assert.deepEqual(r.calls.filter((c) => c.includes('interval=1d')), [req1], label);
    assert.deepEqual(listAll(x.root), before, `${label}: a file changed`);
    assert.equal(node.txs.length, 0, `${label}: a transaction was sent`);
  }
  // control: the same closes — the first line is written and anchored
  const x = inForceRoot();
  const ok = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`#0 ${D1}: Binance's daily candles of the 31 window days close where the 1-minute bars close them`));
  assert.equal(readJsonl(x.rec).length, 1);
  // a later line: one candle, the day D-1 only
  const c1 = BARS[D1].at(-1).c;
  const y = copyRoot(x);
  const sent = node.txs.length;
  const r = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, daily: (d, c) => (d === D1 ? c + 0.01 : undefined) });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`DAILY CLOSE DIFFERS — the 1-minute bars close ${D1} at ${c1}, Binance's daily candle closes it at ${String(c1 + 0.01)}; nothing written for line 2099-02-03`));
  assert.deepEqual(r.calls.filter((c) => c.includes('interval=1d')), [`/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${dms(D1)}&endTime=${dms('2099-02-03') - 1}&limit=1`]);
  assert.equal(readJsonl(y.rec).length, 1);
  assert.equal(node.txs.length, sent);
  // the printed entry, confirmed: the next run writes the line from the 1-minute bars
  const entry = entryIn(r.err, 'daily-close');
  assert.deepEqual(entry, { series: 'qvol', day: D1, check: 'daily-close', minuteClose: String(c1), dailyClose: String(c1 + 0.01) });
  fs.writeFileSync(CHECKS(y), JSON.stringify([{ id: 'qvol-daily-2099-02-02', ...entry, note: 'TEST ONLY — a stand-in confirmation', confirmedAt: '2099-02-03' }], null, 2) + '\n');
  const go = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, daily: (d, c) => (d === D1 ? c + 0.01 : undefined) });
  assert.equal(go.code, 0, go.err);
  assert.match(go.out, new RegExp(`${D1}: Binance's daily candle closes at ${String(c1 + 0.01)}, the 1-minute bars at ${c1} — confirmed by qvol-daily-2099-02-02 in keeper/vol-index-source-checks\\.json; the line is written from the 1-minute bars, as the definition says`));
  const [, L1] = readJsonl(y.rec);
  assert.equal(L1.window[30][1], c1);
  // a dry run: no daily candle is read without --daily; with it, the file's closes are the check
  const dir = tmpDir('vol-if19-dry');
  const good = path.join(dir, 'daily.json');
  fs.writeFileSync(good, JSON.stringify(dailyKlines(BARS)));
  const gz = path.join(dir, 'daily.json.gz');
  fs.writeFileSync(gz, zlib.gzipSync(JSON.stringify(dailyKlines(BARS))));
  const wrong = path.join(dir, 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify(dailyKlines(BARS, { daily: (d, c) => (d === '2099-02-02' ? c + 1 : undefined) })));
  const dry = async (extra) => {
    const fb = withDaily(fakeBinance(BARS, Date.parse('2099-02-04T00:30:00Z')), BARS, Date.parse('2099-02-04T00:30:00Z'));
    const out = tmpDir('vol-if19-out');
    const res = await cli(run, ['--line', 'realized', '--dry-run', '--replay', `${D1}..2099-02-04`, '--out', out, ...extra], { root: x.root, now: () => Date.parse('2099-02-04T00:25:00Z'), fetch: fb.fetch });
    return { ...res, lines: readJsonl(path.join(out, REA)), daily: fb.calls.filter((c) => c.includes('interval=1d')).length, calls: fb.calls.length };
  };
  const plain = await dry([]);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.daily, 0, 'a dry run without --daily reads no daily candle');
  for (const f of [good, gz]) {
    const d = await dry(['--daily', f]);
    assert.equal(d.code, 0, d.err);
    assert.deepEqual(d.lines, plain.lines, `${f}: the lines differ from a dry run without --daily`);
    assert.equal(d.daily, 0);
    assert.equal(d.calls, plain.calls);
  }
  const dw = await dry(['--daily', wrong]);
  assert.equal(dw.code, 1);
  assert.match(dw.err, new RegExp(`DAILY CLOSE DIFFERS — the 1-minute bars close 2099-02-02 at ${c1}, the daily candle in .*wrong\\.json closes it at ${c1 + 1}; nothing written for line 2099-02-03`));
  assert.equal(dw.lines.length, 1);
  // a malformed file, or --daily without --dry-run: refused (exit 2) before any request
  const junk = path.join(dir, 'junk.json');
  fs.writeFileSync(junk, JSON.stringify([[Date.parse('2099-02-01T00:05:00Z'), '1', '1', '1', '1', '1', 0]]));
  for (const argv of [['--line', 'realized', '--dry-run', '--replay', `${D1}..${D1}`, '--out', tmpDir('vol-if19-j'), '--daily', junk], ['--line', 'realized', '--daily', good]]) {
    let calls = 0;
    const rj = await cli(run, argv, { root: x.root, now: () => Date.parse('2099-02-04T00:25:00Z'), fetch: async () => (calls++, new Response('[]')) });
    assert.equal(rj.code, 2, `${argv.join(' ')}: ${rj.err}`);
    assert.equal(calls, 0);
  }
});

test('in force T-IF20 (F4): once per run, before anything is sent or appended, scripts/verify-vol.mjs recomputes the whole record (hash chain, dates, windows, values) — an old line edited in place, an edited line re-hashed, a whole chain re-hashed after an edit, a line dated after the runner\'s clock, a dry-run line, another decision on the first line: each refused (exit 2), nothing appended, anchored or marked; the honest record goes on (control)', async () => {
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  assert.equal((await inForce(x.root, '2099-02-04T00:25:00Z', { key, node })).code, 0);
  const lines = readJsonl(x.rec);
  assert.equal(lines.length, 3);
  // the honest #3 (2099-02-05), as a run without the key writes it on a copy
  const w = copyRoot(x);
  assert.equal((await inForce(w.root, '2099-02-05T00:25:00Z', { argv: [] })).code, 0);
  const L3 = readJsonl(w.rec)[3];
  /** Lines from k on re-hashed, each chained to the one before. */
  const rechain = (ls, k) => {
    const out = ls.slice(0, k);
    for (let i = k; i < ls.length; i++) out.push(rehash({ ...ls[i], prevHash: i ? out[i - 1].hash : null }));
    return out;
  };
  const up = (l) => ({ ...l, value: l.value * 1.01 });
  const cases = [
    ['#0 edited in place', [up(lines[0]), ...lines.slice(1)], '2099-02-05', /hash does not match the line/],
    ['#1 edited and re-hashed', [lines[0], rehash(up(lines[1])), lines[2]], '2099-02-05', /prevHash does not match the previous line/],
    ['#0 edited and the whole chain re-hashed', rechain([up(lines[0]), ...lines.slice(1)], 0), '2099-02-05', /value .* vs recomputed/],
    ['a line dated after the runner\'s clock (the honest 2099-02-05 line at 2099-02-04 00:25)', [...lines, L3], '2099-02-04', /line #3 is dated 2099-02-05, after the runner's clock \(2099-02-04T00:25:00\.000Z\): a day is never written before it has ended/],
    ['a dry-run line', rechain([...lines.slice(0, 2), { ...lines[2], shadow: true }], 2), '2099-02-05', /line #2 2099-02-04 is a dry-run line \("shadow"\)/],
    ['another decision on the first line', rechain([{ ...lines[0], inception: { ...lines[0].inception, decisionSha256: '0'.repeat(64) } }, ...lines.slice(1)], 0), '2099-02-05', /the first line names the decision/],
  ];
  const sent = node.txs.length;
  for (const [label, ls, day, why] of cases) {
    const y = copyRoot(x);
    writeJsonl(y.rec, ls);
    const before = listAll(y.root);
    const r = await inForce(y.root, `${day}T00:25:00Z`, { key, node });
    assert.equal(r.code, 2, `${label}: exit ${r.code} ${r.err}`);
    assert.match(r.err, /qvol: the record does not verify: .* — nothing sent, nothing appended, no mark/, label);
    assert.match(r.err, why, label);
    assert.deepEqual(listAll(y.root), before, `${label}: a file changed`);
    assert.equal(node.txs.length, sent, `${label}: a transaction was sent`);
    assert.equal(r.binanceCalls, 0, `${label}: Binance was called`);
  }
  // control: the honest record — recomputed as a whole, then the next line is written and anchored
  const ok = await inForce(x.root, '2099-02-05T00:25:00Z', { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /trackrecord\/record-qvol\.jsonl: 3 line\(s\) recomputed as a whole by scripts\/verify-vol\.mjs — agrees/);
  assert.equal(readJsonl(x.rec).length, 4);
  assert.equal(node.txs.length, sent + 1);
});

test('in force T-IF21 (F6): only an inception decision of this series starts it — a rulebook naming another series\' decision that quotes this rulebook\'s sha256 (…-qeth15-paper-inception), or an id not of the form <YYYY-MM-DD>-qvol-inception, is NOT IN FORCE (exit 0, nothing read or written, no request); a ledger entry effective on another day than its id\'s date is refused (exit 2); the series\' own decision starts it (control)', async () => {
  for (const id of ['2099-02-01-qeth15-paper-inception', 'qvol-inception', '2099-02-01-qvol-inception-2', '2099-02-30-qvol-inception']) {
    const x = inForceRoot({ id });
    const doc = fs.readFileSync(path.join(x.root, 'trackrecord', 'decisions', `${id}.md`), 'utf8');
    assert.ok(doc.includes(H(fs.readFileSync(x.rbFile))), `${id}: the stand-in quotes the rulebook's sha256`);
    const { key, address } = keyed();
    const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
    const before = listAll(x.root);
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
    assert.equal(r.code, 0, `${id}: ${r.err}`);
    assert.match(r.out, new RegExp(`qvol: NOT IN FORCE: inception\\.decision "${id}" is not an inception decision of this series \\(an id <YYYY-MM-DD>-qvol-inception\\)`), id);
    assert.deepEqual(listAll(x.root), before, `${id}: a file changed`);
    assert.equal(r.binanceCalls, 0, id);
    assert.equal(node.methods.length, 0, id);
  }
  // the id's date and the ledger's effective date differ: an anchored decision the files do not satisfy
  const y = inForceRoot({ effective: '2099-01-31', first: E, id: `${E}-qvol-inception` });
  const ry = await inForce(y.root, `${E}T00:25:00Z`);
  assert.equal(ry.code, 2, ry.err);
  assert.match(ry.err, new RegExp(`decision ${E}-qvol-inception is effective from 2099-01-31 in the ledger, not on the date in its id — the series cannot start`));
  // control: the series' own decision
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const ok = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readJsonl(x.rec).length, 1);
});

test('in force T-IF22 (F7): a run that can anchor first reads the inception decision\'s own anchor transaction (the ledger\'s txHash) — not on chain, sent by another key, not a self-send, carrying other calldata, reverted, or unreadable: NOT IN FORCE / a chain failure (exit 1), nothing read from Binance, nothing written or sent; the signer\'s self-send of qxdec:<the decision\'s sha256> lets the series go on (control); a run without the key reads no chain', async () => {
  const x0 = inForceRoot();
  const tx = x0.entry.txHash.toLowerCase();
  const byHash = (f) => (req) => (req.method === 'eth_getTransactionByHash' && String(req.params[0]).toLowerCase() === tx ? f() : undefined);
  const rcOf = (status) => (req) => (req.method === 'eth_getTransactionReceipt' && String(req.params[0]).toLowerCase() === tx ? { transactionHash: tx, blockNumber: '0x32', blockHash: `0x${'32'.padStart(64, '0')}`, transactionIndex: '0x0', status, gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: null, from: getAddress(`0x${'1'.repeat(40)}`), to: getAddress(`0x${'1'.repeat(40)}`) } : undefined);
  const { key, address } = keyed();
  const other = keyed().address;
  const cases = [
    ['not on chain', (x) => ({ root: x.root, from: address, forget: new Set([tx]) }), /its anchor transaction 0x[d]{64} is not on chain/],
    ['sent by another key', (x) => ({ root: x.root, from: other }), new RegExp(`its anchor transaction 0x[d]{64} was sent by ${other}, not by the signer ${address}`)],
    ['not a self-send', (x) => ({ root: x.root, from: address, answer: byHash(() => rpcTx({ hash: tx, from: address, to: other, input: toHex(`qxdec:${x.entry.sha256}`), block: 50 })) }), new RegExp(`is not a self-send \\(to ${other}\\)`)],
    ['other calldata', (x) => ({ root: x.root, from: address, answer: byHash(() => rpcTx({ hash: tx, from: address, to: address, input: toHex(`qxdec:${'0'.repeat(64)}`), block: 50 })) }), new RegExp(`does not carry qxdec:${x0.entry.sha256}`)],
    ['reverted', (x) => ({ root: x.root, from: address, answer: (req) => rcOf('0x0')(req) }), /did not succeed \(receipt status reverted\)/],
  ];
  for (const [label, chain, why] of cases) {
    const x = inForceRoot();
    const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
    const before = listAll(x.root);
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, transport: quick(node, null, chain(x)) });
    assert.equal(r.code, 1, `${label}: ${r.err}`);
    assert.match(r.err, new RegExp(`qvol: NOT IN FORCE: the inception decision ${DECISION} is in trackrecord/decisions\\.jsonl, but its anchor transaction`), label);
    assert.match(r.err, why, label);
    assert.match(r.err, /nothing read from Binance, nothing written, nothing sent/, label);
    assert.deepEqual(listAll(x.root), before, `${label}: a file changed`);
    assert.equal(r.binanceCalls, 0, `${label}: Binance was called`);
    assert.equal(node.txs.length, 0, `${label}: a transaction was sent`);
  }
  // the node fails to answer: a chain failure, nothing read or written
  const z = inForceRoot();
  const nz = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const rz = await inForce(z.root, `${D1}T00:25:00Z`, { key, transport: quick(nz, (req) => { if (req.method === 'eth_getTransactionByHash') throw new Error('injected: the node is down'); }, { root: z.root, from: address }) });
  assert.equal(rz.code, 1);
  assert.match(rz.err, new RegExp(`the chain failed while reading the inception decision's anchor 0x[d]{64}: .*injected: the node is down.* — nothing read from Binance, nothing written, nothing sent; the next run reads it again`));
  assert.equal(rz.binanceCalls, 0);
  // control: the signer's own self-send of qxdec:<sha256>
  const x = inForceRoot();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const ok = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`decision ${DECISION}: anchored in 0x[d]{64} \\(block 50\\) — the signer's self-send of qxdec:<its sha256>`));
  assert.equal(readJsonl(x.rec).length, 1);
  assert.equal(node.txs.length, 1, 'the line\'s anchor');
  // without the key: the chain is not read (lines are written unanchored; the next run with the key reads the decision's anchor first)
  const k = inForceRoot();
  const rk = await inForce(k.root, `${D1}T00:25:00Z`, { argv: ['--anchor'] });
  assert.equal(rk.code, 0, rk.err);
  assert.equal(readJsonl(k.rec).length, 1);
  assert.doesNotMatch(rk.out, /decision .* anchored in/);
});

test('in force T-IF23 (F8): each run that can anchor reads the last anchor again — a transaction no longer on chain (dropped, as by a reorg) has its line anchored again first (one new transaction, the same calldata), then the run goes on; an entry whose transaction is not the keeper\'s anchor of that line (another key, other calldata) is refused (exit 2), nothing sent; an anchor still on chain lets the run go on with no new anchor of old lines (control)', async () => {
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  const [L0] = readJsonl(x.rec);
  const [A0] = readJsonl(x.anc);
  // control: the anchor is on chain — read again, nothing re-sent, the next line written and anchored
  const c = copyRoot(x);
  const n0 = node.txs.length;
  const ok = await inForce(c.root, '2099-02-03T00:25:00Z', { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`last anchor: #0 ${D1} in ${A0.txHash} \\(block \\d+\\) — on chain, the signer's self-send of this line's hash`));
  assert.doesNotMatch(ok.out, /anchoring it first/);
  assert.equal(node.txs.length, n0 + 1);
  // the node forgets #0's anchor: #0 is anchored again first (one more transaction, the same calldata), then #1
  const y = copyRoot(x);
  const forget = new Set([A0.txHash.toLowerCase()]);
  const n1 = node.txs.length;
  const r = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, chain: { forget } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`the anchor of #0 ${D1} \\(${A0.txHash}\\) is not on chain any more \\(dropped, as by a reorg\\) — #0 is anchored again`));
  assert.match(r.out, new RegExp(`#0 ${D1} has no anchor on chain — anchoring it first`));
  const ay = readJsonl(y.anc);
  assert.deepEqual(ay.map((a) => [a.seq, a.headHash]), [[0, L0.hash], [0, L0.hash], [1, readJsonl(y.rec)[1].hash]]);
  assert.notEqual(ay[1].txHash, A0.txHash);
  const sent = node.txs.slice(n1);
  assert.equal(sent.length, 2, 'one new anchor of #0, one of #1');
  assert.equal(hexToString(sent[0].data), `qxpi-qvol:${L0.hash}`);
  // two anchors dropped: both lines anchored again, in order
  const z = copyRoot(y);
  const az = readJsonl(z.anc);
  const n2 = node.txs.length;
  const rz = await inForce(z.root, '2099-02-04T00:25:00Z', { key, node, chain: { forget: new Set([...forget, az[1].txHash.toLowerCase(), az[2].txHash.toLowerCase()]) } });
  assert.equal(rz.code, 0, rz.err);
  assert.deepEqual(node.txs.slice(n2).map((t) => hexToString(t.data)), [...readJsonl(z.rec).map((l) => `qxpi-qvol:${l.hash}`)]);
  // an entry naming a transaction that is not the keeper's anchor of the line: refused, nothing sent
  const other = keyed().address;
  for (const [label, edit, chain, why] of [
    ['the decision\'s anchor named as #0\'s', (a) => [{ ...a[0], txHash: x.entry.txHash }], {}, new RegExp(`does not carry qxpi-qvol:${L0.hash}`)],
    ['a transaction from another key', (a) => a, { answer: (req) => (req.method === 'eth_getTransactionByHash' && String(req.params[0]).toLowerCase() === A0.txHash.toLowerCase() ? rpcTx({ hash: A0.txHash, from: other, to: other, input: toHex(`qxpi-qvol:${L0.hash}`), block: 101 }) : undefined) }, new RegExp(`was sent by ${other}, not by the signer ${address}`)],
  ]) {
    const w = copyRoot(x);
    writeJsonl(w.anc, edit(readJsonl(w.anc)));
    const before = listAll(w.root);
    const n = node.txs.length;
    const rw = await inForce(w.root, '2099-02-03T00:25:00Z', { key, node, chain });
    assert.equal(rw.code, 2, `${label}: ${rw.err}`);
    assert.match(rw.err, new RegExp(`the anchor of #0 ${D1} in trackrecord/anchors-qvol\\.jsonl \\(0x[0-9a-f]{64}\\) .* — it is not the keeper's anchor of that line; nothing sent`), label);
    assert.match(rw.err, why, label);
    assert.deepEqual(listAll(w.root), before, `${label}: a file changed`);
    assert.equal(node.txs.length, n, `${label}: a transaction was sent`);
    assert.equal(rw.binanceCalls, 0, `${label}: Binance was called`);
  }
});

test('in force T-IF24 (F9): the keeper waits for a receipt at most RECEIPT_TIMEOUT_MS (5 minutes; a few hundred ms here) — an anchor whose receipt never comes: exit 1 within that limit, the line stays on disk without an anchor entry, nothing marked, and the next run anchors it first (a second transaction with the same calldata, harmless); a setNav step whose receipt never comes: exit 1 after the line\'s anchor, and the next run goes on from the vault\'s value', async () => {
  assert.equal(RECEIPT_TIMEOUT_MS, 300_000);
  const LIMIT = 1500;
  const x = inForceRoot({ vaults: qvolVaults() });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const ownTx = (req) => node.txs.some((t) => t.hash.toLowerCase() === String(req.params?.[0]).toLowerCase());
  const noReceipt = (pick) => ({ answer: (req) => (req.method === 'eth_getTransactionReceipt' && ownTx(req) && pick(req) ? null : undefined) });
  // the same run with receipts, for the time a run takes without the wait
  const c = inForceRoot({ vaults: qvolVaults() });
  const nc = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const tc = Date.now();
  assert.equal((await inForce(c.root, `${D1}T00:25:00Z`, { key, node: nc, extra: { receiptTimeoutMs: LIMIT } })).code, 0);
  const base = Date.now() - tc;
  const t0 = Date.now();
  const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node, chain: noReceipt(() => true), extra: { receiptTimeoutMs: LIMIT } });
  const took = Date.now() - t0;
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`qvol: line #0 ${D1} is written but its anchor failed: no receipt for the anchor of #0 0x[0-9a-f]{64} within ${LIMIT / 1000} s — no mark; the next run anchors it first \\(if that transaction is mined later, the line has two anchor transactions with the same calldata: harmless, the anchors file names the later one\\)`));
  // the wait is the limit: no shorter, and no longer than the limit plus a run without it, with slack
  assert.ok(took >= LIMIT, `took ${took} ms, less than the limit ${LIMIT} ms`);
  assert.ok(took <= base + 3 * LIMIT, `took ${took} ms: more than a run without the wait (${base} ms) plus three times the limit`);
  assert.equal(node.anchorsOf().length, 1, 'the anchor was sent once');
  assert.equal(readJsonl(x.rec).length, 1);
  assert.equal(fs.existsSync(x.anc), false);
  assert.equal(fs.existsSync(x.marks), false);
  assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0);
  // the next run: anchored again (the first transaction was mined: two with the same calldata), then marked
  const [L0] = readJsonl(x.rec);
  const r2 = await inForce(x.root, `${D1}T00:40:00Z`, { key, node });
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(node.anchorsOf(), [`qxpi-qvol:${L0.hash}`, `qxpi-qvol:${L0.hash}`]);
  assert.deepEqual(readJsonl(x.anc).map((a) => a.txHash), [node.txs.filter((t) => t.to === t.from)[1].hash]);
  assert.equal(node.state.nav, markUnits(L0.value));
  // a setNav step whose receipt never comes: the line written and anchored, the mark stops (exit 1); the next run goes on from the vault
  const y = inForceRoot({ vaults: qvolVaults() });
  const ny = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const setNav = (req) => getAddress(ny.txs.find((t) => t.hash.toLowerCase() === String(req.params[0]).toLowerCase()).to) === QVAULT;
  const ownY = (req) => ny.txs.some((t) => t.hash.toLowerCase() === String(req.params?.[0]).toLowerCase());
  const ry = await inForce(y.root, `${D1}T00:25:00Z`, { key, transport: quick(ny, null, { root: y.root, from: address, answer: (req) => (req.method === 'eth_getTransactionReceipt' && ownY(req) && setNav(req) ? null : undefined) }), extra: { receiptTimeoutMs: LIMIT } });
  assert.equal(ry.code, 1, ry.err);
  assert.match(ry.err, new RegExp(`qVOL vault marks FAILED after line #0 was written and anchored: no receipt for setNav step 1/\\d+ 0x[0-9a-f]{64} within ${LIMIT / 1000} s`));
  assert.equal(ny.txs.filter((t) => t.to === QVAULT).length, 1, 'one setNav sent, not repeated');
  assert.equal(readJsonl(y.anc).length, 1);
  assert.equal(fs.existsSync(y.marks), false, 'no mark line without its receipt');
  const navAfter = ny.state.nav; // the step was mined
  assert.notEqual(navAfter, 1_000_000n);
  const ry2 = await inForce(y.root, `${D1}T00:40:00Z`, { key, node: ny });
  assert.equal(ry2.code, 0, ry2.err);
  const [Y0] = readJsonl(y.rec);
  assert.equal(ny.state.nav, markUnits(Y0.value));
  const navs = ny.txs.filter((t) => t.to === QVAULT).map((t) => decodeFunctionData({ abi: VAULT_ABI, data: t.data }).args[0]);
  assert.equal(new Set(navs).size, navs.length, 'no setNav step sent twice');
  assert.deepEqual(navs.slice(1), markSteps(navAfter, markUnits(Y0.value)));
});

test('in force T-IF25 (F10): before any mark the registry entry\'s deployTx must be the keeper\'s own contract creation of the entry\'s address — an impostor entry (a vault with the right symbol, keeper and cap) whose deployTx is missing, not on chain, another key\'s, not a creation, the creation of another contract, or in another block gets no mark (exit 1; the line written and anchored, no setNav); the keeper\'s own deployment is marked (control)', async () => {
  const { key, address } = keyed();
  const other = keyed().address;
  const dep = DEPLOY_TX.toLowerCase();
  const txOf = (over) => (req) => (req.method === 'eth_getTransactionByHash' && String(req.params[0]).toLowerCase() === dep ? rpcTx({ hash: DEPLOY_TX, from: address, to: null, input: '0x6080604052', block: 60, ...over }) : undefined);
  const rcOf = (over) => (req) =>
    req.method === 'eth_getTransactionReceipt' && String(req.params[0]).toLowerCase() === dep
      ? { transactionHash: DEPLOY_TX, blockNumber: '0x3c', blockHash: `0x${'3c'.padStart(64, '0')}`, transactionIndex: '0x0', status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: QVAULT, from: address, to: null, ...over }
      : undefined;
  const reg = (over) => ({ qvol: { ...qvolVaults().qvol, ...over } });
  const cases = [
    ['no deployTx', reg({ deployTx: null }), {}, /its deployTx is null, not a transaction hash/],
    ['a deployTx not on chain', reg({}), { forget: new Set([dep]) }, new RegExp(`its deployTx ${DEPLOY_TX} is not on chain`)],
    ['another key\'s deployment', reg({}), { answer: txOf({ from: other }) }, new RegExp(`its deployTx ${DEPLOY_TX} was sent by ${other}, not by the keeper ${address}`)],
    ['not a contract creation', reg({}), { answer: txOf({ to: other }) }, new RegExp(`its deployTx ${DEPLOY_TX} is not a contract creation \\(it is sent to ${other}\\)`)],
    ['the creation of another contract', reg({}), { answer: rcOf({ contractAddress: other }) }, new RegExp(`its deployTx ${DEPLOY_TX} created ${other}, not ${QVAULT}`)],
    ['another block than the entry says', reg({ block: 61 }), {}, new RegExp(`its deployTx ${DEPLOY_TX} is in block 60, not in block 61 as the entry says`)],
  ];
  for (const [label, vaults, chain, why] of cases) {
    const x = inForceRoot({ vaults });
    const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' }); // the right symbol, keeper and cap
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, node, chain });
    assert.equal(r.code, 1, `${label}: ${r.err}`);
    assert.match(r.err, new RegExp(`qVOL vault marks FAILED after line #0 was written and anchored: REFUSED: keeper/leverage-vaults\\.json qvol names ${QVAULT}, but`), label);
    assert.match(r.err, why, label);
    assert.match(r.err, /the entry does not name the keeper's own display vault; no mark sent/, label);
    assert.deepEqual([readJsonl(x.rec).length, readJsonl(x.anc).length, fs.existsSync(x.marks)], [1, 1, false], label);
    assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0, `${label}: a setNav was sent`);
    assert.equal(node.state.nav, 1_000_000n, label);
  }
  // control: the keeper's own deployment
  const x = inForceRoot({ vaults: qvolVaults() });
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const ok = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`vault ${QVAULT}: created by the signer in ${DEPLOY_TX} \\(block 60\\), as the registry says`));
  assert.equal(node.state.nav, markUnits(readJsonl(x.rec)[0].value));
});

test('in force T-IF26 idempotency: an anchor sent and mined whose receipt answer is lost — exit 1, the line stays on disk without an anchor entry, nothing marked; the next run anchors it again with the same calldata (two anchor transactions for one line, harmless) and the anchors file names the later one; the run after reads that one again and sends nothing more for the line', async () => {
  const x = inForceRoot({ vaults: qvolVaults() });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const anchorTx = (req) => node.txs.some((t) => t.to === t.from && t.hash.toLowerCase() === String(req.params?.[0]).toLowerCase());
  const lost = quick(node, (req) => {
    if (req.method === 'eth_getTransactionReceipt' && anchorTx(req)) throw new Error('injected: the answer was lost after the node accepted the transaction');
  }, { root: x.root, from: address });
  const r1 = await inForce(x.root, `${D1}T00:25:00Z`, { key, transport: lost });
  assert.equal(r1.code, 1, r1.err);
  assert.match(r1.err, new RegExp(`line #0 ${D1} is written but its anchor failed: .*injected: the answer was lost.* — no mark; the next run anchors it first`));
  const [L0] = readJsonl(x.rec);
  assert.deepEqual(node.anchorsOf(), [`qxpi-qvol:${L0.hash}`], 'the anchor was mined');
  assert.equal(fs.existsSync(x.anc), false);
  assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0);
  // the next run: the line has no anchor entry — anchored again (same calldata), then marked
  const r2 = await inForce(x.root, `${D1}T00:40:00Z`, { key, node });
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, new RegExp(`#0 ${D1} has no anchor — anchoring it first`));
  const anchors = node.txs.filter((t) => t.to === t.from);
  assert.deepEqual(anchors.map((t) => hexToString(t.data)), [`qxpi-qvol:${L0.hash}`, `qxpi-qvol:${L0.hash}`]);
  assert.deepEqual(readJsonl(x.anc).map((a) => [a.seq, a.headHash, a.txHash]), [[0, L0.hash, anchors[1].hash]]);
  assert.equal(node.state.nav, markUnits(L0.value));
  // the run after: the later anchor is read again, nothing is sent
  const n = node.txs.length;
  const r3 = await inForce(x.root, `${D1}T00:55:00Z`, { key, node });
  assert.equal(r3.code, 0, r3.err);
  assert.match(r3.out, new RegExp(`last anchor: #0 ${D1} in ${anchors[1].hash} `));
  assert.equal(node.txs.length, n);
});

test('in force T-IF27 idempotency: a mark that fails part-way (setNav step 3 reverts) leaves the line written and anchored and exits 1; the next run goes on from the vault\'s value — the steps already done are not sent again and the marks file ends as one uninterrupted mark would', async () => {
  const x = inForceRoot({ vaults: qvolVaults() });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL', failSetNavAtStep: 3 });
  const r1 = await inForce(x.root, `${D1}T00:25:00Z`, { key, node });
  assert.equal(r1.code, 1, r1.err);
  const [L0] = readJsonl(x.rec);
  const n6 = markUnits(L0.value);
  const plan = markSteps(1_000_000n, n6);
  assert.ok(plan.length > 3, `${plan.length} steps`);
  assert.match(r1.err, new RegExp(`qVOL vault marks FAILED after line #0 was written and anchored: setNav step 3/${plan.length} reverted`));
  assert.deepEqual(readJsonl(x.marks).map((m) => BigInt(m.nav)), plan.slice(0, 2));
  assert.equal(node.state.nav, plan[1]);
  assert.equal(readJsonl(x.anc).length, 1);
  const r2 = await inForce(x.root, `${D1}T00:40:00Z`, { key, node });
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, new RegExp(`vault ${QVAULT}: navPerShare ${plan[1]} → target ${n6} `));
  assert.equal(node.state.nav, n6);
  const ok = node.txs.filter((t) => t.to === QVAULT && t.status === '0x1').map((t) => decodeFunctionData({ abi: VAULT_ABI, data: t.data }).args[0]);
  assert.deepEqual(ok, plan, 'the successful steps are the uninterrupted plan, none sent twice');
  assert.deepEqual(readJsonl(x.marks).map((m) => BigInt(m.nav)), plan);
  assert.equal(readJsonl(x.anc).length, 1, 'no second anchor');
});

test('in force T-IF28 (F12 resume): a daily-close entry lets the run go on only when both of its closes are the ones the run reads — an entry for the same day with another daily close, or another 1-minute close, still stops the run (exit 1, nothing written); the exact pair goes on (control)', async () => {
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const x = inForceRoot();
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  const c1 = BARS[D1].at(-1).c;
  const daily = (d, c) => (d === D1 ? c + 0.01 : undefined);
  const entry = (minuteClose, dailyClose) => [{ id: 'qvol-daily-2099-02-02', series: 'qvol', day: D1, check: 'daily-close', minuteClose, dailyClose, note: 'TEST ONLY', confirmedAt: '2099-02-03' }];
  for (const [label, e] of [['another daily close', entry(String(c1), String(c1 + 0.02))], ['another 1-minute close', entry(String(c1 + 0.03), String(c1 + 0.01))], ['no daily candle claimed', entry(String(c1), null)]]) {
    const y = copyRoot(x);
    fs.writeFileSync(CHECKS(y), JSON.stringify(e));
    const n = node.txs.length;
    const r = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, daily });
    assert.equal(r.code, 1, `${label}: ${r.err}`);
    assert.match(r.err, new RegExp(`DAILY CLOSE DIFFERS — the 1-minute bars close ${D1} at ${c1}, Binance's daily candle closes it at ${String(c1 + 0.01)}; nothing written for line 2099-02-03`), label);
    assert.equal(readJsonl(y.rec).length, 1, label);
    assert.equal(node.txs.length, n, label);
  }
  const y = copyRoot(x);
  fs.writeFileSync(CHECKS(y), JSON.stringify(entry(String(c1), String(c1 + 0.01))));
  const ok = await inForce(y.root, '2099-02-03T00:25:00Z', { key, node, daily });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readJsonl(y.rec).length, 2);
});

test('in force T-IF29 (F2 resume): a refetch entry never passes a line without an anchor — a run without the key that continues from an unanchored line whose day Binance now serves differently stops (exit 1, nothing written) although the file holds the exact entry; the same entry passes the anchored line (control)', async () => {
  const changed = alterBar(BARS, E, 600, nudge);
  const served = shaOf(canonicalMinuteText(changed[E]));
  const u = inForceRoot();
  assert.equal((await inForce(u.root, `${D1}T00:25:00Z`, { argv: [] })).code, 0);
  const [L0] = readJsonl(u.rec);
  const e = [{ id: 'qvol-revised-2099-02-01', series: 'qvol', day: E, check: 'refetch', recorded: L0.source.sha256, served, note: 'TEST ONLY', confirmedAt: '2099-02-03' }];
  fs.writeFileSync(CHECKS(u), JSON.stringify(e));
  const before = listAll(u.root);
  const r = await inForce(u.root, '2099-02-03T00:25:00Z', { argv: [], bars: changed });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`SOURCE CHANGED — line #0 ${D1} was built from the bars of ${E} .* canonical text sha256 ${served} — nothing written, nothing anchored, no mark\\. The line has no anchor`));
  assert.doesNotMatch(r.out, /confirmed by/);
  assert.deepEqual(listAll(u.root), before);
  // control: the same entry, the line anchored (with the key)
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  fs.writeFileSync(CHECKS(x), JSON.stringify(e));
  const ok = await inForce(x.root, '2099-02-03T00:25:00Z', { argv: [], bars: changed });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /confirmed by qvol-revised-2099-02-01/);
});

test('in force T-IF30 (F2, first line): an unanchored first line is anchored only after every one of its window days is fetched again — a hand-appended first line whose older window close is forged (value computed from it, every recorded sha256 the real one) is refused (exit 1, nothing sent); the honest first line is anchored (control)', async () => {
  const w = inForceRoot();
  assert.equal((await inForce(w.root, `${D1}T00:25:00Z`, { argv: [] })).code, 0);
  const [L0] = readJsonl(w.rec);
  const win = L0.window.map((e, k) => (k === 10 ? [e[0], e[1] * 1.5] : e));
  const made = realizedFromWindow(win, null, { windowDays: RB_REPO.windowDays, yearDays: RB_REPO.yearDays });
  const forged = rehash({ ...L0, value: made.value, variance: made.variance, window: win });
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  const u = inForceRoot();
  writeJsonl(u.rec, [forged]);
  assert.equal(verify(path.join(u.root, 'trackrecord'), '--line', 'realized', '--rulebook', u.rbFile).status, 0, 'verify-vol accepts the forged first line');
  const before = listAll(u.root);
  const r = await inForce(u.root, `${D1}T00:40:00Z`, { key, node });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`SOURCE CHANGED — line #0 ${D1} was built from the bars of ${win[10][0]} .* — #0 has no anchor and is not anchored: nothing sent`));
  assert.equal(node.txs.length, 0);
  assert.deepEqual(listAll(u.root), before);
  // control: the honest first line, unanchored, is anchored after all 31 days are read again
  const ok = await inForce(w.root, `${D1}T00:40:00Z`, { key, node });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`#0 ${D1}: the bars it records read again from Binance \\(31 days\\) — the same`));
  assert.deepEqual(node.anchorsOf(), [`qxpi-qvol:${L0.hash}`]);
});

test('in force T-IF31 (red team M3): the keeper computes each transaction\'s hash from the bytes it signed — a node that answers eth_sendRawTransaction with another hash, or a receipt that names another transaction, is a failed anchor (exit 1, the line on disk without an anchor entry, nothing marked); the next run with an honest node anchors it (control)', async () => {
  const { key, address } = keyed();
  const OTHER = `0x${'ab'.repeat(32)}`;
  const lying = (node, root, { send = false, receipt = false }) => {
    const base = quick(node, null, { root, from: address });
    return custom({
      async request(req) {
        const v = await base({ retryCount: 0 }).request(req);
        if (send && req.method === 'eth_sendRawTransaction') return OTHER;
        if (receipt && req.method === 'eth_getTransactionReceipt' && v && node.txs.some((t) => t.hash === v.transactionHash)) return { ...v, transactionHash: OTHER };
        return v;
      },
    }, { retryCount: 0 });
  };
  for (const [label, how, why] of [['another hash for the sent transaction', { send: true }, new RegExp(`the node answered the transaction hash ${OTHER}, but the signed transaction hashes to 0x[0-9a-f]{64}`)], ['a receipt naming another transaction', { receipt: true }, new RegExp(`the receipt for the anchor of #0 0x[0-9a-f]{64} names the transaction ${OTHER}`)]]) {
    const x = inForceRoot({ vaults: qvolVaults() });
    const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
    const r = await inForce(x.root, `${D1}T00:25:00Z`, { key, transport: lying(node, x.root, how) });
    assert.equal(r.code, 1, `${label}: ${r.err}`);
    assert.match(r.err, new RegExp(`line #0 ${D1} is written but its anchor failed: `), label);
    assert.match(r.err, why, label);
    assert.equal(readJsonl(x.rec).length, 1, label);
    assert.equal(fs.existsSync(x.anc), false, label);
    assert.equal(node.txs.filter((t) => t.to === QVAULT).length, 0, label);
    const ok = await inForce(x.root, `${D1}T00:40:00Z`, { key, node });
    assert.equal(ok.code, 0, `${label} control: ${ok.err}`);
    assert.equal(readJsonl(x.anc).at(-1).txHash, node.txs.filter((t) => t.to === t.from).at(-1).hash, label);
  }
});
