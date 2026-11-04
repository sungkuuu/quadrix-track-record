/**
 * keeper/vol-index.mjs as a CLI — fake Binance / Deribit, no network, SYNTHETIC
 * data only: the six "cannot compute" reasons (T12), hash chain and key order
 * (T13), the not-in-force path (T14), no key in the new files (T15), Deribit
 * failures (T17), --collect-only (T18), and agreement with the independent
 * scripts/verify-vol.mjs (T19). The last section tests the realized line in
 * force (a stand-in inception decision in a scratch ledger, a fake GIWA node,
 * a key generated here): the decision check, the line, the verifier, the
 * anchor, the display vault's mark and the refusal of open-deposits for qvol.
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
import { custom, decodeFunctionData, getAddress, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { run, parseArgs, rulebookProblem, markUnits } from '../vol-index.mjs';
import { markSteps } from '../leverage-step.mjs';
import { VAULT_ABI } from '../leverage-index.mjs';
import { NAMES, DISPLAY_ONLY } from '../deploy-mark-vault.mjs';
import { fakeNode } from './leverage-helpers.mjs';
import { quotesSha256 } from '../vol-implied.mjs';
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
  for (const [line, root] of [['realized', REPO], ['implied', ON]]) {
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
  assert.match(mutate(rb, 'realized', (c) => (c.inception = { date: '2099-01-01', decision: 'x' })), /cannot have values pending the owner/);
  // what waits for the owner is marked in the realized rulebook, and every mark names a key
  const marked = rb.pendingOwner.map((e) => e.path);
  for (const p of ['source', 'windowDays', 'sampling', 'mean', 'display.decimals']) assert.ok(marked.includes(p), `${p} not marked pendingOwner`);
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

function inForceRoot({ effective = E, first = D1, pin = true, vaults = null, ledger = true } = {}) {
  const root = tmpDir('vol-inforce');
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  rb.status = 'TEST ONLY — a stand-in inception for the in-force tests; not a decision';
  rb.inception = { date: first, decision: `${effective}-qvol-inception` };
  rb.pendingOwner = [];
  fs.mkdirSync(path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'trackrecord', 'decisions'), { recursive: true });
  const rbBytes = Buffer.from(JSON.stringify(rb, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', 'qvol.json'), rbBytes);
  fs.writeFileSync(path.join(root, 'keeper', 'vol-index-gaps.json'), '[]\n');
  if (vaults) fs.writeFileSync(path.join(root, 'keeper', 'leverage-vaults.json'), JSON.stringify(vaults, null, 2) + '\n');
  const id = `${effective}-qvol-inception`;
  const doc = `# TEST ONLY — stand-in decision\n\nPins keeper/rulebooks/qvol.json sha256 ${pin ? H(rbBytes) : '0'.repeat(64)}.\n`;
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions', `${id}.md`), doc);
  const entry = { id, file: `decisions/${id}.md`, effectiveFrom: effective, sha256: H(Buffer.from(doc)), txHash: `0x${'d'.repeat(64)}`, anchoredAt: `${effective}T09:00:00.000Z` };
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), ledger ? JSON.stringify(entry) + '\n' : '');
  return { root, rbFile: path.join(root, 'keeper', 'rulebooks', 'qvol.json'), entry, rec: path.join(root, 'trackrecord', REA), anc: path.join(root, 'trackrecord', ANC), marks: path.join(root, 'keeper', 'marks-qvol.jsonl') };
}
const qvolVaults = (gate = { mode: 'step' }, address = QVAULT) => ({ qvol: { chainId: 91342, address, gate, deployTx: null, block: null } });

/**
 * The fake node as viem's transport, without retries. viem first asks a node to
 * fill a transaction (eth_fillTransaction); the fake node, like a node without
 * that method, refuses it, and viem then fills it itself — answered here at once
 * as "method not found" instead of after viem's retry delays. `refuse(req)`
 * may throw for a request (an injected failure).
 */
const quick = (node, refuse = null) =>
  custom(
    {
      async request(req) {
        if (req.method === 'eth_fillTransaction') throw Object.assign(new Error('the method eth_fillTransaction does not exist'), { code: -32601 });
        if (refuse) refuse(req);
        return node.transport({ retryCount: 0 }).request(req);
      },
    },
    { retryCount: 0 }
  );

/** One in-force run at `iso` (the runner's clock; the fake Binance's server time is 5 minutes later). */
async function inForce(root, iso, { key = null, node = null, transport = null, argv = ['--anchor'], extra = {} } = {}) {
  const now = Date.parse(iso);
  const bin = fakeBinance(BARS, now + 300_000);
  const r = await cli(run, ['--line', 'realized', ...argv], {
    root, now: () => now, fetch: bin.fetch, env: key ? { KEEPER_PK: key } : {},
    transport: transport ? () => transport : node ? () => quick(node) : () => { throw new Error('no chain call expected'); },
    pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 }, ...extra,
  });
  return { ...r, binanceCalls: bin.calls.length };
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
  // the repository's rulebook (inception null), as the daily step runs it before the anchor
  const { key, address } = keyed();
  const node = fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' });
  let calls = 0;
  const r0 = await cli(run, ['--line', 'realized', '--anchor'], { env: { KEEPER_PK: key }, fetch: async () => (calls++, new Response('[]')), transport: () => node.transport });
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
  assert.equal((await inForce(x.root, `${D1}T00:25:00Z`, { key, node })).code, 0);
  const sent = node.txs.length;
  const r2 = await inForce(x.root, '2099-02-03T00:25:00Z', { key, node, extra: { verifyScript: failing } });
  assert.equal(r2.code, 1);
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
  });
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
  const reg = JSON.parse(fs.readFileSync(path.join(KEEPER, 'leverage-vaults.json'), 'utf8'));
  assert.deepEqual(reg.qvol, { chainId: 91342, address: null, gate: { mode: 'step' }, deployTx: null, block: null });
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
