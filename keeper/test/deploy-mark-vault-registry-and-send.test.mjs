/**
 * keeper/deploy-mark-vault.mjs attacked through its inputs and through the RPC it talks to, against a
 * local JSON-RPC server that plays an anvil fork (no network, no key: the fork path, --from, signs with
 * eth_signTransaction as a keyed anvil account would, then logs "signed" and broadcasts, in the order
 * of the KEEPER_PK path; an impersonated account falls back to eth_sendTransaction). Each test states what
 * the code does; the H1 and H13 tests were first written against origin/main 05678825, where they
 * showed a registry line naming another vault taking owner writes and a lost broadcast answer leading
 * to a second deployment, and now assert that neither happens.
 *
 *   node --test keeper/test/deploy-mark-vault-registry-and-send.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, parseAbi, parseTransaction, serializeTransaction } from 'viem';
import { ARTIFACT, expectedRuntime, MOCK_USD, NAMES, REFERENCE_INDEX } from '../deploy-mark-vault.mjs';
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
 * The fake node of deploy-mark-vault.test.mjs, extended for the attacks:
 *   dropSends     — the first n eth_sendRawTransaction requests are ACCEPTED (recorded, state changed) and the
 *                   HTTP response is then dropped (socket destroyed), as a load balancer or a timeout does;
 *                   undrop() makes the node answer again;
 *   receiptAddress — the contractAddress the deploy receipt names (the code still lives at NEW);
 *   refState      — owner/cap/paused of the reference vault (REF), so owner actions can hit it;
 *   simRuntime    — what eth_call of creation code returns (default: the artifact's runtime with MockUSD);
 *   noSigner      — the account is impersonated: eth_signTransaction fails as anvil's does ("No Signer
 *                   available", -32602) and eth_sendTransaction is accepted.
 */
function server({ receipts = true, lagReads = 0, ref = {}, refState = {}, revertSetGuardian = false, tlRoles = [], vault = {}, index = 'qbtc2x', dropSends = 0, receiptAddress = null, simRuntime = null, noSigner = false } = {}) {
  const calls = [];
  const sent = []; // every transaction the node ACCEPTED: { what, to }
  const txs = new Map();
  let block = 100;
  let lag = lagReads;
  let drops = dropSends;
  let deployed = vault.deployed ?? false;
  const want = simRuntime ?? expectedRuntime(MOCK_USD);
  const [name, symbol] = NAMES[index];
  const st = {
    [NEW]: { owner: FROM, keeper: FROM, guardian: zeroAddress, pendingOwner: zeroAddress, navPerShare: 1_000_000n, depositCap: 0n, depositsPaused: false, usd: getAddress(MOCK_USD), name, symbol, decimals: 6, ...vault.state },
    [REF]: { symbol: ref.symbol ?? 'qBTC2X', guardian: ref.guardian ?? REF_GUARD, owner: FROM, keeper: FROM, depositCap: 7n, depositsPaused: false, ...refState },
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
        if (!st[a]) return '0x'; // no contract there
        const { functionName } = decodeFunctionData({ abi: ARTIFACT.abi, data });
        if (['setGuardian', 'setDepositCap', 'setDepositsPaused'].includes(functionName)) return '0x';
        return encodeFunctionResult({ abi: ARTIFACT.abi, functionName, result: st[a][functionName] });
      }
      case 'eth_sendTransaction': { // only for an impersonated account (noSigner); otherwise the tool must not use it
        if (!noSigner) throw new Error('unexpected eth_sendTransaction');
        const [t] = params;
        const fee = { maxFeePerGas: BigInt(t.maxFeePerGas ?? 2), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas ?? 1) };
        return handle('eth_sendRawTransaction', [serializeTransaction({ chainId: 91342, nonce: t.nonce != null ? Number(t.nonce) : sent.length, to: t.to ?? undefined, data: t.data, gas: BigInt(t.gas), value: 0n, ...fee })]);
      }
      case 'eth_signTransaction': { // what anvil does for an unlocked account; unsigned here (the hash is keccak of these bytes either way)
        if (noSigner) throw Object.assign(new Error('No Signer available'), { code: -32602 });
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
        if (!to) { contractAddress = receiptAddress ?? NEW; sent.push({ what: 'deploy', to: null }); } else {
          const a = getAddress(to);
          const { functionName, args } = decodeFunctionData({ abi: ARTIFACT.abi, data });
          sent.push({ what: functionName, to: a });
          if (functionName === 'setGuardian') { if (revertSetGuardian) ok = false; else st[a].guardian = getAddress(args[0]); }
          if (functionName === 'setDepositCap') st[a].depositCap = args[0];
          if (functionName === 'setDepositsPaused') st[a].depositsPaused = args[0];
        }
        if (!to && ok) deployed = true;
        block++;
        txs.set(h, { block, ok, contractAddress });
        if (drops > 0) { drops--; throw Object.assign(new Error('DROP'), { drop: true }); }
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
      let dropped = false;
      const one = (m) => {
        try { return { jsonrpc: '2.0', id: m.id, result: handle(m.method, m.params ?? []) }; } catch (e) {
          if (e.drop) { dropped = true; return null; }
          return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } };
        }
      };
      const out = Array.isArray(msg) ? msg.map(one) : one(msg);
      if (dropped) { req.socket.destroy(); return; } // the node took the transaction; the answer never arrives
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, calls, sent, st, txs, undrop: () => { drops = 0; } })));
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
const readLog = () => (fs.existsSync(OUT[0]) ? fs.readFileSync(OUT[0], 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const live = (url) => ['--live', '--confirm', 'EXECUTE', '--rpc', url, '--from', FROM];
/** The fork's registry copy with `index` pointing at `address` (what a person writes by hand after a partial run). */
function registryWith(index, address) {
  const v = JSON.parse(JSON.stringify(SEED));
  for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object' && 'address' in v[k]) v[k] = { ...v[k], address: null, deployTx: null, block: null };
  v[index] = { ...v[index], address };
  fs.mkdirSync(DRY, { recursive: true });
  fs.writeFileSync(OUT[1], JSON.stringify(v, null, 2) + '\n');
}

// ---------------------------------------------------------------- H1: the registry names another series' vault

test('H1: with qeth15 pointing at the qBTC2X vault, every owner action is refused before anything is sent — set-guardian, open-deposits (dry and live), pause; the qBTC2X vault is untouched and nothing is logged', async () => {
  reset();
  registryWith('qeth15', REF);
  const s = await server({ index: 'qeth15', vault: { deployed: true } });
  try {
    const runs = [
      ['--action', 'set-guardian', '--guardian', GUARD, ...live(s.url)],
      ['--action', 'open-deposits', '--cap', '5', '--rpc', s.url],
      ['--action', 'open-deposits', '--cap', '5', ...live(s.url)],
      ['--action', 'pause', '--rpc', s.url],
      ['--action', 'pause', ...live(s.url)],
    ];
    for (const extra of runs) {
      const r = await runTool(['--index', 'qeth15', ...extra]);
      assert.equal(r.code, 2, `${extra.join(' ')}: ${r.out}`);
      assert.match(r.out, /REFUSED: .* is "qBTC2X", not qETH1\.5X — the registry's qeth15 line names another vault/);
    }
    assert.deepEqual(s.sent, []);
    assert.ok(!s.calls.includes('eth_signTransaction'), 'nothing signed');
    assert.equal(s.st[REF].depositCap, 7n);
    assert.equal(s.st[REF].depositsPaused, false);
    assert.deepEqual(readLog(), [], 'nothing logged');
  } finally {
    s.srv.close();
  }
});

test('H1: the registry line is checked before every owner action — a vault with the right code and symbol but another keeper is refused on a live run; the right line sends exactly the one write', async () => {
  reset();
  registryWith('qeth15', NEW);
  const OTHER = getAddress('0x000000000000000000000000000000000000d00d');
  let s = await server({ index: 'qeth15', vault: { deployed: true, state: { keeper: OTHER } } });
  try {
    for (const extra of [['--action', 'open-deposits', '--cap', '5'], ['--action', 'pause'], ['--action', 'set-guardian', '--guardian', GUARD]]) {
      const r = await runTool(['--index', 'qeth15', ...extra, ...live(s.url)]);
      assert.equal(r.code, 2, `${extra.join(' ')}: ${r.out}`);
      assert.match(r.out, new RegExp(`REFUSED: the signer ${FROM} is not the keeper ${OTHER} of ${NEW}`));
    }
    assert.deepEqual(s.sent, []);
  } finally {
    s.srv.close();
  }
  s = await server({ index: 'qeth15', vault: { deployed: true } });
  try {
    const r = await runTool(['--index', 'qeth15', '--action', 'open-deposits', '--cap', '5', ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /setDepositCap sent tx=0x[0-9a-f]{64} block \d+; read back ok/);
    assert.deepEqual(s.sent, [{ what: 'setDepositCap', to: NEW }]);
    assert.equal(s.st[NEW].depositCap, 5n);
    assert.deepEqual(readLog().map((l) => `${l.index}:${l.what}:${l.status}`), ['qeth15:setDepositCap:signed', 'qeth15:setDepositCap:sent', 'qeth15:setDepositCap:mined']);
  } finally {
    s.srv.close();
  }
});

test('H1 control: a registry address with no code behind it is refused on open-deposits by the code check (exit 2, nothing sent)', async () => {
  reset();
  registryWith('qeth15', TL.replace(/71e1$/, '0bad'));
  const s = await server({ index: 'qeth15' });
  try {
    const r = await runTool(['--index', 'qeth15', '--action', 'open-deposits', '--cap', '5', ...live(s.url)]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /REFUSED: .* \(qeth15 in the registry\) does not run the artifact's code/);
    assert.equal(s.sent.length, 0);
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- H13: the window between broadcast and the "sent" line

test('H13 (one lost response): the hash and nonce are on disk before the broadcast — the node holds ONE deployment, the run exits 1 with a "signed" line naming it; the next run finds it mined and goes on from its receipt (dry run first), deploying nothing again', async () => {
  reset();
  const s = await server({ index: 'qeth15', dropSends: 1 });
  try {
    let r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /HTTP request failed/);
    assert.equal(s.sent.filter((t) => t.what === 'deploy').length, 1, 'the node accepted exactly one deployment (no transport retry of a send)');
    const first = readLog();
    assert.deepEqual(first.map((l) => `${l.what}:${l.status}`), ['deploy:signed']);
    assert.equal(first[0].nonce, 0);
    assert.ok(s.txs.has(first[0].tx), 'the logged hash is the one the node took');
    assert.ok(!fs.existsSync(OUT[1]));
    // the next run, on the same node, now answering
    r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`deploy tx ${first[0].tx} \\(signed, no outcome in the log\\) is mined at block \\d+ — a live run records it`));
    assert.match(r.out, /dry run: would go on from the mined deployment — nothing sent/);
    assert.equal(readLog().length, 1, 'a dry run writes nothing');
    r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`deployed qETH1\\.5X at ${NEW} tx=${first[0].tx}`));
    assert.deepEqual(s.sent.map((t) => t.what), ['deploy', 'setGuardian'], 'one deployment in all');
    assert.deepEqual(readLog().map((l) => `${l.what}:${l.status}${l.recovered ? ' (recovered)' : ''}`), ['deploy:signed', 'deploy:sent (recovered)', 'deploy:mined (recovered)', 'setGuardian:signed', 'setGuardian:sent', 'setGuardian:mined']);
    assert.equal(JSON.parse(fs.readFileSync(OUT[1], 'utf8')).qeth15.address, NEW);
  } finally {
    s.srv.close();
  }
});

test('H13 (every response lost): the "signed" line blocks the next run — on a node with no receipt for it and the nonce unused, dry and live runs are refused and nothing is signed; once the node shows it mined, the run goes on from its receipt', async () => {
  reset();
  const s = await server({ index: 'qeth15', dropSends: Infinity }); // kept open to the end: the node that took it
  try {
    const r0 = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r0.code, 1, r0.out);
    assert.equal(s.sent.filter((t) => t.what === 'deploy').length, 1, 'the node took one deployment');
    assert.deepEqual(readLog().map((l) => `${l.what}:${l.status}`), ['deploy:signed']);
    assert.ok(!fs.existsSync(OUT[1]));
    const tx = readLog()[0].tx;
    // a node that never saw it: no receipt, the nonce not used — refused, a person looks
    const s2 = await server({ index: 'qeth15' });
    try {
      for (const mode of [['--rpc', s2.url], live(s2.url)]) {
        const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...mode]);
        assert.equal(r.code, 2, r.out);
        assert.match(r.out, new RegExp(`REFUSED: deploy of qeth15 on chain 91342 was signed \\(tx ${tx}\\), the log has no outcome for it, and the chain has no receipt for it; nonce 0 of ${FROM} is not used yet`));
      }
      assert.ok(!s2.calls.includes('eth_signTransaction'), 'nothing signed');
      assert.deepEqual(s2.sent, []);
      assert.equal(readLog().length, 1);
    } finally {
      s2.srv.close();
    }
    // a node whose count shows the nonce used but no receipt (a node behind): still refused
    const s3 = await server({ index: 'qeth15' });
    s3.sent.push({ what: 'other', to: null });
    try {
      const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s3.url)]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /nonce 0 of .* is used \(its count is 1\) — by another transaction, or by this one on a node that does not show the receipt yet/);
      assert.ok(!s3.calls.includes('eth_signTransaction'));
    } finally {
      s3.srv.close();
    }
    // the node that took it, answering again: the run goes on from the receipt
    s.undrop();
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`deployed qETH1\\.5X at ${NEW} tx=${tx}`));
    assert.deepEqual(s.sent.map((t) => t.what), ['deploy', 'setGuardian'], 'one deployment in all');
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- an impersonated account on a local fork

test('fork, impersonated account: eth_signTransaction answers "No Signer available", the transaction goes by eth_sendTransaction and is logged "sent" with its hash; deploy and setGuardian complete', async () => {
  reset();
  const s = await server({ index: 'qeth15', noSigner: true });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(s.sent.map((t) => t.what), ['deploy', 'setGuardian']);
    assert.ok(s.calls.includes('eth_signTransaction') && s.calls.includes('eth_sendTransaction'));
    const log = readLog();
    assert.deepEqual(log.map((l) => `${l.what}:${l.status}`), ['deploy:sent', 'deploy:mined', 'setGuardian:sent', 'setGuardian:mined']);
    assert.ok(log.filter((l) => l.status === 'sent').every((l) => l.impersonated === true && /^0x[0-9a-f]{64}$/.test(l.tx)));
    assert.equal(JSON.parse(fs.readFileSync(OUT[1], 'utf8')).qeth15.address, NEW);
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- H3: the live switch

test('H3 blocked: every loose form of --live / --confirm sends nothing — lower case, trailing space, "=" forms, a missing word', async () => {
  reset();
  const s = await server({ index: 'qeth15' });
  try {
    const cases = [
      [['--live', '--confirm', 'execute'], 2],
      [['--live', '--confirm', 'EXECUTE '], 2],
      [['--live', '--confirm', ' EXECUTE'], 2],
      [['--live', '--confirm=EXECUTE'], 2],
      [['--live', '--confirm'], 2],
      [['--live=true', '--confirm', 'EXECUTE'], 0], // not a flag the tool knows: a dry run
      [['--confirm', 'EXECUTE'], 0], // no --live: a dry run
      [['--LIVE', '--confirm', 'EXECUTE'], 0],
    ];
    for (const [extra, code] of cases) {
      const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--rpc', s.url, '--from', FROM, ...extra]);
      assert.equal(r.code, code, `${extra.join(' ')}: ${r.out}`);
      if (code === 2) assert.match(r.out, /REFUSED: --live needs --confirm EXECUTE|REFUSED: a live run on a local RPC needs --from/);
      else assert.match(r.out, /DRY RUN — nothing is sent/);
    }
    assert.equal(s.sent.length, 0, 'nothing sent in any form');
    assert.ok(!s.calls.includes('eth_signTransaction'));
    // voidness: the exact form does send
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    assert.equal(s.sent.length, 2);
  } finally {
    s.srv.close();
  }
});

test('H3b (reproduced, rebutted): isLocalRpc is a prefix test — "http://127.0.0.1:9@<host>" counts as local, and viem turns the userinfo into Basic auth and talks to <host>: a live fork run (--from, no key) is sent to the host after the @; a look-alike host is not local', async () => {
  reset();
  const s = await server({ index: 'qeth15' });
  try {
    const host = s.url.replace(/^http:\/\//, '');
    let r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--live', '--confirm', 'EXECUTE', '--rpc', `http://127.0.0.1:9@${host}`, '--from', FROM]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /LIVE from .*; deploy qeth15; rpc http:\/\/127\.0\.0\.1:9@/);
    assert.equal(s.sent.length, 2, 'deploy + setGuardian reached the host after the @, which nothing in the tool checked');
    assert.match(readLog()[0].rpc, /^http:\/\/127\.0\.0\.1:9@/, 'the log records the URL as a fork');
    reset();
    r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, '--live', '--confirm', 'EXECUTE', '--rpc', 'http://127.0.0.1.example.test:9', '--from', FROM]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--from is for an unlocked account on a local fork/);
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- H5: --cap forms

test('H5: --cap refuses every non-integer form; an integer passes with no bound and no human-unit echo (1000000 = 1 mUSD passes as written); a value past uint256 fails before any send', async () => {
  reset();
  registryWith('qeth15', NEW);
  const s = await server({ index: 'qeth15', vault: { deployed: true } });
  try {
    for (const cap of ['1e12', '-1', '1.5', '0x10', '1_000', '１２', ' 12', '12 ', '']) {
      const r = await runTool(['--index', 'qeth15', '--action', 'open-deposits', '--cap', cap, ...live(s.url)]);
      assert.equal(r.code, 2, `${JSON.stringify(cap)}: ${r.out}`);
      assert.match(r.out, /--cap <integer, 6-decimal mUSD units> is required/);
    }
    for (const cap of ['1000000', '0', '00012', '1000000000000']) {
      const r = await runTool(['--index', 'qeth15', '--action', 'open-deposits', '--cap', cap, '--rpc', s.url]);
      assert.equal(r.code, 0, `${cap}: ${r.out}`);
      assert.match(r.out, new RegExp(`setDepositCap\\(${BigInt(cap)}\\) on ${NEW} \\(owner ${FROM}\\) — simulated ok`));
      assert.doesNotMatch(r.out, /mUSD/, 'the log never says what the number means');
    }
    const big = await runTool(['--index', 'qeth15', '--action', 'open-deposits', '--cap', '1'.padEnd(80, '0'), ...live(s.url)]);
    assert.equal(big.code, 1, big.out);
    assert.equal(s.sent.length, 0, 'nothing sent in any case');
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- H2: guardian input forms

test('H2 blocked: the guardian rule holds for every spelling — leading space, no 0x, bad checksum, 41 bytes, manager in any case; a contract address (MockUSD, the reference vault, the timelock itself) is accepted by the rule as written', async () => {
  reset();
  const s = await server({ index: 'qeth15', tlRoles: [] });
  try {
    const refused = [
      [' ' + GUARD, /--guardian <address> is required/],
      [GUARD.slice(2), /--guardian <address> is required/],
      [GUARD.slice(0, -1) + (GUARD.endsWith('8') ? '9' : '8'), /--guardian <address> is required|guardian/], // checksum broken
      [GUARD + 'ff', /--guardian <address> is required/],
      [FROM.toUpperCase().replace('0X', '0x'), /--guardian <address> is required|guardian == keeper/],
      [FROM.toLowerCase(), /guardian == keeper/],
      [zeroAddress, /guardian unset \(0\)/],
    ];
    for (const [g, re] of refused) {
      const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', g, ...live(s.url)]);
      assert.equal(r.code, 2, `${JSON.stringify(g)}: ${r.out}`);
      assert.match(r.out, re);
    }
    for (const g of [getAddress(MOCK_USD), REF, TL]) {
      const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', g, '--timelock', TL, '--rpc', s.url]);
      assert.equal(r.code, 0, `${g}: ${r.out}`);
      assert.match(r.out, /guardian check passed/);
    }
    assert.equal(s.sent.length, 0);
  } finally {
    s.srv.close();
  }
});

// ---------------------------------------------------------------- H7: the registry write

test('H7 blocked: a qeth15 deployment rewrites the registry with every other entry and _doc unchanged (fork: addresses emptied), keys in order', async () => {
  reset();
  const s = await server({ index: 'qeth15' });
  try {
    const r = await runTool(['--index', 'qeth15', '--manager', FROM, '--guardian', GUARD, ...live(s.url)]);
    assert.equal(r.code, 0, r.out);
    const v = JSON.parse(fs.readFileSync(OUT[1], 'utf8'));
    assert.deepEqual(Object.keys(v), Object.keys(SEED));
    assert.equal(v._doc, SEED._doc);
    for (const k of ['qbtc2x', 'qeth2x']) assert.deepEqual(v[k], { ...SEED[k], address: null, deployTx: null, block: null });
    assert.deepEqual({ ...v.qeth15, deployTx: null, block: null }, { ...SEED.qeth15, address: NEW });
    assert.match(v.qeth15.deployTx, /^0x[0-9a-f]{64}$/);
    assert.equal(typeof v.qeth15.block, 'number');
  } finally {
    s.srv.close();
  }
});
