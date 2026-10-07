/**
 * Leverage stage A — rehearsal on a local anvil fork of GIWA Sepolia.
 *
 * Needs a running fork (one at a time on the machine) and Binance's public
 * REST (read-only):
 *
 *   anvil --fork-url https://sepolia-rpc.giwa.io --port 8599 --host 127.0.0.1 &
 *   node keeper/test/rehearse-leverage.mjs --rpc http://127.0.0.1:8599 --out <dir>
 *
 * Everything runs in temporary copies of this repository (the real
 * keeper/dryrun/ and trackrecord/ are never touched), with two fresh
 * addresses impersonated on the fork (no key exists or is read; KEEPER_PK
 * must not be set). THROWAWAY
 * values only, labelled: BTC n = 120 · T = 2.2, ETH n = 60 · T = 2.1, cost
 * 30 bp · 6% a year; T = 9 to force the model liquidation.
 *
 *   1  deploy both mark vaults with the real tool (--live --confirm EXECUTE --from)
 *   2  the contract refuses: setNav by a non-keeper, setNav(0), a 26% move,
 *      deposit at cap 0, deposit while paused
 *   3  qBTC2X: genesis 2020-03-10 + lines 2020-03-11/12 (run 1), line 2020-03-13
 *      (run 2, the 2020-03-12 crash: stepped marks), run 3 writes and sends nothing;
 *      verify.mjs on the fork (anchors checked) — 0 failures
 *   4  qETH2X with the halt gate (±15%): lines and anchors written, marks halted
 *   5  deposit → marks up → redeem with faucet top-ups; a shortfall over the
 *      faucet's 20 calls reverts `liquidity`
 *   6  a model liquidation (synthetic bars, a day with a deep low): the first run
 *      halts before the liquidation line (owner, 2026-10-06: it waits for a
 *      person); after an accepting entry in the copy's keeper/leverage-gaps.json,
 *      level 0 naming that entry, the vault stepped to the floor in 46 steps and
 *      paused; the next run does nothing.
 *      The bars are dated 2030 and the leg runs on a synthetic clock, so the
 *      fork's clock is first moved to that clock (anvil_setTime): its anchors
 *      are then mined after their lines' days began, as on the real chain
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, getAddress, parseAbi, parseAbiItem, encodeAbiParameters } from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const RPC = opt('--rpc', 'http://127.0.0.1:8599');
const OUT = opt('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'lev-rehearsal-')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw new Error('--rpc must be a local anvil');
if (process.env.KEEPER_PK || process.env.BIDDER_PK) throw new Error('unset KEEPER_PK and BIDDER_PK: the rehearsal signs with anvil accounts only');
fs.mkdirSync(OUT, { recursive: true });

// Fresh addresses, impersonated on the fork. NOT anvil's default accounts: on
// GIWA Sepolia those carry EIP-7702 delegations (eth_getCode 0xef0100…,
// measured 2026-10-02), so a self-send with calldata — an anchor — runs
// someone else's code and reverts.
const fresh = () => getAddress(`0x${crypto.randomBytes(20).toString('hex')}`);
const ACCT0 = fresh(); // manager / keeper / owner
const ACCT1 = fresh(); // a user
const MOCK_USD = getAddress('0xf70B2b744eE604728D661b7D07460843DBD1be76');
const chain = defineChain({ id: 91342, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });
const w0 = createWalletClient({ account: ACCT0, chain, transport: http(RPC) });
const w1 = createWalletClient({ account: ACCT1, chain, transport: http(RPC) });
const VAULT = parseAbi([
  'function setNav(uint256,uint256)', 'function navPerShare() view returns (uint256)', 'function deposit(uint256,address) returns (uint256)', 'function redeem(uint256,address) returns (uint256)',
  'function setDepositCap(uint256)', 'function setDepositsPaused(bool)', 'function depositsPaused() view returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function owner() view returns (address)',
]);
const USD = parseAbi(['function faucet()', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const NAV_UPDATED = parseAbiItem('event NavUpdated(uint256 navPerShare, uint256 indexLevel)');

const report = [];
const results = {};
let failures = 0;
const say = (m) => { console.log(m); report.push(m); };
const check = (label, cond, detail = '') => { if (!cond) failures++; say(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };

function copyRepo(tag) {
  const dst = path.join(OUT, tag);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(REPO, dst, { recursive: true, filter: (src) => !/\/(\.git|node_modules)(\/|$)/.test(src) && !/\/keeper\/(dryrun|cache)(\/|$)/.test(src) });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dst, 'node_modules'));
  fs.mkdirSync(path.join(dst, 'keeper', 'dryrun'), { recursive: true });
  return dst;
}
function node(root, args, label) {
  const r = spawnSync(process.execPath, args.map((a) => a.replace('{root}', root)), { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, `${label}.log`), `$ node ${args.join(' ')}\n${out}\nexit ${r.status}\n`);
  return { code: r.status, out };
}
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function reason(fn) {
  try { await fn(); return 'no revert'; } catch (e) { const m = `${e.shortMessage ?? ''} ${e.details ?? ''} ${e.message ?? ''}`; return (/reverted with the following reason:\s*\n?(.+)/.exec(m)?.[1] ?? /reverted: (.+)/.exec(m)?.[1] ?? m).split('\n')[0].trim(); }
}
// setNav with the keeper's fixed gas (keeper/leverage-index.mjs SETNAV_GAS): an estimate made where
// lastNavUpdate already holds the block's timestamp prices a no-op SSTORE and the mined call, one second
// later, runs out of gas (seen in the 10/2 review rehearsal: EvmError: OutOfGas on the 14th mark up).
const send = async (wallet, req) => { const h = await wallet.writeContract(req.functionName === 'setNav' ? { gas: 120_000n, ...req } : req); const rc = await pc.waitForTransactionReceipt({ hash: h }); if (rc.status !== 'success') throw new Error(`${req.functionName} reverted`); return rc; };
function setGate(root, index, gate) {
  const p = path.join(root, 'keeper', 'dryrun', 'leverage-vaults.json');
  const v = JSON.parse(fs.readFileSync(p, 'utf8'));
  v[index].gate = gate;
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  return getAddress(v[index].address);
}

for (const a of [ACCT0, ACCT1]) {
  const code = await pc.getCode({ address: a });
  if (code && code !== '0x') throw new Error(`${a} has code on the fork`);
  await pc.request({ method: 'anvil_setBalance', params: [a, '0x56bc75e2d63100000'] });
  await pc.request({ method: 'anvil_impersonateAccount', params: [a] });
}
say(`rehearsal ${new Date().toISOString()} · rpc ${RPC} (${await pc.request({ method: 'web3_clientVersion' })}) · fork block ${await pc.getBlockNumber()} · keeper/owner ${ACCT0} · user ${ACCT1} (fresh, impersonated) · out ${OUT}`);

// ------------------------------------------------------------------ 1 deploy
const A = copyRepo('copy-a');
for (const index of ['qbtc2x', 'qeth2x']) {
  const r = node(A, ['{root}/keeper/deploy-mark-vault.mjs', '--index', index, '--manager', ACCT0, '--live', '--confirm', 'EXECUTE', '--rpc', RPC, '--from', ACCT0], `1-deploy-${index}`);
  check(`1 deploy ${index} with the real tool (cap 0, owner = keeper = the fresh keeper address), read back`, r.code === 0 && /read back ok/.test(r.out), r.out.split('\n').filter((l) => /deployed|REFUSED|disagrees/.test(l)).join(' ').slice(0, 300));
}
const log = readJsonl(path.join(A, 'keeper', 'dryrun', 'mark-vaults.jsonl'));
check('1 every deployment logged "sent" before "mined"', log.filter((l) => l.status === 'sent').length === 2 && log.findIndex((l) => l.status === 'sent') < log.findIndex((l) => l.status === 'mined'));
const vBtc = setGate(A, 'qbtc2x', { mode: 'step' });
const vEth = setGate(A, 'qeth2x', { mode: 'halt', pct: 15 });
results.vaults = { qbtc2x: vBtc, qeth2x: vEth };
// constructor arguments as cast abi-encode would give them
const deployTx = await pc.getTransaction({ hash: log.find((l) => l.index === 'qbtc2x' && l.status === 'sent').tx });
const ctorArgs = encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }], [MOCK_USD, 'Quadrix BTC 2x Vault', 'qBTC2X', 0n, ACCT0]);
check('1 the creation input ends with the ABI-encoded constructor arguments (usd, name, symbol, cap 0, manager)', deployTx.input.endsWith(ctorArgs.slice(2)));
const cast = spawnSync(path.join(os.homedir(), '.foundry', 'bin', 'cast'), ['abi-encode', 'constructor(address,string,string,uint256,address)', MOCK_USD, 'Quadrix BTC 2x Vault', 'qBTC2X', '0', ACCT0], { encoding: 'utf8' });
if (cast.status === 0) check('1 cast abi-encode gives the same constructor arguments', cast.stdout.trim() === ctorArgs);

// ------------------------------------------------------------------ 2 contract refusals (on the qETH2X vault)
const r2 = {
  notKeeper: await reason(() => pc.simulateContract({ account: ACCT1, address: vEth, abi: VAULT, functionName: 'setNav', args: [1_000_000n, 1n] })),
  zeroNav: await reason(() => pc.simulateContract({ account: ACCT0, address: vEth, abi: VAULT, functionName: 'setNav', args: [0n, 0n] })),
  move26: await reason(() => pc.simulateContract({ account: ACCT0, address: vEth, abi: VAULT, functionName: 'setNav', args: [740_000n, 74_000_000n] })),
};
await send(w1, { address: MOCK_USD, abi: USD, functionName: 'faucet' });
await send(w1, { address: MOCK_USD, abi: USD, functionName: 'approve', args: [vEth, 2n ** 255n] });
r2.capZero = await reason(() => pc.simulateContract({ account: ACCT1, address: vEth, abi: VAULT, functionName: 'deposit', args: [1_000_000n, ACCT1] }));
await send(w0, { address: vEth, abi: VAULT, functionName: 'setDepositCap', args: [10n ** 12n] });
await send(w0, { address: vEth, abi: VAULT, functionName: 'setDepositsPaused', args: [true] });
r2.paused = await reason(() => pc.simulateContract({ account: ACCT1, address: vEth, abi: VAULT, functionName: 'deposit', args: [1_000_000n, ACCT1] }));
results.refusals = r2;
check('2 the contract refuses setNav by a non-keeper / setNav(0) / a 26% move / deposit at cap 0 / deposit while paused',
  /not keeper/.test(r2.notKeeper) && /zero nav/.test(r2.zeroNav) && /nav move too large/.test(r2.move26) && /cap exceeded/.test(r2.capZero) && /deposits paused/.test(r2.paused), JSON.stringify(r2));

// ------------------------------------------------------------------ 3 qBTC2X from real bars
const leg = (root, index, replay, pair, label) => node(root, ['{root}/keeper/leverage-index.mjs', '--index', index, '--replay', replay, '--throwaway-check', pair, '--throwaway-level', '30:6', '--anchor', '--rpc', RPC, '--from', ACCT0], label);
const fromBlock = await pc.getBlockNumber();
let r = leg(A, 'qbtc2x', '2020-03-10..2020-03-12', '120:2.2', '3a-qbtc2x-run1');
const recA = path.join(A, 'keeper', 'dryrun', 'record-qbtc2x.jsonl');
let lines = readJsonl(recA);
check('3 run 1: genesis 2020-03-10 and lines 2020-03-11, 2020-03-12 from Binance bars, each anchored on the fork; vault marked to the last level', r.code === 0 && lines.length === 3 && readJsonl(path.join(A, 'keeper', 'dryrun', 'anchors-qbtc2x.jsonl')).length === 3, `levels ${lines.map((l) => l.level).join(', ')}`);
const nav1 = await pc.readContract({ address: vBtc, abi: VAULT, functionName: 'navPerShare' });
check('3 run 1: navPerShare = round(E × 1e6) of line 2020-03-12', nav1 === BigInt(Math.round(lines.at(-1).book.E * 1e6)), `${nav1}`);
const mid = await pc.getBlockNumber();
r = leg(A, 'qbtc2x', '2020-03-10..2020-03-13', '120:2.2', '3b-qbtc2x-run2');
lines = readJsonl(recA);
const last = lines.at(-1);
const dayMove = last.book.E / lines.at(-2).book.E - 1;
const events = await pc.getLogs({ address: vBtc, event: NAV_UPDATED, fromBlock: mid + 1n, toBlock: 'latest' });
let prev = nav1;
let bounded = true;
for (const e of events) { const x = e.args.navPerShare; const dlt = (prev * 2500n) / 10000n; if (x < prev - dlt || x > prev + dlt) bounded = false; prev = x; }
const nav2 = await pc.readContract({ address: vBtc, abi: VAULT, functionName: 'navPerShare' });
results.qbtc2x = { levels: lines.map((l) => [l.date, l.level, l.dayStats.triggers]), dayMove2020_03_12: dayMove, steps: events.map((e) => e.args.navPerShare.toString()), nav: nav2.toString() };
check('3 run 2: line 2020-03-13 (UTC day 2020-03-12) moves the level beyond ±25% and ±15% — marked in steps, every NavUpdated within ±25%, last = round(E × 1e6), level carried in the event',
  r.code === 0 && lines.length === 4 && Math.abs(dayMove) > 0.25 && events.length === 5 && bounded && nav2 === BigInt(Math.round(last.book.E * 1e6)) && events.every((e) => e.args.indexLevel === BigInt(Math.round(100 * last.book.E * 1e6))),
  `day move ${(dayMove * 100).toFixed(2)}%, ${events.length} NavUpdated, navPerShare ${nav2}, triggers that day ${last.dayStats.triggers}`);
const n0 = await pc.getTransactionCount({ address: ACCT0 });
r = leg(A, 'qbtc2x', '2020-03-10..2020-03-13', '120:2.2', '3c-qbtc2x-run3');
check('3 run 3 (same command): nothing written, nothing sent', r.code === 0 && readJsonl(recA).length === 4 && (await pc.getTransactionCount({ address: ACCT0 })) === n0);
r = node(A, ['{root}/scripts/verify.mjs', '--dir', '{root}/keeper/dryrun', '--series', 'qbtc2x', '--rpc', RPC, '--allow-rehearsal'], '3d-verify-qbtc2x');
check('3 verify.mjs on the fork: hashes, chain, anchors (calldata on the fork) and the recompute — 0 failures', r.code === 0 && /VERIFIED — 4 records, 4 anchors/.test(r.out), r.out.split('\n').filter((l) => /VERIFIED|FAILED|FAIL /.test(l)).join(' ').slice(0, 200));
const anchorTxs = readJsonl(path.join(A, 'keeper', 'dryrun', 'anchors-qbtc2x.jsonl'));
const marksA = readJsonl(path.join(A, 'keeper', 'dryrun', 'marks-qbtc2x.jsonl'));
const firstMarkBlock = Math.min(...marksA.map((m) => m.block));
const lastAnchorRc = await pc.getTransactionReceipt({ hash: anchorTxs.at(-1).txHash });
check('3 order: the anchor of line 2020-03-13 is mined before the first mark of that line', Number(lastAnchorRc.blockNumber) < Math.min(...marksA.filter((m) => m.seq === 3).map((m) => m.block)) && firstMarkBlock > Number(fromBlock));

// ------------------------------------------------------------------ 4 qETH2X with the halt gate
const navEth0 = await pc.readContract({ address: vEth, abi: VAULT, functionName: 'navPerShare' });
r = leg(A, 'qeth2x', '2020-03-10..2020-03-13', '60:2.1', '4-qeth2x-halt');
const linesE = readJsonl(path.join(A, 'keeper', 'dryrun', 'record-qeth2x.jsonl'));
check('4 qETH2X, gate {halt, 15%}: four lines and four anchors written, the marks halted (exit 1, navPerShare unchanged)',
  r.code === 1 && /MARK HALTED/.test(r.out) && linesE.length === 4 && readJsonl(path.join(A, 'keeper', 'dryrun', 'anchors-qeth2x.jsonl')).length === 4 && (await pc.readContract({ address: vEth, abi: VAULT, functionName: 'navPerShare' })) === navEth0,
  `ETH level ${linesE.at(-1)?.level}`);
r = node(A, ['{root}/scripts/verify.mjs', '--dir', '{root}/keeper/dryrun', '--series', 'qeth2x', '--rpc', RPC, '--allow-rehearsal'], '4b-verify-qeth2x');
check('4 verify.mjs qeth2x on the fork — 0 failures', r.code === 0, r.out.split('\n').filter((l) => /VERIFIED|FAILED/.test(l)).join(' '));

// ------------------------------------------------------------------ 5 deposit, marks up, redeem with faucet top-ups
await send(w0, { address: vEth, abi: VAULT, functionName: 'setDepositsPaused', args: [false] });
const usdBefore = await pc.readContract({ address: MOCK_USD, abi: USD, functionName: 'balanceOf', args: [ACCT1] });
await send(w1, { address: vEth, abi: VAULT, functionName: 'deposit', args: [10_000_000_000n, ACCT1] });
const shares = await pc.readContract({ address: vEth, abi: VAULT, functionName: 'balanceOf', args: [ACCT1] });
let nav = await pc.readContract({ address: vEth, abi: VAULT, functionName: 'navPerShare' });
for (let k = 0; k < 15; k++) { nav += (nav * 2500n) / 10000n; await send(w0, { address: vEth, abi: VAULT, functionName: 'setNav', args: [nav, nav * 100n] }); }
const tooMuch = await reason(() => pc.simulateContract({ account: ACCT1, address: vEth, abi: VAULT, functionName: 'redeem', args: [shares, ACCT1] }));
const half = shares / 2n;
await send(w1, { address: vEth, abi: VAULT, functionName: 'redeem', args: [half, ACCT1] });
const got = (await pc.readContract({ address: MOCK_USD, abi: USD, functionName: 'balanceOf', args: [ACCT1] })) - usdBefore + 10_000_000_000n;
const expect = (half * nav) / 1_000_000n;
results.redeem = { shares: shares.toString(), nav: nav.toString(), redeemedHalf: got.toString(), expected: expect.toString(), fullRedeem: tooMuch };
check('5 deposit 10,000 mUSD → 15 marks up (×28.4) → redeeming all reverts "liquidity" (over 20 faucet calls) → redeeming half pays shares × nav with faucet top-ups',
  /liquidity/.test(tooMuch) && got === expect, `half paid ${Number(got) / 1e6} mUSD = ${Number(expect) / 1e6}`);

// ------------------------------------------------------------------ 6 model liquidation (synthetic bars, a deep low)
const B = copyRepo('copy-b');
r = node(B, ['{root}/keeper/deploy-mark-vault.mjs', '--index', 'qbtc2x', '--manager', ACCT0, '--live', '--confirm', 'EXECUTE', '--rpc', RPC, '--from', ACCT0], '6a-deploy-liq');
const vLiq = setGate(B, 'qbtc2x', { mode: 'step' });
const { run } = await import(pathToFileURL(path.join(B, 'keeper', 'leverage-index.mjs')).href);
const H = await import(pathToFileURL(path.join(B, 'keeper', 'test', 'leverage-helpers.mjs')).href);
const minutes = [];
let p0 = 30_000;
for (let k = 0; k < 4; k++) {
  const d = new Date(Date.parse('2030-05-01T00:00:00Z') + k * 86_400_000).toISOString().slice(0, 10);
  const ms = H.synthMinutes(d, { seed: 41 + k, p0, vol: 0.002, shock: k === 2 ? (m, x) => (m >= 540 && m < 600 ? x - 0.95 / 60 : x) : null });
  minutes.push(...ms);
  p0 = ms.at(-1).c;
}
// The leg below writes lines dated 2030-05-02 … 04 on a synthetic clock (2030-05-05T00:25Z). The fork's own
// clock is today's, so without this its anchors would be mined years before those lines' days began — what
// verify.mjs fails as a line anchored before its own day (rehearsal 2, H1). Move the fork's clock to the
// synthetic one first; the check is not changed.
const T6 = Date.parse('2030-05-05T00:25:00Z');
await pc.request({ method: 'anvil_setTime', params: [T6 / 1000] });
const logs6 = [];
const deps6 = { root: B, now: () => T6, binance: H.fakeBinance({ BTCUSDT: minutes }, { serverTime: T6 }), env: {}, log: (m) => logs6.push(m) };
const legArgs6 = ['--index', 'qbtc2x', '--replay', '2030-05-02..2030-05-05', '--throwaway-check', '120:9', '--throwaway-level', '30:6', '--anchor', '--rpc', RPC, '--from', ACCT0];
// A model liquidation waits for a person (owner, 2026-10-06): the first run halts before the liquidation line
// (exit 1, nothing written for that day, nothing sent for it); the person's entry in keeper/leverage-gaps.json
// (here the copy's) lets the next run write it, anchor it, step the vault down and pause deposits.
const errs6 = [];
const origErr6 = console.error;
console.error = (m) => errs6.push(String(m));
const navPre = await pc.readContract({ address: vLiq, abi: VAULT, functionName: 'navPerShare' });
let code6h;
try { code6h = await run(legArgs6, deps6); } finally { console.error = origErr6; }
const err6 = errs6.join('\n');
fs.writeFileSync(path.join(OUT, '6a-liquidation-halt.log'), logs6.join('\n') + `\n${err6}\nexit ${code6h}\n`);
const linesH = readJsonl(path.join(B, 'keeper', 'dryrun', 'record-qbtc2x.jsonl'));
const navH = await pc.readContract({ address: vLiq, abi: VAULT, functionName: 'navPerShare' });
check('6 a day with a deep low: the run halts before the liquidation line (exit 1) — the two lines before it written and anchored, no liquidation line, the vault not marked',
  code6h === 1 && /MODEL LIQUIDATION NOT WRITTEN/.test(err6) && linesH.length === 2 && !linesH.some((l) => l.liquidated) && readJsonl(path.join(B, 'keeper', 'dryrun', 'anchors-qbtc2x.jsonl')).length === 2 && navH === navPre,
  (/MODEL LIQUIDATION NOT WRITTEN — [^;]+/.exec(err6)?.[0] ?? err6.split('\n')[0]).slice(0, 220));
const m6 = { bar: /the bar (\d\d:\d\d) UTC/.exec(err6)?.[1], ltvLow: Number(/debt ÷ collateral is (\d+(?:\.\d+)?)/.exec(err6)?.[1]), sha256: /canonical sha256 ([0-9a-f]{64})/.exec(err6)?.[1] };
fs.writeFileSync(path.join(B, 'keeper', 'leverage-gaps.json'), JSON.stringify({ accepted: [{ id: 'qbtc2x-2030-05-03-liquidation', index: 'qbtc2x', day: '2030-05-03', sha256: m6.sha256, liquidation: { bar: m6.bar, ltvLow: m6.ltvLow }, note: 'THROWAWAY rehearsal', confirmedAt: '2030-05-05' }] }, null, 2) + '\n');
logs6.length = 0;
const code6 = await run(legArgs6, deps6);
fs.writeFileSync(path.join(OUT, '6b-liquidation.log'), logs6.join('\n') + `\nexit ${code6}\n`);
const linesL = readJsonl(path.join(B, 'keeper', 'dryrun', 'record-qbtc2x.jsonl'));
const marksL = readJsonl(path.join(B, 'keeper', 'dryrun', 'marks-qbtc2x.jsonl'));
const navL = await pc.readContract({ address: vLiq, abi: VAULT, functionName: 'navPerShare' });
const pausedL = await pc.readContract({ address: vLiq, abi: VAULT, functionName: 'depositsPaused' });
check('6 after the accepting entry: model liquidation — level 0 naming the entry, nothing after it, the vault stepped to 3 units in 46 steps and paused',
  code6 === 0 && linesL.at(-1).level === 0 && linesL.at(-1).liquidated && linesL.at(-1).liquidationAccepted === 'qbtc2x-2030-05-03-liquidation' && linesL.length === 3 && marksL.filter((m) => m.step).length === 46 && navL === 3n && pausedL === true,
  `liquidated at ${linesL.at(-1).date} ${linesL.at(-1).liquidated?.bar} (LTV ${linesL.at(-1).liquidated?.ltvLow}, accepted as ${linesL.at(-1).liquidationAccepted}); navPerShare ${navL}; paused ${pausedL}`);
const nL = await pc.getTransactionCount({ address: ACCT0 });
const code6b = await run(legArgs6, { ...deps6, log: () => {} });
check('6 the next run writes and sends nothing (series ended)', code6b === 0 && readJsonl(path.join(B, 'keeper', 'dryrun', 'record-qbtc2x.jsonl')).length === 3 && (await pc.getTransactionCount({ address: ACCT0 })) === nL);
r = node(B, ['{root}/scripts/verify.mjs', '--dir', '{root}/keeper/dryrun', '--series', 'qbtc2x', '--rpc', RPC, '--allow-rehearsal'], '6c-verify-liq');
const anchorsL = readJsonl(path.join(B, 'keeper', 'dryrun', 'anchors-qbtc2x.jsonl'));
const firstAnchorL = anchorsL.length ? await pc.getBlock({ blockNumber: (await pc.getTransactionReceipt({ hash: anchorsL[0].txHash })).blockNumber }) : null;
check('6 verify.mjs on the liquidated series (fork anchors) — 0 failures', r.code === 0 && /MODEL LIQUIDATION/.test(r.out),
  `fork clock set to ${new Date(T6).toISOString()}; first anchor mined at ${firstAnchorL ? new Date(Number(firstAnchorL.timestamp) * 1000).toISOString() : '—'}`);

say(`\n${failures === 0 ? 'REHEARSAL PASSED' : `REHEARSAL FAILED — ${failures} check(s)`} · logs in ${OUT}`);
fs.writeFileSync(path.join(OUT, 'rehearsal-summary.txt'), report.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'rehearsal-results.json'), JSON.stringify(results, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
process.exitCode = failures === 0 ? 0 : 1;
