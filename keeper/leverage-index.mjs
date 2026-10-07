/**
 * Leverage stage A — the daily leg of qBTC2X / qETH2X (a step of the
 * existing paper-index workflow: same KEEPER_PK, same schedule, same
 * `keeper-key` concurrency group; no new key, scheduler or group).
 *
 * One run, per index:
 *   1. refuse if the rule cannot run (check.minutes, check.trigger,
 *      level.primary empty or invalid — exit 2, nothing read, nothing written);
 *      stop if the series is not in force (the inception decision is not
 *      anchored yet, or it is before its date — exit 0); an ANCHORED decision
 *      that the files no longer satisfy (it does not pin this rulebook's
 *      sha256, another date, document missing) is a refusal (exit 2);
 *   2. anchor any line a previous run wrote but did not anchor;
 *   3. for every CLOSED UTC day since the last line, in order: fetch that
 *      day's 1-minute bars from Binance spot (twice, compared), aggregate to
 *      15-minute bars, run keeper/leverage-step.mjs over every bar, have
 *      scripts/verify.mjs recompute the new line on its own (an independent
 *      implementation), append it, anchor it;
 *   4. mark the testnet vault to the last line's level, in steps inside the
 *      contract's ±25% bound — after the anchor, never before.
 *
 * The level is computed from the bars at the grid times, never from a price
 * at the time the keeper wakes, so a late run writes the same level; the line
 * says when it was written (`observedAt`, `keeper.lagSeconds`, `late`). A day
 * is never written before it has ended, on both clocks: the next day's first
 * 1-minute bar must be closed on Binance, and line D is never written before
 * D 00:00 UTC on the runner's clock (red team F02); a source that still calls
 * the day open a full day after that is a failure (exit 1), not a quiet wait.
 * A day with fewer than 1,440 1-minute bars halts the series until a human
 * accepts that exact set of bars (keeper/leverage-gaps.json, an entry with an
 * `id`). A day whose bars would end the series in a model liquidation halts it
 * the same way (exit 1, nothing written, anchored or marked) until a person
 * accepts that exact liquidation in the same file (an entry with an `id` and
 * `liquidation: {bar, ltvLow}`; owner, 2026-10-06). No other exchange stands in
 * for Binance; every request to it has a time limit (red team F09).
 *
 * Usage:
 *   node keeper/leverage-index.mjs --index qbtc2x --anchor          # the workflow step (KEEPER_PK in env)
 *   node keeper/leverage-index.mjs --index qbtc2x --dry-run --replay 2020-03-10..2020-03-13 \
 *        --throwaway-check 120:2.2 --throwaway-level 30:6          # no key, writes keeper/dryrun/
 *   node keeper/leverage-index.mjs --index qbtc2x --replay 2020-03-10..2020-03-13 --throwaway-check 120:2.2 \
 *        --throwaway-level 30:6 --anchor --rpc http://127.0.0.1:8545 --from 0x<anvil account>   # fork rehearsal
 *
 * Options:
 *   --index qbtc2x|qeth2x   required
 *   --anchor                anchor each new line (live: KEEPER_PK; fork rehearsal: --from)
 *   --no-new-lines          write no line: anchor the lines already written but not anchored
 *                           (with --anchor), then mark. For a workflow that pushes the lines to
 *                           main before anything goes on chain (keeper-clock spec G2): run once
 *                           without --anchor and without the key (lines), push, then once with
 *                           --anchor --no-new-lines and the key (anchors, marks) — a day that
 *                           ends between the two runs is not written and anchored unpushed
 *   --dry-run               write keeper/dryrun/{record,anchors,marks}-<index>.jsonl; never reads KEEPER_PK
 *   --replay FROM..TO       FROM is the inception date of the replayed series, TO the last line date;
 *                           only with --dry-run or a fork rehearsal (skips the decision and date checks)
 *   --throwaway-check n:T   stand-in for the empty tested values; only with --dry-run or a fork rehearsal;
 *                           every line it writes carries "rehearsal": "THROWAWAY n=… T=…"
 *   --throwaway-level bp:%  stand-in for an empty level.primary (cost per unit turnover, borrow rate a year)
 *   --rpc URL --from 0x…    fork rehearsal: a local RPC (127.0.0.1 / localhost) and an unlocked account
 *
 * Exit codes: 0 = done, nothing to do, not in force, or series ended;
 * 1 = data or chain failure, or a halt that waits for a person (a gap or a model
 * liquidation not yet accepted) — the workflow opens the paper-index-failure
 * issue; the next run continues from the last line; 2 = configuration (an empty or
 * invalid tested value, a throwaway value outside a dry run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, toHex, getAddress, isAddress, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DAY_MS, MINUTE_MS, sha256, dayMs, dateOf, addDays, isDate, stamp, hhmm, parseKlines, canonicalMinuteText, aggregate15,
  minuteGaps, ruleProblem, rulebookShapeProblem, genesisBook, computeDay, buildLine, markSteps,
} from './leverage-step.mjs';
import { retryRead, blockAtLeast, notYetReason } from './readback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, '..');
export const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify.mjs');
export const INDEXES = ['qbtc2x', 'qeth2x'];
export const GIWA_RPC = 'https://sepolia-rpc.giwa.io';
export const GIWA_CHAIN_ID = 91342;
export const BINANCE_HOST = 'https://data-api.binance.vision';

export const VAULT_ABI = parseAbi([
  'function setNav(uint256 newNavPerShare, uint256 indexLevel)',
  'function setDepositsPaused(bool paused)',
  'function navPerShare() view returns (uint256)',
  'function keeper() view returns (address)',
  'function owner() view returns (address)',
  'function depositsPaused() view returns (bool)',
  'function symbol() view returns (string)',
]);
const ANCHOR_GAS = 60_000n;
const SETNAV_GAS = 120_000n; // measured 36,137 (cast estimate on the qX20 tracking vault, 2026-10-02)
const PAUSE_GAS = 120_000n;

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const refuse = (msg) => new Exit(2, `REFUSED: ${msg}`);

export function isLocalRpc(rpc) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(rpc));
}

// ------------------------------------------------------------------ arguments

export function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const known = new Set(['--index', '--anchor', '--no-new-lines', '--dry-run', '--replay', '--throwaway-check', '--throwaway-level', '--rpc', '--from']);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) throw refuse(`unknown option ${a}`);
  const o = {
    index: opt('--index'),
    anchor: flag('--anchor'),
    noNewLines: flag('--no-new-lines'),
    dryRun: flag('--dry-run'),
    replay: null,
    throwawayCheck: null,
    throwawayLevel: null,
    rpc: opt('--rpc'),
    from: opt('--from'),
  };
  if (!INDEXES.includes(o.index)) throw refuse(`--index must be one of ${INDEXES.join(', ')} (got ${o.index})`);
  const rp = opt('--replay');
  if (argv.includes('--replay')) {
    const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(rp ?? '');
    if (!m || !isDate(m[1]) || !isDate(m[2]) || m[2] < m[1]) throw refuse(`--replay must be FROM..TO with FROM <= TO (got ${rp})`);
    o.replay = { from: m[1], to: m[2] };
  }
  const tc = opt('--throwaway-check');
  if (argv.includes('--throwaway-check')) {
    const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(tc ?? '');
    if (!m) throw refuse(`--throwaway-check must be n:T, e.g. 120:2.2 (got ${tc})`);
    o.throwawayCheck = { minutes: Number(m[1]), trigger: Number(m[2]) };
  }
  const tl = opt('--throwaway-level');
  if (argv.includes('--throwaway-level')) {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(tl ?? '');
    if (!m) throw refuse(`--throwaway-level must be costBp:ratePct, e.g. 30:6 (got ${tl})`);
    o.throwawayLevel = { costBp: Number(m[1]), ratePct: Number(m[2]) };
  }
  if (argv.includes('--rpc') && !o.rpc) throw refuse('--rpc needs a URL');
  if (argv.includes('--from') && !o.from) throw refuse('--from needs an address');
  o.fork = !!(o.rpc && isLocalRpc(o.rpc) && o.from);
  if (o.from && !o.fork) throw refuse('--from is for an unlocked account on a local fork (--rpc http://127.0.0.1:… or localhost)');
  if (o.from && !isAddress(o.from)) throw refuse(`--from ${o.from} is not an address`);
  if (o.rpc && !o.fork) throw refuse('--rpc is accepted only with --from for a local fork rehearsal (the live leg always uses GIWA Sepolia)');
  o.rehearsalMode = o.dryRun || o.fork;
  if ((o.throwawayCheck || o.throwawayLevel) && !o.rehearsalMode) throw refuse('throwaway values are accepted only with --dry-run or a local fork rehearsal (--rpc 127.0.0.1 --from …)');
  if (o.replay && !o.rehearsalMode) throw refuse('--replay is accepted only with --dry-run or a local fork rehearsal');
  return o;
}

// ------------------------------------------------------------------- paths

export function pathsFor(root, index, rehearsalMode) {
  const keeper = path.join(root, 'keeper');
  const out = rehearsalMode ? path.join(keeper, 'dryrun') : path.join(root, 'trackrecord');
  return {
    rulebook: path.join(keeper, 'rulebooks', `${index}.json`),
    records: path.join(out, `record-${index}.jsonl`),
    anchors: path.join(out, `anchors-${index}.jsonl`),
    marks: rehearsalMode ? path.join(keeper, 'dryrun', `marks-${index}.jsonl`) : path.join(keeper, `marks-${index}.jsonl`),
    vaults: rehearsalMode ? path.join(keeper, 'dryrun', 'leverage-vaults.json') : path.join(keeper, 'leverage-vaults.json'),
    gaps: path.join(keeper, 'leverage-gaps.json'),
    ledger: path.join(root, 'trackrecord', 'decisions.jsonl'),
    trackrecord: path.join(root, 'trackrecord'),
  };
}

const readLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const appendLine = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
};

// ------------------------------------------------------------------ Binance

/**
 * Read-only Binance spot REST client (no key). Transient errors are retried briefly; no other host stands in.
 * Every request, body included, is bounded by `timeoutMs` (red team F09: a source that trickles its answer
 * would otherwise hold the step, and the job's "Commit records" for the five paper series, to GitHub's limit).
 */
export const BINANCE_TIMEOUT_MS = 60_000;
export function binanceRest({ host = BINANCE_HOST, fetchImpl = globalThis.fetch, waitMs = 2000, timeoutMs = BINANCE_TIMEOUT_MS } = {}) {
  async function getJSON(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true });
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${url.split('?')[0]}`);
        return await r.json();
      } catch (e) {
        last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? Object.assign(new Error(`no complete answer within ${timeoutMs / 1000} s`), { retry: true }) : e;
        if (last.retry !== true && !/fetch failed|ECONN|ETIMEDOUT|socket/i.test(String(last.message))) throw last;
        await new Promise((res) => setTimeout(res, waitMs * (attempt + 1)));
      }
    }
    throw last;
  }
  return {
    host: host.replace(/^https?:\/\//, ''),
    async time() {
      const j = await getJSON(`${host}/api/v3/time`);
      const t = Number(j?.serverTime);
      if (!Number.isFinite(t)) throw new Error('Binance /api/v3/time answered no serverTime');
      return t >= 1e15 ? Math.floor(t / 1000) : t;
    },
    async klines(symbol, startMs, endMs, limit) {
      const q = new URLSearchParams({ symbol, interval: '1m', startTime: String(startMs), limit: String(limit) });
      if (endMs != null) q.set('endTime', String(endMs));
      return getJSON(`${host}/api/v3/klines?${q}`);
    },
  };
}

/** Has UTC day `day` ended? True when a 1-minute bar opening at or after the next 00:00 is closed. */
async function dayIsFinal(binance, symbol, day, serverTime) {
  const next = dayMs(day) + DAY_MS;
  const rows = parseKlines(await binance.klines(symbol, next, null, 1));
  return rows.length > 0 && rows[0].openMs >= next && rows[0].closeMs < serverTime;
}

/** The closed 1-minute bars opening in [day 00:00, next 00:00), fetched in two pages. */
async function fetchDayOnce(binance, symbol, day, serverTime) {
  const start = dayMs(day);
  const end = start + DAY_MS;
  const rows = [];
  for (let s = start; s < end; s += 1000 * MINUTE_MS) {
    const e = Math.min(s + 1000 * MINUTE_MS, end) - 1;
    rows.push(...parseKlines(await binance.klines(symbol, s, e, 1000)));
  }
  const inDay = rows.filter((m) => m.openMs >= start && m.openMs < end && m.closeMs < serverTime);
  for (let i = 1; i < inDay.length; i++) {
    if (inDay[i].openMs <= inDay[i - 1].openMs) throw new Exit(1, `Binance ${symbol} ${day}: 1-minute bars out of order or repeated at ${stamp(inDay[i].openMs)}`);
  }
  return inDay;
}

/** A day's bars, fetched twice and compared (a difference halts the run). */
async function fetchDay(binance, symbol, day, serverTime) {
  const a = await fetchDayOnce(binance, symbol, day, serverTime);
  const b = await fetchDayOnce(binance, symbol, day, serverTime);
  const ta = canonicalMinuteText(a);
  if (ta !== canonicalMinuteText(b)) throw new Exit(1, `Binance ${symbol} ${day}: two fetches of the same day differ (${a.length} vs ${b.length} rows) — nothing written; the next run fetches again`);
  return { minutes: a, text: ta };
}

// ------------------------------------------------------------- in force?

/**
 * Returns {entry} when the inception decision is in force, else {msg, anchored}.
 * anchored = the decision named by the rulebook IS in the ledger (an anchor
 * cannot be undone) but the files no longer agree with it — the series is due
 * to start and cannot, so the caller refuses (exit 2) even before the genesis
 * line rather than reporting NOT IN FORCE with exit 0 every day (review r2).
 */
function decisionProblem(paths, rb, rulebookSha) {
  const id = rb.inception?.decision;
  if (!rb.inception?.date || !id) return { anchored: false, msg: 'NOT IN FORCE: inception.date / inception.decision are null' };
  const ledger = readLines(paths.ledger);
  const entry = ledger.find((d) => d.id === id);
  if (!entry) return { anchored: false, msg: `NOT IN FORCE: decision not anchored or does not pin this rulebook (${id} is not in trackrecord/decisions.jsonl)` };
  // the decision IS in the ledger: say what no longer matches, not "not anchored" (rehearsal C2)
  const broken = (why) => ({ anchored: true, msg: `NOT IN FORCE: ${why}` });
  const file = path.join(paths.trackrecord, entry.file);
  if (!fs.existsSync(file)) return broken(`${entry.file} missing`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== entry.sha256) return broken(`${entry.file} no longer hashes to the ledger's value`);
  if (!bytes.toString('utf8').includes(rulebookSha)) return broken(`${id} does not contain the rulebook sha256 ${rulebookSha}`);
  if (entry.effectiveFrom !== rb.inception.date) return { anchored: true, msg: `NOT IN FORCE: decision ${id} is effective from ${entry.effectiveFrom}, rulebook inception.date is ${rb.inception.date}` };
  return { entry };
}

// ------------------------------------------------------------------- chain

const giwa = (rpc, id) =>
  defineChain({ id, name: id === GIWA_CHAIN_ID ? 'GIWA Sepolia' : `chain ${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

/** The signer for anchors and marks, or null. Live: KEEPER_PK (signed here, sent raw). Fork: the unlocked --from. */
function makeSigner(o, deps) {
  const transport = deps.transport ?? ((rpc) => http(rpc));
  if (o.fork) {
    const chain = giwa(o.rpc, deps.chainId ?? GIWA_CHAIN_ID);
    const pc = createPublicClient({ chain, transport: transport(o.rpc), pollingInterval: deps.pollingInterval ?? 1000 });
    const address = getAddress(o.from);
    return { pc, wallet: createWalletClient({ account: address, chain, transport: transport(o.rpc) }), address, label: `fork ${o.rpc}, unlocked ${address}` };
  }
  if (o.dryRun) return null; // a dry run never reads the key
  const pk = deps.env.KEEPER_PK;
  if (!pk) return null;
  const chain = giwa(GIWA_RPC, GIWA_CHAIN_ID);
  const account = privateKeyToAccount(pk);
  const pc = createPublicClient({ chain, transport: transport(GIWA_RPC), pollingInterval: deps.pollingInterval ?? 2000 });
  return { pc, wallet: createWalletClient({ account, chain, transport: transport(GIWA_RPC) }), address: account.address, label: 'GIWA Sepolia, KEEPER_PK' };
}

async function sendNonceSafe(fn, wait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 4 || !/nonce/i.test(String(e?.message))) throw e;
      await wait(4000 * (attempt + 1));
    }
  }
}

async function anchorLine(signer, index, line, anchorsPath, deps) {
  const hash = await sendNonceSafe(
    () => signer.wallet.sendTransaction({ to: signer.address, value: 0n, data: toHex(`qxpi-${index}:` + line.hash), gas: ANCHOR_GAS }),
    deps.wait
  );
  const rc = await signer.pc.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Exit(1, `anchor of #${line.seq} ${line.date} reverted (${hash})`);
  appendLine(anchorsPath, { date: line.date, seq: line.seq, headHash: line.hash, txHash: hash });
  deps.log(`  anchored #${line.seq} ${line.date} in ${hash} (block ${rc.blockNumber})`);
}

/** Marks the vault to the last line's level, in contract-bounded steps; after a model liquidation, steps to the floor and pauses deposits. */
async function markVault({ signer, vault, ticker, gate, line, marksPath, deps }) {
  const { pc, wallet, address } = signer;
  const E = line.liquidated ? 0 : line.book.E;
  const target = BigInt(Math.round(E * 1e6));
  const indexLevel = BigInt(Math.round(100 * E * 1e6));
  const read = (functionName, blockNumber) => pc.readContract({ address: vault, abi: VAULT_ABI, functionName, ...(blockNumber != null ? { blockNumber } : {}) });
  // every testnet vault has the same keeper key, so the keeper check alone accepts any of them (red team F05a)
  const symbol = await read('symbol');
  if (symbol !== ticker) throw new Exit(1, `vault ${vault} is ${JSON.stringify(symbol)}, not ${ticker} — keeper/leverage-vaults.json names the wrong vault; no mark sent`);
  const keeper = getAddress(await read('keeper'));
  if (keeper !== getAddress(address)) throw new Exit(1, `vault ${vault} keeper is ${keeper}, not the signer ${address} — no mark sent`);
  const cur = await read('navPerShare');
  if (gate.mode === 'halt') {
    const move = Number(target) / Number(cur) - 1;
    if (Math.abs(move) > gate.pct / 100) {
      throw new Exit(1, `MARK HALTED: the level moves the vault ${(move * 100).toFixed(2)}% (navPerShare ${cur} → ${target}), beyond the ±${gate.pct}% gate — nothing sent; a person decides (keeper/RUNBOOK.md, leverage marks)`);
    }
  }
  // After a write, a simulation runs at a block >= that write's receipt (as in
  // basket-recon.mjs since 9ee440d): GIWA's public endpoint is load-balanced, and
  // a node behind the last step would judge the next step against the old
  // navPerShare and fake a "nav move too large". Repeated only while the node
  // lacks the block; a revert is final.
  let floor = null;
  const simulate = async (data, what) => {
    if (floor == null) return pc.call({ account: address, to: vault, data });
    const { value } = await retryRead(async () => pc.call({ account: address, to: vault, data, blockNumber: await blockAtLeast(pc, floor) }), {
      what: `simulation of ${what} at a block >= ${floor}`,
      retryIf: (e) => notYetReason(e) != null,
      ...(deps.readTiming ?? {}),
    });
    return value;
  };
  const steps = markSteps(cur, target);
  const reach = steps.length ? steps.at(-1) : cur;
  // At navPerShare 3 or below a 25% step rounds to zero and nothing can move the vault (red team F05d).
  // After a model liquidation that floor is the intended end; any other unreachable target is a failure.
  if (reach !== target && !line.liquidated) throw new Exit(1, `vault ${vault} cannot reach navPerShare ${target} from ${cur}: the contract's 25% bound rounds to zero at ${reach} — nothing sent; a person decides (keeper/RUNBOOK.md, leverage marks)`);
  deps.log(`  vault ${vault}: navPerShare ${cur} → target ${target}${steps.length ? ` in ${steps.length} step(s)` : reach === target ? ' — already there' : ''}${line.liquidated ? ' (model liquidation: the floor is as low as the contract goes)' : ''}`);
  for (let k = 0; k < steps.length; k++) {
    const next = steps[k];
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'setNav', args: [next, indexLevel] });
    await simulate(data, `setNav step ${k + 1}/${steps.length}`); // a revert stops here, before anything is sent
    const tx = await sendNonceSafe(() => wallet.sendTransaction({ to: vault, data, gas: SETNAV_GAS }), deps.wait);
    const rc = await pc.waitForTransactionReceipt({ hash: tx });
    if (rc.status !== 'success') throw new Exit(1, `setNav step ${k + 1}/${steps.length} reverted (${tx})`);
    floor = rc.blockNumber;
    appendLine(marksPath, { date: line.date, seq: line.seq, step: k + 1, of: steps.length, nav: Number(next), indexLevel: Number(indexLevel), tx, block: Number(rc.blockNumber) });
    const rb = await retryRead(
      async () => {
        const v = await read('navPerShare', rc.blockNumber);
        if (v !== next) throw new Error(`navPerShare ${v} at block ${rc.blockNumber}, expected ${next}`);
        return v;
      },
      { what: `navPerShare after step ${k + 1}`, ...(deps.readTiming ?? {}) }
    );
    deps.log(`    step ${k + 1}/${steps.length}: navPerShare ${next} tx=${tx} block ${rc.blockNumber}${rb.reads > 1 ? ` (read back at read ${rb.reads})` : ''}`);
  }
  if (line.liquidated) {
    const owner = getAddress(await read('owner'));
    if (owner !== getAddress(address)) throw new Exit(1, `model liquidation: the vault owner ${owner} is not the keeper — the owner must call setDepositsPaused(true) (nothing sent)`);
    const paused = floor == null
      ? await read('depositsPaused')
      : (await retryRead(() => read('depositsPaused', floor), { what: `depositsPaused at block ${floor}`, retryIf: (e) => notYetReason(e) != null, ...(deps.readTiming ?? {}) })).value;
    if (!paused) {
      const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'setDepositsPaused', args: [true] });
      await simulate(data, 'setDepositsPaused(true)');
      const tx = await sendNonceSafe(() => wallet.sendTransaction({ to: vault, data, gas: PAUSE_GAS }), deps.wait);
      const rc = await pc.waitForTransactionReceipt({ hash: tx });
      if (rc.status !== 'success') throw new Exit(1, `setDepositsPaused(true) reverted (${tx})`);
      appendLine(marksPath, { date: line.date, seq: line.seq, action: 'pause', tx, block: Number(rc.blockNumber) });
      deps.log(`    deposits paused tx=${tx}`);
    }
  }
}

// --------------------------------------------------------- independent recompute

/** Runs scripts/verify.mjs --recompute-only on the series with `newLine` appended, in a temporary directory. */
function recomputeWith(paths, index, existing, newLine, { rehearsal, verifyScript }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lev-${index}-`));
  try {
    fs.writeFileSync(path.join(tmp, `record-${index}.jsonl`), [...existing, newLine].map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.copyFileSync(paths.rulebook, path.join(tmp, `rulebook-${index}.json`));
    if (fs.existsSync(paths.ledger)) {
      fs.copyFileSync(paths.ledger, path.join(tmp, 'decisions.jsonl'));
      const id = existing[0]?.inception?.decision ?? newLine.inception?.decision;
      const entry = id ? readLines(paths.ledger).find((d) => d.id === id) : null;
      if (entry) {
        fs.mkdirSync(path.dirname(path.join(tmp, entry.file)), { recursive: true });
        fs.copyFileSync(path.join(paths.trackrecord, entry.file), path.join(tmp, entry.file));
      }
    }
    const args = [verifyScript, '--dir', tmp, '--series', index, '--recompute-only'];
    if (rehearsal) args.push('--allow-rehearsal');
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------- run

export async function run(argv, depsIn = {}) {
  const deps = {
    root: REPO_ROOT,
    now: () => Date.now(),
    env: process.env,
    log: (m) => console.log(m),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    verifyScript: VERIFY_SCRIPT,
    ...depsIn,
  };
  try {
    return await runInner(argv, deps);
  } catch (e) {
    if (e instanceof Exit) {
      (e.code === 0 ? deps.log : (m) => console.error(m))(e.message);
      return e.code;
    }
    console.error(e?.shortMessage ?? e?.message ?? e);
    return 1;
  }
}

async function runInner(argv, deps) {
  const o = parseArgs(argv);
  const paths = pathsFor(deps.root, o.index, o.rehearsalMode);
  const rbBytes = fs.readFileSync(paths.rulebook);
  const rb = JSON.parse(rbBytes.toString('utf8'));
  const rulebookSha256 = sha256(rbBytes);
  const shape = rulebookShapeProblem(rb);
  if (shape) throw refuse(`keeper/rulebooks/${o.index}.json: ${shape}`);

  // §1-6 1–3: the two tested values and the level convention. A live run may
  // use only the rulebook's own values.
  const check = o.throwawayCheck ?? rb.check ?? {};
  const primary = o.throwawayLevel ?? rb.level?.primary ?? null;
  const problem = ruleProblem({ target: rb.product.target, minutes: check.minutes, trigger: check.trigger, primary });
  if (problem) throw refuse(`${problem.field} — ${problem.why}${o.rehearsalMode ? '' : '; a live run uses the rulebook only (the sixth test fills check.*, the owner level.primary)'}`);
  const rehearsalLabel = o.rehearsalMode
    ? o.throwawayCheck || o.throwawayLevel
      ? `THROWAWAY n=${check.minutes} T=${check.trigger}${o.throwawayLevel ? ` costBp=${primary.costBp} ratePct=${primary.ratePct}` : ''}`
      : 'DRY RUN'
    : null;
  const rule = {
    rulebookSha256,
    target: rb.product.target,
    reset: rb.product.reset,
    checkMinutes: check.minutes,
    trigger: check.trigger,
    barMinutes: rb.underlying.barMinutes,
    lltv: rb.model.lltv,
    costBp: primary.costBp,
    ratePct: primary.ratePct,
    ...(rb.level.also.length ? { also: rb.level.also.map((a) => ({ id: a.id, costBp: a.costBp, ratePct: a.ratePct })) } : {}),
  };

  // §1-6 4–6: in force? (a replay is its own inception and skips them)
  let inception = { date: null, decision: null, decisionSha256: null };
  if (o.replay) {
    inception.date = o.replay.from;
  } else {
    // Before the genesis line, "not in force" is the normal state (exit 0).
    // Once the series has lines it is a configuration error: an edit to the
    // pinned rulebook JSON or to the ledger would otherwise stop the series
    // silently every day with exit 0 and no failure issue.
    const started = readLines(paths.records).length;
    const stop = (msg) => (started ? refuse(`${path.relative(deps.root, paths.records)} already holds ${started} line(s), so the series has started — ${msg}. Was keeper/rulebooks/${o.index}.json or the decision ledger changed after inception? (keeper/RUNBOOK.md, leverage)`) : new Exit(0, msg));
    const d = decisionProblem(paths, rb, rulebookSha256);
    // An anchored inception decision that the files no longer satisfy is never
    // "not yet": the anchor is irreversible and the genesis line is due, so a
    // silent exit 0 would leave the opening stalled with no failure issue.
    if (d.msg && d.anchored && !started) throw refuse(`the inception decision ${rb.inception.decision} is anchored, but ${d.msg.replace(/^NOT IN FORCE: /, '')} — the series cannot start. Restore keeper/rulebooks/${o.index}.json to the bytes the decision pins (or anchor a postponement decision); never edit an anchored decision (keeper/RUNBOOK.md, leverage)`);
    if (d.msg) throw stop(d.msg);
    if (deps.now() < dayMs(rb.inception.date)) throw stop(`NOT IN FORCE: inception ${rb.inception.date}`);
    inception = { date: rb.inception.date, decision: d.entry.id, decisionSha256: d.entry.sha256 };
  }

  const ticker = rb.ticker;
  const symbol = rb.underlying.symbol;
  const lines = readLines(paths.records);
  const anchors = readLines(paths.anchors);
  deps.log(`${ticker} ${o.rehearsalMode ? `[${rehearsalLabel}] ` : ''}rule n=${rule.checkMinutes} T=${rule.trigger} cost ${rule.costBp}bp rate ${rule.ratePct}% · rulebook ${rulebookSha256.slice(0, 12)}… · ${lines.length} line(s) in ${path.relative(deps.root, paths.records)}`);

  if (lines.length) {
    const g = lines[0];
    if (g.date !== inception.date) throw refuse(`${path.relative(deps.root, paths.records)} starts ${g.date}, not the inception ${inception.date}${o.rehearsalMode ? ' — remove the dry-run files of this index to replay another series' : ''}`);
    const lastRule = JSON.stringify(lines.at(-1).rule);
    if (lastRule !== JSON.stringify(rule)) throw refuse(`the rule of the last line differs from this run's (${lastRule} vs ${JSON.stringify(rule)}) — a rule change needs its own decision`);
  }
  if (lines.at(-1)?.liquidated) {
    deps.log(`series ended: line #${lines.at(-1).seq} ${lines.at(-1).date} recorded a model liquidation — nothing to do (a new series is a new decision)`);
  }

  const signer = o.anchor || o.fork ? makeSigner(o, deps) : null;
  const anchoring = o.anchor && !!signer;
  if (o.anchor && !signer) deps.log(o.dryRun && !o.fork ? '--anchor in a dry run without a fork — no anchor attempted' : '--anchor requested but KEEPER_PK is not set — lines are written unanchored; the next run with the key anchors them first');
  if (!o.anchor) deps.log('--anchor not passed — no on-chain anchor attempted for this run.');

  // 2. a line written by an earlier run but not anchored is anchored first
  if (anchoring) {
    for (const line of lines) if (!anchors.some((a) => a.seq === line.seq)) {
      deps.log(`  #${line.seq} ${line.date} has no anchor — anchoring it first`);
      await anchorLine(signer, o.index, line, paths.anchors, deps);
    }
  }

  // 3. every closed day since the last line, in order
  const binance = o.noNewLines ? null : deps.binance ?? binanceRest();
  const gapsFile = fs.existsSync(paths.gaps) ? JSON.parse(fs.readFileSync(paths.gaps, 'utf8')) : { accepted: [] };
  let written = 0;
  if (o.noNewLines) deps.log('--no-new-lines: no line is computed in this run (anchors and marks only)');
  while (!o.noNewLines && !lines.at(-1)?.liquidated) {
    const D = lines.length ? addDays(lines.at(-1).date, 1) : inception.date;
    if (o.replay && D > o.replay.to) break;
    const day = addDays(D, -1); // the UTC day whose bars line D carries
    // The runner's clock as well as the source's: line D is never written before D 00:00 UTC (red team F02a).
    if (deps.now() < dayMs(D)) {
      deps.log(`line ${D} not written: the runner's clock (${new Date(deps.now()).toISOString()}) is before ${D}T00:00Z — a day is never written before it has ended`);
      break;
    }
    // A Binance failure names the host, the day and that nothing was written (rehearsal C1).
    const source = async (what, fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof Exit) throw e;
        throw new Exit(1, `Binance (${binance.host}) failed while ${what} ${day}: ${e?.message ?? e} — nothing written for ${D}; the next run continues from the last line`);
      }
    };
    const serverTime = await source('reading the server time for', () => binance.time());
    if (!(await source('checking the end of', () => dayIsFinal(binance, symbol, day, serverTime)))) {
      // A source that still calls the day open a full day after it ended has a stuck clock or stuck bars (red team F02b).
      if (deps.now() >= dayMs(D) + DAY_MS) throw new Exit(1, `Binance says ${day} has not ended (no closed 1-minute bar at or after ${D}T00:00Z, server time ${new Date(serverTime).toISOString()}), but the runner's clock is ${new Date(deps.now()).toISOString()}, more than a day later — the source is stuck; nothing written for ${D}`);
      deps.log(`${day} not final (no closed 1-minute bar at or after ${D}T00:00Z yet) — line ${D} not written`);
      break;
    }
    const fetchedAt = new Date(deps.now()).toISOString();
    const { minutes, text } = await source('fetching the 1-minute bars of', () => fetchDay(binance, symbol, day, serverTime));
    const sourcesSha = sha256(text);
    let gaps = null;
    let gapAccepted = null;
    if (minutes.length < 1440) {
      // an entry that accepts a model liquidation (below) is not a gap acceptance
      const acc = (gapsFile.accepted ?? []).find((g) => g.index === o.index && g.day === day && g.sha256 === sourcesSha && !g.liquidation);
      if (!acc) {
        const g = minuteGaps(minutes, day);
        throw new Exit(1, `Binance ${symbol} ${day}: ${minutes.length} of 1,440 1-minute bars (missing ${g.map((x) => `${x.from}–${x.to}`).slice(0, 6).join(', ')}${g.length > 6 ? ', …' : ''}; canonical sha256 ${sourcesSha}) — halted, nothing written for ${D} or later. Missing bars are never filled: a person confirms the gap and adds {id, index, day, sha256, missing, note, confirmedAt} to keeper/leverage-gaps.json, with id a name of its own, e.g. "${o.index}-${day}" (keeper/RUNBOOK.md, leverage gaps).`);
      }
      // the line records the entry's id and the verifier requires it (red team F01)
      if (typeof acc.id !== 'string' || !acc.id) throw new Exit(1, `keeper/leverage-gaps.json: the accepted gap of ${o.index} ${day} (sha256 ${sourcesSha}) has no "id" — add one, e.g. "${o.index}-${day}"; nothing written for ${D}`);
      gaps = minuteGaps(minutes, day);
      gapAccepted = acc.id;
    }
    const bars = aggregate15(minutes);
    const sources = { host: binance.host, symbol, interval: '1m', rows: minutes.length, sha256: sourcesSha, finalBy: `${D}T00:00Z`, fetchedAt };
    const observedAt = new Date(deps.now()).toISOString();
    const keeper = {
      lagSeconds: Math.floor((Date.parse(observedAt) - dayMs(D)) / 1000),
      run: deps.env.GITHUB_RUN_ID ? `${deps.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${deps.env.GITHUB_REPOSITORY}/actions/runs/${deps.env.GITHUB_RUN_ID}` : 'local',
    };
    let line;
    if (!lines.length) {
      if (!bars.length) throw new Exit(1, `${day} has no bar at all — the series cannot start from it`);
      const lastBar = bars.at(-1);
      const book = genesisBook(rule.target, lastBar);
      const books = rule.also ? Object.fromEntries(rule.also.map((a) => [a.id, { ...book }])) : null;
      line = buildLine({
        seq: 0, date: D, observedAt, ticker, prevHash: null, rule, keeper, sources, gaps, gapAccepted, rehearsal: rehearsalLabel,
        genesis: { book, books, lastBar, inception: { decision: inception.decision, decisionSha256: inception.decisionSha256 } },
      });
    } else {
      const prev = lines.at(-1);
      const dayResult = computeDay(prev, bars, rule);
      // A model-liquidation line is written only after a person accepts it (owner, 2026-10-06): one wrong
      // one-minute low would otherwise end the series, anchor it and step the vault to its floor in one run
      // with no person in between (red team F06). Until an entry of keeper/leverage-gaps.json accepts this
      // exact liquidation (index, day, sha256 of the day's bars, bar and LTV at the low) under an id of its
      // own, nothing is written for D or later, nothing is anchored and the vault is not marked.
      let liquidationAccepted = null;
      const liq = dayResult.primary.liquidated;
      if (liq) {
        const acc = (gapsFile.accepted ?? []).find((g) => g.index === o.index && g.day === day && g.sha256 === sourcesSha && g.liquidation?.bar === liq.bar && g.liquidation?.ltvLow === liq.ltvLow);
        if (!acc) {
          const b = bars.find((x) => hhmm(x.openMs) === liq.bar);
          const m = b ? minutes.filter((x) => x.openMs >= b.openMs && x.openMs < b.openMs + 15 * MINUTE_MS).reduce((lo, x) => (lo == null || x.l < lo.l ? x : lo), null) : null;
          throw new Exit(1, `${ticker} ${day}: MODEL LIQUIDATION NOT WRITTEN — the bar ${liq.bar} UTC has a low${b ? ` of ${b.l}` : ''}${m ? ` (the 1-minute bar ${hhmm(m.openMs)})` : ''} at which debt ÷ collateral is ${liq.ltvLow}, at or above the line ${rule.lltv}; canonical sha256 ${sourcesSha}. Halted: nothing written for ${D} or later, nothing anchored, the vault not marked (it keeps its last price, deposits as they were). A person checks that low against other venues' bars for the same minutes. If it is real, add {id, index, day, sha256, liquidation: {bar, ltvLow}, note, confirmedAt} to keeper/leverage-gaps.json with id a name of its own, e.g. "${o.index}-${day}-liquidation", and bar "${liq.bar}", ltvLow ${liq.ltvLow}; the next run writes the level-0 line, anchors it, steps the vault to the contract's floor and pauses deposits. If it is not, add nothing: the series stays halted, and no code continues it from a corrected book yet (keeper/RUNBOOK.md, leverage model liquidation).`);
        }
        if (typeof acc.id !== 'string' || !acc.id) throw new Exit(1, `keeper/leverage-gaps.json: the accepted model liquidation of ${o.index} ${day} (sha256 ${sourcesSha}) has no "id" — add one, e.g. "${o.index}-${day}-liquidation"; nothing written for ${D}`);
        liquidationAccepted = acc.id;
      }
      line = buildLine({ seq: prev.seq + 1, date: D, observedAt, ticker, prevHash: prev.hash, rule, keeper, sources, gaps, gapAccepted, liquidationAccepted, rehearsal: rehearsalLabel, day: dayResult });
    }
    // independent recompute before anything is appended
    const rc = recomputeWith(paths, o.index, lines, line, { rehearsal: o.rehearsalMode, verifyScript: deps.verifyScript });
    if (!rc.ok) throw new Exit(1, `independent recompute (scripts/verify.mjs --recompute-only) rejected line ${D} — nothing appended:\n${rc.out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).join('\n')}`);
    appendLine(paths.records, line);
    lines.push(line);
    written++;
    deps.log(`${ticker} #${line.seq} ${D} level ${line.level}${line.late ? ' (late)' : ''} · ${line.slots.length} slot(s), ${line.dayStats.triggers} trigger(s), ${line.dayStats.trades} trade(s)${line.liquidated ? ` · MODEL LIQUIDATION at ${line.liquidated.bar} (LTV ${line.liquidated.ltvLow}) — series ends` : ''} · head ${line.hash.slice(0, 16)}…`);
    if (anchoring) await anchorLine(signer, o.index, line, paths.anchors, deps);
  }
  if (!written) deps.log('no new line');

  // 4. the vault follows the record: after the anchor, from the last line
  const last = lines.at(-1);
  if (!last) return 0;
  const vaults = fs.existsSync(paths.vaults) ? JSON.parse(fs.readFileSync(paths.vaults, 'utf8')) : {};
  const v = vaults[o.index];
  if (!v?.address) {
    deps.log('no vault — marks skipped');
    return 0;
  }
  if (!v.gate) {
    deps.log('mark gate not set — marks skipped');
    return 0;
  }
  if (!signer) {
    deps.log('no signer — marks skipped');
    return 0;
  }
  if (!readLines(paths.anchors).some((a) => a.seq === last.seq && a.headHash === last.hash)) {
    deps.log(`#${last.seq} ${last.date} is not anchored — marks skipped (the anchor goes first)`);
    return 0;
  }
  const chainId = await signer.pc.getChainId();
  if (chainId !== v.chainId) throw new Exit(1, `RPC is chain ${chainId}, the vault entry says ${v.chainId}`);
  if (!['step', 'halt'].includes(v.gate.mode) || (v.gate.mode === 'halt' && !(v.gate.pct > 0))) throw refuse(`${path.relative(deps.root, paths.vaults)} ${o.index}.gate must be {"mode":"step"} or {"mode":"halt","pct":<number>} (got ${JSON.stringify(v.gate)})`);
  try {
    await markVault({ signer, vault: getAddress(v.address), ticker, gate: v.gate, line: last, marksPath: paths.marks, deps });
  } catch (e) {
    const msg = e instanceof Exit ? e.message : (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0];
    console.error(`${ticker} vault marks FAILED after line #${last.seq} was written and anchored: ${msg}`);
    if (deps.env.GITHUB_ACTIONS === 'true') console.log(`::error title=${ticker} vault marks failed::${msg}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}

// exported for the tests
export { hhmm, dateOf };
