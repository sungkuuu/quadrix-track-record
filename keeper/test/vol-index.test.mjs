/**
 * keeper/vol-index.mjs as a CLI — fake Binance / Deribit, no network, SYNTHETIC
 * data only: the six "cannot compute" reasons (T12), hash chain and key order
 * (T13), the not-in-force path (T14), no key in the new files (T15), Deribit
 * failures (T17), --collect-only (T18), and agreement with the independent
 * scripts/verify-vol.mjs (T19).
 *
 *   node --test keeper/test/vol-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { run, parseArgs, rulebookProblem } from '../vol-index.mjs';
import { quotesSha256 } from '../vol-implied.mjs';
import { handTable, syntheticTable, syntheticDays, writeOffline, writeSnapshot, fakeDeribit, tmpDir, readJsonl, cli, KEEPER, REPO, addDays, rulebookPath, impliedOnRoot } from './vol-helpers.mjs';

const IMP = 'record-volbtc-implied.jsonl';
const REA = 'record-volbtc-realized.jsonl';
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
  assert.equal(realized.active, true);
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
    ['--line', 'realized', '--anchor'],
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
  for (const p of ['name', 'series', 'source', 'windowDays', 'sampling', 'mean', 'display.decimals']) assert.ok(marked.includes(p), `${p} not marked pendingOwner`);
  const markedImplied = ib.pendingOwner.map((e) => e.path);
  for (const p of ['active', 'name', 'series', 'source']) assert.ok(markedImplied.includes(p), `implied ${p} not marked pendingOwner`);
  // through the CLI, from a scratch root
  const root = tmpDir('vol-rb');
  const dir = path.join(root, 'keeper', 'rulebooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'volbtc-realized.json'), JSON.stringify({ ...rb, id: 'other' }));
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
test('T15 no key: the new files read no signing key and import no wallet client', () => {
  const files = [
    ...fs.readdirSync(KEEPER).filter((f) => /^vol-.*\.mjs$/.test(f)).map((f) => path.join(KEEPER, f)),
    ...fs.readdirSync(path.join(KEEPER, 'test')).filter((f) => /^vol-.*\.mjs$/.test(f)).map((f) => path.join(KEEPER, 'test', f)),
    VERIFY,
  ];
  assert.ok(files.length >= 8, files.join(','));
  const needles = ['KEEPER' + '_PK', 'BIDDER' + '_PK', "from 'vi" + "em", 'privateKey' + 'ToAccount', 'createWallet' + 'Client', 'process.env.KEE' + 'PER'];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const n of needles) assert.ok(!src.includes(n), `${path.basename(f)} contains ${n}`);
  }
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
  t2[3].value = Math.round((t2[3].value + 0.01) * 100) / 100;
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
  const changed = rehash({ ...lines[3], value: Math.round((lines[3].value + 0.01) * 100) / 100 });
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
