#!/usr/bin/env node
/**
 * REHEARSAL ONLY (local anvil fork) — basket-recon.mjs through a node that
 * has not seen our last block, against the same run through a clean node.
 *
 *   node keeper/test/rehearse-readback.mjs --date 2026-10-01 --index qdefi --stages announce
 *   node keeper/test/rehearse-readback.mjs --date 2026-10-01 --index qdefi --main-recon /path/basket-recon.main.mjs
 *
 * Forks GIWA Sepolia (`anvil --auto-impersonate`), prepares one basket's day
 * the way keeper/rehearse-day7.mjs does — the day's real work order, the
 * mocks already deployed (keeper/mocks/{date}.json), the cached prices
 * (--no-fetch), plan → decision draft → rehearsal ledger → plan with the
 * decision — and snapshots. Then, from that snapshot, each variant runs
 *
 *   announce (live, the vault's owner unlocked) → 7 days → re-plan → the
 *   daily mark, emulated → day7 (--warp --fill fair; the keeper fills its
 *   own auctions, as on the chain while no BIDDER_PK is set)
 *
 * with the tool talking to the anvil through keeper/test/lag-proxy.mjs,
 * either with no lag ("clean": the proxy passes everything through and only
 * makes the --warp exact, see below) or "lagging" (after every receipt the
 * next --lag reads of each read method come from a node one block behind —
 * stale, empty, not found, in turn). Block times are made deterministic (anvil_setBlockTimestampInterval
 * 1: every block is one second after the last, whatever the wall clock; a
 * warp is evm_setNextBlockTimestamp, since anvil then ignores
 * evm_increaseTime — the proxy translates the tool's --warp), so
 * the two runs must leave the SAME plan-file records and the SAME chain:
 * the transactions mined (from, to, input, gas), the vault's registry,
 * balances and references. --main-recon adds the tool as on main through the
 * same lagging node (it is expected to lose the announcement) and through
 * the clean node (it must send exactly what the new tool sends).
 *
 * Only the anvil this script starts on 127.0.0.1 and the proxy in front of
 * it are written to. No key is read; KEEPER_PK and BIDDER_PK are blanked for
 * every child. It refuses to run under Actions.
 *
 * --stop-variant adds a re-run after a stop: day7 through a proxy that goes
 * dark for 40 s right after the FILL's receipt (the tool records the fill,
 * then stops at its 30 s bound), then day7 again on the clean node — the
 * re-run must not trade the recorded fill again, and must leave the same
 * mined transactions and vault state as the clean run.
 *
 * --pk-variant adds the announce as the workflow sends it: signed with
 * KEEPER_PK instead of an unlocked --from, through a lagging proxy that
 * refuses to sign (--refuse-node-signing: "unknown account", as the public
 * endpoint answers — it holds no key). The key is generated in this process
 * for this fork only and handed to that one child; nothing is read from the
 * environment, and every other child still gets KEEPER_PK blanked. On the
 * fork the vault's ownership is first moved to the key's address (announce
 * is onlyOwner). With --main-recon the tool as on main runs the same way.
 *
 * Options: --date (today, UTC) --index (qdefi) --stages announce|day7 (day7)
 *          --lag n (4) --port n (8571) --proxy-port n (8581) --work DIR
 *          --fork-block n --duration s (1800) --main-recon FILE --foundry-bin DIR
 *          --stop-variant --pk-variant
 *          --modes m,m…    lag-proxy modes (default its own: stale,empty,notfound;
 *                          `null` plays the public op-reth node)
 *          --anvil-pid n   use the anvil the caller started on --port (same fork
 *                          arguments as below) and kill that pid at the end
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, getAddress, toFunctionSelector, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, chainFor, makeReader, readVault, sha256, loadPlan, savePlan } from '../basket-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEPER = path.join(HERE, '..');
const ROOT = path.join(KEEPER, '..');
const ZERO32 = `0x${'0'.repeat(64)}`;
const BAND_BPS = 1_500n;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const O = {
  date: opt('--date', new Date().toISOString().slice(0, 10)),
  index: opt('--index', 'qdefi'),
  stages: opt('--stages', 'day7'),
  lag: Number(opt('--lag', 4)),
  port: Number(opt('--port', 8571)),
  proxyPort: Number(opt('--proxy-port', 8581)),
  work: path.resolve(opt('--work', path.join(os.tmpdir(), 'quadrix-readback-rehearsal'))),
  forkBlock: opt('--fork-block', null),
  duration: Number(opt('--duration', 1800)),
  mainRecon: opt('--main-recon', null),
  foundry: opt('--foundry-bin', process.env.FOUNDRY_BIN ?? path.join(os.homedir(), '.foundry', 'bin')),
  stopVariant: argv.includes('--stop-variant'),
  pkVariant: argv.includes('--pk-variant'),
  modes: opt('--modes', null),
  anvilPid: opt('--anvil-pid', null) == null ? null : Number(opt('--anvil-pid')),
};
const ANVIL = `http://127.0.0.1:${O.port}`;
const PROXY = `http://127.0.0.1:${O.proxyPort}`;
const log = (m) => console.log(`[readback] ${m}`);
const CHECKS = [];
function check(name, ok, detail = '') {
  CHECKS.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`[readback] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}

// --------------------------------------------------------------- processes
function portFree(port) {
  return new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
}
async function rpc(method, params = [], url = ANVIL) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function waitUp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (Number(await rpc('eth_chainId', [], url)) === GIWA_CHAIN_ID) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}
/** The caller started the anvil (so that it holds the machine's one anvil slot from the first moment). */
async function attachAnvil() {
  log(`attaching to the anvil already started on ${ANVIL} (pid ${O.anvilPid})`);
  await waitUp(ANVIL, 120_000);
  return { kill: () => { try { process.kill(O.anvilPid); } catch { /* gone */ } } };
}
async function startAnvil() {
  const bin = fs.existsSync(path.join(O.foundry, 'anvil')) ? path.join(O.foundry, 'anvil') : 'anvil';
  const args = ['--port', String(O.port), '--host', '127.0.0.1', '--auto-impersonate', '--fork-url', GIWA_RPC, '--compute-units-per-second', '100', '--retries', '8', '--fork-retry-backoff', '2000', '--timeout', '45000'];
  if (O.forkBlock) args.push('--fork-block-number', String(O.forkBlock));
  const fd = fs.openSync(path.join(O.work, 'anvil.log'), 'w');
  log(`anvil ${args.join(' ')}`);
  const child = spawn(bin, args, { stdio: ['ignore', fd, fd] });
  await waitUp(ANVIL, 120_000);
  return child;
}
let proxyChild = null;
async function startProxy(tag, extra = [], lag = O.lag) {
  await stopProxy();
  const sends = path.join(O.work, `${tag}-proxy-sends.jsonl`);
  const events = path.join(O.work, `${tag}-proxy-lag.jsonl`);
  for (const f of [sends, events]) fs.rmSync(f, { force: true });
  const fd = fs.openSync(path.join(O.work, `${tag}-proxy.log`), 'w');
  proxyChild = spawn(process.execPath, [path.join(HERE, 'lag-proxy.mjs'), '--port', String(O.proxyPort), '--upstream', ANVIL, '--lag', String(lag), '--exact-warp', '--log', sends, '--events', events, ...(O.modes ? ['--modes', O.modes] : []), ...extra], { stdio: ['ignore', fd, fd] });
  await waitUp(PROXY, 20_000);
  return { sends, events };
}
async function stopProxy() {
  if (!proxyChild) return;
  const c = proxyChild;
  proxyChild = null;
  c.kill();
  await new Promise((r) => { c.once('exit', r); setTimeout(r, 2000); });
}

// --------------------------------------------------------------- the scratch repo
function setupWork() {
  const repo = path.join(O.work, 'repo');
  const keeper = path.join(repo, 'keeper');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(path.join(keeper, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(keeper, 'mocks'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'trackrecord', 'decisions'), { recursive: true });
  for (const f of ['basket-plan.mjs', 'basket-recon.mjs', 'readback.mjs', 'gen-recon-decision.mjs', 'nav-marks.jsonl']) fs.copyFileSync(path.join(KEEPER, f), path.join(keeper, f));
  if (O.mainRecon) fs.copyFileSync(path.resolve(O.mainRecon), path.join(keeper, 'basket-recon-main.mjs'));
  for (const d of ['rulebooks', 'artifacts']) fs.cpSync(path.join(KEEPER, d), path.join(keeper, d), { recursive: true });
  for (const f of fs.readdirSync(KEEPER).filter((f) => /^(state(-\w+)?|pending-registry-\w+)\.json$/.test(f))) fs.copyFileSync(path.join(KEEPER, f), path.join(keeper, f));
  const mocks = path.join(KEEPER, 'mocks', `${O.date}.json`);
  if (!fs.existsSync(mocks)) throw new Error(`keeper/mocks/${O.date}.json is missing — this rehearsal uses the mocks deployed that day`);
  fs.copyFileSync(mocks, path.join(keeper, 'mocks', `${O.date}.json`));
  for (const f of [`cg-markets-top500-${O.date}.json`, `cp-tickers-${O.date}.json`]) {
    const src = path.join(KEEPER, 'cache', f);
    if (!fs.existsSync(src)) throw new Error(`keeper/cache/${f} is missing — run the planner once first`);
    fs.copyFileSync(src, path.join(keeper, 'cache', f));
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'trackrecord')).filter((f) => /^record-\w+\.jsonl$/.test(f))) fs.copyFileSync(path.join(ROOT, 'trackrecord', f), path.join(repo, 'trackrecord', f));
  fs.writeFileSync(path.join(repo, 'trackrecord', 'decisions.jsonl'), '');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(repo, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  return { repo, keeper, ledger: path.join(repo, 'trackrecord', 'decisions.jsonl') };
}
function run(env, script, args, label, { throwawayKey = null } = {}) {
  console.log(`$ node keeper/${script} ${args.join(' ')}${throwawayKey ? ' (KEEPER_PK = a key generated for this fork)' : ''}`);
  // A throwaway key goes only to a child that talks to the local proxy.
  if (throwawayKey && args[args.indexOf('--rpc') + 1] !== PROXY) throw new Error('a throwaway key is only for a run against the local proxy');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(env.keeper, script), ...args], {
    cwd: env.repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GITHUB_ACTIONS: '', KEEPER_PK: throwawayKey ?? '', BIDDER_PK: '', COINGECKO_API_KEY: '' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  fs.writeFileSync(path.join(O.work, `${label.replace(/\W+/g, '-')}.log`), out);
  for (const line of out.split('\n')) if (line.trim()) console.log(`    | ${line}`);
  console.log(`    exit=${r.status} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { status: r.status, out };
}

// --------------------------------------------------------------- chain side
let reader;
let pc;
const wallets = {};
const walletFor = (a) => (wallets[a] ??= createWalletClient({ account: getAddress(a), chain: chainFor(ANVIL, GIWA_CHAIN_ID), transport: http(ANVIL) }));
async function tx(from, { address, abi = VAULT_ABI, functionName, args = [], gas = 3_000_000n }) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: getAddress(from) });
  const hash = await walletFor(from).writeContract({ ...request, gas });
  const rc = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (rc.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return rc;
}
/** The daily mark, emulated (rehearse-day7.mjs markToPlan). */
async function markToPlan(keeper, vault, plan) {
  let posts = 0;
  for (const r of plan.registry) {
    if (r.inRemoval) continue;
    let cur = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: 'refPrice', args: [r.address] });
    const target = BigInt(r.planRefPrice);
    while (cur !== target) {
      const span = (cur * (BAND_BPS - 10n)) / 10_000n;
      const next = target > cur ? (target - cur <= span ? target : cur + span) : (cur - target <= span ? target : cur - span);
      await tx(keeper, { address: vault, functionName: 'setRefPrice', args: [r.address, next], gas: 150_000n });
      posts++;
      cur = next;
    }
  }
  return posts;
}
/** `seconds` later, exactly — under the timestamp interval anvil ignores evm_increaseTime. */
async function warpExact(seconds) {
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  await rpc('evm_setNextBlockTimestamp', [Number(BigInt(head.timestamp) + BigInt(seconds))]);
  await rpc('evm_mine', []);
}

/** Every transaction mined after `fromBlock`: from, to, input, gas, status. */
async function minedSince(fromBlock) {
  const head = BigInt(await rpc('eth_blockNumber'));
  const out = [];
  for (let n = fromBlock; n <= head; n++) {
    const b = await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
    for (const t of b.transactions) {
      const rc = await rpc('eth_getTransactionReceipt', [t.hash]);
      out.push({ block: Number(n), time: Number(b.timestamp), from: getAddress(t.from), to: t.to ? getAddress(t.to) : null, input: t.input, gas: BigInt(t.gas).toString(), status: rc.status });
    }
  }
  return out;
}
async function vaultState(vault) {
  const v = await readVault(reader, vault);
  return { assetCount: v.assetCount, pending: v.pendingRegistryChange, eta: v.pendingRegistryEta.toString(), assets: v.assets.map((a) => ({ address: a.address, balance: a.balance.toString(), refPrice: a.refPrice.toString(), refAt: a.refPriceUpdatedAt.toString(), inRemoval: a.inRemoval })), auctionCount: v.auctionCount.toString() };
}
/** A plan file without its wall-clock fields. */
function planRecords(p) {
  const drop = new Set(['sentAt', 'generatedAt']);
  return JSON.parse(JSON.stringify({ announce: p.announce, execute: p.execute ?? null, firstPrices: p.firstPrices, fills: p.fills, finalize: p.finalize, finalizePending: p.finalizePending ?? null, verify: p.verify ? { ...p.verify, at: undefined } : null, sent: p.sent ?? [] }, (k, v) => (drop.has(k) ? undefined : v)));
}

// --------------------------------------------------------------- one variant
async function variant(env, B, tag, { script, lag }) {
  await rpc('evm_revert', [B.snap]);
  B.snap = await rpc('evm_snapshot');
  await rpc('anvil_setBlockTimestampInterval', [1]);
  savePlan(B.planFile, loadPlan(B.savedPlan));
  const from = BigInt(await rpc('eth_blockNumber')) + 1n;
  await startProxy(tag, [], lag);
  const live = ['--live', '--from', B.owner];
  const recon = (stage, extra = []) => ['--index', O.index, '--stage', stage, '--rpc', PROXY, '--plan', B.planFile, ...live, ...extra];
  const res = { tag, script, rpc: lag ? `lag-proxy, ${lag} lagging read(s) of each read method after each receipt` : 'lag-proxy with no lag (pass-through, exact warp)' };
  let r = run(env, script, recon('announce'), `${tag}-announce`);
  res.announceExit = r.status;
  res.announceOut = r.out;
  res.afterAnnounce = { plan: planRecords(loadPlan(B.planFile)), chain: await vaultState(B.vault) };
  if (O.stages === 'day7' && r.status === 0) {
    await stopProxy();
    await warpExact(Number(B.registryDelay) + 60);
    r = run(env, 'basket-plan.mjs', B.planArgs, `${tag}-replan`);
    res.replanExit = r.status;
    const day7Plan = loadPlan(B.planFile);
    res.posts = await markToPlan(B.owner, B.vault, day7Plan);
    await startProxy(`${tag}-day7`, [], lag);
    r = run(env, script, recon('day7', ['--warp', '--fill', 'fair']), `${tag}-day7`);
    res.day7Exit = r.status;
    res.day7Out = r.out;
  }
  res.lagStats = await rpc('lagproxy_stats', [], PROXY).catch(() => null);
  await stopProxy();
  res.plan = planRecords(loadPlan(B.planFile));
  res.mined = await minedSince(from);
  res.chain = await vaultState(B.vault);
  fs.copyFileSync(B.planFile, path.join(O.work, `${tag}-plan.json`));
  fs.writeFileSync(path.join(O.work, `${tag}-result.json`), JSON.stringify(res, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return res;
}

/** Day 7 through a node that goes dark right after the fill's receipt, then
 *  day 7 again on the clean node (announce, re-plan and mark as in variant()). */
async function variantStop(env, B, tag) {
  await rpc('evm_revert', [B.snap]);
  B.snap = await rpc('evm_snapshot');
  await rpc('anvil_setBlockTimestampInterval', [1]);
  savePlan(B.planFile, loadPlan(B.savedPlan));
  const from = BigInt(await rpc('eth_blockNumber')) + 1n;
  const live = ['--live', '--from', B.owner];
  const recon = (rpcUrl, stage, extra = []) => ['--index', O.index, '--stage', stage, '--rpc', rpcUrl, '--plan', B.planFile, ...live, ...extra];
  const res = { tag };
  await startProxy(`${tag}-clean`, [], 0);
  let r = run(env, 'basket-recon.mjs', recon(PROXY, 'announce'), `${tag}-announce`);
  await stopProxy();
  res.announceExit = r.status;
  await warpExact(Number(B.registryDelay) + 60);
  r = run(env, 'basket-plan.mjs', B.planArgs, `${tag}-replan`);
  res.posts = await markToPlan(B.owner, B.vault, loadPlan(B.planFile));
  await startProxy(`${tag}-dark`, ['--dark-after-selector', toFunctionSelector('fill(uint256,uint256)'), '--dark-ms', '40000'], O.lag);
  r = run(env, 'basket-recon.mjs', recon(PROXY, 'day7', ['--warp', '--fill', 'fair']), `${tag}-day7-stopped`);
  res.stoppedExit = r.status;
  res.stoppedOut = r.out;
  res.lagStats = await rpc('lagproxy_stats', [], PROXY).catch(() => null);
  await stopProxy();
  res.afterStop = planRecords(loadPlan(B.planFile));
  await startProxy(`${tag}-rerun`, [], 0);
  r = run(env, 'basket-recon.mjs', recon(PROXY, 'day7', ['--warp', '--fill', 'fair']), `${tag}-day7-rerun`);
  await stopProxy();
  res.rerunExit = r.status;
  res.rerunOut = r.out;
  res.plan = planRecords(loadPlan(B.planFile));
  res.mined = await minedSince(from);
  res.chain = await vaultState(B.vault);
  fs.copyFileSync(B.planFile, path.join(O.work, `${tag}-plan.json`));
  fs.writeFileSync(path.join(O.work, `${tag}-result.json`), JSON.stringify(res, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return res;
}

const OWNABLE_ABI = parseAbi(['function transferOwnership(address newOwner)']);
const ANNOUNCE_SELECTOR = toFunctionSelector('announceRegistryChange(address[],address[],bytes32)');

/** The announce as the workflow sends it: KEEPER_PK, a node that will not sign. */
async function variantPk(env, B, tag, { script, lag }) {
  await rpc('evm_revert', [B.snap]);
  B.snap = await rpc('evm_snapshot');
  await rpc('anvil_setBlockTimestampInterval', [1]);
  savePlan(B.planFile, loadPlan(B.savedPlan));
  const key = generatePrivateKey(); // this fork only; never written anywhere
  const signer = privateKeyToAccount(key).address;
  await tx(B.owner, { address: B.vault, abi: OWNABLE_ABI, functionName: 'transferOwnership', args: [signer], gas: 100_000n });
  await rpc('anvil_setBalance', [signer, `0x${(10n ** 18n).toString(16)}`]);
  log(`${tag}: vault ownership moved on the fork to a throwaway signer ${signer}`);
  const from = BigInt(await rpc('eth_blockNumber')) + 1n;
  const { sends } = await startProxy(tag, ['--refuse-node-signing'], lag);
  const r = run(env, script, ['--index', O.index, '--stage', 'announce', '--rpc', PROXY, '--plan', B.planFile, '--live'], `${tag}-announce`, { throwawayKey: key });
  const res = { tag, script, signer, announceExit: r.status, announceOut: r.out };
  res.lagStats = await rpc('lagproxy_stats', [], PROXY).catch(() => null);
  await stopProxy();
  res.plan = planRecords(loadPlan(B.planFile));
  res.mined = await minedSince(from);
  res.chain = await vaultState(B.vault);
  res.sends = fs.existsSync(sends) ? fs.readFileSync(sends, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  res.raw = [];
  for (const x of res.sends.filter((y) => y.method === 'eth_sendRawTransaction')) {
    const t = parseTransaction(x.params[0]);
    res.raw.push({ to: getAddress(t.to), input: t.data, gas: t.gas.toString(), chainId: t.chainId, from: await recoverTransactionAddress({ serializedTransaction: x.params[0] }) });
  }
  fs.copyFileSync(B.planFile, path.join(O.work, `${tag}-plan.json`));
  fs.writeFileSync(path.join(O.work, `${tag}-result.json`), JSON.stringify(res, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return res;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function firstDiff(a, b, p = '') {
  if (same(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return `${p}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return `${p}: differs`;
}

// ---------------------------------------------------------------------- main
async function main() {
  if (process.env.GITHUB_ACTIONS === 'true') { console.error('REFUSED: a local rehearsal — not for a workflow'); process.exit(1); }
  if (O.date !== new Date().toISOString().slice(0, 10)) { console.error(`REFUSED: --date ${O.date} is not today (UTC) — the executor refuses a plan not generated today`); process.exit(1); }
  for (const p of O.anvilPid ? [O.proxyPort] : [O.port, O.proxyPort]) if (!(await portFree(p))) { console.error(`port ${p} is in use`); process.exit(1); }
  fs.mkdirSync(O.work, { recursive: true });
  const env = setupWork();
  const anvil = O.anvilPid ? await attachAnvil() : await startAnvil();
  let fails = 1;
  try {
    reader = await makeReader(ANVIL, { chainId: GIWA_CHAIN_ID });
    pc = reader.publicClient;
    const blk = await pc.getBlock();
    log(`fork of ${GIWA_RPC} at block ${blk.number}; work ${O.work}`);
    // ---- prepare the basket as rehearse-day7.mjs does (keeper bids)
    const rb = JSON.parse(fs.readFileSync(path.join(env.keeper, 'rulebooks', `${O.index}.json`), 'utf8'));
    const vault = getAddress(rb.basket.vault);
    const v0 = await readVault(reader, vault);
    const owner = v0.owner;
    await rpc('anvil_setBalance', [owner, `0x${(10n ** 21n).toString(16)}`]);
    const planFile = path.join(env.keeper, 'plans', O.index, `${O.date}.json`);
    const mocksFile = path.join(env.keeper, 'mocks', `${O.date}.json`);
    const planArgs = ['--index', O.index, '--date', O.date, '--rpc', ANVIL, '--mocks', mocksFile, '--no-fetch', '--duration', String(O.duration)];
    let r = run(env, 'basket-plan.mjs', planArgs, 'plan');
    if (r.status !== 0) throw new Error('plan failed');
    let plan = loadPlan(planFile);
    r = run(env, 'gen-recon-decision.mjs', ['--index', O.index, '--plan', planFile, '--force'], 'decision-draft');
    if (r.status !== 0) throw new Error('decision draft failed');
    const draftPath = path.join(env.repo, plan.decisionFile);
    const decisionId = `${O.date}-${O.index}-basket-reconstitution`;
    fs.appendFileSync(env.ledger, JSON.stringify({ id: decisionId, file: plan.decisionFile.replace(/^trackrecord\//, ''), effectiveFrom: O.date, sha256: sha256(fs.readFileSync(draftPath)), txHash: '0xREHEARSAL-not-anchored', anchoredAt: 'rehearsal' }) + '\n');
    r = run(env, 'basket-plan.mjs', [...planArgs, '--decision', decisionId], 'plan-with-decision');
    if (r.status !== 0) throw new Error('plan with the decision failed');
    plan = loadPlan(planFile);
    log(`${O.index}: vault ${vault}, owner = keeper ${owner}; adds [${plan.adds.map((a) => `${a.symbol} ${a.address}`).join(', ')}], removes [${plan.removes.map((a) => a.symbol).join(', ')}], ${plan.trades.length} planned auction(s)`);
    const savedPlan = path.join(O.work, 'plan-before-announce.json');
    savePlan(savedPlan, plan);
    const B = { vault, owner, planFile, savedPlan, planArgs, registryDelay: v0.registryDelay, snap: await rpc('evm_snapshot') };

    // ---- the variants
    const out = {};
    out.clean = await variant(env, B, 'new-clean', { script: 'basket-recon.mjs', lag: 0 });
    out.lag = await variant(env, B, 'new-lagging', { script: 'basket-recon.mjs', lag: O.lag });
    if (O.stopVariant && O.stages === 'day7') out.stop = await variantStop(env, B, 'new-stop-rerun');
    if (O.mainRecon) {
      out.mainLag = await variant(env, B, 'main-lagging', { script: 'basket-recon-main.mjs', lag: O.lag });
      out.mainClean = await variant(env, B, 'main-clean', { script: 'basket-recon-main.mjs', lag: 0 });
    }
    if (O.pkVariant) {
      out.pk = await variantPk(env, B, 'new-pk-lagging', { script: 'basket-recon.mjs', lag: O.lag });
      if (O.mainRecon) out.mainPk = await variantPk(env, B, 'main-pk-lagging', { script: 'basket-recon-main.mjs', lag: O.lag });
    }

    // ---- checks
    const c = out.clean;
    const l = out.lag;
    check('clean node: announce exits 0 and records plan.announce', c.announceExit === 0 && !!c.afterAnnounce.plan.announce?.pendingHash && c.afterAnnounce.plan.announce.pendingHash === c.afterAnnounce.chain.pending, `pending ${c.afterAnnounce.chain.pending}`);
    check('lagging node: announce exits 0 and records plan.announce', l.announceExit === 0 && !!l.afterAnnounce.plan.announce?.pendingHash && l.afterAnnounce.plan.announce.pendingHash === l.afterAnnounce.chain.pending, `lagging reads played: ${JSON.stringify(l.lagStats ?? {})}`);
    check('announce: the same plan.announce and plan.sent records on both nodes', same(c.afterAnnounce.plan.announce, l.afterAnnounce.plan.announce) && same(c.afterAnnounce.plan.sent, l.afterAnnounce.plan.sent), firstDiff(c.afterAnnounce.plan, l.afterAnnounce.plan) ?? 'identical');
    check('announce: the same chain state after it on both nodes (pending hash, eta)', same(c.afterAnnounce.chain, l.afterAnnounce.chain), `eta ${c.afterAnnounce.chain.eta}`);
    check('lagging node: a read after the announce was answered late and repeated', /answered at read [2-9]/.test(l.announceOut), (l.announceOut.match(/\([^)]*answered at read \d+\)/g) ?? []).slice(0, 3).join(' '));
    if (O.stages === 'day7') {
      check('clean node: day7 exits 0, verify passed', c.day7Exit === 0 && /verify: all checks passed/.test(c.day7Out ?? ''), (c.day7Out?.match(/verify: [^\n]*/) ?? ['no verify line'])[0]);
      check('lagging node: day7 exits 0, verify passed', l.day7Exit === 0 && /verify: all checks passed/.test(l.day7Out ?? ''), (l.day7Out?.match(/verify: [^\n]*/) ?? ['no verify line'])[0]);
      check('day7: the same plan-file records on both nodes (execute, first prices, fills, finalize, verify, sent)', same(c.plan, l.plan), firstDiff(c.plan, l.plan) ?? `${c.plan.fills.length} fill(s), ${c.plan.finalize.length} finalize, ${c.plan.sent.length} sent`);
      check('day7: the same transactions mined (from, to, input, gas, block, time) on both nodes', same(c.mined, l.mined), firstDiff(c.mined, l.mined) ?? `${c.mined.length} transaction(s)`);
      check('day7: the same vault state after the session on both nodes', same(c.chain, l.chain), firstDiff(c.chain, l.chain) ?? `${c.chain.assetCount} assets`);
    }
    if (O.mainRecon) {
      const ml = out.mainLag;
      const mc = out.mainClean;
      check('the tool on main, lagging node: the announcement is mined but NOT recorded (the failure being fixed)', ml.afterAnnounce.chain.pending !== ZERO32 && !ml.afterAnnounce.plan.announce && ml.announceExit !== 0, (ml.announceOut.split('\n').filter(Boolean).at(-1) ?? '').slice(0, 200));
      const strip = (m) => m.map(({ from, to, input, gas }) => ({ from, to, input, gas }));
      check('what is sent: the tool on main and this tool send the same transactions (from, to, input, gas; block and time too) on a clean node', same(strip(mc.mined), strip(c.mined)) && same(mc.mined, c.mined), firstDiff(mc.mined, c.mined) ?? `${c.mined.length} transaction(s)`);
    }
    if (out.pk) {
      const p = out.pk;
      const ref = c.mined.find((m) => m.input.startsWith(ANNOUNCE_SELECTOR));
      check('KEEPER_PK path, lagging node that will not sign: announce exits 0, signed here (eth_sendRawTransaction only), recorded with the signer', p.announceExit === 0 && p.sends.length === 1 && p.sends.every((x) => x.method === 'eth_sendRawTransaction') && p.raw[0]?.from === p.signer && p.plan.announce?.pendingHash === p.chain.pending && p.plan.announce?.signer === p.signer && p.plan.sent.length === 1 && p.plan.sent[0].status === 'success', `exit ${p.announceExit}; sends ${p.sends.map((x) => x.method).join(',') || 'none'}; lag ${JSON.stringify(p.lagStats ?? {})}`);
      check('KEEPER_PK path: the same transaction (to, calldata, gas) and the same pending tuple hash as the --from run', !!ref && p.raw.length === 1 && p.raw[0].to === ref.to && p.raw[0].input === ref.input && p.raw[0].gas === ref.gas && p.chain.pending === c.afterAnnounce.chain.pending, ref ? `gas ${ref.gas}; pending ${p.chain.pending}` : 'no announce in the --from run');
      if (out.mainPk) {
        const m = out.mainPk;
        // viem prints the node's refusal (code -32000) as "Missing or invalid parameters."
        check('the tool on main, KEEPER_PK path: it asks the node to sign (eth_sendTransaction), the node refuses — nothing sent, nothing announced (the defect fixed in 8812757)', m.announceExit !== 0 && m.mined.length === 0 && m.chain.pending === ZERO32 && (m.lagStats?.refusedNodeSigning ?? 0) >= 1 && m.sends.length >= 1 && m.sends.every((x) => x.method === 'eth_sendTransaction'), `exit ${m.announceExit}; asked the node to sign ${m.lagStats?.refusedNodeSigning ?? 0}×; mined ${m.mined.length}; last line: ${(m.announceOut.split('\n').filter(Boolean).at(-2) ?? '').slice(0, 120)}`);
      }
    }
    if (out.stop) {
      const s = out.stop;
      const fillsAfterStop = s.afterStop.fills.length;
      check('stop: the run through the dark node stops after the fill is mined, with the fill recorded', s.stoppedExit !== 0 && fillsAfterStop >= 1 && !!s.afterStop.fills[0].fillTx, `exit ${s.stoppedExit}; ${fillsAfterStop} fill(s) recorded; last line: ${(s.stoppedOut.split('\n').filter(Boolean).at(-1) ?? '').slice(0, 160)}`);
      check('stop → re-run on the clean node: day7 exits 0 and verify passes', s.rerunExit === 0 && /verify: all checks passed/.test(s.rerunOut), (s.rerunOut.match(/verify: [^\n]*/) ?? ['no verify line'])[0]);
      check('stop → re-run: the recorded fill is not traded again (no second open, no second fill)', !/open auction #1\b/.test(s.rerunOut) && s.plan.fills.length === c.plan.fills.length, `fills ${s.plan.fills.map((f) => f.seq).join(',')} vs clean ${c.plan.fills.map((f) => f.seq).join(',')}`);
      check('stop → re-run: the same transactions mined (from, to, input, gas, block, time) as the clean run', same(s.mined, c.mined), firstDiff(s.mined, c.mined) ?? `${s.mined.length} transaction(s)`);
      check('stop → re-run: the same vault state as the clean run', same(s.chain, c.chain), firstDiff(s.chain, c.chain) ?? `${s.chain.assetCount} assets`);
      const blank = (p) => ({ ...p, fills: p.fills.map(({ at, factorBps, elapsed, ...x }) => x), sent: p.sent.map(({ at, settledLater, ...x }) => x), verify: p.verify });
      check('stop → re-run: the same plan records as the clean run, but for the fill\'s block time and factor (unread while the node was dark)', same(blank(s.plan), blank(c.plan)), firstDiff(blank(s.plan), blank(c.plan)) ?? 'identical otherwise');
    }
    fails = CHECKS.filter((x) => !x.ok).length;
    console.log(`\n[readback] ${CHECKS.length - fails} PASS / ${fails} FAIL`);
    fs.writeFileSync(path.join(O.work, 'checks.json'), JSON.stringify(CHECKS, null, 2));
  } finally {
    await stopProxy();
    anvil.kill();
  }
  process.exit(fails ? 1 : 0);
}

main().catch(async (e) => { console.error(e.stack ?? e.message ?? e); await stopProxy(); process.exit(1); });
