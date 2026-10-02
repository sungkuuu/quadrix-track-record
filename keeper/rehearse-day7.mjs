#!/usr/bin/env node
/**
 * Reconstitution rehearsal of a real day — local anvil fork only.
 *
 *   node keeper/rehearse-day7.mjs --date 2026-10-01                # all five baskets with a work order
 *   node keeper/rehearse-day7.mjs --date 2026-10-01 --index qdefi  # one
 *
 * Forks GIWA Sepolia (`anvil --auto-impersonate`) and drives the REAL tools
 * against the day's real work orders (keeper/pending-registry-*.json), books
 * and record rows, with the day's cached prices (keeper/cache: CoinGecko as
 * source A, CoinPaprika as B — offline, --no-fetch), the vault's own owner
 * impersonated and anvil's public dev accounts as bidder, holder and
 * stranger. Per basket:
 *
 *   set-bidder → deploy-mocks → plan → decision draft (rehearsal ledger) →
 *   plan with the decision → announce guards (a duplicate address, a wrong
 *   mock symbol) → announce → 7 days → re-plan (tuple carried; it supplies
 *   the day's prices) → the daily mark, emulated → the day-7 plan (sized at
 *   the marked references) → day7 (execute → first prices → auctions →
 *   finalize → verify) with the bidder as a separate account → checks,
 *   including the planner spec's acceptance checks of 2026-10-01 §4
 *   (sessionChecks: fills as sized, weights against the trade targets
 *   within the fill bound and against the book)
 *
 * and, from a snapshot taken just before day 7 (anvil evm_snapshot/revert),
 * the acceptance criteria of option K (review of 2026-10-01, §2.7):
 *   ① one base unit donated in window 1 (after the drain auction is read and
 *     opened, before the fill) → finalized in the same run
 *   ② a donation between the drain fill and the finalize, three times → the
 *     re-drains finish it
 *   ③ a donation at every attempt → PENDING after five, verify passes with
 *     PENDING, exit 0
 *   ④ a creation of 1,000 shares in window 1 → finalized
 *   ⑤ a redemption in window 1 → the fill shrinks to the live balance,
 *     finalized
 *   ⑥ a third party calls executeRegistryChange first → day7 completes
 *   ⑦ a run with no interference fills the same amounts as the tool on main
 * The windows are reached through basket-recon.mjs --hook (refused anywhere
 * but --live --from on a local anvil). Nothing here touches the record
 * repository: the scripts are copied into --work, and the only RPC written to
 * is the anvil this script started on 127.0.0.1. No key is read.
 *
 * Options:
 *   --date YYYY-MM-DD   the work-order date (default today, UTC); must be today
 *                       for the executor's same-day plan rule
 *   --index a,b         subset (default every basket with a work order that day)
 *   --port n            anvil port (default 8571)
 *   --work DIR          scratch directory (default $TMPDIR/quadrix-day7-rehearsal)
 *   --main-recon FILE   basket-recon.mjs as on main, for ⑦ (default: skip ⑦)
 *   --fork-block n      pin the fork block
 *   --duration s        auction duration for the planner (default 1800, as on the public chain)
 *   --foundry-bin DIR   default ~/.foundry/bin
 *   --keeper-bids       no separate bidder: the keeper key fills its own auctions, as on
 *                       the chain while no BIDDER_PK secret is set (set-bidder then has
 *                       nothing to send, and the new mocks' inventory goes to the keeper)
 *   --mark-offset-bps n  the emulated daily mark leaves each reference n bp off the plan's
 *                       market price, alternately above and below (default 0: exactly at
 *                       it). On the chain the mark and the plan's price differ (2026-10-01:
 *                       94–252 bp median, 543 bp at most); at 0 the day-7 plan's chain
 *                       references equal its market prices, so sizing at either looks the
 *                       same and the chain-reference sizing goes untested. Must stay under
 *                       the executor's 5% guard.
 *   --create-shares n    shares the ④ creation in window 1 makes (default 1,000 — 0.1% of the
 *                       2026-10-01 vaults, too small to leave a traded name outside the fill
 *                       bound; about 10,000 makes the executor run a residual round)
 *   --stop-resume       ⑧ the job stopped mid-session (the 6-hour limit of a GitHub job: the
 *                       runner is terminated and the plan file is not committed) — the
 *                       executor is killed at a fill, the plan file is put back to the version
 *                       the plan stage committed, and day7 is dispatched again: (a) killed
 *                       right after a drain's fill, before its finalize; (b) killed with an
 *                       auction open at its fair point; (c) as (b), then the day's mark moves
 *                       a reference before the re-run — the re-run records and refuses, and
 *                       the RUNBOOK's resume path (work order put aside, a plan with
 *                       --reweight-block, auctions, verify) finishes the session. Then ⑨ a
 *                       verify run after a later mark. (second review of the planner change)
 *   --keep-anvil
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, getAddress, parseAbi, encodeDeployData, maxUint256 } from 'viem';
import { TICKER, GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, ERC20_ABI, chainFor, makeReader, readVault, sha256, loadPlan, savePlan } from './basket-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ZERO32 = `0x${'0'.repeat(64)}`;
const DEV = {
  bidder: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // anvil #1
  stranger: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // anvil #3
  holder: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // anvil #4
  decoyDeployer: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', // anvil #5
};
const EXTRA_ABI = parseAbi([
  'function create(uint256[] amounts, address receiver) returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function executeRegistryChange(address[] adds, address[] removes, bytes32 decisionSha256)',
]).concat(VAULT_ABI.filter((x) => x.type === 'error'));
const FAUCET_ABI = parseAbi(['function faucetAmount() view returns (uint256)']);
const AUCTION_FILLED = VAULT_ABI.find((x) => x.type === 'event' && x.name === 'AuctionFilled');
const BAND_BPS = 1_500n;
/** Who fills: anvil #1, or (--keeper-bids) the vault's own keeper. */
let BIDDER = DEV.bidder;

// ------------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const O = {
  date: opt('--date', new Date().toISOString().slice(0, 10)),
  index: opt('--index', null),
  port: Number(opt('--port', 8571)),
  work: path.resolve(opt('--work', path.join(os.tmpdir(), 'quadrix-day7-rehearsal'))),
  mainRecon: opt('--main-recon', null),
  forkBlock: opt('--fork-block', null),
  duration: Number(opt('--duration', 1800)), // the setting for the public chain (a 60 s fair window)
  foundry: opt('--foundry-bin', process.env.FOUNDRY_BIN ?? path.join(os.homedir(), '.foundry', 'bin')),
  keepAnvil: flag('--keep-anvil'),
  keeperBids: flag('--keeper-bids'),
  markOffsetBps: Number(opt('--mark-offset-bps', 0)),
  createShares: BigInt(opt('--create-shares', '1000')),
  stopResume: flag('--stop-resume'),
};
const RPC = `http://127.0.0.1:${O.port}`;

// ------------------------------------------------------------ reporting
const REPORT = { startedAt: new Date().toISOString(), date: O.date, markOffsetBps: O.markOffsetBps, createShares: O.createShares.toString(), checks: [], commands: [], baskets: {} };
let CURRENT = 'setup';
const log = (m) => console.log(`[day7] ${m}`);
function check(name, ok, detail = '', criterion = null) {
  REPORT.checks.push({ basket: CURRENT, criterion, name, ok: !!ok, detail: String(detail) });
  console.log(`[day7] ${ok ? 'PASS' : 'FAIL'}  ${criterion ? `${criterion} ` : ''}${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
class Abort extends Error {}
function must(name, ok, detail = '') { if (!check(name, ok, detail)) throw new Abort(name); }

// ------------------------------------------------------------ the scratch repo
function setupWork() {
  const repo = path.join(O.work, 'repo');
  const keeper = path.join(repo, 'keeper');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(path.join(keeper, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'trackrecord', 'decisions'), { recursive: true });
  for (const f of ['basket-plan.mjs', 'basket-recon.mjs', 'readback.mjs', 'gen-recon-decision.mjs', 'deploy-mocks.mjs', 'set-bidder.mjs', 'nav-marks.jsonl']) fs.copyFileSync(path.join(HERE, f), path.join(keeper, f));
  if (O.mainRecon) fs.copyFileSync(path.resolve(O.mainRecon), path.join(keeper, 'basket-recon-main.mjs'));
  for (const d of ['rulebooks', 'artifacts']) fs.cpSync(path.join(HERE, d), path.join(keeper, d), { recursive: true });
  for (const f of fs.readdirSync(HERE).filter((f) => /^(state(-\w+)?|pending-registry-\w+)\.json$/.test(f))) fs.copyFileSync(path.join(HERE, f), path.join(keeper, f));
  for (const f of [`cg-markets-top500-${O.date}.json`, `cp-tickers-${O.date}.json`]) {
    const src = path.join(HERE, 'cache', f);
    if (!fs.existsSync(src)) throw new Abort(`keeper/cache/${f} is missing — run the planner once (it caches both sources) before rehearsing offline`);
    fs.copyFileSync(src, path.join(keeper, 'cache', f));
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'trackrecord')).filter((f) => /^record-\w+\.jsonl$/.test(f))) fs.copyFileSync(path.join(ROOT, 'trackrecord', f), path.join(repo, 'trackrecord', f));
  fs.writeFileSync(path.join(repo, 'trackrecord', 'decisions.jsonl'), '');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(repo, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  // Inside the scratch repo so that its `import 'viem'` resolves.
  fs.writeFileSync(path.join(repo, 'rehearsal-hook.mjs'), HOOK_SOURCE);
  return { repo, keeper, ledger: path.join(repo, 'trackrecord', 'decisions.jsonl'), hook: path.join(repo, 'rehearsal-hook.mjs') };
}

function run(env, script, args, label, extraEnv = {}) {
  const shown = `node keeper/${script} ${args.join(' ')}`;
  console.log(`$ ${shown}${Object.keys(extraEnv).length ? `   [env ${Object.keys(extraEnv).join(', ')}]` : ''}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(env.keeper, script), ...args], {
    cwd: env.repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GITHUB_RUN_ID: '', GITHUB_WORKFLOW: '', GITHUB_ACTIONS: '', KEEPER_PK: '', BIDDER_PK: '', COINGECKO_API_KEY: '', ...extraEnv },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const line of out.split('\n')) if (line.trim()) console.log(`    | ${line}`);
  console.log(`    exit=${r.status} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  REPORT.commands.push({ basket: CURRENT, label, cmd: shown, env: Object.keys(extraEnv), exit: r.status, seconds: (Date.now() - t0) / 1000 });
  return { status: r.status, out };
}
const refused = (r, re) => r.status === 1 && /REFUSED:/.test(r.out) && (!re || re.test(r.out));

// ------------------------------------------------------------------ anvil
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function startAnvil() {
  const bin = fs.existsSync(path.join(O.foundry, 'anvil')) ? path.join(O.foundry, 'anvil') : 'anvil';
  const args = ['--port', String(O.port), '--host', '127.0.0.1', '--auto-impersonate', '--fork-url', GIWA_RPC, '--compute-units-per-second', '100', '--retries', '8', '--fork-retry-backoff', '2000', '--timeout', '45000'];
  if (O.forkBlock) args.push('--fork-block-number', String(O.forkBlock));
  const logPath = path.join(O.work, 'anvil.log');
  const fd = fs.openSync(logPath, 'w');
  log(`anvil ${args.join(' ')} (log ${logPath})`);
  const child = spawn(bin, args, { stdio: ['ignore', fd, fd] });
  let exited = null;
  child.on('exit', (c) => { exited = c ?? -1; });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited != null) throw new Error(`anvil exited (${exited})`);
    try { if (Number(await rpc('eth_chainId')) === GIWA_CHAIN_ID) return child; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('anvil did not come up in 120 s');
}

// --------------------------------------------------------------- chain side
let reader;
let pc;
const wallets = {};
const walletFor = (a) => (wallets[a] ??= createWalletClient({ account: getAddress(a), chain: chainFor(RPC, GIWA_CHAIN_ID), transport: http(RPC) }));
async function tx(from, { address, abi = VAULT_ABI, functionName, args = [], gas = 3_000_000n }) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: getAddress(from) });
  const hash = await walletFor(from).writeContract({ ...request, gas });
  // viem re-checks the receipt only when the block number moves; an idle
  // auto-mining anvil makes no further block, so a receipt that was not yet
  // there at the first look is waited for until the timeout (seen under load:
  // the faucet tx mined in the next block, the wait ran out at 180 s). Ask
  // for the receipt directly once the wait gives up.
  let rc;
  try { rc = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 30_000 }); } catch (e) {
    rc = await pc.getTransactionReceipt({ hash }).catch(() => null);
    if (!rc) throw e;
  }
  if (rc.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return rc;
}
const fund = (a) => rpc('anvil_setBalance', [a, '0x' + (10n ** 21n).toString(16)]);
const snapshot = () => rpc('evm_snapshot');
const revert = async (id) => { const ok = await rpc('evm_revert', [id]); if (!ok) throw new Error(`evm_revert ${id} failed`); };

/** The daily mark, emulated: step each chain reference to the plan's price in
 *  in-band posts from the keeper (what paper-index.mjs does on the day) —
 *  with --mark-offset-bps, that many bp above it for every other name and
 *  below it for the rest, as a mark made at another time of the day is. */
async function markToPlan(keeper, vault, plan) {
  let posts = 0;
  let k = 0;
  for (const r of plan.registry) {
    if (r.inRemoval) continue;
    let cur = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: 'refPrice', args: [r.address] });
    const off = BigInt(O.markOffsetBps) * (k++ % 2 === 0 ? 1n : -1n);
    const target = (BigInt(r.planRefPrice) * (10_000n + off)) / 10_000n;
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

async function fillsSince(vault, fromBlock) {
  // A run refused before it sent anything mined no block: nothing to read
  // (anvil rejects a from-block past the head).
  if (fromBlock > BigInt(await rpc('eth_blockNumber'))) return [];
  const v = await readVault(reader, vault);
  const logs = await pc.getLogs({ address: vault, event: AUCTION_FILLED, fromBlock, toBlock: 'latest' });
  const rows = [];
  for (const l of logs) {
    const a = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: 'auctions', args: [l.args.id] });
    const blk = await pc.getBlock({ blockNumber: l.blockNumber });
    const elapsed = Number(blk.timestamp - BigInt(a[3]));
    const factor = 10_000 + Number(v.premiumBps) - Math.floor(((Number(v.premiumBps) + Number(v.maxFillLossBps)) * elapsed) / Number(a[4]));
    rows.push({ id: l.args.id.toString(), bidder: getAddress(l.args.bidder), sell: getAddress(a[0]), buy: getAddress(a[1]), sellTaken: l.args.sellTaken, buyPaid: l.args.buyPaid, lossAtRef: l.args.lossAtRef, factor, open: a[5], sellRemaining: a[2] });
  }
  return rows;
}

/** A creation in window 1 must be ONE transaction, as it would be on the
 *  chain: the holder is funded and has approved every asset (registry and
 *  adds) before the session, so the hook only sends create(). Funded for
 *  --create-shares shares at the larger of today's balance and the plan's
 *  post-session balance per share (an add has none today and its target
 *  after the first auctions), times 2; at least the 3 faucet calls per asset
 *  of the earlier runs. */
async function prefundHolder(F) {
  const v = await readVault(reader, F.vault);
  const tokens = [...v.assets.map((a) => a.address), ...F.plan.adds.map((a) => getAddress(a.address))];
  const value = v.assets.reduce((t, x) => t + x.balance * x.refPrice, 0n);
  const symOfAddr = (a) => F.plan.registry.find((x) => getAddress(x.address) === a)?.symbol ?? F.plan.adds.find((x) => getAddress(x.address) === a)?.symbol;
  let calls = 0;
  for (const a of tokens) {
    const on = v.assets.find((x) => x.address === a);
    const ref = on?.refPrice || BigInt(F.plan.adds.find((x) => getAddress(x.address) === a)?.firstRefPrice ?? 0);
    const aim = F.plan.targets.find((t) => t.symbol === symOfAddr(a))?.tradeTargetWeight ?? 0;
    const post = ref > 0n ? BigInt(Math.ceil((aim * Number(value)) / Number(ref))) : 0n;
    const perVault = (on?.balance ?? 0n) > post ? on.balance : post;
    const need = v.totalSupply > 0n ? (perVault * O.createShares * 10n ** 18n * 2n) / v.totalSupply : 0n;
    const faucetAmount = await pc.readContract({ address: a, abi: FAUCET_ABI, functionName: 'faucetAmount' });
    let bal = await pc.readContract({ address: a, abi: ERC20_ABI, functionName: 'balanceOf', args: [DEV.holder] });
    for (let i = 0; i < 3 || (bal < need && i < 400); i++) { await tx(DEV.holder, { address: a, abi: ERC20_ABI, functionName: 'faucet', gas: 150_000n }); bal += faucetAmount; calls++; }
    if (bal < need) throw new Abort(`holder cannot be funded for ${O.createShares} shares of ${a} (${bal} < ${need} after 400 faucet calls)`);
    await tx(DEV.holder, { address: a, abi: ERC20_ABI, functionName: 'approve', args: [F.vault, maxUint256], gas: 100_000n });
  }
  log(`holder funded for ${O.createShares} shares (${calls} faucet calls over ${tokens.length} assets) and approved`);
}

async function redeemOne(vault) {
  const v = await readVault(reader, vault);
  const rc = await tx(DEV.holder, { address: vault, functionName: 'redeem', args: [10n ** 18n, DEV.holder], gas: 5_000_000n });
  return { assetCount: v.assetCount, gas: rc.gasUsed };
}

// --------------------------------------------------------------- one basket
async function prepare(env, index, pending) {
  const rb = JSON.parse(fs.readFileSync(path.join(env.keeper, 'rulebooks', `${index}.json`), 'utf8'));
  const vault = getAddress(rb.basket.vault);
  const v0 = await readVault(reader, vault);
  const owner = v0.owner;
  for (const a of [owner, DEV.bidder, DEV.holder, DEV.stranger, DEV.decoyDeployer]) await fund(a);
  await tx(owner, { address: vault, abi: EXTRA_ABI, functionName: 'transfer', args: [DEV.holder, 2_000n * 10n ** 18n] });
  log(`${TICKER[index]} ${vault}: ${v0.assetCount} assets, owner=keeper ${owner}, work order adds [${pending.adds.map((a) => a.symbol).join(',')}] removes [${pending.removes.map((a) => a.symbol).join(',')}]`);
  return { rb, vault, owner, v0 };
}

const bidderArg = () => (O.keeperBids ? [] : ['--bidder', BIDDER]);
const recon = (index, stage, planFile, extra = []) => ['--index', index, '--stage', stage, '--rpc', RPC, '--plan', planFile, ...extra];

async function flowToDay7(env, index) {
  const pending = JSON.parse(fs.readFileSync(path.join(env.keeper, `pending-registry-${index}.json`), 'utf8'));
  const B = await prepare(env, index, pending);
  const live = ['--live', '--from', B.owner];
  if (O.keeperBids) BIDDER = B.owner;
  // With no separate bidder the tools are called as the workflows call them
  // without a BIDDER_PK: no --genesis-to, no --bidder.
  const genesisTo = O.keeperBids ? [] : ['--genesis-to', BIDDER];
  const planFile = path.join(env.keeper, 'plans', index, `${O.date}.json`);
  const mocksFile = path.join(env.keeper, 'mocks', `${O.date}.json`);

  // 1. bidder
  let r = run(env, 'set-bidder.mjs', ['--bidder', BIDDER, '--index', index, '--rpc', RPC, ...live], 'set-bidder');
  const isB = await pc.readContract({ address: B.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [BIDDER] });
  const logLine = fs.existsSync(path.join(env.keeper, 'bidder-log.jsonl')) ? fs.readFileSync(path.join(env.keeper, 'bidder-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.index === index) : null;
  if (O.keeperBids) check('set-bidder: the keeper is whitelisted already, nothing sent, nothing logged', r.status === 0 && isB && /already true — nothing to send/.test(r.out) && !logLine, `${BIDDER} isBidder ${isB}`, 'setup');
  else check('set-bidder: separate bidder whitelisted, tx logged in bidder-log.jsonl', r.status === 0 && isB && !!logLine?.txHash && logLine.isBidderAfter === true, `${BIDDER} isBidder ${isB}; tx ${logLine?.txHash ?? '—'}`, 'setup');
  r = run(env, 'set-bidder.mjs', ['--bidder', BIDDER, '--index', index, '--rpc', RPC, ...live], 'set-bidder again (idempotent)');
  check('set-bidder again: nothing sent', r.status === 0 && /already true — nothing to send/.test(r.out), '', 'setup');

  // 2. mocks
  r = run(env, 'deploy-mocks.mjs', ['--date', O.date, '--index', index, '--rpc', RPC, ...genesisTo, '--no-fetch', ...live], 'deploy-mocks');
  must('deploy-mocks exits 0', r.status === 0);
  const mocks = JSON.parse(fs.readFileSync(mocksFile, 'utf8'))[index];
  const addSyms = pending.adds.map((a) => a.symbol);
  const shapes = [];
  for (const s of addSyms) {
    const m = mocks?.[s];
    if (!m) { shapes.push(`${s} missing`); continue; }
    const [sym, dec, bal] = await reader.batch([
      { address: m.address, abi: ERC20_ABI, functionName: 'symbol' },
      { address: m.address, abi: ERC20_ABI, functionName: 'decimals' },
      { address: m.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [BIDDER] },
    ]);
    shapes.push(`${s} ${sym} ${dec}dec bidder ${bal}${sym === `m${s}` && Number(dec) === m.decimals && bal === BigInt(m.genesisAmount) ? '' : ' MISMATCH'}`);
  }
  check('deploy-mocks: one m{SYMBOL} mock per add, decimals as recorded, inventory with the bidder', shapes.length === addSyms.length && shapes.every((x) => !/MISMATCH|missing/.test(x)), shapes.join('; '), 'setup');
  r = run(env, 'deploy-mocks.mjs', ['--date', O.date, '--index', index, '--rpc', RPC, ...genesisTo, '--no-fetch', ...live], 'deploy-mocks again (idempotent)');
  check('deploy-mocks again: every add skipped', r.status === 0 && (r.out.match(/already deployed/g) ?? []).length === addSyms.length, '', 'setup');

  // 3. plan → draft → ledger → plan with the decision
  const planArgs = ['--index', index, '--date', O.date, '--rpc', RPC, '--mocks', mocksFile, '--no-fetch', '--duration', String(O.duration)];
  r = run(env, 'basket-plan.mjs', planArgs, 'plan (mocks, no decision)');
  must('plan exits 0', r.status === 0);
  let plan = loadPlan(planFile);
  check('plan: adds carry the deployed mock addresses; tuple waits for the decision', plan.adds.every((a) => a.address && getAddress(a.address) === getAddress(mocks[a.symbol].address) && a.decimals === mocks[a.symbol].decimals) && plan.announceTuple === null, plan.adds.map((a) => `${a.symbol} ${a.address?.slice(0, 8)}`).join(', '), 'setup');
  r = run(env, 'gen-recon-decision.mjs', ['--index', index, '--plan', planFile, '--force'], 'decision draft');
  must('decision draft written', r.status === 0);
  const draftPath = path.join(env.repo, plan.decisionFile);
  const draft = fs.readFileSync(draftPath, 'utf8');
  check('draft: no "to be deployed" address left; the TO FILL comment no longer asks for mocks', !/_to be deployed_/.test(draft) && !/mock addresses of/.test(draft.split('\n')[1]), '', 'setup');
  const decisionId = `${O.date}-${index}-basket-reconstitution`;
  fs.appendFileSync(env.ledger, JSON.stringify({ id: decisionId, file: plan.decisionFile.replace(/^trackrecord\//, ''), effectiveFrom: O.date, sha256: sha256(fs.readFileSync(draftPath)), txHash: '0xREHEARSAL-not-anchored', anchoredAt: 'rehearsal' }) + '\n');
  r = run(env, 'basket-plan.mjs', [...planArgs, '--decision', decisionId], 'plan (with the decision)');
  must('plan with decision exits 0', r.status === 0);
  plan = loadPlan(planFile);
  must('plan: announce tuple complete', !!plan.announceTuple && plan.announceTuple.adds.length === addSyms.length && plan.announceTuple.removes.length === pending.removes.length);

  // 4. announce guards
  const dupPlan = path.join(O.work, `${index}-plan-duplicate.json`);
  const t = plan.announceTuple;
  const dupTuple = t.adds.length ? { ...t, adds: [...t.adds, t.adds[0]] } : { ...t, removes: [...t.removes, t.removes[0]] };
  savePlan(dupPlan, { ...plan, announceTuple: dupTuple });
  r = run(env, 'basket-recon.mjs', recon(index, 'announce', dupPlan, live), 'announce with a duplicate address in the tuple');
  check('announce refuses a duplicate address in the tuple; nothing pending', refused(r, /duplicate address/) && (await readVault(reader, B.vault)).pendingRegistryChange === ZERO32, (r.out.match(/REFUSED: [^\n]*/) ?? [''])[0].slice(0, 160), 'announce');
  if (index === 'qrev' || index === 'triens') {
    // A wrong mock: same decimals, another name.
    const art = JSON.parse(fs.readFileSync(path.join(env.keeper, 'artifacts', 'MockConstituent.json'), 'utf8'));
    const a0 = plan.adds[0];
    const hash = await walletFor(DEV.decoyDeployer).sendTransaction({ data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: ['Mock Decoy', 'mDECOY', a0.decimals, 1n, DEV.decoyDeployer, 0n, '0x0000000000000000000000000000000000000000', 0n] }), gas: 2_500_000n });
    const decoy = getAddress((await pc.waitForTransactionReceipt({ hash })).contractAddress);
    const wrongPlan = path.join(O.work, `${index}-plan-wrong-symbol.json`);
    savePlan(wrongPlan, { ...plan, adds: plan.adds.map((a, i) => (i === 0 ? { ...a, address: decoy } : a)), announceTuple: { ...t, adds: t.adds.map((a, i) => (i === 0 ? decoy : a)) } });
    r = run(env, 'basket-recon.mjs', recon(index, 'announce', wrongPlan, live), 'announce with a mock whose symbol is not m{SYMBOL}');
    check(`announce refuses an add whose chain symbol is not m${a0.symbol}; nothing pending`, refused(r, /is mDECOY on chain/) && (await readVault(reader, B.vault)).pendingRegistryChange === ZERO32, (r.out.match(/REFUSED: [^\n]*/) ?? [''])[0].slice(0, 160), 'announce');
  }
  r = run(env, 'basket-recon.mjs', recon(index, 'announce', planFile), 'announce dry run');
  check('announce dry run: simulated, the checks line printed, nothing sent', r.status === 0 && /checks: no duplicate address/.test(r.out) && /would announce/.test(r.out) && (await readVault(reader, B.vault)).pendingRegistryChange === ZERO32, '', 'announce');
  r = run(env, 'basket-recon.mjs', recon(index, 'announce', planFile, live), 'announce live');
  must('announce live exits 0', r.status === 0);
  const vA = await readVault(reader, B.vault);
  must('a change is pending', vA.pendingRegistryChange !== ZERO32);

  // 5. seven days, then the day's order on the chain: the daily mark, then
  // the plan, then day7. The plan sizes its auctions at the references on
  // chain and the executor refuses if they moved since (chainRefAtPlan), so
  // the mark comes first; the first re-plan here only supplies the mark's
  // target prices (the day's market price per name, planRefPrice).
  await rpc('evm_increaseTime', [Number(vA.registryDelay) + 60]);
  await rpc('evm_mine', []);
  r = run(env, 'basket-plan.mjs', planArgs, 're-plan on day 7 (tuple carried) — the mark\'s prices');
  must('re-plan while pending exits 0 and carries the tuple', r.status === 0 && /carrying the announced tuple/.test(r.out));
  plan = loadPlan(planFile);
  const posts = await markToPlan(B.owner, B.vault, plan);
  log(`daily mark emulated: ${posts} in-band reference post(s)${O.markOffsetBps ? `, each reference ±${O.markOffsetBps} bp off the plan's market price` : ''}`);
  r = run(env, 'basket-plan.mjs', planArgs, 'day-7 plan after the mark (tuple carried)');
  must('day-7 plan after the mark exits 0 and carries the tuple', r.status === 0 && /carrying the announced tuple/.test(r.out));
  plan = loadPlan(planFile);
  const vM = await readVault(reader, B.vault);
  const sized = plan.registry.filter((x) => x.chainRefAtPlan != null);
  check('day-7 plan: every held name sized at the reference now on chain (chainRefAtPlan)', sized.length === plan.registry.length && sized.every((x) => vM.assets.find((a) => a.address === getAddress(x.address))?.refPrice === BigInt(x.chainRefAtPlan)), `${sized.length}/${plan.registry.length} names`, 'plan');
  const savedPlan = path.join(O.work, `${index}-plan-day7.json`);
  savePlan(savedPlan, plan);
  const snap = await snapshot();
  return { ...B, index, pending, plan, planFile, savedPlan, snap, live, removes: plan.removes.map((x) => ({ ...x, address: getAddress(x.address) })) };
}

/** day7 from the snapshot, with an optional hook config and an optional tool. */
async function day7(env, F, { label, hook = null, script = 'basket-recon.mjs', before = null }) {
  await revert(F.snap);
  F.snap = await snapshot();
  savePlan(F.planFile, loadPlan(F.savedPlan));
  if (before) await before();
  // Straight from the node: viem caches the block number for seconds, and a
  // revert just moved it back.
  const fromBlock = BigInt(await rpc('eth_blockNumber')) + 1n;
  const extra = [...F.live, ...bidderArg(), '--warp', '--fill', 'fair', ...(hook ? ['--hook', env.hook] : [])];
  const hookLog = path.join(O.work, `${F.index}-${label.replace(/\W+/g, '-')}-hook.jsonl`);
  fs.rmSync(hookLog, { force: true });
  const r = run(env, script, recon(F.index, 'day7', F.planFile, extra), `day7 — ${label}`, hook ? { REHEARSAL_HOOK_CONFIG: JSON.stringify(hook.map((h) => ({ ...h, log: hookLog }))) } : {});
  const plan = loadPlan(F.planFile);
  const fills = await fillsSince(F.vault, fromBlock);
  const v = await readVault(reader, F.vault);
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  fs.copyFileSync(F.planFile, path.join(O.work, `${F.index}-${label.replace(/\W+/g, '-')}-plan.json`));
  return { r, plan, fills, v, hooks };
}

function baseChecks(F, res, label, { expectPending = [] } = {}) {
  const { r, plan, fills, v } = res;
  const pendSet = new Set(expectPending);
  check(`${label}: day7 exits 0, verify passed`, r.status === 0 && /verify: all checks passed/.test(r.out), (r.out.match(/verify: [^\n]*/) ?? ['no verify line'])[0]);
  check(`${label}: every fill by the ${O.keeperBids ? 'keeper key (no separate bidder)' : 'separate bidder'}, lossAtRef 0`, fills.every((f) => f.bidder === getAddress(BIDDER) && f.lossAtRef === 0n), `${fills.length} fill(s)`);
  const planned = plan.fills.filter((f) => typeof f.seq === 'number');
  const residualFills = plan.fills.filter((f) => typeof f.seq !== 'number');
  check(`${label}: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp)`, planned.every((f) => f.factorBps >= 10_000 && f.factorBps <= 10_010) && residualFills.every((f) => f.policy === 'fair' ? f.factorBps >= 10_000 && f.factorBps <= 10_010 : f.factorBps <= 10_200 && f.factorBps >= 10_000), `planned ${planned.map((f) => f.factorBps).join(',') || '—'}; remnants ${residualFills.map((f) => `${f.seq}:${f.policy}:${f.factorBps}`).join(',') || '—'}`);
  const gone = F.removes.filter((x) => !v.assets.some((a) => a.address === x.address)).map((x) => x.symbol);
  const left = F.removes.filter((x) => v.assets.some((a) => a.address === x.address)).map((x) => x.symbol);
  check(`${label}: removals finalized${pendSet.size ? ` except PENDING ${[...pendSet].join(',')}` : ''}`, left.every((s) => pendSet.has(s)) && [...pendSet].every((s) => left.includes(s)), `finalized [${gone.join(',') || '—'}], still in registry [${left.join(',') || '—'}]; plan.finalize ${plan.finalize.map((f) => f.symbol).join(',') || '—'}; finalizePending ${(plan.finalizePending ?? []).map((p) => `${p.symbol}(${p.attempts})`).join(',') || '—'}`);
  check(`${label}: every add in the registry with a reference`, F.plan.adds.every((a) => v.assets.some((x) => x.address === getAddress(a.address) && x.refPrice > 0n)), `assetCount ${v.assetCount}`);
}

/** Seconds one auction takes on the public chain: the executor's aim point
 *  of an 1,800 s auction (1,166 s) plus four transactions (open, two
 *  same-value re-posts, fill) — the planner spec of 2026-10-01 §2 uses
 *  1,196 s. Only an estimate for the report; nothing here waits on it. */
const PUBLIC_SECONDS_PER_AUCTION = 1_196;

/**
 * The planner spec's acceptance checks (2026-10-01 §4) on a session with no
 * interference: the planned auctions filled as sized, no residual round,
 * every traded name within the bound fair fills allow of its trade target,
 * the vault against the book, the untraded sleeves untouched. The bound is
 * re-derived here, not imported from the executor:
 *   window × (bought_i + aim_i × bought) / V + (traded × $1 + fills × maxRef) / V
 * with the executor's fair window (10 bp) and the plan's $1 minimum.
 */
function sessionChecks(F, res, label) {
  const plan = F.plan; // the day-7 plan as made, before the run
  const fills = res.plan.fills;
  const symOf = (addr) => plan.registry.find((x) => getAddress(x.address) === addr)?.symbol ?? plan.adds.find((x) => x.address && getAddress(x.address) === addr)?.symbol ?? addr;
  const rows = res.v.assets.map((a) => ({ symbol: symOf(a.address), balance: a.balance, ref: a.refPrice }));
  const V = rows.reduce((t, r) => t + Number(r.balance * r.ref), 0);
  const w = Object.fromEntries(rows.map((r) => [r.symbol, Number(r.balance * r.ref) / V]));
  const tgt = Object.fromEntries(plan.targets.map((t) => [t.symbol, t]));
  const refOf = Object.fromEntries(rows.map((r) => [r.symbol, r.ref]));

  // 1. the planned auctions, as sized
  const planned = fills.filter((f) => typeof f.seq === 'number' && f.round === 1);
  const mism = plan.trades.filter((t) => planned.filter((f) => f.seq === t.seq).length !== 1 || planned.find((f) => f.seq === t.seq).sellTaken !== String(t.sellAmount));
  check(`${label}: every planned auction filled once, for the amount the plan sized (${plan.trades.length})`, mism.length === 0 && planned.length === plan.trades.length, mism.length ? `differ: ${mism.map((t) => `#${t.seq} ${t.sell}→${t.buy} planned ${t.sellAmount} took ${planned.find((f) => f.seq === t.seq)?.sellTaken ?? '—'}`).join('; ')}` : `${planned.length} fill(s)`, 'spec §4');
  // 2. nothing left for a residual round
  const extra = fills.filter((f) => !(typeof f.seq === 'number' && f.round === 1));
  check(`${label}: no residual round and no re-drain (no creation or redemption in the session)`, extra.length === 0, extra.map((f) => `${f.seq}/r${f.round}`).join(', ') || 'none', 'spec §4');
  // 3. traded names inside the fill bound
  const bought = {};
  let boughtAll = 0;
  for (const f of fills) { const v = Number(BigInt(f.buyPaid) * (refOf[f.buy] ?? 0n)); bought[f.buy] = (bought[f.buy] ?? 0) + v; boughtAll += v; }
  const n = plan.targets.filter((t) => t.traded).length;
  const maxRef = rows.reduce((m, r) => (r.ref > m ? r.ref : m), 0n);
  const slack = (n * 1e18 + fills.length * Number(maxRef)) / V;
  const bound = (s) => (0.001 * ((bought[s] ?? 0) + Math.max(0, tgt[s]?.tradeTargetWeight ?? 0) * boughtAll)) / V + slack;
  const traded = rows.filter((r) => tgt[r.symbol]?.traded);
  const worstAim = traded.map((r) => ({ s: r.symbol, gap: w[r.symbol] - tgt[r.symbol].tradeTargetWeight, b: bound(r.symbol) })).sort((a, b) => Math.abs(b.gap) / b.b - Math.abs(a.gap) / a.b)[0] ?? { s: '—', gap: 0, b: 0 };
  const outside = traded.filter((r) => Math.abs(w[r.symbol] - tgt[r.symbol].tradeTargetWeight) > bound(r.symbol));
  check(`${label}: every traded name within the fill bound of its trade target`, outside.length === 0, `${traded.length} traded; closest to its bound ${worstAim.s} ${(worstAim.gap * 100).toFixed(5)} pt (bound ${(worstAim.b * 100).toFixed(5)} pt)${outside.length ? `; OUTSIDE ${outside.map((r) => r.symbol).join(',')}` : ''}`, 'spec §4');
  // 4. against the book (the same references the plan valued the book at)
  const gaps = rows.map((r) => ({ s: r.symbol, gap: w[r.symbol] - (tgt[r.symbol]?.targetWeight ?? 0) })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const sleeveOf = (s) => tgt[s]?.sleeve ?? 'quality';
  let bookDetail = `largest gap to the book ${gaps[0]?.s} ${((gaps[0]?.gap ?? 0) * 100).toFixed(4)} pt`;
  if (plan.policy.sleeve) {
    const sl = {};
    for (const r of rows) { const k = sleeveOf(r.symbol); sl[k] ??= { w: 0, b: 0 }; sl[k].w += w[r.symbol]; sl[k].b += tgt[r.symbol]?.targetWeight ?? 0; }
    bookDetail += `; sleeves ${Object.entries(sl).map(([k, x]) => `${k} ${((x.w - x.b) * 100).toFixed(4)} pt`).join(', ')}`;
    const fixedRows = plan.registry.filter((x) => !tgt[x.symbol]?.traded);
    const moved = fixedRows.filter((x) => res.v.assets.find((a) => a.address === getAddress(x.address))?.balance !== BigInt(x.balance));
    check(`${label}: untraded names (${fixedRows.map((x) => x.symbol).join(', ')}) hold exactly their pre-session balances`, moved.length === 0, moved.map((x) => x.symbol).join(', ') || 'unchanged', 'spec §4');
    const qGap = gaps.filter((g) => sleeveOf(g.s) === 'quality')[0];
    bookDetail += `; largest inside Quality ${qGap?.s} ${((qGap?.gap ?? 0) * 100).toFixed(4)} pt`;
  } else {
    const off = rows.filter((r) => Math.abs(w[r.symbol] - (tgt[r.symbol]?.targetWeight ?? 0)) > bound(r.symbol));
    check(`${label}: every name at its book weight within the fill bound`, off.length === 0, `${bookDetail}${off.length ? `; OUTSIDE ${off.map((r) => r.symbol).join(',')}` : ''}`, 'spec §4');
  }
  // 5. the entering names
  const addRows = plan.adds.map((a) => ({ s: a.symbol, bal: res.v.assets.find((x) => x.address === getAddress(a.address))?.balance ?? 0n }));
  check(`${label}: every entering name bought (balance > 0) to its book weight`, addRows.every((a) => a.bal > 0n), addRows.map((a) => `${a.s} ${(w[a.s] * 100).toFixed(3)}% vs book ${((tgt[a.s]?.targetWeight ?? 0) * 100).toFixed(3)}%`).join(', '), 'spec §4');
  const auctions = new Set(fills.map((f) => f.auctionId)).size;
  return {
    auctions, planned: plan.trades.length, residualFills: extra.length,
    publicChainEstimate: { seconds: auctions * PUBLIC_SECONDS_PER_AUCTION, hours: +((auctions * PUBLIC_SECONDS_PER_AUCTION) / 3600).toFixed(2), basis: `${auctions} auction(s) × ${PUBLIC_SECONDS_PER_AUCTION} s, one at a time; execute, first prices and finalize not included` },
    largestGapToAim: { symbol: worstAim.s, points: +(worstAim.gap * 100).toFixed(6), boundPoints: +(worstAim.b * 100).toFixed(6) },
    largestGapToBook: { symbol: gaps[0]?.s, points: +((gaps[0]?.gap ?? 0) * 100).toFixed(6) },
    bookDetail,
    weights: rows.map((r) => ({ symbol: r.symbol, vault: +(w[r.symbol] * 100).toFixed(5), book: +((tgt[r.symbol]?.targetWeight ?? 0) * 100).toFixed(5), aim: +((tgt[r.symbol]?.tradeTargetWeight ?? 0) * 100).toFixed(5) })),
  };
}

// ------------------------------------- ⑧ a job stopped mid-session, re-run
/** day7 killed by the hook at `at` (the 6-hour job limit terminates the
 *  runner), the plan file put back to the version the plan stage committed
 *  (a terminated job commits nothing), `between` (e.g. the day's mark), then
 *  day7 dispatched again. */
async function killedThenRerun(env, F, label, at, { between = null, rerunStage = 'day7' } = {}) {
  await revert(F.snap);
  F.snap = await snapshot();
  savePlan(F.planFile, loadPlan(F.savedPlan));
  const fromBlock = BigInt(await rpc('eth_blockNumber')) + 1n;
  const extra = [...F.live, ...bidderArg(), '--warp', '--fill', 'fair'];
  const hookLog = path.join(O.work, `${F.index}-${label.replace(/\W+/g, '-')}-hook.jsonl`);
  fs.rmSync(hookLog, { force: true });
  const r1 = run(env, 'basket-recon.mjs', recon(F.index, 'day7', F.planFile, [...extra, '--hook', env.hook]), `day7 — ${label} (killed)`, { REHEARSAL_HOOK_CONFIG: JSON.stringify([{ ...at, action: 'kill', max: 1, log: hookLog }]) });
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const fillsAtKill = await fillsSince(F.vault, fromBlock);
  savePlan(F.planFile, loadPlan(F.savedPlan));
  if (between) await between();
  const r2 = run(env, 'basket-recon.mjs', recon(F.index, rerunStage, F.planFile, rerunStage === 'verify' ? [] : extra), `${rerunStage} — ${label} (re-run)`);
  const plan = loadPlan(F.planFile);
  const fills = await fillsSince(F.vault, fromBlock);
  const v = await readVault(reader, F.vault);
  fs.copyFileSync(F.planFile, path.join(O.work, `${F.index}-${label.replace(/\W+/g, '-')}-plan.json`));
  return { r: r2, r1, r2, hooks, fillsAtKill, plan, fills, v, fromBlock };
}

/** Every planned trade sold exactly once on chain, for its planned amount
 *  (a drain: the balance), and nothing else filled. */
function onceOnChain(F, res, label) {
  const per = F.plan.trades.map((t) => {
    const hits = res.fills.filter((f) => f.sell === getAddress(t.sellAddress) && f.buy === getAddress(t.buyAddress));
    return { t, hits };
  });
  const bad = per.filter(({ t, hits }) => hits.length !== 1 || (!t.drain && hits[0].sellTaken !== BigInt(t.sellAmount)));
  check(`${label}: every planned auction sold exactly once on chain, for its planned amount; nothing else filled`, bad.length === 0 && res.fills.length === F.plan.trades.length, bad.length ? bad.map(({ t, hits }) => `#${t.seq} ${t.sell}→${t.buy} fills ${hits.length}${hits.length ? ` took ${hits.map((h) => h.sellTaken).join('+')} planned ${t.sellAmount}` : ''}`).join('; ') : `${res.fills.length} fill(s) on chain for ${F.plan.trades.length} planned`, '⑧');
}

async function stopResume(env, F) {
  const index = F.index;
  const drain = F.plan.trades.find((t) => t.drain);
  const plain = F.plan.trades.filter((t) => !t.drain);
  const late = plain[Math.min(plain.length - 1, Math.floor(plain.length * 0.6))];
  if (drain) {
    const res = await killedThenRerun(env, F, 'stopped after a drain fill', { point: 'after-fill', seq: drain.seq });
    check(`⑧a the job is killed right after the ${drain.sell} drain fill (#${drain.seq}), before its finalize`, res.r1.status === 137 && res.hooks.length === 1 && res.fillsAtKill.length === drain.seq, `exit ${res.r1.status}; ${res.fillsAtKill.length} fill(s) mined before the kill`, '⑧');
    baseChecks(F, res, '⑧a re-run');
    onceOnChain(F, res, '⑧a re-run');
    const adopted = res.plan.fills.filter((f) => f.adopted);
    check('⑧a the re-run records the killed run\'s fills from the chain (the plan file had none of them)', adopted.length > 0 && adopted.length === res.fillsAtKill.length && adopted.every((f) => typeof f.seq === 'number'), `adopted #${adopted.map((f) => f.seq).join(',')}`, '⑧');
    sessionChecks(F, res, '⑧a re-run');
    // ⑨ the next day's mark moves every reference; verify on the same plan
    const v0 = await readVault(reader, F.vault);
    let k = 0;
    for (const a of v0.assets.filter((x) => !x.inRemoval)) {
      const next = (a.refPrice * (k++ % 2 ? 9_700n : 10_300n)) / 10_000n;
      await tx(F.owner, { address: F.vault, functionName: 'setRefPrice', args: [a.address, next], gas: 150_000n });
    }
    const rv = run(env, 'basket-recon.mjs', recon(index, 'verify', F.planFile), 'verify after a later mark (every reference ±3%)');
    check('⑨ verify after a later mark (every reference ±3%): a finished session still passes', rv.status === 0 && /verify: all checks passed/.test(rv.out), (rv.out.match(/verify: [^\n]*/) ?? [`exit ${rv.status}`])[0], '⑨');
  }
  {
    const res = await killedThenRerun(env, F, 'stopped with an auction open', { point: 'before-fill', seq: late.seq });
    const killedId = res.hooks[0]?.auctionId;
    const a = killedId != null ? await pc.readContract({ address: F.vault, abi: VAULT_ABI, functionName: 'auctions', args: [BigInt(killedId)] }) : null;
    check(`⑧b the job is killed with auction ${killedId ?? '?'} (#${late.seq}) open at its fair point`, res.r1.status === 137 && res.hooks.length === 1, `exit ${res.r1.status}; ${res.fillsAtKill.length} fill(s) mined before the kill`, '⑧');
    check('⑧b the re-run cancels the auction the killed run left open; it is never filled', !!a && a[5] === false && !res.fills.some((f) => f.id === String(killedId)) && /left open by an earlier run|still open from an earlier run/.test(res.r2.out), `auction ${killedId}: open ${a?.[5]}, sellRemaining ${a?.[2]}`, '⑧');
    baseChecks(F, res, '⑧b re-run');
    onceOnChain(F, res, '⑧b re-run');
    sessionChecks(F, res, '⑧b re-run');
  }
  {
    const r0 = F.plan.registry.find((x) => !x.inRemoval && x.chainRefAtPlan != null && !F.plan.trades.some((t) => t.sell === x.symbol && t.drain));
    const res = await killedThenRerun(env, F, 'stopped, then the mark moved a reference', { point: 'before-fill', seq: late.seq }, {
      between: async () => {
        const cur = BigInt(r0.chainRefAtPlan);
        await tx(F.owner, { address: F.vault, functionName: 'setRefPrice', args: [getAddress(r0.address), cur + cur / 1000n], gas: 150_000n });
      },
    });
    const killedId = res.hooks[0]?.auctionId;
    const a = killedId != null ? await pc.readContract({ address: F.vault, abi: VAULT_ABI, functionName: 'auctions', args: [BigInt(killedId)] }) : null;
    check(`⑧c after the mark moved ${r0.symbol} the re-run records the killed run's fills, cancels its open auction, then refuses`, refused(res.r2, /moved since the plan sized its auctions/) && res.fillsAtKill.length > 0 && res.plan.fills.length === res.fillsAtKill.length && res.plan.fills.every((f) => f.adopted) && !!a && a[5] === false, `${(res.r2.out.match(/REFUSED: [^\n]*/) ?? [`exit ${res.r2.status}`])[0].slice(0, 160)}; recorded ${res.plan.fills.length}/${res.fillsAtKill.length}`, '⑧');
    // The RUNBOOK's resume: the work order is done (executed), a plan with --reweight-block, auctions, verify.
    const pendingFile = path.join(env.keeper, `pending-registry-${index}.json`);
    const planArgs = ['--index', index, '--date', O.date, '--rpc', RPC, '--mocks', path.join(env.keeper, 'mocks', `${O.date}.json`), '--no-fetch', '--duration', String(O.duration)];
    fs.copyFileSync(F.planFile, path.join(O.work, `${index}-stop-c-first-plan-records.json`));
    fs.renameSync(pendingFile, `${pendingFile}.executed`);
    try {
      let r = run(env, 'basket-plan.mjs', planArgs, 'resume plan without --reweight-block (what it misses)');
      const p1 = r.status === 0 ? loadPlan(F.planFile) : null;
      r = run(env, 'basket-plan.mjs', [...planArgs, '--reweight-block'], 'resume plan with --reweight-block');
      const p2 = r.status === 0 ? loadPlan(F.planFile) : null;
      check('⑧c resume: a plan made after execute sees no add; without --reweight-block it trades less than the block, with it the whole block', !!p1 && !!p2 && p2.adds.length === 0 && p2.trades.length > 0 && p2.targets.every((t) => t.traded) && p2.notes.some((x) => /--reweight-block/.test(x)) && p1.trades.length <= p2.trades.length, `without: ${p1?.trades.length ?? '—'} auction(s), traded ${p1?.targets.filter((t) => t.traded).length ?? '—'}/${p1?.targets.length ?? '—'}; with: ${p2?.trades.length ?? '—'} auction(s), traded ${p2?.targets.filter((t) => t.traded).length ?? '—'}/${p2?.targets.length ?? '—'}`, '⑧');
      if (p2) {
        const savedP2 = path.join(O.work, `${index}-stop-c-resume-plan.json`);
        savePlan(savedP2, p2);
        const from2 = BigInt(await rpc('eth_blockNumber')) + 1n;
        r = run(env, 'basket-recon.mjs', recon(index, 'auctions', F.planFile, [...F.live, ...bidderArg(), '--warp', '--fill', 'fair']), 'auctions with the resume plan');
        const ra = r;
        r = run(env, 'basket-recon.mjs', recon(index, 'verify', F.planFile), 'verify with the resume plan');
        const after = loadPlan(F.planFile);
        const v = await readVault(reader, F.vault);
        const fills2 = await fillsSince(F.vault, from2);
        check('⑧c resume: auctions and verify pass; every removal finalized', ra.status === 0 && r.status === 0 && /verify: all checks passed/.test(r.out) && F.removes.every((x) => !v.assets.some((q) => q.address === x.address)), `${fills2.length} fill(s); ${(r.out.match(/verify: [^\n]*/) ?? [`exit ${r.status}`])[0]}`, '⑧');
        sessionChecks({ ...F, plan: loadPlan(savedP2) }, { plan: after, v, fills: fills2 }, '⑧c resumed session against the resume plan (the book at its references)');
      }
    } finally {
      fs.renameSync(`${pendingFile}.executed`, pendingFile);
      savePlan(F.planFile, loadPlan(F.savedPlan));
    }
  }
  {
    // ⑧d a later UTC day: auctions/day7 refuse the old plan before reading anything; verify (dry run) records first.
    const res = await killedThenRerun(env, F, 'stopped, verify records it', { point: 'before-fill', seq: late.seq }, { rerunStage: 'verify' });
    const adopted = res.plan.fills.filter((f) => f.adopted);
    check('⑧d a dry-run verify on the old plan records the stopped job\'s fills from the chain (a later UTC day\'s first step), and fails its weight checks (the session is not finished)', res.r1.status === 137 && res.fillsAtKill.length > 0 && adopted.length === res.fillsAtKill.length && res.r2.status !== 0 && /verify: \d+ check\(s\) failed/.test(res.r2.out), `recorded ${adopted.length}/${res.fillsAtKill.length}; ${(res.r2.out.match(/verify: [^\n]*/) ?? [`exit ${res.r2.status}`])[0]}`, '⑧');
    savePlan(F.planFile, loadPlan(F.savedPlan));
  }
}

// ------------------------------------------------------------- per basket
async function rehearseBasket(env, index) {
  CURRENT = index;
  console.log(`\n[day7] ===== ${TICKER[index]} =====`);
  const F = await flowToDay7(env, index);
  const removeSyms = F.removes.map((x) => x.symbol);
  const drains = F.plan.trades.filter((t) => t.drain).map((t) => t.sell);
  REPORT.baskets[index] = { vault: F.vault, adds: F.plan.adds.map((a) => `${a.symbol} ${a.address}`), removes: removeSyms, trades: F.plan.trades.length, unfundedAdds: F.plan.adds.filter((a) => !F.plan.trades.some((t) => t.buy === a.symbol)).map((a) => a.symbol) };
  check('day-7 plan: every entering name is bought by a planned auction', REPORT.baskets[index].unfundedAdds.length === 0, `${F.plan.trades.length} auction(s); traded ${F.plan.targets.filter((t) => t.traded).length}/${F.plan.targets.length} names${REPORT.baskets[index].unfundedAdds.length ? `; NOT BOUGHT ${REPORT.baskets[index].unfundedAdds.join(',')}` : ''}`, 'plan');

  // Baseline: no interference.
  const base = await day7(env, F, { label: 'baseline' });
  baseChecks(F, base, 'baseline');
  REPORT.baskets[index].session = sessionChecks(F, base, 'baseline');
  const est = REPORT.baskets[index].session.publicChainEstimate;
  log(`${TICKER[index]}: ${REPORT.baskets[index].session.auctions} auction(s) → ≈ ${est.hours} h on the public chain one at a time (${est.basis}); ${REPORT.baskets[index].session.bookDetail}`);
  const red = await redeemOne(F.vault);
  check('baseline: a holder redeems after the session', red.assetCount > 0, `assetCount ${red.assetCount}, gas ${red.gas}`);
  REPORT.baskets[index].baseline = { fills: base.plan.fills.map((f) => ({ seq: f.seq, sell: f.sell, buy: f.buy, sellTaken: f.sellTaken, buyPaid: f.buyPaid, factorBps: f.factorBps })), finalize: base.plan.finalize.map((f) => f.symbol), assetCount: base.v.assetCount };
  if (REPORT.baskets[index].unfundedAdds.length) {
    const z = REPORT.baskets[index].unfundedAdds.map((s) => { const a = F.plan.adds.find((x) => x.symbol === s); const on = base.v.assets.find((x) => x.address === getAddress(a.address)); return `${s} balance ${on?.balance}`; });
    log(`NOTE: no planned trade buys ${REPORT.baskets[index].unfundedAdds.join(', ')} — after the session: ${z.join('; ')}`);
  }

  // The plan sized its auctions at the references on chain: one reference
  // moved after the plan (a mark in between) → day7 refuses BEFORE it sends
  // execute, so the change is still pending and a new plan still sees the adds.
  {
    const r0 = F.plan.registry.find((x) => !x.inRemoval && x.chainRefAtPlan != null);
    const res = await day7(env, F, {
      label: 'reference moved after the plan',
      before: async () => {
        const cur = BigInt(r0.chainRefAtPlan);
        await tx(F.owner, { address: F.vault, functionName: 'setRefPrice', args: [getAddress(r0.address), cur + cur / 1000n], gas: 150_000n });
      },
    });
    check(`day7 refuses before execute when a reference moved after the plan (${r0.symbol} +0.1%); the change stays pending, nothing filled`, refused(res.r, /moved since the plan sized its auctions/) && res.v.pendingRegistryChange !== ZERO32 && res.plan.fills.length === 0 && !res.plan.execute, (res.r.out.match(/REFUSED: [^\n]*/) ?? [`exit ${res.r.status}`])[0].slice(0, 220), 'spec §1.3');
  }

  // ⑦ main's tool, same snapshot, same plan.
  if (O.mainRecon && F.plan.trades.length) {
    const m = await day7(env, F, { label: 'main tool', script: 'basket-recon-main.mjs' });
    // The amount sold is the criterion; what the bidder pays depends on the
    // second the fill lands in the fair window (anvil's clock runs with the
    // wall clock between warps), so it is printed, not compared.
    const a = base.plan.fills.filter((f) => typeof f.seq === 'number').map((f) => `${f.seq}:${f.sell}:${f.sellTaken}`);
    const b = m.plan.fills.filter((f) => typeof f.seq === 'number').map((f) => `${f.seq}:${f.sell}:${f.sellTaken}`);
    const factors = base.plan.fills.filter((f) => typeof f.seq === 'number').map((f, i) => `${f.seq} ${f.factorBps}/${m.plan.fills.filter((x) => typeof x.seq === 'number')[i]?.factorBps ?? '—'}`);
    check('no interference: the same fills, the same amounts sold, as the tool on main', m.r.status === 0 && a.length > 0 && a.join() === b.join(), `new [${a.join(' ')}] main [${b.join(' ')}]; factor bp new/main ${factors.join(', ')}; main exit ${m.r.status}`, '⑦');
    REPORT.baskets[index].mainTool = { fills: m.plan.fills.map((f) => ({ seq: f.seq, sell: f.sell, sellTaken: f.sellTaken, buyPaid: f.buyPaid, factorBps: f.factorBps })), finalize: m.plan.finalize.map((f) => f.symbol) };
  }

  // ⑥ a third party executes first.
  if (index === 'qrev' || index === 'qx20') {
    const t = F.plan.announceTuple;
    const res = await day7(env, F, {
      label: 'third-party execute first',
      before: async () => {
        await tx(DEV.stranger, { address: F.vault, abi: EXTRA_ABI, functionName: 'executeRegistryChange', args: [t.adds.map((a) => getAddress(a)), t.removes.map((a) => getAddress(a)), t.decisionSha256], gas: 2_000_000n });
      },
    });
    baseChecks(F, res, '⑥ third party executed');
    sessionChecks(F, res, '⑥ third party executed');
    check('day7 names the third party and continues (plan.execute.byThirdParty)', res.r.status === 0 && /executeRegistryChange is permissionless and was called by 0x90F79bf6EB2c4f870365E785982E1f101E93b906/i.test(res.r.out) && res.plan.execute?.byThirdParty === true && !!res.plan.execute.txHash, `execute tx ${res.plan.execute?.txHash ?? '—'} by ${res.plan.execute?.signer ?? '—'}`, '⑥');
  }

  if (O.stopResume) await stopResume(env, F);

  // Removal cases.
  if (index === 'qdefi') {
    const X = drains[0];
    let res = await day7(env, F, { label: 'window-1 donation', hook: [{ point: 'before-fill', symbol: X, action: 'donate', amount: '1', max: 1 }] });
    baseChecks(F, res, '① 1 base unit donated in window 1');
    const rem = res.plan.fills.filter((f) => typeof f.seq !== 'number');
    check(`${X}: donation landed in window 1 and was re-drained at once; finalized in the same run`, res.hooks.length === 1 && rem.length >= 1 && rem.every((f) => f.policy === 'open') && res.plan.finalize.some((f) => f.symbol === X) && !(res.plan.finalizePending ?? []).length, `${res.hooks.length} donation(s); remnant fills ${rem.map((f) => `${f.seq} took ${f.sellTaken} at ${f.factorBps} bp`).join(', ')}`, '①');
    res = await day7(env, F, { label: 'window-1 create', before: () => prefundHolder(F), hook: [{ point: 'before-fill', symbol: X, action: 'create', shares: String(O.createShares), max: 1 }] });
    baseChecks(F, res, `④ ${O.createShares}-share creation in window 1`);
    const rem4 = res.plan.fills.filter((f) => typeof f.seq !== 'number');
    check(`${X}: a creation's pro-rata slice in window 1 is re-drained and ${X} finalized`, res.hooks.length === 1 && rem4.length >= 1 && res.plan.finalize.some((f) => f.symbol === X), `remnant fills ${rem4.map((f) => `${f.seq} ${f.policy} took ${f.sellTaken} at ${f.factorBps} bp`).join(', ')}`, '④');
    check('④ after the creation: verify within the fill bound after the residual rounds', res.r.status === 0 && /verify: all checks passed/.test(res.r.out), `fills by round ${JSON.stringify(res.plan.fills.reduce((m, f) => ({ ...m, [f.round]: (m[f.round] ?? 0) + 1 }), {}))}`, 'spec §4');
    res = await day7(env, F, { label: 'window-1 redeem', hook: [{ point: 'before-fill', symbol: X, action: 'redeem', shares: '100', max: 1 }] });
    baseChecks(F, res, '⑤ redemption in window 1');
    const drainFill = res.plan.fills.find((f) => f.sell === X && typeof f.seq === 'number');
    const auctionAfter = drainFill ? await pc.readContract({ address: F.vault, abi: VAULT_ABI, functionName: 'auctions', args: [BigInt(drainFill.auctionId)] }) : null;
    check(`${X}: the fill shrank to the live balance, the rest of the auction was cancelled, ${X} finalized`, !!drainFill?.auctionAmount && BigInt(drainFill.sellTaken) < BigInt(drainFill.auctionAmount) && auctionAfter && auctionAfter[5] === false && res.plan.finalize.some((f) => f.symbol === X), drainFill ? `took ${drainFill.sellTaken} of an auction for ${drainFill.auctionAmount}; auction open ${auctionAfter?.[5]}` : 'no drain fill', '⑤');

    // Review 2026-10-01 (first review of the K build): a PENDING left by one
    // session must be cleared by a LATER plan's auctions stage. A later plan
    // has no auction for a remnant under the trade minimum, so the stage has
    // to drain what is in removal even with nothing planned.
    const planArgs = ['--index', index, '--date', O.date, '--rpc', RPC, '--mocks', path.join(env.keeper, 'mocks', `${O.date}.json`), '--no-fetch', '--duration', String(O.duration)];
    const pendingFile = path.join(env.keeper, `pending-registry-${index}.json`);
    const Xaddr = F.removes.find((x) => x.symbol === X).address;
    res = await day7(env, F, { label: 'donation at every attempt', hook: [{ point: 'after-fill', symbol: X, action: 'donate', amount: '1' }] });
    baseChecks(F, res, 'PENDING, then a later plan', { expectPending: [X] });
    // The work order is done once executed; the operator removes it (the
    // planner refuses a work order that no longer matches the registry).
    fs.renameSync(pendingFile, `${pendingFile}.executed`);
    try {
      let r = run(env, 'basket-plan.mjs', planArgs, 'a later plan (executed, remnant pending)');
      const later = r.status === 0 ? loadPlan(F.planFile) : null;
      check(`a later plan lists ${X} as in removal and plans no auction for a remnant under $1`, r.status === 0 && later.trades.length === 0 && later.removes.some((x) => x.symbol === X && x.inRemoval), later ? `removes ${later.removes.map((x) => `${x.symbol} balance ${x.balance} inRemoval ${x.inRemoval}`).join(', ')}; trades ${later.trades.length}` : `plan exit ${r.status}`, 'K-4');
      r = run(env, 'basket-recon.mjs', recon(index, 'auctions', F.planFile, [...F.live, ...bidderArg(), '--warp']), 'auctions with the later plan (no planned auction)');
      const v2 = await readVault(reader, F.vault);
      const after = loadPlan(F.planFile);
      check(`${X}: the auctions stage of a later plan drains and finalizes the PENDING remnant`, r.status === 0 && !v2.assets.some((a) => a.address === Xaddr) && after.finalize.some((f) => f.symbol === X) && !(after.finalizePending ?? []).length, `exit ${r.status}; in registry ${v2.assets.some((a) => a.address === Xaddr)}; finalize ${after.finalize.map((f) => f.symbol).join(',') || '—'}`, 'K-4');
      r = run(env, 'basket-recon.mjs', recon(index, 'verify', F.planFile), 'verify with the later plan');
      check('verify passes after the later drain, nothing PENDING', r.status === 0 && /verify: all checks passed$/m.test(r.out), (r.out.match(/verify: [^\n]*/) ?? ['no verify line'])[0], 'K-4');
    } finally {
      fs.renameSync(`${pendingFile}.executed`, pendingFile);
    }

    // A third party executing BEFORE the day-7 plan is made is not what K-6
    // covers (K-6: after the plan). Pinned here as it is today: the planner
    // refuses, because the work order still lists as adds what the registry
    // already holds — the manual path in the RUNBOOK applies.
    await revert(F.snap);
    F.snap = await snapshot();
    const t = F.plan.announceTuple;
    await tx(DEV.stranger, { address: F.vault, abi: EXTRA_ABI, functionName: 'executeRegistryChange', args: [t.adds.map((a) => getAddress(a)), t.removes.map((a) => getAddress(a)), t.decisionSha256], gas: 2_000_000n });
    const rp = run(env, 'basket-plan.mjs', planArgs, 'day-7 plan after a third party executed');
    check('known limit: a day-7 plan made AFTER a third party executed is refused by the planner (work order vs registry) — manual path', rp.status !== 0 && /resolve before planning/.test(rp.out), (rp.out.match(/[^\n]*resolve before planning[^\n]*/) ?? [`exit ${rp.status}`])[0].slice(0, 220), 'limit');
    savePlan(F.planFile, loadPlan(F.savedPlan));
  }
  if (index === 'qai') {
    const [X, Y] = drains;
    const res = await day7(env, F, { label: 'donations between fill and finalize', hook: [
      { point: 'after-fill', symbol: X, action: 'donate', amount: '1', max: 3 },
      { point: 'after-fill', symbol: Y, action: 'donate', amount: '1' },
    ] });
    baseChecks(F, res, '②③ donations between fill and finalize', { expectPending: [Y] });
    const remX = res.plan.fills.filter((f) => f.sell === X && typeof f.seq !== 'number');
    check(`${X}: three donations between the drain fill and the finalize, three immediate re-drains, finalized`, res.hooks.filter((h) => h.symbol === X).length === 3 && remX.length === 3 && remX.every((f) => f.policy === 'open') && res.plan.finalize.some((f) => f.symbol === X), `${remX.length} re-drain(s): ${remX.map((f) => `${f.seq}@${f.factorBps}`).join(', ')}`, '②');
    const p = (res.plan.finalizePending ?? []).find((x) => x.symbol === Y);
    const onY = res.v.assets.find((a) => a.address === F.removes.find((x) => x.symbol === Y).address);
    check(`${Y}: a donation at every attempt → PENDING after five re-drains, verify passes with PENDING, exit 0`, res.r.status === 0 && p?.attempts === 5 && /PENDING/.test(res.r.out) && new RegExp(`verify: all checks passed \\(PENDING: [^)]*\\b${Y}\\b`).test(res.r.out) && onY?.inRemoval === true && onY.balance > 0n, `finalizePending ${JSON.stringify(p ?? null)}; on chain inRemoval ${onY?.inRemoval} balance ${onY?.balance}`, '③');
    // …and the PENDING one is drained by a later auctions run without interference.
    const r2 = run(env, 'basket-recon.mjs', recon(index, 'auctions', F.planFile, [...F.live, ...bidderArg(), '--warp']), 'auctions re-run (no interference) after PENDING');
    const v2 = await readVault(reader, F.vault);
    const after = loadPlan(F.planFile);
    check(`${Y}: a later auctions run drains and finalizes the PENDING remnant`, r2.status === 0 && !v2.assets.some((a) => a.address === F.removes.find((x) => x.symbol === Y).address) && !(after.finalizePending ?? []).length, `exit ${r2.status}; finalize ${after.finalize.map((f) => f.symbol).join(',')}`, '③');
  }
  if (index === 'qx20') {
    const X = drains[0];
    const res = await day7(env, F, { label: 'one donation between fill and finalize', hook: [{ point: 'after-fill', symbol: X, action: 'donate', amount: '1', max: 1 }] });
    baseChecks(F, res, '1 base unit between drain and finalize');
    const remX = res.plan.fills.filter((f) => f.sell === X && typeof f.seq !== 'number');
    check(`${X}: one base unit between the drain fill and the finalize → one immediate re-drain, finalized in the same run`, res.hooks.length === 1 && remX.length === 1 && res.plan.finalize.some((f) => f.symbol === X), remX.map((f) => `${f.seq} took ${f.sellTaken} paid ${f.buyPaid} at ${f.factorBps} bp`).join(', '), '②');
    const Z = drains[1];
    const res2 = await day7(env, F, { label: 'window-1 create', before: () => prefundHolder(F), hook: [{ point: 'before-fill', symbol: Z, action: 'create', shares: String(O.createShares), max: 1 }] });
    baseChecks(F, res2, `④ ${O.createShares}-share creation in window 1`);
    check(`${Z}: a creation in window 1 → re-drained and finalized`, res2.hooks.length === 1 && res2.plan.finalize.some((f) => f.symbol === Z) && res2.plan.fills.some((f) => f.sell === Z && typeof f.seq !== 'number'), res2.plan.fills.filter((f) => f.sell === Z).map((f) => `${f.seq} ${f.policy} ${f.sellTaken}`).join(', '), '④');
    check('④ after the creation: verify within the fill bound after the residual rounds', res2.r.status === 0 && /verify: all checks passed/.test(res2.r.out), `fills by round ${JSON.stringify(res2.plan.fills.reduce((m, f) => ({ ...m, [f.round]: (m[f.round] ?? 0) + 1 }), {}))}`, 'spec §4');
  }
}

// ------------------------------------------------------------- the hook
const HOOK_SOURCE = `// Written by keeper/rehearse-day7.mjs — rehearsal only (anvil, impersonated accounts).
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, maxUint256 } from 'viem';
const CFG = JSON.parse(process.env.REHEARSAL_HOOK_CONFIG || '[]');
const SEEN = CFG.map(() => 0);
const STRANGER = '${DEV.stranger}';
const HOLDER = '${DEV.holder}';
const ABI = parseAbi([
  'function faucet()', 'function faucetAmount() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)', 'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)', 'function assetCount() view returns (uint256)',
  'function assets(uint256) view returns (address)', 'function create(uint256[] amounts, address receiver) returns (uint256)',
  'function redeem(uint256 shares, address receiver) returns (uint256[])',
]);
export default async function hook(point, info, api) {
  for (let i = 0; i < CFG.length; i++) {
    const c = CFG[i];
    if (c.point !== point) continue;
    if (c.seq != null ? String(info.seq) !== String(c.seq) : c.symbol !== info.symbol) continue;
    if (point === 'before-fill' && c.action !== 'kill' && (!info.drain || info.residual)) continue;
    if (c.max != null && SEEN[i] >= c.max) continue;
    SEEN[i]++;
    if (c.action === 'kill') {
      // The runner terminated (the 6-hour job limit): nothing after this line runs.
      fs.appendFileSync(c.log, JSON.stringify({ point, symbol: info.symbol, seq: String(info.seq), auctionId: info.auctionId != null ? String(info.auctionId) : null, action: 'kill' }) + '\\n');
      console.log('[hook] ' + point + ' #' + info.seq + ' ' + info.symbol + ': the job is killed here');
      process.exit(137);
    }
    const chain = { id: api.chainId, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [api.rpc] } } };
    const pc = createPublicClient({ chain, transport: http(api.rpc) });
    const send = async (from, address, functionName, args = []) => {
      const w = createWalletClient({ account: getAddress(from), chain, transport: http(api.rpc) });
      const { request } = await pc.simulateContract({ address, abi: ABI, functionName, args, account: getAddress(from) });
      const hash = await w.writeContract({ ...request, gas: 5_000_000n });
      const rc = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
      if (rc.status !== 'success') throw new Error('hook ' + functionName + ' reverted');
      return hash;
    };
    const before = await pc.readContract({ address: info.asset, abi: ABI, functionName: 'balanceOf', args: [api.vault] });
    let hash;
    if (c.action === 'donate') {
      const amt = BigInt(c.amount ?? '1');
      if ((await pc.readContract({ address: info.asset, abi: ABI, functionName: 'balanceOf', args: [STRANGER] })) < amt) await send(STRANGER, info.asset, 'faucet');
      hash = await send(STRANGER, info.asset, 'transfer', [api.vault, amt]);
    } else if (c.action === 'create') {
      const n = BigInt(c.shares);
      const { result: per } = await pc.simulateContract({ address: api.vault, abi: ABI, functionName: 'redeem', args: [10n ** 18n, HOLDER], account: getAddress(HOLDER) });
      const count = Number(await pc.readContract({ address: api.vault, abi: ABI, functionName: 'assetCount' }));
      const amounts = [];
      for (let k = 0; k < count; k++) amounts.push(per[k] * n); // funded and approved before the session
      void count;
      hash = await send(HOLDER, api.vault, 'create', [amounts, HOLDER]);
    } else if (c.action === 'redeem') {
      hash = await send(HOLDER, api.vault, 'redeem', [BigInt(c.shares) * 10n ** 18n, HOLDER]);
    }
    const after = await pc.readContract({ address: info.asset, abi: ABI, functionName: 'balanceOf', args: [api.vault] });
    fs.appendFileSync(c.log, JSON.stringify({ point, symbol: info.symbol, seq: String(info.seq), attempt: info.attempt ?? null, action: c.action, tx: hash, vaultBalanceBefore: before.toString(), vaultBalanceAfter: after.toString() }) + '\\n');
    console.log('[hook] ' + point + ' ' + info.symbol + ' ' + c.action + ': vault balance ' + before + ' -> ' + after + ' (tx ' + hash + ')');
  }
}
`;

// ---------------------------------------------------------------------- main
async function main() {
  if (process.env.GITHUB_ACTIONS === 'true') { console.error('REFUSED: a local rehearsal — not for a workflow'); process.exit(1); }
  if (O.date !== new Date().toISOString().slice(0, 10)) { console.error(`REFUSED: --date ${O.date} is not today (UTC) — the executor refuses a plan not generated today`); process.exit(1); }
  if (!Number.isInteger(O.markOffsetBps) || O.markOffsetBps < 0 || O.markOffsetBps >= 500) { console.error(`REFUSED: --mark-offset-bps ${O.markOffsetBps} — a whole number of bp under 500 (the executor refuses a reference more than 5% from the market)`); process.exit(1); }
  if (!(await portFree(O.port))) { console.error(`port ${O.port} is in use — pass --port`); process.exit(1); }
  fs.mkdirSync(O.work, { recursive: true });
  const env = setupWork();
  const want = O.index ? O.index.split(',') : ['qrev', 'qdefi', 'qai', 'qx20', 'triens'];
  const indexes = want.filter((i) => fs.existsSync(path.join(env.keeper, `pending-registry-${i}.json`)) && JSON.parse(fs.readFileSync(path.join(env.keeper, `pending-registry-${i}.json`), 'utf8')).date === O.date);
  log(`work ${O.work}; baskets ${indexes.join(', ')}; main tool for ⑦: ${O.mainRecon ?? 'none'}`);
  const anvil = await startAnvil();
  let fails = 1;
  try {
    reader = await makeReader(RPC, { chainId: GIWA_CHAIN_ID });
    pc = reader.publicClient;
    const blk = await pc.getBlock();
    REPORT.fork = { block: blk.number.toString(), timestamp: new Date(Number(blk.timestamp) * 1000).toISOString(), client: await rpc('web3_clientVersion') };
    log(`fork of ${GIWA_RPC} at block ${blk.number}`);
    for (const index of indexes) {
      const t0 = Date.now();
      try { await rehearseBasket(env, index); } catch (e) {
        if (!(e instanceof Abort)) check(`${index} aborted by an unexpected error`, false, e.shortMessage ?? e.message ?? String(e));
        else log(`${index} stopped: ${e.message}`);
      }
      log(`${index} took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    CURRENT = 'summary';
    const rows = REPORT.checks;
    fails = rows.filter((r) => !r.ok).length;
    console.log('\nbasket   criterion  result  check');
    for (const r of rows) console.log(`${r.basket.padEnd(8)} ${(r.criterion ?? '').padEnd(10)} ${r.ok ? 'PASS' : 'FAIL'}    ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    console.log(`\n[day7] ${rows.length - fails} PASS / ${fails} FAIL`);
  } finally {
    REPORT.finishedAt = new Date().toISOString();
    REPORT.fails = fails;
    fs.writeFileSync(path.join(O.work, 'report.json'), JSON.stringify(REPORT, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
    log(`report ${path.join(O.work, 'report.json')}`);
    if (O.keepAnvil) log(`anvil left running on ${RPC} (pid ${anvil.pid})`); else anvil.kill();
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e.stack ?? e.message ?? e); process.exit(1); });
