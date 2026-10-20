/**
 * keeper/deploy-mark-vault.mjs attacked through the artifact file and the RPC's answers.
 *   - the artifact swapped for an old build (honest metadata) or for a crafted file;
 *   - a receipt whose contractAddress is not where the code is; a read-back whose values differ.
 * The two read-back cases wait out the tool's 30 s bound each (its READ_TIMING is not configurable
 * from outside), so this file takes about 70 s.
 *
 *   node --test keeper/test/deploy-mark-vault-artifact-readback.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, parseTransaction, serializeTransaction } from 'viem';
import { ARTIFACT, expectedRuntime, MOCK_USD, NAMES, REFERENCE_INDEX } from '../deploy-mark-vault.mjs';
import { KEEPER_DIR, REPO } from './leverage-helpers.mjs';

const DRY = path.join(KEEPER_DIR, 'dryrun');
const OUT = [path.join(DRY, 'mark-vaults.jsonl'), path.join(DRY, 'leverage-vaults.json')];
const saved = new Map(OUT.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f)]));
const reset = () => { for (const f of OUT) fs.rmSync(f, { force: true }); };
after(() => { reset(); for (const [f, b] of saved) fs.writeFileSync(f, b); });

const SEED = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'leverage-vaults.json'), 'utf8'));
const REF = getAddress(SEED[REFERENCE_INDEX].address);
const FROM = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const GUARD = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const REF_GUARD = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const NEW = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const OTHER = getAddress('0x000000000000000000000000000000000000d00d');
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** A node whose receipt may name another address and whose vault state may differ from what the tool expects. */
function server({ index = 'qeth15', receiptAddress = null, state = {}, simRuntime = null, abi = ARTIFACT.abi } = {}) {
  const calls = [];
  const sent = [];
  const txs = new Map();
  let block = 100;
  let deployed = false;
  const want = simRuntime ?? expectedRuntime(MOCK_USD);
  const [name, symbol] = NAMES[index];
  const st = {
    [NEW]: { owner: FROM, keeper: FROM, guardian: zeroAddress, pendingOwner: zeroAddress, navPerShare: 1_000_000n, depositCap: 0n, depositsPaused: false, usd: getAddress(MOCK_USD), name, symbol, decimals: 6, ...state },
    [REF]: { symbol: 'qBTC2X', guardian: REF_GUARD, owner: FROM, keeper: FROM },
  };
  const refCode = ARTIFACT.deployedBytecode.replace(/a2646970667358221220[0-9a-f]{64}/, `a2646970667358221220${'1'.repeat(64)}`);
  const handle = (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId': return hex(91342);
      case 'web3_clientVersion': return 'anvil/v1.5.1';
      case 'eth_blockNumber': return hex(block);
      case 'eth_getTransactionCount': return hex(sent.length);
      case 'eth_gasPrice': return '0x3b9aca00';
      case 'eth_maxPriorityFeePerGas': return '0x1';
      case 'eth_estimateGas': return '0x100000';
      case 'eth_getBlockByNumber': return { number: hex(block), hash: `0x${'b'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1', transactions: [] };
      case 'eth_getCode': {
        const a = getAddress(params[0]);
        if (a === getAddress(MOCK_USD)) return '0x6001';
        if (a === REF) return refCode;
        if (a === NEW && deployed) return want;
        return '0x';
      }
      case 'eth_call': {
        const [{ to, data }] = params;
        if (!to) return want;
        const a = getAddress(to);
        if (!st[a] || (a === NEW && !deployed)) return '0x';
        const { functionName } = decodeFunctionData({ abi, data });
        if (['setGuardian', 'setDepositCap', 'setDepositsPaused'].includes(functionName)) return '0x';
        return encodeFunctionResult({ abi, functionName, result: st[a][functionName] });
      }
      case 'eth_signTransaction': { // what anvil does for an unlocked account; unsigned here (the hash is keccak of these bytes either way)
        const [t] = params;
        const fee = t.maxFeePerGas != null ? { maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) } : { gasPrice: BigInt(t.gasPrice) };
        return serializeTransaction({ chainId: Number(t.chainId), nonce: Number(t.nonce), to: t.to ?? undefined, data: t.data, gas: BigInt(t.gas), value: 0n, ...fee });
      }
      case 'eth_sendRawTransaction': {
        const { to, data, nonce } = parseTransaction(params[0]);
        if (nonce !== sent.length) throw Object.assign(new Error(`nonce ${nonce}, expected ${sent.length}`), { code: -32000 });
        const h = keccak256(params[0]);
        let contractAddress = null;
        if (!to) { contractAddress = receiptAddress ?? NEW; sent.push({ what: 'deploy', to: null }); deployed = true; } else {
          const a = getAddress(to);
          const { functionName, args } = decodeFunctionData({ abi, data });
          sent.push({ what: functionName, to: a });
          if (functionName === 'setGuardian') st[a].guardian = getAddress(args[0]);
        }
        block++;
        txs.set(h, { block, contractAddress });
        return h;
      }
      case 'eth_getTransactionReceipt': {
        const t = txs.get(params[0]);
        if (!t) return null;
        return { transactionHash: params[0], blockNumber: hex(t.block), blockHash: `0x${'b'.repeat(64)}`, transactionIndex: '0x0', status: '0x1', gasUsed: '0x12d687', cumulativeGasUsed: '0x12d687', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: t.contractAddress, from: FROM, to: null };
      }
      case 'eth_getTransactionByHash': return null;
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const one = (m) => { try { return { jsonrpc: '2.0', id: m.id, result: handle(m.method, m.params ?? []) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } }; } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, calls, sent, st })));
}

function runTool(args, { tool = path.join(KEEPER_DIR, 'deploy-mark-vault.mjs') } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tool, ...args], { env: { PATH: process.env.PATH } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code, sig) => resolve({ code, sig, out }));
  });
}
const readLog = (dir = DRY) => { const f = path.join(dir, 'mark-vaults.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const live = (url) => ['--live', '--confirm', 'EXECUTE', '--rpc', url, '--from', FROM];

/** A copy of keeper/ (the .mjs files, the registry, an artifacts dir) with `mutate(artifact)` applied — the tool resolves everything from its own directory. */
function keeperCopy(mutate, mutateTool = null) {
  // realpath: macOS os.tmpdir() is a symlink (/var → /private/var) and the tool runs main() only when argv[1] resolves to its own import.meta.url
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mark-vault-keeper-'));
  const k = path.join(root, 'keeper');
  fs.mkdirSync(path.join(k, 'artifacts'), { recursive: true });
  for (const f of fs.readdirSync(KEEPER_DIR)) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(KEEPER_DIR, f), path.join(k, f));
  const toolSrc = fs.readFileSync(path.join(KEEPER_DIR, 'deploy-mark-vault.mjs'), 'utf8');
  const mutated = mutateTool ? mutateTool(toolSrc) : toolSrc;
  if (mutateTool && mutated === toolSrc) throw new Error('mutateTool changed nothing');
  fs.writeFileSync(path.join(k, 'deploy-mark-vault.mjs'), mutated);
  fs.copyFileSync(path.join(KEEPER_DIR, 'leverage-vaults.json'), path.join(k, 'leverage-vaults.json'));
  const a = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'artifacts', 'QuadrixIndexVault.json'), 'utf8'));
  mutate(a);
  fs.writeFileSync(path.join(k, 'artifacts', 'QuadrixIndexVault.json'), JSON.stringify(a));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  return { root, tool: path.join(k, 'deploy-mark-vault.mjs'), dry: path.join(k, 'dryrun') };
}

// ---------------------------------------------------------------- H4: the artifact file

test('H4 blocked: an artifact of an older build (no setGuardian in the ABI, other code, honest metadata) — the tool no longer demands a guardian, but the reference check refuses it before anything is sent', async () => {
  const { tool } = keeperCopy((a) => {
    a.abi = a.abi.filter((f) => !['setGuardian', 'guardian', 'disableKeeper', 'pendingOwner', 'acceptOwnership'].includes(f.name));
    // one byte of the executable changed
    const b = a.deployedBytecode.slice(2).split('');
    b[1000] = b[1000] === 'a' ? 'b' : 'a';
    a.deployedBytecode = `0x${b.join('')}`;
  });
  const s = await server();
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, ...live(s.url)], { tool });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /is not the contract of the reference vault/);
    assert.doesNotMatch(r.out, /--guardian <address> is required/, 'with the old ABI the guardian is no longer required (HAS_GUARDIAN false) — the reference check is what stops it');
    assert.equal(s.sent.length, 0);
  } finally {
    s.srv.close();
  }
});

test('H4 BREAK (reproduced, rebutted): a crafted artifact — any runtime up to 3,067 bytes, immutableReferences {} and metadataBytes 6135 — makes codeShape() empty on both sides; the reference check passes and a dry run says "would deploy"', async () => {
  const runtime = `0x${'60'.repeat(100)}`;
  const { tool } = keeperCopy((a) => {
    a.deployedBytecode = runtime;
    a.bytecode = runtime;
    a.immutableReferences = {};
    a.metadataBytes = 6135;
  });
  const s = await server({ simRuntime: runtime });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url], { tool });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /artifact = the code of the reference vault/);
    assert.match(r.out, /dry run: would deploy/);
    assert.equal(s.sent.length, 0);
  } finally {
    s.srv.close();
  }
  // the check that would stop it, taken from the artifact test (which no CI job runs): the metadata length the chain's code itself states
  const chainCode = ARTIFACT.deployedBytecode.replace(/^0x/, '');
  assert.equal(parseInt(chainCode.slice(-4), 16) + 2, 53);
  assert.notEqual(parseInt(chainCode.slice(-4), 16) + 2, 6135);
});

// ---------------------------------------------------------------- H8: the RPC's answers after the send

test('H8 blocked (30 s): a receipt whose contractAddress is not where the code is — the read-back finds no code there, exit 1 after the bound, the registry is not written; the person who then writes that address by hand is stopped by set-guardian (REFUSED at the code check, the first read of the registry line)', async () => {
  reset();
  const s = await server({ receiptAddress: OTHER });
  try {
    let r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`deployed at ${OTHER} \\(tx 0x[0-9a-f]{64}, logged\\) but the read-back disagrees: .*no answer after \\d+ read\\(s\\) over 3\\d s`));
    assert.ok(!fs.existsSync(OUT[1]), 'registry not written');
    const log = readLog();
    assert.deepEqual(log.map((l) => `${l.what}:${l.status}`), ['deploy:signed', 'deploy:sent', 'deploy:mined']);
    assert.equal(log[2].contractAddress, OTHER, 'the log carries the address the receipt named');
    assert.deepEqual(s.sent.map((t) => t.what), ['deploy']);
    // the hand-written follow-up with the receipt's address
    const v = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'leverage-vaults.json'), 'utf8'));
    v.qeth15 = { ...v.qeth15, address: OTHER };
    fs.writeFileSync(OUT[1], JSON.stringify(v, null, 2) + '\n');
    r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 2, r.out); // the registry line is checked before any other read: no code there, REFUSED, nothing sent
    assert.match(r.out, new RegExp(`REFUSED: ${OTHER} \\(qeth15 in the registry\\) does not run the artifact's code`));
    assert.deepEqual(s.sent.map((t) => t.what), ['deploy']);
  } finally {
    s.srv.close();
  }
});

test('H8 blocked (30 s): a read-back whose values differ (navPerShare 2e6, depositCap 1) — reported after the bound, exit 1, no setGuardian sent, registry not written', async () => {
  reset();
  const s = await server({ state: { navPerShare: 2_000_000n, depositCap: 1n } });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /read-back disagrees: .*navPerShare 2000000; depositCap 1/);
    assert.deepEqual(s.sent.map((t) => t.what), ['deploy']);
    assert.ok(!fs.existsSync(OUT[1]));
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- voidness: the checks the blocks rest on are live

test('voidness: with the confirm-word line removed from a copy of the tool, --live alone SENDS — so the H3 block above is the line, not an accident', async () => {
  reset();
  const { tool, dry } = keeperCopy(() => {}, (src) => src.replace("if (o.live && o.confirm !== 'EXECUTE') throw new Refused(", "if (false) throw new Refused("));
  const s = await server();
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--live', '--rpc', s.url, '--from', FROM], { tool });
    assert.equal(r.code, 0, r.out);
    assert.equal(s.sent.length, 2, 'the mutant sends without the word');
    assert.equal(readLog(dry).length, 6, 'signed, sent, mined for each of the two');
  } finally {
    s.srv.close();
  }
});

test('voidness: with the code-shape comparison removed from a copy of the tool, the old-build artifact of H4 passes the reference check (and is then stopped by the simulation) — so the H4 block is that comparison', async () => {
  const { tool } = keeperCopy((a) => {
    const b = a.deployedBytecode.slice(2).split('');
    b[1000] = b[1000] === 'a' ? 'b' : 'a';
    a.deployedBytecode = `0x${b.join('')}`;
  }, (src) => src.replace('if (codeShape(code) !== codeShape(ARTIFACT.deployedBytecode)) throw new Refused(', 'if (false) throw new Refused('));
  const s = await server();
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url], { tool });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /the simulated deployment returns runtime code that is not the artifact/);
    assert.doesNotMatch(r.out, /is not the contract of the reference vault/);
  } finally {
    s.srv.close();
  }
});
