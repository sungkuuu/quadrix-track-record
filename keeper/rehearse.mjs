#!/usr/bin/env node
/**
 * Basket reconstitution rehearsal — one command, local anvil only.
 *
 *   node keeper/rehearse.mjs                      # fork GIWA Sepolia at the latest block
 *   node keeper/rehearse.mjs --fresh              # fresh anvil + DeployIndexBasket instead
 *   node keeper/rehearse.mjs --scenario qrev-adds # one scenario
 *
 * Starts `anvil --auto-impersonate` forking GIWA Sepolia (falling back to a
 * fresh anvil chain deployed with the site repo's DeployIndexBasket script
 * when the public RPC refuses or throttles the fork), then drives the REAL
 * keeper/basket-plan.mjs and keeper/basket-recon.mjs — in their
 * `--rpc <local> --live --from <unlocked owner>` rehearsal mode — through the
 * whole cycle for three scenarios:
 *
 *   qrev-adds    qREV 10 → 15: five stand-in adds, announce → 7 days →
 *                execute → first prices → auctions → verify
 *   qx20-swap    qX20-like: two removes + two adds; drains, finalizeRemoval's
 *                swap-and-pop order, and a dust-donation griefing variant
 *   qduo-sleeve  qDUO sleeve-ratio reset: weight-only auctions, no registry
 *                change (announce must refuse, the daily mark must run first)
 *
 * and asserts the safety design's pass/fail list, each line a PASS/FAIL row:
 *   - a holder can redeem at every stage (before announce, after announce,
 *     after execute before first prices, mid-auction, after finalize) and the
 *     payout has one slice per registry asset, nonzero for every asset with
 *     balance — checked with a real redeem, not only a simulation;
 *   - share value at reference prices is continuous across the session
 *     (fair-point fills move nothing; the only drift allowed is the streaming
 *     fee over the warped days);
 *   - no fill under --fill fair books lossAtRef != 0 or lands outside the
 *     fair window (read back from AuctionFilled logs, not from the script);
 *   - every first reference price equals source A and is within the
 *     tolerance of source B, and a 5% disagreement is refused;
 *   - registry order and assetCount after finalizeRemoval match an
 *     independent swap-and-pop simulation;
 *   - redeem gas at the enlarged registry (22 assets transiently for qX20)
 *     stays under the block gas limit and the deploy test's 1.5M bound;
 *   - a one-unit donation to a leaving asset blocks finalizeRemoval and the
 *     runner reports it (finalize exits 1, auctions exits 1 after its bounded
 *     rounds) instead of looping or sending anything;
 *   - a second announce while one is pending is refused; announcing an
 *     un-anchored decision is refused; execute before the eta is refused;
 *   - a creation vector of the new registry length in chain order is accepted
 *     and the old length reverts LengthMismatch (the desk's outage window);
 *   - the plan's expected post-trade weights agree with its trade targets
 *     (they are what the decision draft prints for anchoring), and the
 *     generator refuses to render a plan whose two disagree;
 *   - a decision of another basket is refused by the planner and the
 *     executor; an empty (weight-only) change is never announced — the
 *     planner leaves the tuple null even with a decision, the executor
 *     refuses an empty tuple; a re-plan while a change is pending carries the
 *     announced tuple verbatim (order included) and refuses a book that no
 *     longer matches it; a missed fair window is retried at most three
 *     times, then the runner stops with the duration guidance.
 *
 * Nothing here touches the record repository: the keeper scripts, rulebooks
 * and state files are copied into a scratch repo under --work, plan files,
 * price caches and the draft decisions land there, and the contracts are
 * built from a copy of the site repo's contracts/ (so `forge build` and the
 * fresh-mode `forge script --broadcast` never write into either checkout).
 * Prices are synthetic and offline (source A = the chain's own references
 * plus fixed stand-in prices, source B = A + 12 bp), so the run does not
 * depend on CoinGecko or CoinPaprika. Books are derived from the vault's own
 * balances and then transformed per scenario (rehearsal-only shapes, not
 * keeper output). Signers are anvil's public dev accounts and the vault's own
 * owner, impersonated; no key file is read, no secret is used, and the only
 * RPC anything writes to is the anvil this script started on 127.0.0.1.
 *
 * Exit status is 1 when any check fails. LOCAL ONLY: this must not be wired
 * into a GitHub Actions workflow (it refuses to run under GITHUB_ACTIONS) —
 * the point is zero Actions minutes and no shared runner near a keeper key.
 *
 * Options:
 *   --scenario a,b       qrev-adds | qx20-swap | qduo-sleeve | 1 | 2 | 3 (default all)
 *   --port n             anvil port (default 8570; must be free)
 *   --fresh              skip the fork, deploy fresh vaults with DeployIndexBasket
 *   --fork-url URL       upstream for the fork (default the GIWA Sepolia public RPC)
 *   --fork-block n       pin the fork block (default latest)
 *   --contracts DIR      site repo contracts/ (default ../quadrix/contracts, or $QUADRIX_CONTRACTS)
 *   --foundry-bin DIR    where anvil/forge live (default ~/.foundry/bin, or $FOUNDRY_BIN)
 *   --work DIR           scratch directory (default $TMPDIR/quadrix-basket-rehearsal)
 *   --duration s         auction duration passed to the planner (default 900)
 *   --cups n             anvil --compute-units-per-second against the upstream (default 100)
 *   --keep-anvil         leave anvil running afterwards (for a look with cast)
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, getAddress, keccak256, encodeAbiParameters,
  encodeDeployData, parseAbi, parseEventLogs, maxUint256,
} from 'viem';
import {
  TICKER, GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, ERC20_ABI, SLEEVE_INDEXES,
  chainFor, makeReader, readVault, toRefPrice, decimalsByPrice, sha256, loadPlan, savePlan,
} from './basket-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ZERO32 = `0x${'0'.repeat(64)}`;

/** anvil's public dev accounts (the mnemonic every anvil prints). Nothing
 *  here is a secret; with --auto-impersonate no key is needed at all. */
const DEV = {
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // #0: fresh-mode owner/keeper
  bidder: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',   // #1: the separate bidder (mainnet shape)
  stranger: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // #3: donates the griefing dust
  holder: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',   // #4: the holder who redeems at every stage
  desk: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',     // #5: DESK for DeployIndexBasket (fresh mode)
};

/** contracts/test/DeployIndexBasket.t.sol pins a 20-asset redemption under this. */
const REDEEM_GAS_BOUND = 1_500_000n;
/** Same-price re-posts move nothing; a mark may step at most this per post. */
const BAND_BPS = 1_500n;
const FEE_TOL = 10e-4; // 10 bp: share-value continuity tolerance beyond the streaming fee
const FIRST_PRICE_TOL = 0.02; // the executor's default --first-price-tol

/** Stand-in prices for the adds (arbitrary; the symbols are only labels). */
const STAND_INS = {
  'qrev-adds': { AAVE: 150.65, LDO: 0.487553, GMX: 8.07, DYDX: 0.137746, MORPHO: 2.64 },
  'qx20-swap': { ZEC: 45.2, XMR: 165.3 },
};
const SCENARIO_NAMES = ['qrev-adds', 'qx20-swap', 'qduo-sleeve'];

const EXTRA_ABI = parseAbi([
  'function create(uint256[] amounts, address receiver) returns (uint256)',
  'function setBidder(address bidder, bool allowed)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function mgmtFeeBps() view returns (uint256)',
  'function openCreation() view returns (bool)',
  'event Redeemed(address indexed holder, address indexed receiver, uint256 shares, uint256[] amounts)',
  'event Created(address indexed ap, address indexed receiver, uint256 shares, uint256 feeShares)',
]).concat(VAULT_ABI.filter((x) => x.type === 'error')); // so a create() revert decodes to its name
const AUCTION_FILLED = VAULT_ABI.find((x) => x.type === 'event' && x.name === 'AuctionFilled');

class Abort extends Error {}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const iso = (ts) => new Date(Number(ts) * 1000).toISOString();
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const usdOf = (ref, decimals) => (Number(ref) * 10 ** decimals) / 1e18;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const o = {
    port: Number(opt('--port', 8570)),
    scenario: opt('--scenario', 'all'),
    fresh: flag('--fresh'),
    forkUrl: opt('--fork-url', GIWA_RPC),
    forkBlock: opt('--fork-block', null),
    contracts: opt('--contracts', process.env.QUADRIX_CONTRACTS ?? path.join(ROOT, '..', 'quadrix', 'contracts')),
    foundry: opt('--foundry-bin', process.env.FOUNDRY_BIN ?? path.join(os.homedir(), '.foundry', 'bin')),
    work: opt('--work', path.join(os.tmpdir(), 'quadrix-basket-rehearsal')),
    duration: Number(opt('--duration', 900)),
    cups: Number(opt('--cups', 100)),
    keepAnvil: flag('--keep-anvil'),
    help: flag('--help') || flag('-h'),
  };
  if (o.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 75).map((l) => l.replace(/^ \*( |$)/, '')).join('\n'));
    process.exit(0);
  }
  const want = o.scenario === 'all' ? SCENARIO_NAMES : o.scenario.split(',').map((s) => (/^\d$/.test(s) ? SCENARIO_NAMES[Number(s) - 1] : s));
  if (want.some((s) => !SCENARIO_NAMES.includes(s))) {
    console.error(`--scenario takes ${SCENARIO_NAMES.join(' | ')} (or 1 | 2 | 3), comma-separated`);
    process.exit(2);
  }
  o.scenarios = want;
  return o;
}

// ------------------------------------------------------------ reporting
const REPORT = { startedAt: new Date().toISOString(), mode: null, checks: [], commands: [], scenarios: {} };
let CURRENT = 'setup';
const log = (m) => console.log(`[rehearse] ${m}`);
function check(name, ok, detail = '') {
  REPORT.checks.push({ scenario: CURRENT, name, ok: !!ok, detail: String(detail) });
  console.log(`[rehearse] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
function must(name, ok, detail = '') {
  if (!check(name, ok, detail)) throw new Abort(`${name}${detail ? ` (${detail})` : ''}`);
}

function printTable() {
  const rows = REPORT.checks;
  const w = { s: Math.max(8, ...rows.map((r) => r.scenario.length)), n: Math.min(70, Math.max(5, ...rows.map((r) => r.name.length))) };
  console.log('');
  console.log(`${'scenario'.padEnd(w.s)}  ${'check'.padEnd(w.n)}  result  detail`);
  console.log(`${'-'.repeat(w.s)}  ${'-'.repeat(w.n)}  ------  ------`);
  for (const r of rows) console.log(`${r.scenario.padEnd(w.s)}  ${r.name.slice(0, w.n).padEnd(w.n)}  ${(r.ok ? 'PASS' : 'FAIL').padEnd(6)}  ${r.detail}`);
  const fails = rows.filter((r) => !r.ok).length;
  console.log('');
  console.log(`[rehearse] ${rows.length - fails} PASS / ${fails} FAIL${fails ? ' — FAILED' : ' — all checks passed'} (${REPORT.mode})`);
  return fails;
}

// -------------------------------------------------------- child processes
function bin(o, name) {
  const p = path.join(o.foundry, name);
  return fs.existsSync(p) ? p : name; // else hope it is on PATH
}

/** Run one of the real keeper scripts from the scratch repo and echo its
 *  output indented; the caller decides what exit status it expected. */
function runScript(env, script, args, label) {
  const shown = `node keeper/${script} ${args.join(' ')}`;
  console.log(`$ ${shown}`);
  const r = spawnSync(process.execPath, [path.join(env.repo, 'keeper', script), ...args], {
    cwd: env.repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GITHUB_RUN_ID: '', GITHUB_WORKFLOW: '' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const line of out.split('\n')) if (line.trim()) console.log(`    | ${line}`);
  console.log(`    exit=${r.status}`);
  REPORT.commands.push({ scenario: CURRENT, label, cmd: shown, exit: r.status });
  return { status: r.status, out };
}
const refused = (r, re) => r.status === 1 && /REFUSED:/.test(r.out) && (!re || re.test(r.out));
const failed = (r, re) => r.status !== 0 && (!re || re.test(r.out));

// ----------------------------------------------------------- work layout
/** A scratch copy of the record repo's keeper: the real scripts, byte for
 *  byte, with their own plans/ cache/ trackrecord/ so the checkout stays
 *  clean and stale plans from an earlier run cannot be picked up. */
function setupWork(o) {
  const work = path.resolve(o.work);
  const repo = path.join(work, 'repo');
  const keeper = path.join(repo, 'keeper');
  fs.mkdirSync(keeper, { recursive: true });
  for (const d of ['plans', 'cache']) fs.rmSync(path.join(keeper, d), { recursive: true, force: true });
  fs.rmSync(path.join(repo, 'trackrecord'), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, 'trackrecord', 'decisions'), { recursive: true });
  for (const f of ['basket-plan.mjs', 'basket-recon.mjs', 'gen-recon-decision.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(keeper, f));
  fs.rmSync(path.join(keeper, 'rulebooks'), { recursive: true, force: true });
  fs.cpSync(path.join(HERE, 'rulebooks'), path.join(keeper, 'rulebooks'), { recursive: true });
  for (const f of fs.readdirSync(HERE).filter((f) => /^state(-\w+)?\.json$/.test(f))) fs.copyFileSync(path.join(HERE, f), path.join(keeper, f));
  const nm = path.join(repo, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, 'node_modules'), nm, 'dir');
  const realLedger = path.join(ROOT, 'trackrecord', 'decisions.jsonl');
  const ledgerReal = path.join(repo, 'trackrecord', 'decisions-real.jsonl');
  fs.writeFileSync(ledgerReal, fs.existsSync(realLedger) ? fs.readFileSync(realLedger) : '');
  const ledger = path.join(repo, 'trackrecord', 'decisions.jsonl');
  fs.writeFileSync(ledger, '');
  fs.mkdirSync(path.join(work, 'scenarios'), { recursive: true });
  return { work, repo, keeper, ledger, ledgerReal, date: todayUTC(), rpc: `http://127.0.0.1:${o.port}` };
}

/** Build the contracts from a copy of the site repo's contracts/ so neither
 *  checkout gains an out/, cache/ or broadcast/ entry from this run. */
function buildContracts(o, env) {
  const src = path.resolve(o.contracts);
  if (!fs.existsSync(path.join(src, 'src', 'QuadrixBasketVault.sol'))) throw new Abort(`--contracts ${src} does not look like the site repo's contracts/`);
  const cb = path.join(env.work, 'cbuild');
  fs.mkdirSync(cb, { recursive: true });
  for (const d of ['src', 'script', 'baskets']) {
    fs.rmSync(path.join(cb, d), { recursive: true, force: true });
    fs.cpSync(path.join(src, d), path.join(cb, d), { recursive: true });
  }
  fs.copyFileSync(path.join(src, 'foundry.toml'), path.join(cb, 'foundry.toml'));
  if (!fs.existsSync(path.join(cb, 'lib', 'openzeppelin-contracts'))) {
    log(`copying ${path.join(src, 'lib')} (once)`);
    fs.cpSync(path.join(src, 'lib'), path.join(cb, 'lib'), { recursive: true, filter: (p) => !/\/\.git(\/|$)/.test(p) });
  }
  log('forge build (scratch copy of contracts/)');
  const r = spawnSync(bin(o, 'forge'), ['build', '--root', cb, '--skip', 'test'], { cwd: cb, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Abort(`forge build failed:\n${r.stdout}\n${r.stderr}`);
  const art = (name) => JSON.parse(fs.readFileSync(path.join(cb, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  return { dir: cb, mock: art('MockConstituent') };
}

// ------------------------------------------------------------------ anvil
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function rpcCall(rpc, method, params = []) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function startAnvil(o, env, mode) {
  const args = ['--port', String(o.port), '--host', '127.0.0.1', '--auto-impersonate'];
  if (mode === 'fork') {
    args.push('--fork-url', o.forkUrl, '--compute-units-per-second', String(o.cups), '--retries', '8', '--fork-retry-backoff', '2000', '--timeout', '45000');
    if (o.forkBlock) args.push('--fork-block-number', String(o.forkBlock));
  } else {
    // GIWA's block gas limit (60M at block 37,226,087) so the gas check means the same thing.
    args.push('--chain-id', String(GIWA_CHAIN_ID), '--gas-limit', '60000000');
  }
  const logPath = path.join(env.work, `anvil-${mode}.log`);
  const fd = fs.openSync(logPath, 'w');
  log(`anvil ${args.join(' ')}  (log ${logPath})`);
  const child = spawn(bin(o, 'anvil'), args, { stdio: ['ignore', fd, fd] });
  let exited = null;
  child.on('exit', (code) => { exited = code ?? -1; });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited != null) throw new Error(`anvil exited (${exited}) — ${fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-5).join(' / ')}`);
    try {
      const id = Number(await rpcCall(env.rpc, 'eth_chainId'));
      if (id === GIWA_CHAIN_ID) return { child, logPath };
      throw new Error(`chain id ${id}, expected ${GIWA_CHAIN_ID}`);
    } catch (e) {
      if (/chain id/.test(e.message)) { child.kill(); throw e; }
    }
    await sleep(500);
  }
  child.kill();
  throw new Error('anvil did not come up in 120 s');
}

/** Fork first; on any startup or canary failure fall back to a fresh chain. */
async function bringUpChain(o, env) {
  if (!o.fresh) {
    try {
      const a = await startAnvil(o, env, 'fork');
      const qrev = JSON.parse(fs.readFileSync(path.join(env.keeper, 'rulebooks', 'qrev.json'), 'utf8')).basket.vault;
      const canary = createPublicClient({ chain: chainFor(env.rpc), transport: http(env.rpc, { timeout: 60_000 }) });
      const n = await Promise.race([
        canary.readContract({ address: getAddress(qrev), abi: VAULT_ABI, functionName: 'assetCount' }),
        sleep(90_000).then(() => { throw new Error('canary read timed out (upstream throttling?)'); }),
      ]);
      const blk = await canary.getBlock();
      log(`fork up: block ${blk.number} (${iso(blk.timestamp)}), qREV assetCount ${n}, client ${await rpcCall(env.rpc, 'web3_clientVersion')}`);
      REPORT.mode = `fork of ${o.forkUrl} at block ${blk.number}`;
      REPORT.fork = { url: o.forkUrl, block: blk.number.toString(), timestamp: iso(blk.timestamp) };
      return { anvil: a, mode: 'fork' };
    } catch (e) {
      log(`fork unavailable — ${e.message}; falling back to a fresh chain`);
    }
  }
  const a = await startAnvil(o, env, 'fresh');
  REPORT.mode = 'fresh anvil chain (DeployIndexBasket)';
  return { anvil: a, mode: 'fresh' };
}

/** Fresh mode: the repo's deploy script, per index, from the copied contracts;
 *  the rulebook copy is then pointed at the new vault, faucet and mocks. */
async function deployFresh(o, env, cb, index, chain) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cb.dir, 'baskets', `${index}.json`), 'utf8'));
  log(`forge script DeployIndexBasket (INDEX=${index}, DESK=${DEV.desk}, sender ${DEV.deployer}, unlocked)`);
  const r = spawnSync(bin(o, 'forge'), [
    'script', 'script/DeployIndexBasket.s.sol:DeployIndexBasket', '--root', cb.dir, '--rpc-url', env.rpc,
    '--broadcast', '--unlocked', '--sender', DEV.deployer, '--skip', 'test',
  ], { cwd: cb.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, INDEX: index, DESK: DEV.desk } });
  if (r.status !== 0) throw new Abort(`DeployIndexBasket ${index} failed:\n${r.stdout.slice(-4000)}\n${r.stderr.slice(-2000)}`);
  const out = r.stdout;
  const vault = out.match(/QuadrixBasketVault:\s+(0x[0-9a-fA-F]{40})/)?.[1];
  const faucet = out.match(/MockBasketFaucet:\s+(0x[0-9a-fA-F]{40})/)?.[1];
  if (!vault || !faucet) throw new Abort(`could not parse the deploy report for ${index}`);
  // The registry as deployed, symbol by mockSymbol from the manifest — read
  // back from the chain rather than trusted from the console.
  const v = await readVault(chain.reader, vault);
  const byMock = Object.fromEntries(manifest.constituents.map((c) => [c.mockSymbol, c.symbol]));
  const assets = {};
  for (const a of v.assets) {
    const sym = byMock[a.onchainSymbol];
    if (!sym) throw new Abort(`${index}: deployed mock ${a.onchainSymbol} is not in the manifest`);
    assets[sym] = { address: a.address.toLowerCase(), decimals: a.decimals };
  }
  const rbPath = path.join(env.keeper, 'rulebooks', `${index}.json`);
  const rb = JSON.parse(fs.readFileSync(rbPath, 'utf8'));
  rb.basket = { ...rb.basket, vault: vault.toLowerCase(), faucet: faucet.toLowerCase(), assets, _rehearsal: `fresh anvil deployment ${new Date().toISOString()} (rulebook copy, scratch only)` };
  fs.writeFileSync(rbPath, JSON.stringify(rb, null, 2) + '\n');
  log(`${TICKER[index]} fresh vault ${vault} (${v.assetCount} assets, owner ${short(v.owner)}); rulebook copy patched`);
}

// ------------------------------------------------------------ chain side
async function makeChain(env) {
  const reader = await makeReader(env.rpc, { chainId: GIWA_CHAIN_ID });
  const pc = reader.publicClient;
  const chainDef = chainFor(env.rpc, GIWA_CHAIN_ID);
  const wallets = {};
  const walletFor = (addr) => (wallets[addr] ??= createWalletClient({ account: getAddress(addr), chain: chainDef, transport: http(env.rpc) }));
  /** Simulate (for a decoded revert), send from an impersonated account,
   *  require a successful receipt. Fixed gas: anvil's limit is far above. */
  async function tx(from, { address, abi = VAULT_ABI, functionName, args = [], gas = 3_000_000n }) {
    let request;
    try {
      ({ request } = await pc.simulateContract({ address, abi, functionName, args, account: getAddress(from) }));
    } catch (e) {
      throw new Error(`${functionName}(${args.map(String).join(', ')}) from ${short(from)} would revert: ${e.shortMessage ?? e.message}`);
    }
    const hash = await walletFor(from).writeContract({ ...request, gas });
    const receipt = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted on chain (${hash})`);
    return receipt;
  }
  /** Expect a call to revert; returns the decoded error text. */
  async function expectRevert(from, { address, abi = VAULT_ABI, functionName, args = [] }) {
    try {
      await pc.simulateContract({ address, abi, functionName, args, account: getAddress(from) });
      return null;
    } catch (e) {
      let cur = e;
      for (let i = 0; cur && i < 8; i++) {
        if (cur.data?.errorName) return cur.data.errorName;
        cur = cur.cause;
      }
      return e.shortMessage ?? e.message;
    }
  }
  const rpc = (method, params = []) => rpcCall(env.rpc, method, params);
  const fund = async (addr) => rpc('anvil_setBalance', [addr, '0x' + (10n ** 21n).toString(16)]); // 1,000 ETH
  async function warp(seconds) {
    await rpc('evm_increaseTime', [Number(seconds)]);
    await rpc('evm_mine', []);
  }
  const now = async () => (await pc.getBlock()).timestamp;
  return { reader, pc, tx, expectRevert, rpc, fund, warp, now, walletFor };
}

/** Everything one scenario needs about its vault, symbol-joined through the
 *  (possibly patched) rulebook copy; refreshed with v() as the run goes. */
async function vaultCtx(env, chain, index) {
  const rb = JSON.parse(fs.readFileSync(path.join(env.keeper, 'rulebooks', `${index}.json`), 'utf8'));
  const vault = getAddress(rb.basket.vault);
  const symOf = {};
  for (const [s, e] of Object.entries(rb.basket.assets)) symOf[getAddress(e.address)] = s;
  const v0 = await readVault(chain.reader, vault);
  if (v0.owner !== v0.keeper) throw new Abort(`${TICKER[index]}: owner ${v0.owner} != keeper ${v0.keeper} — the executor's --from is one signer; this rehearsal assumes the deployed owner=keeper shape`);
  const [mgmtFeeBps, openCreation] = await chain.reader.batch([
    { address: vault, abi: EXTRA_ABI, functionName: 'mgmtFeeBps' },
    { address: vault, abi: EXTRA_ABI, functionName: 'openCreation' },
  ]);
  const ctx = {
    index, ticker: TICKER[index], vault, rb, symOf, owner: v0.owner, keeper: v0.keeper,
    mgmtFeeBps: Number(mgmtFeeBps), openCreation, sleeve: SLEEVE_INDEXES.has(index),
    v: () => readVault(chain.reader, vault),
    sym: (addr) => symOf[getAddress(addr)] ?? addr,
    addSym: (addr, s) => { symOf[getAddress(addr)] = s; },
  };
  log(`${ctx.ticker} ${vault}: ${v0.assetCount} assets, supply ${(Number(v0.totalSupply) / 1e18).toFixed(0)}, nav ${(Number(v0.navPerShare) / 1e6).toFixed(6)}, owner=keeper ${short(v0.owner)}, pending ${v0.pendingRegistryChange === ZERO32 ? 'none' : v0.pendingRegistryChange}, auctions ${v0.auctionCount}, fee ${mgmtFeeBps} bp, openCreation ${openCreation}`);
  return ctx;
}

/** Fund the actors, give the holder shares, whitelist the separate bidder. */
async function prepareActors(chain, ctx) {
  for (const a of [ctx.owner, DEV.bidder, DEV.holder, DEV.stranger, DEV.deployer]) await chain.fund(a);
  const holderShares = 2_000n * 10n ** 18n;
  await chain.tx(ctx.owner, { address: ctx.vault, abi: EXTRA_ABI, functionName: 'transfer', args: [DEV.holder, holderShares] });
  const isB = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [DEV.bidder] });
  if (!isB) await chain.tx(ctx.owner, { address: ctx.vault, abi: EXTRA_ABI, functionName: 'setBidder', args: [DEV.bidder, true] });
  const isB2 = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [DEV.bidder] });
  must('bidder is a separate whitelisted address (owner setBidder)', isB2 && DEV.bidder !== ctx.owner, `${short(DEV.bidder)} isBidder ${isB2}; owner/keeper ${short(ctx.owner)}`);
  log(`holder ${short(DEV.holder)} holds 2,000 shares; stranger ${short(DEV.stranger)}; all funded with test ETH`);
}

/** Stand-in MockConstituents for the adds, genesis inventory to the bidder
 *  (the design's genesisTo = bidder), deployed from anvil dev account #0. */
async function deployStandIns(chain, cb, standIns, outPath) {
  const out = {};
  for (const [sym, price] of Object.entries(standIns)) {
    const decimals = decimalsByPrice(price);
    const faucetAmount = BigInt(Math.floor((60 / price) * 10 ** decimals)); // ≈ $60, a 6% seat of 1,000 shares
    const genesisAmount = BigInt(Math.floor((1_500_000 / price) * 10 ** decimals)); // bidder inventory ≈ $1.5M
    const data = encodeDeployData({
      abi: cb.mock.abi, bytecode: cb.mock.bytecode.object,
      args: [`Mock ${sym} (stand-in)`, `m${sym}`, decimals, faucetAmount, DEV.bidder, genesisAmount, '0x0000000000000000000000000000000000000000', 0n],
    });
    const hash = await chain.walletFor(DEV.deployer).sendTransaction({ data, gas: 2_500_000n });
    const rc = await chain.pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (rc.status !== 'success' || !rc.contractAddress) throw new Abort(`stand-in ${sym} deploy failed (${hash})`);
    out[sym] = { address: rc.contractAddress, decimals, price, genesisTo: DEV.bidder, genesisAmount: genesisAmount.toString(), tx: hash };
    log(`stand-in ${sym.padEnd(7)} ${rc.contractAddress} ${decimals} dec $${price}, ${genesisAmount} base units to the bidder`);
  }
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  return out;
}

// ------------------------------------------------------- books and prices
/** The vault's own holdings as a book: units per 100 shares. Only ratios
 *  matter to the planner, so book == vault by construction before the
 *  scenario's transformation. */
function unitsFromVault(v, ctx) {
  const shares = Number(v.totalSupply) / 1e18;
  const units = {};
  for (const a of v.assets) units[ctx.sym(a.address)] = (Number(a.balance) / 10 ** a.decimals / shares) * 100;
  return units;
}

/** Source A = the chain's references (yesterday's mark) plus the stand-ins;
 *  source B = A + 12 bp. Written where the planner looks for the day's
 *  CoinGecko snapshot, and as a --prices-b file. Rewritten per scenario
 *  because qX20 and qDUO both hold a mock called BTC at different prices. */
function writePrices(env, v, ctx, extra = {}) {
  const prices = {};
  for (const a of v.assets) prices[ctx.sym(a.address)] = usdOf(a.refPrice, a.decimals);
  Object.assign(prices, extra);
  const rows = Object.entries(prices).map(([symbol, price]) => ({ id: `rehearsal-${symbol.toLowerCase()}`, symbol, price, marketCap: 0 }));
  fs.mkdirSync(path.join(env.keeper, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(env.keeper, 'cache', `cg-markets-top500-${env.date}.json`), JSON.stringify(rows));
  const b = Object.fromEntries(Object.entries(prices).map(([s, p]) => [s, p * 1.0012]));
  const bPath = path.join(env.work, 'scenarios', `${CURRENT}-prices-b.json`);
  fs.writeFileSync(bPath, JSON.stringify(b, null, 2) + '\n');
  return { prices, bPath };
}

function writeBook(env, name, book) {
  const p = path.join(env.work, 'scenarios', `${name}-book.json`);
  fs.writeFileSync(p, JSON.stringify(book, null, 2) + '\n');
  return p;
}

// ------------------------------------------------------------- the checks
/** The holder redeems: a simulation of the whole balance (one slice per
 *  registry asset, nonzero wherever the vault holds a balance) and a REAL
 *  redeem of one share whose payout must reach the holder's wallet. Returns
 *  the per-share value at the current references for the continuity check. */
async function redeemCheck(chain, ctx, label) {
  const v = await ctx.v();
  const shares = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'balanceOf', args: [DEV.holder] });
  let sim;
  try {
    sim = (await chain.pc.simulateContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'redeem', args: [shares, DEV.holder], account: DEV.holder })).result;
  } catch (e) {
    must(`redeem ${label}: simulation of the holder's ${shares / 10n ** 18n} shares`, false, e.shortMessage ?? e.message);
  }
  const shape = sim.length === v.assetCount && v.assets.every((a, i) => (a.balance > 0n ? sim[i] > 0n : sim[i] === 0n));
  check(`redeem ${label}: one slice per registry asset, nonzero where the vault holds balance`, shape,
    `${sim.length} amounts for assetCount ${v.assetCount}; ${sim.filter((x) => x > 0n).length} nonzero; ${v.assets.filter((a) => a.balance === 0n).length} zero-balance asset(s)`);
  const before = await chain.reader.batch(v.assets.map((a) => ({ address: a.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [DEV.holder] })));
  const one = 10n ** 18n;
  const rc = await chain.tx(DEV.holder, { address: ctx.vault, functionName: 'redeem', args: [one, DEV.holder], gas: 5_000_000n });
  const ev = parseEventLogs({ abi: EXTRA_ABI, logs: rc.logs, eventName: 'Redeemed' })[0]?.args;
  const after = await chain.reader.batch(v.assets.map((a) => ({ address: a.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [DEV.holder] })));
  const paid = v.assets.every((a, i) => after[i] - before[i] === (ev?.amounts?.[i] ?? -1n));
  check(`redeem ${label}: a real redeem(1 share) pays every slice to the holder`, !!ev && ev.amounts.length === v.assetCount && paid,
    `tx ${short(rc.transactionHash)}, ${ev?.amounts?.length ?? 0} slices, holder balances moved by exactly the event amounts: ${paid}`);
  const blk = await chain.pc.getBlock({ blockNumber: rc.blockNumber });
  check(`redeem ${label}: gas ${rc.gasUsed} at ${v.assetCount} assets under the block limit and the 1.5M test bound`,
    rc.gasUsed < blk.gasLimit && rc.gasUsed < REDEEM_GAS_BOUND, `block gasLimit ${blk.gasLimit}; bound ${REDEEM_GAS_BOUND}`);
  // Per-share value at the references the chain holds now (an unset reference
  // only ever belongs to a zero-balance add, so it contributes nothing).
  const v2 = await ctx.v();
  let value = 0;
  for (const a of v2.assets) value += Number(a.balance * a.refPrice);
  const perShare = value / Number(v2.totalSupply);
  return { perShare, at: blk.timestamp, assetCount: v.assetCount, gas: rc.gasUsed, amounts: ev?.amounts ?? [], holderShares: shares - one };
}

/** Share value at references must not move across a session except by the
 *  streaming fee over the elapsed (warped) time. */
function continuityCheck(ctx, a, b, label) {
  const dt = Number(b.at - a.at);
  const feeDrag = (ctx.mgmtFeeBps * dt) / (10_000 * 365 * 86_400);
  const actual = b.perShare / a.perShare - 1;
  const excess = actual + feeDrag; // what is left after the fee explains its part
  check(`share value continuity ${label}`, Math.abs(excess) <= FEE_TOL,
    `per-share ${a.perShare.toFixed(6)} → ${b.perShare.toFixed(6)} USD (${(actual * 1e4).toFixed(2)} bp) over ${dt} s; fee drag ${(feeDrag * 1e4).toFixed(2)} bp; unexplained ${(excess * 1e4).toFixed(2)} bp, tolerance ${FEE_TOL * 1e4} bp`);
}

/** A creation vector of the current registry length in chain order must be
 *  accepted (what the desk sends), and the old length must not. */
async function createCheck(chain, ctx, label, { oldLength = null } = {}) {
  const v = await ctx.v();
  const shares = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'balanceOf', args: [DEV.holder] });
  const amounts = (await chain.pc.simulateContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'redeem', args: [10n ** 18n, DEV.holder], account: DEV.holder })).result;
  if (oldLength != null) {
    const err = await chain.expectRevert(DEV.holder, { address: ctx.vault, abi: EXTRA_ABI, functionName: 'create', args: [amounts.slice(0, oldLength), DEV.holder] });
    check(`create ${label}: a ${oldLength}-amount vector (the old registry length) is refused`, err === 'LengthMismatch', `reverts ${err}`);
  }
  for (let i = 0; i < v.assets.length; i++) {
    if (amounts[i] === 0n) continue;
    const allowance = await chain.pc.readContract({ address: v.assets[i].address, abi: ERC20_ABI, functionName: 'allowance', args: [DEV.holder, ctx.vault] });
    if (allowance < amounts[i]) await chain.tx(DEV.holder, { address: v.assets[i].address, abi: ERC20_ABI, functionName: 'approve', args: [ctx.vault, maxUint256], gas: 100_000n });
  }
  let rc;
  try {
    rc = await chain.tx(DEV.holder, { address: ctx.vault, abi: EXTRA_ABI, functionName: 'create', args: [amounts, DEV.holder], gas: 5_000_000n });
  } catch (e) {
    return check(`create ${label}: a ${v.assetCount}-amount vector in chain order mints shares`, false, e.message);
  }
  const after = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'balanceOf', args: [DEV.holder] });
  check(`create ${label}: a ${v.assetCount}-amount vector in chain order mints shares`, after > shares, `+${((Number(after - shares)) / 1e18).toFixed(6)} shares, gas ${rc.gasUsed}`);
}

/** Read every AuctionFilled since `fromBlock` and re-derive the curve factor
 *  from the auction's own start time — independent of the executor's log. */
async function fillsCheck(chain, ctx, fromBlock, plan, expectedCount) {
  const v = await ctx.v();
  const logs = await chain.pc.getLogs({ address: ctx.vault, event: AUCTION_FILLED, fromBlock, toBlock: 'latest' });
  const rows = [];
  for (const l of logs) {
    const a = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'auctions', args: [l.args.id] });
    const blk = await chain.pc.getBlock({ blockNumber: l.blockNumber });
    const elapsed = Number(blk.timestamp - BigInt(a[3]));
    const factor = 10_000 + Number(v.premiumBps) - Math.floor(((Number(v.premiumBps) + Number(v.maxFillLossBps)) * elapsed) / Number(a[4]));
    rows.push({ id: l.args.id.toString(), bidder: l.args.bidder, sellTaken: l.args.sellTaken.toString(), buyPaid: l.args.buyPaid.toString(), lossAtRef: l.args.lossAtRef.toString(), factor, elapsed, sell: ctx.sym(a[0]), buy: ctx.sym(a[1]) });
  }
  check(`auctions: ${expectedCount} planned fill(s) mined (AuctionFilled logs)`, logs.length >= expectedCount && plan.fills.length === logs.length,
    `${logs.length} log(s), plan.fills ${plan.fills.length}: ${rows.map((r) => `#${r.id} ${r.sell}→${r.buy}`).join(', ')}`);
  check('auctions: every fill has lossAtRef == 0 (--fill fair)', rows.length > 0 && rows.every((r) => r.lossAtRef === '0'), rows.map((r) => `#${r.id} loss ${r.lossAtRef}`).join(', '));
  check('auctions: every fill inside the fair window [10000, 10010] bp, re-derived from the auction start time', rows.length > 0 && rows.every((r) => r.factor >= 10_000 && r.factor <= 10_010), rows.map((r) => `#${r.id} ${r.factor} bp @${r.elapsed}s`).join(', '));
  check('auctions: every fill came from the separate bidder', rows.every((r) => getAddress(r.bidder) === DEV.bidder), [...new Set(rows.map((r) => short(r.bidder)))].join(', '));
  return rows;
}

/** The plan's own arithmetic: the weights it expects after its fills must be
 *  the trade targets it verifies against (gen-recon-decision.mjs prints the
 *  former in the document that gets anchored). A removal split over two
 *  buys is where this can diverge. */
function planConsistencyCheck(plan) {
  const off = plan.expectedPostTradeWeights
    .map((w) => ({ ...w, target: plan.targets.find((t) => t.symbol === w.symbol) }))
    .filter((w) => w.target?.traded && (w.weight < -1e-9 || Math.abs(w.weight - w.target.tradeTargetWeight) > 0.005));
  check('plan: expectedPostTradeWeights agree with the trade targets (the decision draft prints them)', off.length === 0,
    off.length ? `${off.map((w) => `${w.symbol} expected ${pct(w.weight)} vs trade target ${pct(w.target.tradeTargetWeight)}`).join('; ')} — basket-plan.mjs computeTrades books a drain slice at the whole pre-session balance` : `${plan.expectedPostTradeWeights.filter((w) => plan.targets.find((t) => t.symbol === w.symbol)?.traded).length} traded name(s) agree`);
}

/** Weights from balances × references against the plan's trade targets. */
async function weightsCheck(chain, ctx, plan, label) {
  const v = await ctx.v();
  const total = v.assets.reduce((t, a) => t + Number(a.balance * a.refPrice), 0);
  const tol = plan.policy.tolerancePoints / 100;
  const out = [];
  let ok = true;
  for (const a of v.assets) {
    const s = ctx.sym(a.address);
    const t = plan.targets.find((x) => x.symbol === s);
    const w = Number(a.balance * a.refPrice) / total;
    const isRemove = plan.removes.some((r) => r.symbol === s);
    const fine = isRemove ? a.balance === 0n : !t?.traded || Math.abs(w - t.tradeTargetWeight) < tol;
    if (!fine) ok = false;
    if (t?.traded || isRemove) out.push(`${s} ${pct(w)} vs ${isRemove ? 'drain' : pct(t.tradeTargetWeight)}${fine ? '' : ' OUTSIDE'}`);
  }
  check(`weights ${label}: every traded name within ${plan.policy.tolerancePoints} pt of its trade target, removals drained`, ok, out.join('; '));
}

/** The daily keeper's job, emulated: step each chain reference to the plan's
 *  price in ≤15% posts from the keeper (same value → no-op). */
async function markToPlan(chain, ctx, plan) {
  let posts = 0;
  for (const r of plan.registry) {
    let cur = BigInt(r.refPrice);
    const target = BigInt(r.planRefPrice);
    while (cur !== target) {
      const span = (cur * (BAND_BPS - 10n)) / 10_000n; // just inside the band
      const next = target > cur ? (target - cur <= span ? target : cur + span) : (cur - target <= span ? target : cur - span);
      await chain.tx(ctx.keeper, { address: ctx.vault, functionName: 'setRefPrice', args: [r.address, next], gas: 150_000n });
      posts++;
      cur = next;
    }
  }
  return posts;
}

/** Faucet the bidder up to `need` of a mock (what a real bidder would do on
 *  testnet before a session; the design's "size the inventory beforehand"). */
async function fundBidder(chain, token, need, label) {
  const bal = await chain.pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [DEV.bidder] });
  if (bal >= need) return 0;
  const per = await chain.pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'faucetAmount' });
  const calls = Number((need - bal + per - 1n) / per);
  log(`bidder needs ${need} ${label} (holds ${bal}): ${calls} × faucet() of ${per}`);
  for (let i = 0; i < calls; i++) await chain.tx(DEV.bidder, { address: token, abi: ERC20_ABI, functionName: 'faucet', gas: 120_000n });
  return calls;
}

/** finalizeRemoval's order rule, simulated: swap the leaving asset with the
 *  last one and pop, in the given finalize sequence. */
function swapPop(order, sequence) {
  const o = [...order];
  for (const x of sequence) {
    const i = o.indexOf(x);
    if (i < 0) continue;
    o[i] = o[o.length - 1];
    o.pop();
  }
  return o;
}

/** Keeper opens a real-size auction, the holder redeems while it is open,
 *  the keeper cancels — redemption is oblivious to auction state. */
async function midAuctionRedeem(chain, ctx, plan) {
  const t = plan.trades[0];
  const bal = await chain.pc.readContract({ address: getAddress(t.sellAddress), abi: ERC20_ABI, functionName: 'balanceOf', args: [ctx.vault] });
  const amount = t.drain ? bal : (BigInt(t.sellAmount) < bal ? BigInt(t.sellAmount) : bal);
  const id = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'auctionCount' });
  await chain.tx(ctx.keeper, { address: ctx.vault, functionName: 'openAuction', args: [getAddress(t.sellAddress), getAddress(t.buyAddress), amount, BigInt(t.duration)], gas: 300_000n });
  const a = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
  must(`mid-auction: auction ${id} ${t.sell}→${t.buy} is open for the checkpoint`, a[5] === true, `sellRemaining ${a[2]}`);
  const snap = await redeemCheck(chain, ctx, `mid-auction (auction ${id} open)`);
  await chain.tx(ctx.keeper, { address: ctx.vault, functionName: 'cancelAuction', args: [id], gas: 100_000n });
  const a2 = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
  check(`mid-auction: checkpoint auction ${id} cancelled by the keeper (unfilled)`, a2[5] === false, 'open=false');
  return snap;
}

// =========================================================== registry flow
/** Announce → 7 days → execute → first prices → auctions → finalize → verify,
 *  with every guard poked on the way. `shape` transforms the vault-derived
 *  book; `standIns` are the adds; `beforeFinalize` hooks the griefing
 *  variant in and returns true when it finalized itself. */
async function registryChangeFlow(o, env, chain, cb, { index, standIns, shape, expectAdds, expectRemoves, beforeFinalize = null }) {
  const ctx = await vaultCtx(env, chain, index);
  await prepareActors(chain, ctx);
  const v0 = await ctx.v();
  const mocks = await deployStandIns(chain, cb, standIns, path.join(env.work, 'scenarios', `${CURRENT}-mocks.json`));
  for (const [s, m] of Object.entries(mocks)) ctx.addSym(m.address, s);
  const { bPath } = writePrices(env, v0, ctx, standIns);
  const units = shape(unitsFromVault(v0, ctx), (s) => usdOf(v0.assets.find((a) => ctx.sym(a.address) === s).refPrice, v0.assets.find((a) => ctx.sym(a.address) === s).decimals), standIns);
  const bookPath = writeBook(env, CURRENT, { updatedAt: new Date().toISOString(), level: 100, units, lastReconQuarter: 'rehearsal', onNotice: [], synthetic: `REHEARSAL ONLY — ${CURRENT}: the vault's own holdings reshaped (${expectAdds.join(',') || 'no'} add, ${expectRemoves.join(',') || 'no'} remove)` });
  const planFile = path.join(env.keeper, 'plans', index, `${env.date}.json`);
  const mocksPath = path.join(env.work, 'scenarios', `${CURRENT}-mocks.json`);
  const planArgs = ['--index', index, '--date', env.date, '--rpc', env.rpc, '--book', bookPath, '--mocks', mocksPath, '--prices-b', bPath, '--no-fetch', '--duration', String(o.duration)];

  // ---- plan without a decision: the tuple must stay incomplete
  let r = runScript(env, 'basket-plan.mjs', planArgs, 'plan (no decision)');
  must('plan (no decision) exits 0', r.status === 0);
  let plan = loadPlan(planFile);
  check(`plan: adds [${expectAdds.join(',')}] removes [${expectRemoves.join(',')}] as designed`,
    plan.adds.map((a) => a.symbol).sort().join() === [...expectAdds].sort().join() && plan.removes.map((a) => a.symbol).sort().join() === [...expectRemoves].sort().join(),
    `adds ${plan.adds.map((a) => a.symbol).join(',')}; removes ${plan.removes.map((a) => a.symbol).join(',')}`);
  check('plan: announce tuple is null until a decision is anchored', plan.announceTuple === null && plan.decisionSha256 === null, plan.notes.find((n) => n.startsWith('announce tuple')) ?? '');
  check('plan: each add carries the deployed mock\'s decimals and two source prices', plan.adds.every((a) => a.address && a.decimals === mocks[a.symbol].decimals && a.priceB > 0 && a.disagreementBps < 200),
    plan.adds.map((a) => `${a.symbol} ${a.decimals} dec ${a.disagreementBps} bp`).join(', '));

  // ---- draft decision → rehearsal ledger → complete plan
  r = runScript(env, 'gen-recon-decision.mjs', ['--index', index, '--plan', planFile], 'draft decision');
  must('draft decision generated (never anchored)', r.status === 0 && fs.existsSync(path.join(env.repo, plan.decisionFile)));
  const draft = fs.readFileSync(path.join(env.repo, plan.decisionFile));
  check('draft prints the trade targets the executor verifies against (not the projection alone)', /The auctions aim at, and the executor verifies against/.test(String(draft)) && !/Expected weights after these fills/.test(String(draft)));
  // The generator must not render a plan whose projection disagrees with its
  // targets by more than half a point (what problem 1 used to produce).
  const skewed = loadPlan(planFile);
  const skewSym = skewed.targets.find((t) => t.traded && !skewed.removes.some((x) => x.symbol === t.symbol)).symbol;
  skewed.expectedPostTradeWeights = skewed.expectedPostTradeWeights.map((w) => (w.symbol === skewSym ? { ...w, weight: w.weight + 0.01 } : w));
  const skewedPath = path.join(env.work, 'scenarios', `${CURRENT}-plan-skewed.json`);
  savePlan(skewedPath, skewed);
  r = runScript(env, 'gen-recon-decision.mjs', ['--index', index, '--plan', skewedPath, '--out', path.join(env.work, 'scenarios', `${CURRENT}-skewed-draft.md`)], 'draft from a plan whose projection is 1 pt off its targets');
  check('generator refuses a plan whose expected weights disagree with its trade targets (> 0.5 pt)', failed(r, /disagrees with itself/) && !fs.existsSync(path.join(env.work, 'scenarios', `${CURRENT}-skewed-draft.md`)), `${skewSym} skewed by +1 pt`);
  const decisionId = `${env.date}-${index}-basket-reconstitution`;
  fs.appendFileSync(env.ledger, JSON.stringify({ id: decisionId, file: plan.decisionFile.replace(/^trackrecord\//, ''), effectiveFrom: env.date, sha256: sha256(draft), txHash: '0xREHEARSAL-not-anchored', anchoredAt: 'rehearsal' }) + '\n');
  // A decision of ANOTHER basket, anchored in the same ledger: neither the
  // planner nor the executor may pin its sha into this vault's announcement.
  const foreignIndex = index === 'qai' ? 'qdefi' : 'qai';
  const foreignId = `${env.date}-${foreignIndex}-rehearsal-foreign`;
  const foreignSha = sha256(`rehearsal foreign decision ${foreignId}`);
  if (!fs.readFileSync(env.ledger, 'utf8').includes(foreignId)) fs.appendFileSync(env.ledger, JSON.stringify({ id: foreignId, file: `decisions/${foreignId}.md`, effectiveFrom: env.date, sha256: foreignSha, txHash: '0xREHEARSAL-not-anchored', anchoredAt: 'rehearsal' }) + '\n');
  r = runScript(env, 'basket-plan.mjs', [...planArgs, '--decisions', env.ledger, '--decision', foreignId], `plan with a ${foreignIndex} decision`);
  check(`planner refuses a decision of another basket (${foreignIndex}) for ${index}`, failed(r, new RegExp(`is not a ${index} decision`)) && loadPlan(planFile).decisionSha256 === null, 'plan file untouched');
  r = runScript(env, 'basket-plan.mjs', [...planArgs, '--decisions', env.ledger, '--decision', decisionId], 'plan (with decision)');
  must('plan (with decision) exits 0', r.status === 0);
  plan = loadPlan(planFile);
  must('plan: announce tuple complete (mock addresses + decisionSha256)', !!plan.announceTuple && plan.announceTuple.adds.length === expectAdds.length && plan.announceTuple.removes.length === expectRemoves.length,
    `sha ${plan.decisionSha256?.slice(0, 12) ?? 'null'}…, ${plan.trades.length} auction(s)`);
  must('plan: at least one auction (the adds are bought / the removes drained)', plan.trades.length > 0, plan.trades.map((t) => `#${t.seq} ${t.sell}→${t.buy} $${Math.round(t.sellValueUsd)}${t.drain ? ' drain' : ''}`).join(', '));
  planConsistencyCheck(plan);
  if (plan.removes.length) {
    const soldPer = {};
    for (const t of plan.trades) soldPer[t.sell] = (soldPer[t.sell] ?? 0n) + BigInt(t.sellAmount);
    const drains = plan.removes.map((x) => ({ symbol: x.symbol, sold: soldPer[x.symbol] ?? 0n, balance: BigInt(x.balance) }));
    check('plan: the slices of each removal add up to exactly its balance (a split drain sells the remainder, not the whole balance twice)', drains.every((d) => d.sold === d.balance), drains.map((d) => `${d.symbol} ${d.sold}/${d.balance}`).join(', '));
  }
  REPORT.scenarios[CURRENT] = { vault: ctx.vault, adds: plan.adds.map((a) => ({ symbol: a.symbol, address: a.address, decimals: a.decimals })), removes: plan.removes.map((x) => x.symbol), trades: plan.trades.length };

  const recon = (stage, extra = [], planArg = planFile) => ['--index', index, '--stage', stage, '--rpc', env.rpc, '--plan', planArg, ...extra];
  const live = ['--live', '--from', ctx.owner];
  const R0 = await redeemCheck(chain, ctx, 'before announce');

  // ---- announce guards, then the announcement
  r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledgerReal]), 'announce dry-run vs the anchored ledger');
  check('announce refuses a decisionSha256 that is not in the anchored ledger', refused(r, /not in .*decisions-real/));
  const foreignPlan = path.join(env.work, 'scenarios', `${CURRENT}-plan-foreign-sha.json`);
  savePlan(foreignPlan, { ...loadPlan(planFile), decisionSha256: foreignSha, announceTuple: { ...plan.announceTuple, decisionSha256: `0x${foreignSha}` } });
  r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledger, ...live], foreignPlan), `announce with the ${foreignIndex} decision's sha`);
  check(`announce refuses a sha anchored for another basket (${foreignIndex}); nothing pending afterwards`, refused(r, new RegExp(`is not a ${index} decision`)) && (await ctx.v()).pendingRegistryChange === ZERO32);
  r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledger]), 'announce dry-run');
  check('announce dry-run simulates ok and sends nothing', r.status === 0 && /would announce/.test(r.out) && (await ctx.v()).pendingRegistryChange === ZERO32);
  r = runScript(env, 'basket-recon.mjs', recon('execute', live), 'execute before announce');
  check('execute refuses when nothing is pending', refused(r, /nothing is pending/));
  r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledger, ...live]), 'announce live');
  must('announce (live, unlocked owner) exits 0', r.status === 0);
  let v = await ctx.v();
  const t = plan.announceTuple;
  const expectedHash = keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'address[]' }, { type: 'bytes32' }], [t.adds.map((a) => getAddress(a)), t.removes.map((a) => getAddress(a)), t.decisionSha256]));
  check('announce: on-chain pending hash == keccak(adds, removes, decisionSha256) computed here', v.pendingRegistryChange.toLowerCase() === expectedHash.toLowerCase(), short(v.pendingRegistryChange));
  const annBlock = await chain.pc.getBlock({ blockNumber: BigInt(loadPlan(planFile).announce.block) });
  check('announce: eta == announce block time + REGISTRY_DELAY (7 days)', v.pendingRegistryEta === annBlock.timestamp + v.registryDelay, `eta ${iso(v.pendingRegistryEta)}, delay ${Number(v.registryDelay) / 86400} d`);
  const etaBefore = v.pendingRegistryEta;
  r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledger, ...live]), 're-announce');
  v = await ctx.v();
  check('re-announce is refused while a change is pending (hash and eta untouched)', refused(r, /already pending/) && v.pendingRegistryEta === etaBefore && v.pendingRegistryChange.toLowerCase() === expectedHash.toLowerCase());
  const R1 = await redeemCheck(chain, ctx, 'after announce');
  // Re-plan while pending, from a book whose key ORDER is reversed (what a
  // rank-order rebuild of the book does between announce and day 7): the
  // tuple must come back verbatim, order included — keccak(abi.encode(…)) is
  // order-sensitive and execute compares hashes.
  const reversedBook = writeBook(env, `${CURRENT}-reversed`, { ...JSON.parse(fs.readFileSync(bookPath, 'utf8')), units: Object.fromEntries(Object.entries(units).reverse()) });
  const replanArgs = planArgs.map((a, i) => (planArgs[i - 1] === '--book' ? reversedBook : a));
  r = runScript(env, 'basket-plan.mjs', [...replanArgs, '--decisions', env.ledger], 're-plan while pending (book in reverse order)');
  const replanned = r.status === 0 ? loadPlan(planFile) : null;
  check('re-plan while pending carries the announced tuple verbatim (order included) although the book order changed', !!replanned && /carrying the announced tuple/.test(r.out) && JSON.stringify(replanned.announceTuple) === JSON.stringify(t) && replanned.announce?.pendingHash?.toLowerCase() === expectedHash.toLowerCase(),
    replanned ? `adds ${replanned.announceTuple.adds.map((a) => ctx.sym(a)).join(',')} == announced` : 'planner failed');
  plan = replanned ?? plan;
  // …and a book that no longer matches the announced set is refused, the
  // plan file left as it was (the announcement cannot be amended).
  const dropSym = expectAdds[0] ?? Object.keys(units).find((s) => !expectRemoves.includes(s));
  const changedUnits = { ...units };
  if (expectAdds[0]) delete changedUnits[dropSym]; else changedUnits[expectRemoves[0]] = 1e-9;
  const changedBook = writeBook(env, `${CURRENT}-changed`, { ...JSON.parse(fs.readFileSync(bookPath, 'utf8')), units: changedUnits });
  r = runScript(env, 'basket-plan.mjs', [...planArgs.map((a, i) => (planArgs[i - 1] === '--book' ? changedBook : a)), '--decisions', env.ledger], 're-plan while pending with a different change');
  check('re-plan while pending refuses a book that no longer matches the announced tuple; plan file untouched', failed(r, /book vs announced tuple differ/) && JSON.stringify(loadPlan(planFile).announceTuple) === JSON.stringify(t) && loadPlan(planFile).announce?.pendingHash?.toLowerCase() === expectedHash.toLowerCase(), `${expectAdds[0] ? `add ${dropSym} dropped from the book` : `remove ${expectRemoves[0]} back in the book`}`);

  // ---- the timelock
  r = runScript(env, 'basket-recon.mjs', recon('execute', live), 'execute before eta');
  check('execute refuses before the eta', refused(r, /timelock not elapsed/));
  await chain.warp(v.registryDelay);
  log(`warped ${Number(v.registryDelay)} s; chain time ${iso(await chain.now())}`);
  const orderBefore = v.assets.map((a) => a.address);
  r = runScript(env, 'basket-recon.mjs', recon('execute', live), 'execute');
  must('execute (live) exits 0', r.status === 0);
  v = await ctx.v();
  const orderAfterExecute = [...orderBefore, ...t.adds.map((a) => getAddress(a))];
  check(`execute: assetCount ${v0.assetCount} → ${v.assetCount}, adds appended in tuple order, removes flagged inRemoval`,
    v.assetCount === v0.assetCount + t.adds.length && v.assets.map((a) => a.address).join() === orderAfterExecute.join() && t.removes.every((a) => v.assets.find((x) => x.address === getAddress(a))?.inRemoval),
    v.assets.map((a) => ctx.sym(a.address)).join(' '));
  const pvErr = await chain.expectRevert(DEV.holder, { address: ctx.vault, functionName: 'portfolioValueAtRef' });
  check('after execute: portfolioValueAtRef reverts PriceUnset (fills closed) while redeem still works', pvErr === 'PriceUnset', `reverts ${pvErr}`);
  const R2 = await redeemCheck(chain, ctx, 'after execute, before first prices');
  await createCheck(chain, ctx, 'after execute', { oldLength: v0.assetCount });
  r = runScript(env, 'basket-recon.mjs', recon('auctions', [...live, '--bidder', DEV.bidder, '--warp']), 'auctions before first prices');
  check('auctions refuse while an added asset is unpriced', refused(r, /unpriced registry assets/));

  // ---- first prices: the two-source gate, then the posts
  const badPlan = path.join(env.work, 'scenarios', `${CURRENT}-plan-priceB-off.json`);
  const bad = loadPlan(planFile);
  bad.adds = bad.adds.map((a) => ({ ...a, priceB: a.priceA * 1.05 }));
  savePlan(badPlan, bad);
  r = runScript(env, 'basket-recon.mjs', recon('first-prices', live, badPlan), 'first-prices with sources 5% apart');
  check('first-prices refuses when the two sources disagree by 5% (> 2%)', refused(r, /sources disagree/));
  r = runScript(env, 'basket-recon.mjs', recon('first-prices', live), 'first-prices');
  must('first-prices (live) exits 0', r.status === 0);
  v = await ctx.v();
  const fp = plan.adds.map((a) => {
    const on = v.assets.find((x) => x.address === getAddress(a.address));
    const refA = toRefPrice(a.priceA, a.decimals);
    const refB = toRefPrice(a.priceB, a.decimals);
    const offB = Math.abs(Number(on.refPrice - refB)) / Number(refB);
    return { symbol: a.symbol, ok: on.refPrice === refA && offB <= FIRST_PRICE_TOL && on.decimals === a.decimals, detail: `${a.symbol} ref ${on.refPrice} == A ${refA}, ${(offB * 1e4).toFixed(0)} bp from B` };
  });
  check('first prices: each add\'s reference == source A and within 2% of source B, decimals re-read from the mock', fp.every((x) => x.ok), fp.map((x) => x.detail).join('; '));
  const R3 = await midAuctionRedeem(chain, ctx, plan);

  // ---- the session
  const fromBlock = await chain.pc.getBlockNumber();
  r = runScript(env, 'basket-recon.mjs', recon('auctions', [...live, '--bidder', DEV.bidder, '--warp', '--fill', 'fair']), 'auctions');
  must('auctions (live, --fill fair, separate bidder) exit 0', r.status === 0);
  plan = loadPlan(planFile);
  await fillsCheck(chain, ctx, fromBlock, plan, plan.trades.length);
  await weightsCheck(chain, ctx, plan, 'after auctions');
  const R4 = await redeemCheck(chain, ctx, 'after auctions');
  continuityCheck(ctx, R3, R4, 'across the auction session (mid-auction → after auctions)');

  // ---- finalize (with the griefing variant when the scenario has removes)
  let finalizedByHook = false;
  if (beforeFinalize) finalizedByHook = await beforeFinalize({ chain, ctx, env, plan, planFile, recon, live, orderAfterExecute, mocks });
  if (!finalizedByHook) {
    r = runScript(env, 'basket-recon.mjs', recon('finalize', live), 'finalize');
    check('finalize exits 0', r.status === 0, plan.removes.length ? '' : 'nothing in removal');
  }
  r = runScript(env, 'basket-recon.mjs', recon('verify'), 'verify');
  check('verify: all of the executor\'s checks pass', r.status === 0 && /all checks passed/.test(r.out));
  const R5 = await redeemCheck(chain, ctx, 'after finalize');
  await createCheck(chain, ctx, 'after finalize');
  continuityCheck(ctx, R0, R5, 'across the whole cycle (before announce → after finalize; 7 days of fee expected)');
  v = await ctx.v();
  REPORT.scenarios[CURRENT].final = { assetCount: v.assetCount, order: v.assets.map((a) => ctx.sym(a.address)), redeemGas: { before: R0.gas.toString(), afterExecute: R2.gas.toString(), afterFinalize: R5.gas.toString() } };
  log(`${ctx.ticker} final registry (${v.assetCount}): ${v.assets.map((a) => ctx.sym(a.address)).join(' ')}; redeem gas ${R0.gas} → ${R2.gas} (transient ${R2.assetCount}) → ${R5.gas}`);
  return { ctx, plan };
}

// ------------------------------------------------------------- scenarios
const SCENARIOS = {
  /** qREV 10 → 15: the existing names shrink to 70% of the book, five
   *  stand-ins take 6% each (the shape the tolerance rule then trades). */
  'qrev-adds': (o, env, chain, cb) => registryChangeFlow(o, env, chain, cb, {
    index: 'qrev',
    standIns: STAND_INS['qrev-adds'],
    expectAdds: Object.keys(STAND_INS['qrev-adds']),
    expectRemoves: [],
    shape: (units, priceOf, adds) => {
      const total = Object.entries(units).reduce((t, [s, u]) => t + u * priceOf(s), 0);
      const out = Object.fromEntries(Object.entries(units).map(([s, u]) => [s, u * 0.7]));
      for (const [s, p] of Object.entries(adds)) out[s] = (0.06 * total) / p;
      return out;
    },
  }),

  /** qX20-like: XRP and DOGE leave, ZEC and XMR enter with the leaving
   *  value split between them; the leaving names drain, one of them is
   *  griefed with a one-unit donation before finalize. */
  'qx20-swap': (o, env, chain, cb) => registryChangeFlow(o, env, chain, cb, {
    index: 'qx20',
    standIns: STAND_INS['qx20-swap'],
    expectAdds: Object.keys(STAND_INS['qx20-swap']),
    expectRemoves: ['XRP', 'DOGE'],
    shape: (units, priceOf, adds) => {
      const leaving = ['XRP', 'DOGE'].reduce((t, s) => t + units[s] * priceOf(s), 0);
      const out = { ...units };
      delete out.XRP;
      delete out.DOGE;
      const n = Object.keys(adds).length;
      for (const [s, p] of Object.entries(adds)) out[s] = leaving / n / p;
      return out;
    },
    beforeFinalize: async ({ chain, ctx, env, plan, planFile, recon, live, orderAfterExecute, mocks }) => {
      const removes = plan.removes.map((x) => getAddress(x.address)); // XRP, DOGE in registry order
      let v = await ctx.v();
      check('drains: both leaving assets at balance 0 after the session', removes.every((a) => v.assets.find((x) => x.address === a)?.balance === 0n), removes.map((a) => `${ctx.sym(a)} ${v.assets.find((x) => x.address === a)?.balance}`).join(', '));
      // Griefing: a stranger faucets the second leaving mock and donates one base unit.
      const griefed = removes[1];
      await chain.tx(DEV.stranger, { address: griefed, abi: ERC20_ABI, functionName: 'faucet', gas: 120_000n });
      await chain.tx(DEV.stranger, { address: griefed, abi: ERC20_ABI, functionName: 'transfer', args: [ctx.vault, 1n], gas: 100_000n });
      const auctionsBefore = (await ctx.v()).auctionCount;
      let r = runScript(env, 'basket-recon.mjs', recon('finalize', live), 'finalize with a 1-unit donation on the second removal');
      v = await ctx.v();
      const firstGone = !v.assets.some((x) => x.address === removes[0]);
      const griefedStays = v.assets.find((x) => x.address === griefed);
      check(`griefing: finalize exits 1 and reports the 1-unit balance on ${ctx.sym(griefed)} instead of looping`, failed(r, /is not zero|not drained/) && !!griefedStays && griefedStays.inRemoval && griefedStays.balance === 1n, `assetCount ${v.assetCount}; ${ctx.sym(removes[0])} finalized: ${firstGone}`);
      const expectedMid = swapPop(orderAfterExecute, [removes[0]]);
      check(`swap-and-pop after finalizing ${ctx.sym(removes[0])}: order matches the simulation`, v.assets.map((a) => a.address).join() === expectedMid.join(), v.assets.map((a) => ctx.sym(a.address)).join(' '));
      r = runScript(env, 'basket-recon.mjs', recon('auctions', [...live, '--bidder', DEV.bidder, '--warp']), 'auctions re-run with the dust in place');
      v = await ctx.v();
      const opened = Number(v.auctionCount - auctionsBefore);
      check('griefing: the auction runner exits 1 after its bounded residual rounds (dust < $1 is never a trade), dust untouched', failed(r, /still outside tolerance/) && opened <= 2 && v.assets.find((x) => x.address === griefed)?.balance === 1n, `${opened} residual auction(s) opened in ≤3 rounds; ${ctx.sym(griefed)} balance still 1`);
      // Remedy, by hand: a one-unit drain auction (keeper opens, bidder fills at the open).
      const buy = getAddress(mocks[Object.keys(mocks)[0]].address);
      const [pS, pB] = await chain.reader.batch([{ address: ctx.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [griefed] }, { address: ctx.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [buy] }]);
      await chain.tx(ctx.keeper, { address: ctx.vault, functionName: 'setRefPrice', args: [griefed, pS], gas: 150_000n });
      await chain.tx(ctx.keeper, { address: ctx.vault, functionName: 'setRefPrice', args: [buy, pB], gas: 150_000n });
      await chain.tx(DEV.bidder, { address: buy, abi: ERC20_ABI, functionName: 'approve', args: [ctx.vault, maxUint256], gas: 100_000n });
      const id = await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'auctionCount' });
      await chain.tx(ctx.keeper, { address: ctx.vault, functionName: 'openAuction', args: [griefed, buy, 1n, 900n], gas: 300_000n });
      const rc = await chain.tx(DEV.bidder, { address: ctx.vault, functionName: 'fill', args: [id, 1n], gas: 800_000n });
      const ev = parseEventLogs({ abi: VAULT_ABI, logs: rc.logs, eventName: 'AuctionFilled' })[0]?.args;
      v = await ctx.v();
      check(`remedy: a 1-unit drain auction (keeper opens, bidder fills) empties ${ctx.sym(griefed)} again, lossAtRef 0`, v.assets.find((x) => x.address === griefed)?.balance === 0n && ev?.lossAtRef === 0n, `auction ${id}, paid ${ev?.buyPaid} ${ctx.sym(buy)}`);
      r = runScript(env, 'basket-recon.mjs', recon('finalize', live), 'finalize after the remedy');
      v = await ctx.v();
      const expectedFinal = swapPop(orderAfterExecute, removes);
      check('finalize after the remedy exits 0', r.status === 0);
      check(`swap-and-pop final: assetCount ${expectedFinal.length} and order match the simulation`, v.assetCount === expectedFinal.length && v.assets.map((a) => a.address).join() === expectedFinal.join(), v.assets.map((a) => ctx.sym(a.address)).join(' '));
      const fin = loadPlan(planFile).finalize;
      check('plan file records both finalizations in order', fin.length === 2 && fin.map((f) => getAddress(f.address)).join() === removes.join(), fin.map((f) => f.symbol).join(', '));
      return true;
    },
  }),

  /** qDUO sleeve reset: BTC 35% above the vault's mark, the book re-solved to
   *  60/40 at that price, so the vault sits ≈66/34 — outside the 5-pt sleeve
   *  tolerance — and one weight-only auction sells BTC for working capital. */
  'qduo-sleeve': async (o, env, chain) => {
    const index = 'barbell';
    const ctx = await vaultCtx(env, chain, index);
    await prepareActors(chain, ctx);
    const v0 = await ctx.v();
    const btc = v0.assets.find((a) => ctx.sym(a.address) === 'BTC');
    const wc = v0.assets.find((a) => ctx.sym(a.address) === 'WC');
    must('qDUO holds exactly BTC and WC', !!btc && !!wc && v0.assetCount === 2, v0.assets.map((a) => ctx.sym(a.address)).join(' '));
    const pBtc = usdOf(btc.refPrice, btc.decimals) * 1.35;
    const uWc = usdOf(wc.refPrice, wc.decimals);
    const { bPath } = writePrices(env, v0, ctx, { BTC: pBtc });
    const units = unitsFromVault(v0, ctx);
    const total = units.BTC * pBtc + units.WC * uWc;
    const bookPath = writeBook(env, CURRENT, {
      updatedAt: new Date().toISOString(), level: 100,
      sleeves: { monetary: { units: { BTC: (0.6 * total) / pBtc } }, workingCapital: { units: (0.4 * total) / uWc, unitValue: uWc, lastAccrual: env.date, proxy: 'DTB3' } },
      targets: { monetary: 0.6, workingCapital: 0.4 }, seats: null, lastReconQuarter: 'rehearsal', onNotice: [],
      synthetic: 'REHEARSAL ONLY — sleeves re-solved to 60/40 at a BTC price 35% above the vault\'s mark',
    });
    const vaultBtcW = (units.BTC * pBtc) / total;
    log(`qDUO at the plan price: vault BTC ${pct(vaultBtcW)} vs book 60.00% (${((vaultBtcW - 0.6) * 100).toFixed(1)} pt)`);
    const planFile = path.join(env.keeper, 'plans', index, `${env.date}.json`);
    const planArgs = ['--index', index, '--date', env.date, '--rpc', env.rpc, '--book', bookPath, '--prices-b', bPath, '--no-fetch', '--duration', String(o.duration)];
    let r = runScript(env, 'basket-plan.mjs', planArgs, 'plan');
    must('plan exits 0', r.status === 0);
    let plan = loadPlan(planFile);
    const tr = plan.trades[0];
    check('plan: one weight-only auction BTC → WC on a sleeve reset, no registry change', plan.adds.length === 0 && plan.removes.length === 0 && plan.trades.length === 1 && tr.sell === 'BTC' && tr.buy === 'WC' && /sleeve reset/.test(tr.reason),
      `${plan.trades.length} trade(s): ${tr ? `${tr.sell}→${tr.buy} $${Math.round(tr.sellValueUsd)} (${tr.reason})` : '—'}`);
    check('plan: trade targets are the sleeve targets 60/40 (every sleeve traded)', plan.targets.every((t) => t.traded) && Math.abs(plan.targets.find((t) => t.symbol === 'BTC').tradeTargetWeight - 0.6) < 1e-9, plan.targets.map((t) => `${t.symbol} ${t.sleeve} ${pct(t.currentWeight)}→${pct(t.tradeTargetWeight)}`).join(', '));
    check('plan: announce tuple null (nothing to announce)', plan.announceTuple === null);
    // The same plan WITH a decision id (the workflow's `decision` input on a
    // weight-only day): the tuple must stay null — an empty announcement is
    // accepted by the contract and blocks the vault's auctions for 7 days.
    const woId = `${env.date}-${index}-rehearsal-weight-only`;
    const woSha = sha256(`rehearsal weight-only decision ${woId}`);
    fs.appendFileSync(env.ledger, JSON.stringify({ id: woId, file: `decisions/${woId}.md`, effectiveFrom: env.date, sha256: woSha, txHash: '0xREHEARSAL-not-anchored', anchoredAt: 'rehearsal' }) + '\n');
    r = runScript(env, 'basket-plan.mjs', [...planArgs, '--decisions', env.ledger, '--decision', woId], 'plan (weight-only, with a decision id)');
    const planWo = r.status === 0 ? loadPlan(planFile) : null;
    check('plan with a decision on a weight-only change: tuple stays null, decisionSha256 recorded, note says nothing to announce', !!planWo && planWo.announceTuple === null && planWo.decisionSha256 === woSha && planWo.notes.some((n) => n.startsWith('nothing to announce')) && planWo.trades.length === 1,
      planWo ? planWo.notes.find((n) => n.startsWith('nothing to announce')) : 'planner failed');
    plan = planWo ?? plan;
    REPORT.scenarios[CURRENT] = { vault: ctx.vault, trades: plan.trades.length, vaultBtcWeightAtPlanPrice: vaultBtcW };
    const recon = (stage, extra = [], planArg = planFile) => ['--index', index, '--stage', stage, '--rpc', env.rpc, '--plan', planArg, ...extra];
    const live = ['--live', '--from', ctx.owner];
    r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledger, ...live]), 'announce (weight-only plan)');
    check('announce refuses a weight-only plan (no tuple); nothing pending afterwards', refused(r, /no complete announce tuple — nothing to announce/) && (await ctx.v()).pendingRegistryChange === ZERO32);
    // A plan file carrying an EMPTY tuple (a hand-edited or older plan): the
    // executor must refuse it before any ledger or chain check.
    const emptyTuplePlan = path.join(env.work, 'scenarios', `${CURRENT}-plan-empty-tuple.json`);
    savePlan(emptyTuplePlan, { ...plan, announceTuple: { adds: [], removes: [], decisionSha256: `0x${woSha}` } });
    r = runScript(env, 'basket-recon.mjs', recon('announce', ['--decisions', env.ledger, ...live], emptyTuplePlan), 'announce with an empty tuple');
    check('announce refuses an empty tuple (would block the vault\'s auctions for 7 days); nothing pending afterwards', refused(r, /empty change/) && (await ctx.v()).pendingRegistryChange === ZERO32);
    r = runScript(env, 'basket-recon.mjs', recon('auctions', [...live, '--bidder', DEV.bidder, '--warp']), 'auctions before the daily mark');
    check('auctions refuse while the chain reference is 35% from the plan (the daily mark must run first)', refused(r, /re-mark with the daily keeper/));
    const posts = await markToPlan(chain, ctx, plan);
    const vm = await ctx.v();
    const btcNow = vm.assets.find((a) => ctx.sym(a.address) === 'BTC');
    check(`daily mark emulated: BTC reference stepped to the plan price in ${posts} in-band post(s)`, btcNow.refPrice === BigInt(plan.registry.find((x) => x.symbol === 'BTC').planRefPrice) && posts >= 2, `ref ${btc.refPrice} → ${btcNow.refPrice}`);
    const faucets = await fundBidder(chain, getAddress(tr.buyAddress), (BigInt(tr.expectedBuyAtOpen) * 102n) / 100n, 'WC');
    log(`bidder WC inventory sized for the buy-in (${faucets} faucet calls)`);
    // Missed-window bound. anvil mines same-second blocks, so a short auction
    // cannot force a miss; a block-timestamp INTERVAL can: at 5/18 of the
    // duration (250 s of 900), the three blocks between the open and the
    // first factor read — the warp block and the two same-value re-posts —
    // put that read at 5/6 of the duration (750 s), past the fair window
    // ([570, 602] s), on every attempt. The runner must cancel, reopen at
    // most twice more, then stop with the duration guidance: three auctions
    // opened and cancelled, nothing filled, no balance moved.
    const latePlan = path.join(env.work, 'scenarios', `${CURRENT}-plan-late.json`);
    r = runScript(env, 'basket-plan.mjs', [...planArgs, '--out', latePlan], 'plan copy for the missed-window bound');
    must('plan copy for the missed-window bound exits 0', r.status === 0);
    const vLate0 = await ctx.v();
    const balBeforeLate = vLate0.assets.map((a) => a.balance.toString()).join();
    const fromLate = await chain.pc.getBlockNumber();
    const interval = Math.ceil((o.duration * 5) / 18);
    await chain.rpc('anvil_setBlockTimestampInterval', [interval]);
    try {
      r = runScript(env, 'basket-recon.mjs', recon('auctions', [...live, '--bidder', DEV.bidder, '--warp', '--fill', 'fair'], latePlan), `auctions with anvil blocks ${interval} s apart (every fair window missed)`);
    } finally {
      await chain.rpc('anvil_removeBlockTimestampInterval', []);
    }
    const vLate = await ctx.v();
    const openedLate = Number(vLate.auctionCount - vLate0.auctionCount);
    const stillOpen = [];
    for (let i = Number(vLate0.auctionCount); i < Number(vLate.auctionCount); i++) stillOpen.push((await chain.pc.readContract({ address: ctx.vault, abi: VAULT_ABI, functionName: 'auctions', args: [BigInt(i)] }))[5]);
    const fillsLate = await chain.pc.getLogs({ address: ctx.vault, event: AUCTION_FILLED, fromBlock: fromLate, toBlock: 'latest' });
    const balancesSame = vLate.assets.map((a) => a.balance.toString()).join() === balBeforeLate;
    check('missed fair window: the runner gives up after 3 attempts with the duration guidance (no endless cancel/reopen, nothing filled)', failed(r, /missed the fair window 3 times/) && /widen the planner's --duration/.test(r.out) && openedLate === 3 && stillOpen.every((x) => x === false) && fillsLate.length === 0 && balancesSame,
      `${openedLate} auction(s) opened, all cancelled: ${stillOpen.every((x) => x === false)}; fills ${fillsLate.length}; balances unchanged: ${balancesSame}; blocks ${interval} s apart`);
    const R0 = await redeemCheck(chain, ctx, 'before the session (after the mark)');
    const R1 = await midAuctionRedeem(chain, ctx, plan);
    const fromBlock = await chain.pc.getBlockNumber();
    r = runScript(env, 'basket-recon.mjs', recon('auctions', [...live, '--bidder', DEV.bidder, '--warp', '--fill', 'fair']), 'auctions');
    must('auctions (live, --fill fair, separate bidder) exit 0', r.status === 0);
    plan = loadPlan(planFile);
    await fillsCheck(chain, ctx, fromBlock, plan, 1);
    await weightsCheck(chain, ctx, plan, 'after the sleeve reset');
    const R2 = await redeemCheck(chain, ctx, 'after auctions');
    continuityCheck(ctx, R1, R2, 'across the auction session');
    r = runScript(env, 'basket-recon.mjs', recon('finalize', live), 'finalize');
    check('finalize: nothing in removal, exits 0', r.status === 0 && /nothing to finalize/.test(r.out));
    r = runScript(env, 'basket-recon.mjs', recon('verify'), 'verify');
    check('verify: all of the executor\'s checks pass', r.status === 0 && /all checks passed/.test(r.out));
    const R3 = await redeemCheck(chain, ctx, 'after verify');
    await createCheck(chain, ctx, 'after the session');
    continuityCheck(ctx, R0, R3, 'across the whole session (after the mark → after verify)');
    const v = await ctx.v();
    const wBtc = Number(v.assets[0].balance * v.assets[0].refPrice) / v.assets.reduce((t, a) => t + Number(a.balance * a.refPrice), 0);
    REPORT.scenarios[CURRENT].final = { btcWeight: ctx.sym(v.assets[0].address) === 'BTC' ? wBtc : 1 - wBtc, redeemGas: R3.gas.toString() };
  },
};

// -------------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error('REFUSED: keeper/rehearse.mjs is a local rehearsal (zero Actions minutes, no runner near a keeper key) — do not wire it into a workflow');
    process.exit(1);
  }
  if (!(await portFree(o.port))) {
    console.error(`port ${o.port} is in use (another anvil?) — pass --port`);
    process.exit(1);
  }
  const env = setupWork(o);
  log(`work ${env.work}; scratch repo ${env.repo}; date ${env.date}; scenarios ${o.scenarios.join(', ')}`);
  const cb = buildContracts(o, env);
  const { anvil, mode } = await bringUpChain(o, env);
  let fails = 1;
  try {
    const chain = await makeChain(env);
    REPORT.anvil = { port: o.port, client: await chain.rpc('web3_clientVersion'), mode };
    if (mode === 'fresh') {
      const need = new Set(o.scenarios.map((s) => ({ 'qrev-adds': 'qrev', 'qx20-swap': 'qx20', 'qduo-sleeve': 'barbell' })[s]));
      for (const index of need) await deployFresh(o, env, cb, index, chain);
    }
    for (const name of o.scenarios) {
      CURRENT = name;
      console.log(`\n[rehearse] ===== scenario ${name} =====`);
      const t0 = Date.now();
      try {
        await SCENARIOS[name](o, env, chain, cb);
      } catch (e) {
        if (!(e instanceof Abort)) check(`scenario ${name} aborted by an unexpected error`, false, e.shortMessage ?? e.message ?? String(e));
        else log(`scenario ${name} stopped: ${e.message}`);
      }
      log(`scenario ${name} took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    CURRENT = 'summary';
    fails = printTable();
  } finally {
    const reportPath = path.join(env.work, `report-${REPORT.startedAt.replace(/[:.]/g, '-')}.json`);
    REPORT.finishedAt = new Date().toISOString();
    REPORT.fails = fails;
    fs.writeFileSync(reportPath, JSON.stringify(REPORT, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
    log(`report ${reportPath}`);
    if (o.keepAnvil) log(`anvil left running on ${env.rpc} (pid ${anvil.child.pid})`);
    else { anvil.child.kill(); log('anvil stopped'); }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Abort ? `ABORTED: ${e.message}` : (e.stack ?? e.shortMessage ?? e.message ?? e));
  process.exit(1);
});
