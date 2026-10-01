/**
 * A basket mark that fails cannot cost the day its record line or its anchor
 * (RUNBOOK failure mode 7). Every record-writing leg of paper-index.mjs runs
 * in this order: record line → state → anchor → basket marks. A mark that
 * throws afterwards — a reverted post, a failed RPC read inside basket-mark,
 * a NAV that cannot be stepped — is logged as `markFailed` and makes the
 * process exit 1, with the line and the anchor entry already on disk for the
 * workflow's "Commit records" step.
 *
 * The Barbell leg (sleeve path) and the qDEFI leg (ranked path, a
 * mark-to-market day on a fixture book) are run for real as child processes,
 * on dry runs dated in 2099 (output under keeper/dryrun/, fixtures in
 * keeper/cache/; every file is removed or restored afterwards), with --anchor
 * and a key generated for this test only. A
 * data: URL preload replaces fetch: every non-RPC URL fails, and the GIWA
 * Sepolia RPC is answered in-process — the anchor's self-send succeeds, every
 * eth_call (the basket vault reads) fails. Nothing leaves the process and the
 * key holds nothing on any chain.
 *
 *   node --test keeper/test/mark-after-anchor.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';

const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = path.join(KEEPER, 'dryrun');
const CACHE = path.join(KEEPER, 'cache');
const outputs = (index) => ['record', 'state', 'anchors'].map((k) => path.join(DRY, k === 'state' ? `state-${index}.json` : `${k}-${index}.jsonl`));
const OUT = [...outputs('barbell'), ...outputs('qdefi')];
const FIXTURES = [];

// Keep whatever is in keeper/dryrun/ (tracked demonstration files included)
// and put it back afterwards.
const saved = new Map(OUT.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f)]));
for (const f of OUT) fs.rmSync(f, { force: true });
after(() => {
  for (const f of [...OUT, ...FIXTURES]) fs.rmSync(f, { force: true });
  for (const [f, buf] of saved) fs.writeFileSync(f, buf);
});
function fixture(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  FIXTURES.push(file);
}
const row = (symbol, price = 1) => ({ id: symbol.toLowerCase(), symbol, price, marketCap: 1e9, volume24h: 1e6 });

/** In-process GIWA Sepolia: enough JSON-RPC for viem to sign, send and
 *  confirm one transaction. eth_call always fails. Each method is written to
 *  stderr as `[rpc] <method>` so the test can read the order of calls. */
const RPC_STUB = `
const RPC = 'https://sepolia-rpc.giwa.io';
const TX = '0x' + 'ab'.repeat(32);
const BH = '0x' + '11'.repeat(32);
const block = { number: '0x10', hash: BH, parentHash: '0x' + '22'.repeat(32), timestamp: '0x5f5e100',
  baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], nonce: '0x0000000000000000',
  miner: '0x' + '00'.repeat(20), difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0',
  logsBloom: '0x' + '00'.repeat(256), sha3Uncles: '0x' + '00'.repeat(32), stateRoot: '0x' + '00'.repeat(32),
  receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), uncles: [] };
let from = null;
function answer(m, params) {
  switch (m) {
    case 'eth_chainId': return '0x164ce';
    case 'eth_blockNumber': return '0x10';
    case 'eth_getBlockByNumber': return block;
    case 'eth_getTransactionCount': return '0x0';
    case 'eth_maxPriorityFeePerGas': return '0x1';
    case 'eth_gasPrice': return '0x2';
    case 'eth_estimateGas': from = params[0].from; return '0x5208';
    case 'eth_sendRawTransaction': return TX;
    case 'eth_getTransactionByHash': return null;
    case 'eth_getTransactionReceipt':
      return { transactionHash: TX, transactionIndex: '0x0', blockHash: BH, blockNumber: '0x10', from, to: from,
        cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x2', contractAddress: null, logs: [],
        logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x2' };
    default: return undefined;
  }
}
globalThis.fetch = async (url, init) => {
  if (String(url).replace(/\\/$/, '') !== RPC) throw new Error('offline (test)');
  const req = JSON.parse(init.body);
  const one = (r) => {
    process.stderr.write('[rpc] ' + r.method + '\\n');
    if (r.method === 'eth_call') return { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'rpc read failed (test)' } };
    const result = answer(r.method, r.params);
    if (result === undefined) return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'not stubbed: ' + r.method } };
    return { jsonrpc: '2.0', id: r.id, result };
  };
  const body = Array.isArray(req) ? req.map(one) : one(req);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
`;
const PRELOAD = 'data:text/javascript,' + encodeURIComponent(RPC_STUB);

function runLeg(index, date) {
  const r = spawnSync(
    process.execPath,
    ['--import', PRELOAD, path.join(KEEPER, 'paper-index.mjs'), '--index', index, '--dry-run', '--as-of', date, '--anchor'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, KEEPER_PK: generatePrivateKey(), GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', PAPER_INDEX_TEST_DROP_SYMBOL: '', COINGECKO_API_KEY: '' },
    }
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** What every case asserts: exit 1 with a `markFailed` line, one record line
 *  on disk, its anchor entry in the existing format, and the anchor sent
 *  before the basket vault was first read. */
function assertKept(index, date, { status, out }) {
  const [recordPath, statePath, anchorsPath] = outputs(index);
  assert.equal(status, 1, out);
  const failed = out.split('\n').find((l) => l.startsWith('markFailed '));
  assert.ok(failed, out);
  const f = JSON.parse(failed.slice('markFailed '.length));
  assert.equal(f.index, index);
  assert.equal(f.date, date);
  assert.equal(f.anchored, true);
  assert.match(f.error, /rpc read failed \(test\)/);

  const lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, out);
  const rec = lines[0];
  assert.equal(rec.date, date);
  assert.equal(f.seq, rec.seq);
  assert.ok(fs.existsSync(statePath), 'state written');

  const anchors = fs.readFileSync(anchorsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(anchors, [{ date, seq: rec.seq, headHash: rec.hash, txHash: '0x' + 'ab'.repeat(32) }]);

  const rpc = out.split('\n').filter((l) => l.startsWith('[rpc] ')).map((l) => l.slice(6));
  const sent = rpc.indexOf('eth_sendRawTransaction');
  const read = rpc.indexOf('eth_call');
  assert.ok(sent >= 0 && read >= 0 && sent < read, rpc.join(' '));
  assert.equal(rpc.filter((m) => m === 'eth_sendRawTransaction').length, 1, 'one transaction: the anchor');
}

test('Barbell leg (sleeve path): a basket mark that fails after the record keeps the line and its anchor, exit 1', () => {
  const date = '2099-12-27';
  fixture(path.join(CACHE, `cg-markets-top500-${date}.json`), [row('BTC', 100000)]);
  fixture(path.join(CACHE, `fred-dtb3-${date}.json`), { '2099-12-20': 4.0 });
  assertKept('barbell', date, runLeg('barbell', date));
});

test('qDEFI leg (ranked path): a basket mark that fails after the record keeps the line and its anchor, exit 1', () => {
  const date = '2099-12-26';
  // A mark-to-market day: a book already reconstituted this quarter, every
  // name priced, so the leg goes straight from the day's prices to the record.
  const units = { AAVE: 1, UNI: 2, LINK: 3 };
  fixture(outputs('qdefi')[1], { updatedAt: '2099-12-25T00:00:00.000Z', level: 6, units, lastReconQuarter: '2099Q4', onNotice: [] });
  fixture(path.join(CACHE, `cg-markets-top500-${date}.json`), Object.keys(units).map((s) => row(s)));
  assertKept('qdefi', date, runLeg('qdefi', date));
});
