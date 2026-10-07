/**
 * keeper/deploy-mark-vault.mjs against a local JSON-RPC server that plays an
 * anvil node (no network, no key):
 *   - the transaction hash is in keeper/dryrun/mark-vaults.jsonl as soon as
 *     the send returns — before the receipt (here: a receipt that never comes);
 *   - a read-back answered by a node behind the receipt's block (header not
 *     found, then no code) is repeated until it agrees; the address is then
 *     written to keeper/dryrun/leverage-vaults.json with the gate unchanged;
 *   - a second deployment for an index that already names a vault is refused.
 * The tool writes under keeper/dryrun/ for a local RPC; this test saves and
 * restores those two files.
 *
 *   node --test keeper/test/deploy-mark-vault.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex } from 'viem';
import { ARTIFACT, expectedRuntime, MOCK_USD, REFERENCE_VAULT } from '../deploy-mark-vault.mjs';
import { KEEPER_DIR } from './leverage-helpers.mjs';

const DRY = path.join(KEEPER_DIR, 'dryrun');
const OUT = [path.join(DRY, 'mark-vaults.jsonl'), path.join(DRY, 'leverage-vaults.json')];
const saved = new Map(OUT.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f)]));
const reset = () => { for (const f of OUT) fs.rmSync(f, { force: true }); };
after(() => { reset(); for (const [f, b] of saved) fs.writeFileSync(f, b); });

const FROM = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const NEW = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** A JSON-RPC server: `lagReads` reads after the receipt fail or answer empty; `receipts` false = never mined. */
function server({ receipts = true, lagReads = 0 } = {}) {
  const calls = [];
  let mined = null;
  let lag = lagReads;
  const want = expectedRuntime(MOCK_USD);
  const state = { owner: FROM, keeper: FROM, navPerShare: 1_000_000n, depositCap: 0n, depositsPaused: false, usd: getAddress(MOCK_USD), name: 'Quadrix BTC 2x Vault', symbol: 'qBTC2X', decimals: 6 };
  const handle = (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId': return hex(91342);
      case 'web3_clientVersion': return 'anvil/v1.5.1';
      case 'eth_blockNumber': return hex(mined ? 101 : 100);
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_gasPrice': return '0x3b9aca00';
      case 'eth_maxPriorityFeePerGas': return '0x1';
      case 'eth_estimateGas': return '0x100000';
      case 'eth_getBlockByNumber': return { number: hex(mined ? 101 : 100), hash: `0x${'b'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1', transactions: [] };
      case 'eth_getCode': {
        const a = getAddress(params[0]);
        if (a === getAddress(MOCK_USD)) return '0x6001';
        if (a === getAddress(REFERENCE_VAULT)) return ARTIFACT.deployedBytecode.replace(/a2646970667358221220[0-9a-f]{64}/, `a2646970667358221220${'1'.repeat(64)}`);
        if (a === NEW && mined) {
          if (lag > 0) { lag--; throw Object.assign(new Error('header not found'), { code: -32000 }); }
          return want;
        }
        return '0x';
      }
      case 'eth_call': {
        const [{ to, data }] = params;
        if (!to) return want; // the simulated deployment
        const { functionName } = decodeFunctionData({ abi: ARTIFACT.abi, data });
        return encodeFunctionResult({ abi: ARTIFACT.abi, functionName, result: state[functionName] });
      }
      case 'eth_sendTransaction': {
        mined = keccak256(toHex(JSON.stringify(params)));
        return mined;
      }
      case 'eth_getTransactionReceipt':
        if (!receipts || params[0] !== mined) return null;
        return { transactionHash: mined, blockNumber: hex(101), blockHash: `0x${'b'.repeat(64)}`, transactionIndex: '0x0', status: '0x1', gasUsed: '0x12d687', cumulativeGasUsed: '0x12d687', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: NEW, from: FROM, to: null };
      case 'eth_getTransactionByHash': return null;
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const one = (m) => {
        try { return { jsonrpc: '2.0', id: m.id, result: handle(m.method, m.params ?? []) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } }; }
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, calls })));
}

function runTool(args, { killAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(KEEPER_DIR, 'deploy-mark-vault.mjs'), ...args], { env: { PATH: process.env.PATH } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = killAfterMs ? setTimeout(() => p.kill('SIGKILL'), killAfterMs) : null;
    p.on('close', (code, sig) => { if (t) clearTimeout(t); resolve({ code, sig, out }); });
  });
}

test('the transaction is logged as soon as it is sent — a receipt that never comes still leaves the hash on disk', async () => {
  reset();
  const { srv, url } = await server({ receipts: false });
  try {
    const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--live', '--confirm', 'EXECUTE', '--rpc', url, '--from', FROM], { killAfterMs: 4000 });
    assert.equal(r.sig, 'SIGKILL', r.out);
    const log = fs.readFileSync(OUT[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].status, 'sent');
    assert.match(log[0].tx, /^0x[0-9a-f]{64}$/);
    assert.ok(!fs.existsSync(OUT[1]), 'no address written without a receipt and a read-back');
  } finally {
    srv.close();
  }
});

test('a read-back behind the receipt block is repeated until it agrees; the address is written with the gate unchanged; a second deployment is refused', async () => {
  reset();
  const { srv, url, calls } = await server({ lagReads: 2 });
  try {
    let r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--live', '--confirm', 'EXECUTE', '--rpc', url, '--from', FROM]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /read back ok \(at read 3\)/);
    const log = fs.readFileSync(OUT[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => l.status), ['sent', 'mined']);
    assert.ok(calls.indexOf('eth_sendTransaction') < calls.indexOf('eth_getTransactionReceipt'));
    const v = JSON.parse(fs.readFileSync(OUT[1], 'utf8'));
    assert.equal(v.qbtc2x.address, NEW);
    // unchanged: the gate the shipped registry holds (null before the owner's choice, {mode: 'step'} after it)
    assert.deepEqual(v.qbtc2x.gate, JSON.parse(fs.readFileSync(new URL('../leverage-vaults.json', import.meta.url), 'utf8')).qbtc2x.gate);
    r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--live', '--confirm', 'EXECUTE', '--rpc', url, '--from', FROM]);
    assert.equal(r.code, 2);
    assert.match(r.out, /already names a vault/);
  } finally {
    srv.close();
  }
});

test('review r1: a deployment that was sent but never reached the registry blocks a second deployment until a person resolves it', async () => {
  reset();
  let s = await server({ receipts: false });
  try {
    const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--live', '--confirm', 'EXECUTE', '--rpc', s.url, '--from', FROM], { killAfterMs: 4000 });
    assert.equal(r.sig, 'SIGKILL', r.out);
  } finally {
    s.srv.close();
  }
  const first = JSON.parse(fs.readFileSync(OUT[0], 'utf8').trim().split('\n')[0]);
  assert.equal(first.status, 'sent');
  s = await server();
  try {
    // re-running the same command (live or dry) is refused and sends nothing
    for (const extra of [['--live', '--confirm', 'EXECUTE'], []]) {
      const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, ...extra, '--rpc', s.url, '--from', FROM]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, new RegExp(`already sent \\(tx ${first.tx}\\)`));
    }
    assert.ok(!s.calls.includes('eth_sendTransaction'), 'nothing sent');
    // another index is not blocked
    let r = await runTool(['--index', 'qeth2x', '--manager', FROM, '--rpc', s.url, '--from', FROM]);
    assert.equal(r.code, 0, r.out);
    // once a person marks the first one abandoned, a deployment may go ahead
    fs.appendFileSync(OUT[0], JSON.stringify({ index: 'qbtc2x', chainId: 91342, tx: first.tx, status: 'abandoned', note: 'test' }) + '\n');
    r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--rpc', s.url, '--from', FROM]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry run: would deploy/);
  } finally {
    s.srv.close();
  }
});

test('a live run on a local RPC never uses KEEPER_PK and a live run without the confirm word is refused', async () => {
  for (const args of [['--live', '--confirm', 'EXECUTE', '--rpc', 'http://127.0.0.1:9'], ['--live']]) {
    const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, ...args]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /REFUSED/);
  }
});

test('rehearsal C4: a fork rehearsal starts from the real registry with every address emptied (gates kept), so it still runs after the real vaults exist; a live run reads the registry as it is', async () => {
  const { readVaults } = await import('../deploy-mark-vault.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-c4-'));
  const seed = path.join(dir, 'leverage-vaults.json');
  const real = { _doc: 'x', qbtc2x: { chainId: 91342, address: '0x00000000000000000000000000000000000beef1', gate: { mode: 'step' }, deployTx: `0x${'a'.repeat(64)}`, block: 7 }, qeth2x: { chainId: 91342, address: null, gate: { mode: 'step' }, deployTx: null, block: null } };
  fs.writeFileSync(seed, JSON.stringify(real));
  const fork = readVaults(path.join(dir, 'missing.json'), seed, true);
  assert.deepEqual(fork.qbtc2x, { chainId: 91342, address: null, gate: { mode: 'step' }, deployTx: null, block: null });
  assert.deepEqual(fork.qeth2x, real.qeth2x);
  assert.equal(fork._doc, 'x');
  assert.deepEqual(readVaults(path.join(dir, 'missing.json'), seed, false), real);
});
