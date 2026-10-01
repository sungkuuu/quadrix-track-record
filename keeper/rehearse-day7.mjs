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
 *   mock symbol) → announce → 7 days → re-plan (tuple carried) → the daily
 *   mark, emulated → day7 (execute → first prices → auctions → finalize →
 *   verify) with the bidder as a separate account → checks
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
};
const RPC = `http://127.0.0.1:${O.port}`;

// ------------------------------------------------------------ reporting
const REPORT = { startedAt: new Date().toISOString(), date: O.date, checks: [], commands: [], baskets: {} };
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
  for (const f of ['basket-plan.mjs', 'basket-recon.mjs', 'gen-recon-decision.mjs', 'deploy-mocks.mjs', 'set-bidder.mjs', 'nav-marks.jsonl']) fs.copyFileSync(path.join(HERE, f), path.join(keeper, f));
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
  const rc = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (rc.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return rc;
}
const fund = (a) => rpc('anvil_setBalance', [a, '0x' + (10n ** 21n).toString(16)]);
const snapshot = () => rpc('evm_snapshot');
const revert = async (id) => { const ok = await rpc('evm_revert', [id]); if (!ok) throw new Error(`evm_revert ${id} failed`); };

/** The daily mark, emulated: step each chain reference to the plan's price in
 *  in-band posts from the keeper (what paper-index.mjs does on the day). */
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

async function fillsSince(vault, fromBlock) {
  const v = await readVault(reader, vault);
  const logs = await pc.getLogs({ address: vault, event: AUCTION_FILLED, fromBlock, toBlock: 'latest' });
  const rows = [];
  for (const l of logs) {
    const a = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: 'auctions', args: [l.args.id] });
    const blk = await pc.getBlock({ blockNumber: l.blockNumber });
    const elapsed = Number(blk.timestamp - BigInt(a[3]));
    const factor = 10_000 + Number(v.premiumBps) - Math.floor(((Number(v.premiumBps) + Number(v.maxFillLossBps)) * elapsed) / Number(a[4]));
    rows.push({ id: l.args.id.toString(), bidder: getAddress(l.args.bidder), sell: getAddress(a[0]), sellTaken: l.args.sellTaken, buyPaid: l.args.buyPaid, lossAtRef: l.args.lossAtRef, factor, open: a[5], sellRemaining: a[2] });
  }
  return rows;
}

/** A creation in window 1 must be ONE transaction, as it would be on the
 *  chain: the holder is funded and has approved every asset (registry and
 *  adds) before the session, so the hook only sends create(). */
async function prefundHolder(F) {
  const v = await readVault(reader, F.vault);
  const tokens = [...v.assets.map((a) => a.address), ...F.plan.adds.map((a) => getAddress(a.address))];
  for (const a of tokens) {
    for (let i = 0; i < 3; i++) await tx(DEV.holder, { address: a, abi: ERC20_ABI, functionName: 'faucet', gas: 150_000n });
    await tx(DEV.holder, { address: a, abi: ERC20_ABI, functionName: 'approve', args: [F.vault, maxUint256], gas: 100_000n });
  }
  log(`holder funded with 3 faucet calls of each of ${tokens.length} assets and approved`);
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

  // 5. seven days, then the day's order: re-plan (carried), mark, day7
  await rpc('evm_increaseTime', [Number(vA.registryDelay) + 60]);
  await rpc('evm_mine', []);
  r = run(env, 'basket-plan.mjs', planArgs, 're-plan on day 7 (tuple carried)');
  must('re-plan while pending exits 0 and carries the tuple', r.status === 0 && /carrying the announced tuple/.test(r.out));
  plan = loadPlan(planFile);
  const posts = await markToPlan(B.owner, B.vault, plan);
  log(`daily mark emulated: ${posts} in-band reference post(s)`);
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

// ------------------------------------------------------------- per basket
async function rehearseBasket(env, index) {
  CURRENT = index;
  console.log(`\n[day7] ===== ${TICKER[index]} =====`);
  const F = await flowToDay7(env, index);
  const removeSyms = F.removes.map((x) => x.symbol);
  const drains = F.plan.trades.filter((t) => t.drain).map((t) => t.sell);
  REPORT.baskets[index] = { vault: F.vault, adds: F.plan.adds.map((a) => `${a.symbol} ${a.address}`), removes: removeSyms, trades: F.plan.trades.length, unfundedAdds: F.plan.adds.filter((a) => !F.plan.trades.some((t) => t.buy === a.symbol)).map((a) => a.symbol) };

  // Baseline: no interference.
  const base = await day7(env, F, { label: 'baseline' });
  baseChecks(F, base, 'baseline');
  const red = await redeemOne(F.vault);
  check('baseline: a holder redeems after the session', red.assetCount > 0, `assetCount ${red.assetCount}, gas ${red.gas}`);
  REPORT.baskets[index].baseline = { fills: base.plan.fills.map((f) => ({ seq: f.seq, sell: f.sell, buy: f.buy, sellTaken: f.sellTaken, buyPaid: f.buyPaid, factorBps: f.factorBps })), finalize: base.plan.finalize.map((f) => f.symbol), assetCount: base.v.assetCount };
  if (REPORT.baskets[index].unfundedAdds.length) {
    const z = REPORT.baskets[index].unfundedAdds.map((s) => { const a = F.plan.adds.find((x) => x.symbol === s); const on = base.v.assets.find((x) => x.address === getAddress(a.address)); return `${s} balance ${on?.balance}`; });
    log(`NOTE: no planned trade buys ${REPORT.baskets[index].unfundedAdds.join(', ')} — after the session: ${z.join('; ')}`);
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
    check('day7 names the third party and continues (plan.execute.byThirdParty)', res.r.status === 0 && /executeRegistryChange is permissionless and was called by 0x90F79bf6EB2c4f870365E785982E1f101E93b906/i.test(res.r.out) && res.plan.execute?.byThirdParty === true && !!res.plan.execute.txHash, `execute tx ${res.plan.execute?.txHash ?? '—'} by ${res.plan.execute?.signer ?? '—'}`, '⑥');
  }

  // Removal cases.
  if (index === 'qdefi') {
    const X = drains[0];
    let res = await day7(env, F, { label: 'window-1 donation', hook: [{ point: 'before-fill', symbol: X, action: 'donate', amount: '1', max: 1 }] });
    baseChecks(F, res, '① 1 base unit donated in window 1');
    const rem = res.plan.fills.filter((f) => typeof f.seq !== 'number');
    check(`${X}: donation landed in window 1 and was re-drained at once; finalized in the same run`, res.hooks.length === 1 && rem.length >= 1 && rem.every((f) => f.policy === 'open') && res.plan.finalize.some((f) => f.symbol === X) && !(res.plan.finalizePending ?? []).length, `${res.hooks.length} donation(s); remnant fills ${rem.map((f) => `${f.seq} took ${f.sellTaken} at ${f.factorBps} bp`).join(', ')}`, '①');
    res = await day7(env, F, { label: 'window-1 create', before: () => prefundHolder(F), hook: [{ point: 'before-fill', symbol: X, action: 'create', shares: '1000', max: 1 }] });
    baseChecks(F, res, '④ 1,000-share creation in window 1');
    const rem4 = res.plan.fills.filter((f) => typeof f.seq !== 'number');
    check(`${X}: a creation's pro-rata slice in window 1 is re-drained and ${X} finalized`, res.hooks.length === 1 && rem4.length >= 1 && res.plan.finalize.some((f) => f.symbol === X), `remnant fills ${rem4.map((f) => `${f.seq} ${f.policy} took ${f.sellTaken} at ${f.factorBps} bp`).join(', ')}`, '④');
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
    const res2 = await day7(env, F, { label: 'window-1 create', before: () => prefundHolder(F), hook: [{ point: 'before-fill', symbol: Z, action: 'create', shares: '1000', max: 1 }] });
    baseChecks(F, res2, '④ 1,000-share creation in window 1');
    check(`${Z}: a creation in window 1 → re-drained and finalized`, res2.hooks.length === 1 && res2.plan.finalize.some((f) => f.symbol === Z) && res2.plan.fills.some((f) => f.sell === Z && typeof f.seq !== 'number'), res2.plan.fills.filter((f) => f.sell === Z).map((f) => `${f.seq} ${f.policy} ${f.sellTaken}`).join(', '), '④');
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
    if (c.point !== point || c.symbol !== info.symbol) continue;
    if (point === 'before-fill' && (!info.drain || info.residual)) continue;
    if (c.max != null && SEEN[i] >= c.max) continue;
    SEEN[i]++;
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
