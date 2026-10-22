/**
 * keeper/deploy-mark-vault.mjs against a local JSON-RPC server that plays an
 * anvil node (no network, no key):
 *   - the transaction hash and nonce are in keeper/dryrun/mark-vaults.jsonl
 *     as soon as it is signed — before the broadcast and the receipt (here: a
 *     receipt that never comes);
 *   - a read-back answered by a node behind the receipt's block (header not
 *     found, then no code) is repeated until it agrees; the guardian is then
 *     set and read back, and only then is the address written to
 *     keeper/dryrun/leverage-vaults.json with the gate unchanged;
 *   - a second deployment for an index that already names a vault is refused;
 *   - qETH1.5X: its name and symbol (the rulebook's ticker);
 *   - the guardian rule (not 0, not the keeper, not the owner, no timelock
 *     role), before anything is sent and on the chain after setGuardian;
 *   - the reference vault: the registry's qBTC2X line as committed (also on a
 *     fork, whose registry empties every address), with symbol() "qBTC2X"
 *     and a guardian other than 0;
 *   - a deployment whose setGuardian did not complete is not written to the
 *     registry; once a person writes it, --action set-guardian finishes it;
 *   - the artifact is the build whose fingerprint it states.
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
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, parseAbi, parseTransaction, serializeTransaction } from 'viem';
import { ARTIFACT, expectedRuntime, MOCK_USD, NAMES, REFERENCE_INDEX, guardianProblems, referenceVault } from '../deploy-mark-vault.mjs';
import { KEEPER_DIR } from './leverage-helpers.mjs';

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
const TL = getAddress('0x00000000000000000000000000000000000071e1');
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const TL_ABI = parseAbi(['function hasRole(bytes32,address) view returns (bool)', 'function PROPOSER_ROLE() view returns (bytes32)', 'function CANCELLER_ROLE() view returns (bytes32)', 'function DEFAULT_ADMIN_ROLE() view returns (bytes32)']);
const ROLE = { PROPOSER_ROLE: keccak256(toHex('PROPOSER_ROLE')), CANCELLER_ROLE: keccak256(toHex('CANCELLER_ROLE')), DEFAULT_ADMIN_ROLE: `0x${'0'.repeat(64)}` };

/**
 * A JSON-RPC server. `lagReads` reads of the new vault's code after the receipt fail; `receipts` false = never mined;
 * `ref` overrides the reference vault (code, symbol, guardian); `revertSetGuardian` mines setGuardian as reverted;
 * `tlRoles` = the roles (names) the guardian holds on the timelock TL; `vault` presets the new vault's state.
 */
function server({ receipts = true, lagReads = 0, ref = {}, revertSetGuardian = false, tlRoles = [], vault = {}, index = 'qbtc2x' } = {}) {
  const calls = [];
  const sent = [];
  const txs = new Map();
  let block = 100;
  let lag = lagReads;
  let deployed = vault.deployed ?? false;
  const want = expectedRuntime(MOCK_USD);
  const [name, symbol] = NAMES[index];
  const st = {
    [NEW]: { owner: FROM, keeper: FROM, guardian: zeroAddress, pendingOwner: zeroAddress, navPerShare: 1_000_000n, depositCap: 0n, depositsPaused: false, usd: getAddress(MOCK_USD), name, symbol, decimals: 6, ...vault.state },
    [REF]: { symbol: ref.symbol ?? 'qBTC2X', guardian: ref.guardian ?? REF_GUARD },
  };
  const refCode = ref.code ?? ARTIFACT.deployedBytecode.replace(/a2646970667358221220[0-9a-f]{64}/, `a2646970667358221220${'1'.repeat(64)}`);
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
        if (a === TL) return '0x6001';
        if (a === NEW && deployed) {
          if (lag > 0) { lag--; throw Object.assign(new Error('header not found'), { code: -32000 }); }
          return want;
        }
        return '0x';
      }
      case 'eth_call': {
        const [{ to, data }] = params;
        if (!to) return want; // the simulated deployment
        const a = getAddress(to);
        if (a === TL) {
          const { functionName, args } = decodeFunctionData({ abi: TL_ABI, data });
          if (functionName === 'hasRole') return encodeFunctionResult({ abi: TL_ABI, functionName, result: getAddress(args[1]) === GUARD && tlRoles.some((r) => ROLE[r] === args[0]) });
          return encodeFunctionResult({ abi: TL_ABI, functionName, result: ROLE[functionName] });
        }
        const { functionName } = decodeFunctionData({ abi: ARTIFACT.abi, data });
        if (functionName === 'setGuardian') return '0x';
        return encodeFunctionResult({ abi: ARTIFACT.abi, functionName, result: st[a][functionName] });
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
        let ok = true;
        let contractAddress = null;
        if (!to) { contractAddress = NEW; sent.push('deploy'); } else {
          const { functionName, args } = decodeFunctionData({ abi: ARTIFACT.abi, data });
          sent.push(functionName);
          if (functionName === 'setGuardian') { if (revertSetGuardian) ok = false; else st[NEW].guardian = getAddress(args[0]); }
        }
        if (!to && ok) deployed = true;
        block++;
        txs.set(h, { block, ok, contractAddress });
        return h;
      }
      case 'eth_getTransactionReceipt': {
        const t = txs.get(params[0]);
        if (!receipts || !t) return null;
        return { transactionHash: params[0], blockNumber: hex(t.block), blockHash: `0x${'b'.repeat(64)}`, transactionIndex: '0x0', status: t.ok ? '0x1' : '0x0', gasUsed: '0x12d687', cumulativeGasUsed: '0x12d687', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: t.contractAddress, from: FROM, to: null };
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
      const one = (m) => {
        try { return { jsonrpc: '2.0', id: m.id, result: handle(m.method, m.params ?? []) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } }; }
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, calls, sent, st })));
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
const readLog = () => fs.readFileSync(OUT[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const live = (url) => ['--live', '--confirm', 'EXECUTE', '--rpc', url, '--from', FROM];

test('the transaction is logged as soon as it is signed, before the broadcast — a receipt that never comes still leaves the hash and nonce on disk', async () => {
  reset();
  const { srv, url } = await server({ receipts: false });
  try {
    const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, ...live(url)], { killAfterMs: 4000 });
    assert.equal(r.sig, 'SIGKILL', r.out);
    const log = readLog();
    assert.deepEqual(log.map((l) => l.status), ['signed', 'sent'], 'signed (hash, nonce) before the broadcast, sent after it');
    assert.match(log[0].tx, /^0x[0-9a-f]{64}$/);
    assert.equal(log[0].nonce, 0);
    assert.equal(log[1].tx, log[0].tx);
    assert.ok(!fs.existsSync(OUT[1]), 'no address written without a receipt and a read-back');
  } finally {
    srv.close();
  }
});

test('a read-back behind the receipt block is repeated until it agrees; the guardian is set and read back; the address is written with the gate unchanged; a second deployment is refused', async () => {
  reset();
  const { srv, url, calls, sent, st } = await server({ lagReads: 2 });
  try {
    let r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, ...live(url)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /read back ok \(at read 3\)/);
    assert.match(r.out, new RegExp(`guardian ${GUARD} set \\(tx 0x[0-9a-f]{64}\\) and read back`));
    assert.deepEqual(sent, ['deploy', 'setGuardian']);
    assert.equal(st[NEW].guardian, GUARD);
    const log = readLog();
    assert.deepEqual(log.map((l) => `${l.what}:${l.status}`), ['deploy:signed', 'deploy:sent', 'deploy:mined', 'setGuardian:signed', 'setGuardian:sent', 'setGuardian:mined']);
    assert.ok(calls.indexOf('eth_sendRawTransaction') < calls.indexOf('eth_getTransactionReceipt'));
    const v = JSON.parse(fs.readFileSync(OUT[1], 'utf8'));
    assert.equal(v.qbtc2x.address, NEW);
    // unchanged: the gate the shipped registry holds
    assert.deepEqual(v.qbtc2x.gate, SEED.qbtc2x.gate);
    r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, ...live(url)]);
    assert.equal(r.code, 2);
    assert.match(r.out, /already names a vault/);
  } finally {
    srv.close();
  }
});

test('review r1: a deployment that was signed but has no outcome in the log, and no receipt on the chain, blocks a second deployment until a person resolves it', async () => {
  reset();
  let s = await server({ receipts: false });
  try {
    const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, ...live(s.url)], { killAfterMs: 4000 });
    assert.equal(r.sig, 'SIGKILL', r.out);
  } finally {
    s.srv.close();
  }
  const first = readLog()[0];
  assert.equal(first.status, 'signed');
  s = await server();
  try {
    // re-running the same command (live or dry) is refused and sends nothing
    for (const extra of [['--live', '--confirm', 'EXECUTE'], []]) {
      const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, ...extra, '--rpc', s.url, '--from', FROM]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, new RegExp(`deploy of qbtc2x on chain 91342 was signed \\(tx ${first.tx}\\), the log has no outcome for it, and the chain has no receipt for it; nonce 0 of ${FROM} is not used yet`));
    }
    assert.ok(!s.calls.includes('eth_signTransaction'), 'nothing sent');
    // another index is not blocked
    let r = await runTool(['--index', 'qeth2x', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url, '--from', FROM]);
    assert.equal(r.code, 0, r.out);
    // once a person marks the first one abandoned, a deployment may go ahead
    fs.appendFileSync(OUT[0], JSON.stringify({ index: 'qbtc2x', chainId: 91342, tx: first.tx, status: 'abandoned', note: 'test' }) + '\n');
    r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url, '--from', FROM]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry run: would deploy/);
  } finally {
    s.srv.close();
  }
});

test('a live run on a local RPC never uses KEEPER_PK and a live run without the confirm word is refused', async () => {
  for (const args of [['--live', '--confirm', 'EXECUTE', '--rpc', 'http://127.0.0.1:9'], ['--live']]) {
    const r = await runTool(['--index', 'qbtc2x', '--manager', FROM, '--guardian', GUARD, ...args]);
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

test('qETH1.5X — name "Quadrix ETH 1.5x Vault", symbol = the rulebook ticker; the registry entry exists with no address; a dry run deploys it after setGuardian; open-deposits and pause accept the index', async () => {
  const rb = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'rulebooks', 'qeth15.json'), 'utf8'));
  assert.deepEqual(NAMES.qeth15, ['Quadrix ETH 1.5x Vault', rb.ticker]);
  assert.equal(rb.ticker, 'qETH1.5X');
  assert.deepEqual({ ...SEED.qeth15, gate: undefined }, { chainId: 91342, address: null, gate: undefined, deployTx: null, block: null });
  reset();
  const s = await server({ index: 'qeth15' });
  try {
    let r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /name "Quadrix ETH 1\.5x Vault", symbol qETH1\.5X, depositCap 0 \(closed\)/);
    assert.match(r.out, new RegExp(`then setGuardian\\(${GUARD}\\) — guardian check passed`));
    assert.match(r.out, new RegExp(`artifact = the code of the reference vault ${REF} \\(qBTC2X, guardian set`));
    assert.ok(!s.calls.includes('eth_signTransaction'));
    // the address-less entry: the owner actions are refused for want of a vault, not for the index
    for (const extra of [['--action', 'open-deposits', '--cap', '1000000000000'], ['--action', 'pause']]) {
      r = await runTool(['--index', 'qeth15', ...extra, '--rpc', s.url]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /qeth15 has no vault address/);
    }
    r = await runTool(['--index', 'qeth3x', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url]);
    assert.equal(r.code, 2);
    assert.match(r.out, /--index must be one of qbtc2x, qeth2x, qeth15/);
  } finally {
    s.srv.close();
  }
});

test('the guardian rule — missing, 0, = manager (keeper and owner), or a timelock role: REFUSED before anything is sent', async () => {
  reset();
  const s = await server({ tlRoles: ['CANCELLER_ROLE'] });
  try {
    const cases = [
      [[], /--guardian <address> is required for a deployment/],
      [['--guardian', zeroAddress], /guardian unset \(0\)/],
      [['--guardian', FROM], /guardian == keeper .*guardian == owner/],
      [['--guardian', FROM.toLowerCase()], /guardian == keeper/],
      [['--guardian', GUARD, '--timelock', TL], /guardian is a timelock canceller/],
    ];
    for (const [extra, re] of cases) {
      for (const mode of [[], live(s.url).slice(0, 3)]) {
        const r = await runTool(['--index', 'qeth15', '--manager', FROM, ...extra, ...mode, '--rpc', s.url, '--from', FROM]);
        assert.equal(r.code, 2, `${extra.join(' ')}: ${r.out}`);
        assert.match(r.out, re);
      }
    }
    assert.ok(!s.calls.includes('eth_signTransaction'), 'nothing sent');
  } finally {
    s.srv.close();
  }
  // a guardian with no role on the timelock passes
  const s2 = await server({ tlRoles: [] });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--timelock', TL, '--rpc', s2.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`no role on the timelock ${TL}`));
  } finally {
    s2.srv.close();
  }
  // the rule itself, with keeper and owner apart (after a handover they differ)
  const K = getAddress('0x00000000000000000000000000000000000000a1');
  const O = getAddress('0x00000000000000000000000000000000000000b2');
  assert.deepEqual(guardianProblems({ guardian: GUARD, keeper: K, owner: O }), []);
  assert.deepEqual(guardianProblems({ guardian: O, keeper: K, owner: O }), [`guardian == owner (${O})`]);
  assert.deepEqual(guardianProblems({ guardian: K, keeper: K, owner: O }), [`guardian == keeper (${K})`]);
  assert.deepEqual(guardianProblems({ guardian: GUARD, keeper: zeroAddress, owner: O }), ['keeper is 0']);
});

test('the reference vault is the registry\'s qBTC2X as committed — other code, another symbol, or guardian 0 is REFUSED', async () => {
  reset();
  const old = `0x${'60'.repeat(100)}`;
  const cases = [
    [{ code: old }, /is not the contract of the reference vault/],
    [{ code: '0x' }, /has no code on this chain/],
    [{ symbol: 'qETH2X' }, /is "qETH2X", not qBTC2X/],
    [{ guardian: zeroAddress }, /has guardian 0/],
  ];
  for (const [ref, re] of cases) {
    const s = await server({ ref, index: 'qeth15' });
    try {
      const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, re);
      assert.ok(!s.calls.includes('eth_signTransaction'), 'nothing sent');
    } finally {
      s.srv.close();
    }
  }
});

test('the reference vault on a fork: the registry copy empties every address, but the reference is still read from the committed registry; a registry with no qBTC2X address is REFUSED', async () => {
  reset();
  const s = await server({ index: 'qeth15' });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    const v = JSON.parse(fs.readFileSync(OUT[1], 'utf8'));
    assert.equal(v.qbtc2x.address, null, 'the fork copy emptied the qBTC2X address');
    assert.equal(v.qeth15.address, NEW);
    assert.match(r.out, new RegExp(`reference vault ${REF}`));
  } finally {
    s.srv.close();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-ref-'));
  const pc = { getCode: async () => { throw new Error('not reached'); } };
  for (const qbtc2x of [{ chainId: 91342, address: null }, { chainId: 1, address: REF }, undefined]) {
    const seed = path.join(dir, 'leverage-vaults.json');
    fs.writeFileSync(seed, JSON.stringify({ qbtc2x }));
    await assert.rejects(referenceVault(pc, seed, 91342), /names no qbtc2x vault on chain 91342/);
  }
});

test('a setGuardian that does not complete leaves the registry unwritten; the deployment then blocks a second one; once a person writes the address, --action set-guardian sets and reads it back', async () => {
  reset();
  let s = await server({ revertSetGuardian: true, index: 'qeth15' });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /setGuardian did not complete: setGuardian reverted/);
    assert.match(r.out, new RegExp(`then run --action set-guardian --guardian ${GUARD}`));
    assert.ok(!fs.existsSync(OUT[1]), 'registry not written');
    assert.deepEqual(readLog().map((l) => `${l.what}:${l.status}`), ['deploy:signed', 'deploy:sent', 'deploy:mined', 'setGuardian:signed', 'setGuardian:sent', 'setGuardian:reverted']);
  } finally {
    s.srv.close();
  }
  s = await server({ index: 'qeth15', vault: { deployed: true } });
  try {
    let r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /already sent/);
    // the person writes the address (fork: the dryrun copy of the registry)
    const v = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'leverage-vaults.json'), 'utf8'));
    v.qeth15 = { ...v.qeth15, address: NEW };
    fs.writeFileSync(OUT[1], JSON.stringify(v, null, 2) + '\n');
    // set-guardian checks the rule against the vault's own keeper and owner
    r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', FROM, ...live(s.url)]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /guardian == keeper/);
    r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', GUARD, '--rpc', s.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /simulated ok; guardian check passed/);
    assert.ok(!s.calls.includes('eth_signTransaction'), 'dry run sends nothing');
    r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /setGuardian sent tx=0x[0-9a-f]{64} block \d+; read back ok/);
    assert.equal(s.st[NEW].guardian, GUARD);
    r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already has guardian .* nothing to send/);
    r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', REF_GUARD, ...live(s.url)]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /replacing a guardian is its own decision/);
    assert.deepEqual(s.sent, ['setGuardian']);
  } finally {
    s.srv.close();
  }
});

test('the artifact is the build it states — immutables-zero codehash 0x4a333ad4…, metadata tail 53 bytes, 6,135 runtime bytes, setGuardian in the ABI, no local path', () => {
  const code = ARTIFACT.deployedBytecode.replace(/^0x/, '').toLowerCase();
  const b = code.split('');
  for (const r of Object.values(ARTIFACT.immutableReferences).flat()) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = '0';
  const zero = b.join('');
  assert.equal(keccak256(`0x${zero}`), '0x4a333ad4d0a7394817991d41b046ffee2b044eb8215c7715cd0bd156411bc1ab');
  assert.equal(keccak256(`0x${zero}`), ARTIFACT.build.codehashImmutablesZero);
  assert.equal(keccak256(`0x${zero.slice(0, zero.length - ARTIFACT.metadataBytes * 2)}`), ARTIFACT.build.executableHash);
  assert.equal(code.length / 2, 6135);
  assert.equal(ARTIFACT.build.runtimeBytes, 6135);
  assert.equal(ARTIFACT.metadataBytes, parseInt(code.slice(-4), 16) + 2);
  assert.equal(ARTIFACT.metadataBytes, 53);
  assert.equal(Object.values(ARTIFACT.immutableReferences).flat().length, 6);
  for (const fn of ['setGuardian', 'guardian', 'disableKeeper', 'pendingOwner', 'acceptOwnership']) assert.ok(ARTIFACT.abi.some((f) => f.name === fn), fn);
  assert.equal(ARTIFACT.source.builtAt, '9d6ade4da3d88a8611d34806f38738704d1304b2');
  const text = fs.readFileSync(path.join(KEEPER_DIR, 'artifacts', 'QuadrixIndexVault.json'), 'utf8');
  assert.doesNotMatch(text, /\/Users\/|\/home\/|\/private\/|\/tmp\/|C:\\\\/);
});

test('a live deployment from a signer other than the manager is refused (setGuardian is the owner\'s); set-guardian refuses a registry address that is another vault or other code', async () => {
  reset();
  let s = await server({ index: 'qeth15' });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', REF_GUARD, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /is not the manager .* deploy from the manager/);
    assert.ok(!s.calls.includes('eth_signTransaction'), 'nothing sent');
  } finally {
    s.srv.close();
  }
  const v = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'leverage-vaults.json'), 'utf8'));
  v.qeth15 = { ...v.qeth15, address: NEW };
  for (const [opts, re] of [[{ index: 'qbtc2x', vault: { deployed: true } }, /is "qBTC2X", not qETH1\.5X/], [{ index: 'qeth15' }, /does not run the artifact's code/]]) {
    reset();
    fs.mkdirSync(DRY, { recursive: true });
    fs.writeFileSync(OUT[1], JSON.stringify(v, null, 2) + '\n');
    s = await server(opts);
    try {
      const r = await runTool(['--index', 'qeth15', '--action', 'set-guardian', '--guardian', GUARD, ...live(s.url)]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, re);
      assert.ok(!s.calls.includes('eth_signTransaction'), 'nothing sent');
    } finally {
      s.srv.close();
    }
  }
});
