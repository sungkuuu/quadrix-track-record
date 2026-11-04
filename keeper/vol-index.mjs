/**
 * BTC volatility index (working name) — keeper CLI for its two lines,
 * `qvol` (realized, ticker qVOL) and `volbtc-implied`. Neither line is in
 * force in this repository: the realized line starts only once its inception
 * decision is anchored (the in-force path below); the implied line is
 * switched off and has no in-force path. What the series is and is not:
 * docs/vol-index.md.
 *
 * Realized, one run (--dry-run): read the last line → is the next day D over
 * (Binance server time and D's first closed 1-minute bar)? → fetch D-1's
 * 1-minute bars twice and compare the canonical text → 1,440 bars, or an
 * accepted gap whose sha256 matches, else stop (exit 1, nothing written) →
 * build the line → have scripts/verify-vol.mjs recompute it on its own (a
 * child process, the new line after the record's last line with --tail, the
 * rule against the rulebook JSON; non-zero = discard, exit 1) → append → next day.
 *
 * Realized, in force (no --dry-run; the daily paper-index step runs
 * `--line realized --anchor` with KEEPER_PK in its environment):
 *   1. in force? With inception.date null in keeper/rulebooks/qvol.json:
 *      NOT IN FORCE, exit 0, nothing else read, nothing written. Otherwise
 *      inception.decision must be in trackrecord/decisions.jsonl (the ledger
 *      the decision anchor appends to), its file must still hash to the
 *      ledger's value and carry this rulebook's sha256, and it must be
 *      effective on the day before inception.date: the decision is effective
 *      on the day it is anchored and the first line is dated the next UTC
 *      day. A decision not in the ledger yet, or a run before inception.date
 *      00:00 UTC, is NOT IN FORCE (exit 0, nothing written, no request); a
 *      decision in the ledger that the files no longer satisfy is refused
 *      (exit 2), and so is any of these once the record has a line;
 *   2. a line an earlier run wrote but did not anchor is anchored first;
 *   3. every closed UTC day since the last line, in order — the first line
 *      is dated inception.date and no day before it is ever written: the
 *      same line a dry run builds (same fields, same order), without
 *      "shadow" and with inception {decision, decisionSha256} on the first
 *      line → scripts/verify-vol.mjs recomputes it as above (a mismatch: exit
 *      1, nothing appended, anchored or marked) → appended to
 *      trackrecord/record-qvol.jsonl → anchored: a zero-value self-send whose
 *      calldata is `qxpi-qvol:` + the line's hash, signed here with KEEPER_PK
 *      and sent raw, as the other daily series (trackrecord/anchors-qvol.jsonl).
 *      Line D is never written before D 00:00 UTC on the runner's clock, and
 *      a source that still calls the day open a full day after that is a
 *      failure (exit 1). A day that earlier runs missed is written by a later
 *      run from the same closed bars and carries "late": true;
 *   4. the display vault (keeper/leverage-vaults.json, entry qvol; deposit
 *      cap 0) is marked to the last line after that line is anchored, never
 *      before, and only when its symbol() is the rulebook's ticker, its
 *      keeper() is the signer and its depositCap() is 0: the share price goes to
 *      n6 = floor(value x 1,000,000) — the record value, unrounded, cut to the
 *      contract's unit of 1e-6 — in setNav steps inside the contract's bound
 *      of 25% per mark (markSteps, keeper/leverage-step.mjs), each step read
 *      back (keeper/marks-qvol.jsonl). No address or no gate in the registry,
 *      no key, or an unanchored last line: no mark. The keeper sends the
 *      vault nothing but setNav; keeper/deploy-mark-vault.mjs refuses
 *      open-deposits for qvol (a display vault takes no deposits).
 * A dry run never reads a key, never anchors and never marks; it loads no
 * chain library.
 *
 * Fork rehearsal (--rpc <local URL> --from 0x…, the two together): the same
 * in-force path against a local anvil fork of GIWA Sepolia, signed by the
 * account --from that the fork node holds unlocked (eth_sendTransaction to
 * --rpc; KEEPER_PK is not read and nothing is signed here). The record, the
 * anchors, the marks and the vault registry are read and written under
 * keeper/dryrun/ instead (that registry is the one keeper/deploy-mark-vault.mjs
 * writes on a fork); the decision ledger, the rulebook JSON and the gap file
 * are read where the line in force reads them, and nothing under trackrecord/
 * is written. --rpc must name 127.0.0.1, localhost or [::1] (the host as a URL
 * parser reads it). --rpc or --from alone, with --dry-run, with --line implied
 * or under GitHub Actions is refused (exit 2) before anything is read. Each
 * step prints its result: the decision check, each line and its recompute,
 * each anchor, each mark step (keeper/test/rehearse-qvol.mjs drives it).
 *
 * Implied, one run (--dry-run): a line for today already → nothing to do →
 * get_instruments, then get_book_summary_by_currency (or the saved raw
 * responses of --from-snapshot) → value or null with a reason → recompute →
 * append. A missed day is never filled in.
 *
 * Usage:
 *   node keeper/vol-index.mjs --line realized --anchor        # the daily workflow step (KEEPER_PK in env)
 *   node keeper/vol-index.mjs --line realized --anchor --rpc http://127.0.0.1:8599 --from 0x<unlocked>   # fork rehearsal
 *   node keeper/vol-index.mjs --line realized --dry-run --replay 2019-03-04..2019-03-31 --out keeper/dryrun
 *   node keeper/vol-index.mjs --line implied --collect-only --out <dir>
 *   node keeper/vol-index.mjs --line implied --dry-run --from-snapshot <book.json.gz> --instruments <inst.json.gz>
 *
 * Options:
 *   --line realized|implied   required
 *   --anchor                  (realized, in force) anchor each new line and mark the display vault, with
 *                             KEEPER_PK; without it, or without the key, lines are written unanchored and
 *                             the next run with the key anchors them first. Not accepted with --dry-run
 *   --rpc URL --from 0x…      (realized, in force) fork rehearsal: a local RPC (127.0.0.1, localhost, [::1]) and
 *                             an account unlocked there; record, anchors, marks and registry under keeper/dryrun/
 *   --dry-run                 write lines under --out only; every line carries "shadow": true
 *   --out <dir>               default keeper/dryrun/ (gitignored); for --dry-run and --collect-only (refused in force)
 *   --collect-only            (implied) save the two raw responses gzipped and their sha256; no value
 *   --from-snapshot <book.json.gz> --instruments <inst.json.gz>   (implied, --dry-run) compute from saved responses
 *   --replay FROM..TO         (realized, --dry-run) FROM is the first line's date, TO the last
 *   --offline <dir>           (realized, --dry-run) bars from <dir>/btcusdt-1m-<YYYY-MM-DD>.csv; no network
 *   --gaps <file>             (realized, --dry-run) the gap acceptance file; default keeper/vol-index-gaps.json
 *   --quotes embed|hash       (implied) embed the quotes in the line (default) or only their sha256
 *
 * Each line has its own rulebook JSON (realized keeper/rulebooks/qvol.json,
 * implied keeper/rulebooks/volbtc-implied.json), so
 * a line's rule (and the rulebookSha256 its lines carry) covers that line's
 * values only, and one line can start, stop or change without touching the
 * other's record.
 *
 * The switch (implied line only): an implied rulebook with "active": false
 * turns that line off. Every run of it (in force, --dry-run, --collect-only)
 * prints INACTIVE and exits 0 — no file read besides the rulebook, no network
 * call, nothing written. The code of the line stays; setting "active": true
 * turns it back on. An inactive line cannot carry an inception date. The
 * realized rulebook has no "active" key (a rulebook with one is refused):
 * whether the realized line is in force is decided by its inception only.
 *
 * Without --dry-run (and without --collect-only) a line (the implied line: an
 * active one) whose inception is null prints NOT IN FORCE and exits 0 — no
 * file, no network call. The implied line has no in-force path: with its
 * inception set it is refused (exit 2).
 *
 * Exit codes: 0 = done, nothing to do, not in force, inactive; 1 = data or
 * chain failure (nothing written for the failed day; a line whose anchor
 * failed is written, and the next run anchors it first), or a vault mark that
 * failed after the line was written and anchored; 2 = configuration (bad
 * option, bad rulebook or acceptance file, an anchored inception decision
 * that the files no longer satisfy).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sha256, dayMs, dateOf, addDays, isDate, canonicalMinuteText, minuteGaps, dayClose, realizedFromWindow, windowDates, buildRealizedLine, DAY_MIN, DAY_MS, SERIES,
} from './vol-realized.mjs';
import { parseDeribit, joinQuotes, computeImplied, buildImpliedLine, expiryList, quotesSha256, FormatError } from './vol-implied.mjs';
import { binanceRest, binanceDayIsFinal, binanceDayOnce, offlineDay, offlineDayIsFinal, deribitRest } from './vol-sources.mjs';
import { markSteps } from './leverage-step.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, '..');
export const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-vol.mjs');

export class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const refuse = (m) => new Exit(2, m);

// ------------------------------------------------------------------ arguments

export function parseArgs(argv, cwd = process.cwd()) {
  const valued = ['--line', '--out', '--from-snapshot', '--instruments', '--replay', '--offline', '--gaps', '--quotes', '--rpc', '--from'];
  const flags = ['--dry-run', '--collect-only', '--anchor'];
  const o = { line: null, dryRun: false, collectOnly: false, anchor: false, out: null, fromSnapshot: null, instruments: null, replay: null, offline: null, gaps: null, quotes: 'embed', rpc: null, from: null, fork: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!valued.includes(a) && !flags.includes(a)) throw refuse(`unknown option ${a}`);
    if (seen.has(a)) throw refuse(`${a} given twice`);
    seen.add(a);
    if (flags.includes(a)) {
      o[{ '--dry-run': 'dryRun', '--collect-only': 'collectOnly', '--anchor': 'anchor' }[a]] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw refuse(`${a} needs a value`);
    i++;
    if (a === '--line') o.line = v;
    else if (a === '--out') o.out = path.resolve(cwd, v);
    else if (a === '--from-snapshot') o.fromSnapshot = path.resolve(cwd, v);
    else if (a === '--instruments') o.instruments = path.resolve(cwd, v);
    else if (a === '--offline') o.offline = path.resolve(cwd, v);
    else if (a === '--gaps') o.gaps = path.resolve(cwd, v);
    else if (a === '--quotes') o.quotes = v;
    else if (a === '--rpc') o.rpc = v;
    else if (a === '--from') o.from = v;
    else if (a === '--replay') {
      const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
      if (!m || !isDate(m[1]) || !isDate(m[2]) || m[2] < m[1]) throw refuse(`--replay must be FROM..TO with FROM <= TO (got ${v})`);
      o.replay = { from: m[1], to: m[2] };
    }
  }
  if (o.line !== 'realized' && o.line !== 'implied') throw refuse(`--line must be realized or implied (got ${o.line})`);
  const realizedOnly = ['--replay', '--offline', '--gaps', '--anchor', '--rpc', '--from'];
  const impliedOnly = ['--collect-only', '--from-snapshot', '--instruments', '--quotes'];
  for (const a of o.line === 'realized' ? impliedOnly : realizedOnly) if (seen.has(a)) throw refuse(`${a} is for --line ${o.line === 'realized' ? 'implied' : 'realized'}`);
  for (const a of ['--replay', '--offline', '--gaps', '--from-snapshot']) if (seen.has(a) && !o.dryRun) throw refuse(`${a} is accepted only with --dry-run`);
  if (o.anchor && o.dryRun) throw refuse('--anchor is not accepted with --dry-run: a dry run never anchors, never marks and reads no key');
  if (!!o.fromSnapshot !== !!o.instruments) throw refuse('--from-snapshot and --instruments go together');
  if (o.quotes !== 'embed' && o.quotes !== 'hash') throw refuse(`--quotes must be embed or hash (got ${o.quotes})`);
  if (o.collectOnly && (o.fromSnapshot || o.dryRun || seen.has('--quotes'))) throw refuse('--collect-only takes no --dry-run, --from-snapshot or --quotes (it computes nothing)');
  // the fork rehearsal: both flags or neither; a local node only; never a dry run
  if (seen.has('--rpc') || seen.has('--from')) {
    if (!seen.has('--rpc') || !seen.has('--from')) throw refuse('--rpc and --from go together: a fork rehearsal needs a local node and an account unlocked on it (the line in force always signs with KEEPER_PK on GIWA Sepolia)');
    if (!isLocalRpc(o.rpc)) throw refuse(`--rpc ${o.rpc} is not a local node: a fork rehearsal runs only against 127.0.0.1, localhost or [::1]`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.from)) throw refuse(`--from ${o.from} is not an address`);
    if (o.dryRun) throw refuse('--rpc and --from are for a fork rehearsal of the line in force; a dry run never reaches a chain');
    o.fork = true;
  }
  return o;
}

/** Is `rpc` a local node? The host as a URL parser reads it: userinfo (`http://127.0.0.1:1@host/`) does not make a remote host local (as keeper/leverage-index.mjs). */
export function isLocalRpc(rpc) {
  let u;
  try {
    u = new URL(String(rpc));
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password;
}

// ------------------------------------------------------------------ rulebook

const posInt = (x) => Number.isSafeInteger(x) && x > 0;

export const LINES = ['realized', 'implied'];
/** The rulebook file of a line, relative to the repository root. */
export const rulebookFile = (line) => path.join('keeper', 'rulebooks', line === 'realized' ? 'qvol.json' : `volbtc-${line}.json`);

/** Does a dotted path ("source", "display.decimals") name a key of the rulebook? */
const hasPath = (obj, p) => {
  let o = obj;
  for (const k of p.split('.')) {
    if (o == null || typeof o !== 'object' || !Object.hasOwn(o, k)) return false;
    o = o[k];
  }
  return true;
};

/**
 * What the code implements: a key checked below that holds another value is
 * refused (exit 2). Keys not checked here (name, ticker, track, kind, status,
 * asOf, _doc, close, display.unit, …) are neither read nor refused; in
 * particular `close` is not checked — the code always takes the close of the
 * latest-opened 1-minute bar. Checked for both lines: line, id (realized
 * "qvol", implied "volbtc"), the inception, the owner-pending list and the
 * display decimals (display only: the record path never reads them). The
 * implied line has the active switch; the realized line has none (in force =
 * inception only) and refuses an "active" key.
 */
export function rulebookProblem(rb, line) {
  if (!LINES.includes(line)) return `line must be one of ${LINES.join(', ')}`;
  if (rb?.line !== line) return `line must be "${line}" (this is the ${line} line's rulebook)`;
  const id = line === 'realized' ? 'qvol' : 'volbtc';
  if (rb.id !== id) return `id must be "${id}"`;
  if (line === 'realized') {
    if ('active' in rb) return 'active: the realized line has no switch (whether it is in force is decided by inception only)';
  } else if (typeof rb.active !== 'boolean') return 'active must be true or false';
  const inc = rb.inception;
  if (!(inc && typeof inc === 'object' && 'date' in inc && 'decision' in inc && (inc.date === null || isDate(inc.date)))) return 'inception must be {date: null | "YYYY-MM-DD", decision}';
  if (line === 'implied' && !rb.active && inc.date !== null) return 'an inactive line (active false) cannot have an inception date';
  if (!Array.isArray(rb.pendingOwner)) return 'pendingOwner must be a list (empty when nothing waits for the owner)';
  for (const e of rb.pendingOwner) {
    if (typeof e?.path !== 'string' || typeof e?.what !== 'string' || !e.what) return `pendingOwner entries are {path, what} (got ${JSON.stringify(e)?.slice(0, 80)})`;
    if (!hasPath(rb, e.path)) return `pendingOwner path "${e.path}" is not a key of this rulebook`;
  }
  if (inc.date !== null && rb.pendingOwner.length) return `a line with an inception date cannot have values pending the owner (${rb.pendingOwner.map((e) => e.path).join(', ')})`;
  if (rb.display?.decimals !== 2) return 'display.decimals: only 2 is implemented';
  return line === 'realized' ? realizedProblem(rb) : impliedProblem(rb);
}

function realizedProblem(R) {
  if (R.series !== SERIES) return `series must be "${SERIES}"`;
  const rs = R.source ?? {};
  if (rs.host !== 'https://data-api.binance.vision' || rs.path !== '/api/v3/klines' || rs.symbol !== 'BTCUSDT' || rs.interval !== '1m' || 'barMinutes' in rs || rs.fallback !== null)
    return 'source must be Binance spot BTCUSDT 1m klines on data-api.binance.vision, no barMinutes (the close is the latest 1-minute bar), no fallback';
  if (!posInt(R.windowDays) || !posInt(R.yearDays)) return 'windowDays and yearDays must be positive integers';
  if (R.sampling !== '1d-close-00:00-utc' || R.mean !== 'zero') return 'only sampling "1d-close-00:00-utc" and mean "zero" are implemented';
  return null;
}

function impliedProblem(I) {
  if (I.series !== 'volbtc-implied') return 'series must be "volbtc-implied"';
  const is = I.source ?? {};
  if (is.host !== 'https://www.deribit.com' || !Array.isArray(is.calls) || is.calls.length !== 2 || !is.calls[0].startsWith('/api/v2/public/get_instruments?') || !is.calls[1].startsWith('/api/v2/public/get_book_summary_by_currency?') || is.fallback !== null)
    return 'source must be the two Deribit public calls (get_instruments, then get_book_summary_by_currency), no fallback';
  if (!posInt(I.constantMaturityMinutes) || !posInt(I.yearMinutes)) return 'constantMaturityMinutes and yearMinutes must be positive integers';
  if (I.price !== 'top-of-book-mid' || I.validQuote !== 'bid>0 && ask>bid' || I.forward !== 'K/(1-(c-p))' || I.snapshot !== 'first-success-after-00:00-utc')
    return 'only price "top-of-book-mid", validQuote "bid>0 && ask>bid", forward "K/(1-(c-p))" and snapshot "first-success-after-00:00-utc" are implemented';
  if (I.cutoff?.rule !== 'consecutive-invalid' || !posInt(I.cutoff?.count)) return 'cutoff must be {rule: "consecutive-invalid", count: positive integer}';
  return null;
}

/** keeper/vol-index-gaps.json (or --gaps): [{id, series, day, sha256, missing, note, confirmedAt}]. */
export function readGaps(file) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw refuse(`gap acceptance file ${file}: ${e.message}`);
  }
  if (!Array.isArray(list)) throw refuse(`gap acceptance file ${file}: not a JSON array`);
  for (const g of list) {
    if (typeof g?.id !== 'string' || g.series !== SERIES || !isDate(g.day) || !/^[0-9a-f]{64}$/.test(g.sha256 ?? '') || !Array.isArray(g.missing))
      throw refuse(`gap acceptance file ${file}: entry ${JSON.stringify(g).slice(0, 120)} needs id, series "${SERIES}", day, sha256 (64 hex), missing[]`);
  }
  return list;
}

// ---------------------------------------------------------------------- io

const readLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const appendLine = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
};
const runUrl = (env) => (env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : 'local');

/**
 * scripts/verify-vol.mjs on the new line in a scratch folder; env carries PATH
 * only. The first line is checked on its own; a later line is checked with
 * --tail against the last line of the record (each line was checked when it
 * was appended, so the whole record is not re-verified for every new line;
 * `node scripts/verify-vol.mjs --dir <dir>` checks the whole file). The rule
 * is checked against the rulebook JSON the run read (--rulebook).
 */
function recompute(deps, series, existing, newLine, sidecar, rbPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${series}-`));
  try {
    const context = existing.length ? [existing.at(-1)] : [];
    fs.writeFileSync(path.join(tmp, `record-${series}.jsonl`), [...context, newLine].map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (sidecar) {
      fs.mkdirSync(path.join(tmp, 'quotes'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'quotes', `${sidecar.sha}.json`), JSON.stringify(sidecar.quotes));
    }
    const line = series === SERIES ? 'realized' : 'implied';
    const argv = [deps.verifyScript, '--dir', tmp, '--line', line, '--rulebook', rbPath, '--recompute-only', '--quiet', ...(context.length ? ['--tail'] : [])];
    const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** An acceptance entry's missing list against the bars' gaps, field by field (key order does not matter). */
export const sameMissing = (a, b) =>
  Array.isArray(a) && a.length === b.length && a.every((x, k) => x != null && x.from === b[k].from && x.to === b[k].to && x.minutes === b[k].minutes);

// --------------------------------------------------------------------- run

export async function run(argv, depsIn = {}) {
  const deps = {
    root: REPO_ROOT,
    cwd: process.cwd(),
    now: () => Date.now(),
    env: process.env,
    log: (m) => console.log(m),
    err: (m) => console.error(m),
    fetch: globalThis.fetch,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    verifyScript: VERIFY_SCRIPT,
    ...depsIn,
  };
  try {
    return await runInner(argv, deps);
  } catch (e) {
    if (e instanceof Exit) {
      (e.code === 0 ? deps.log : deps.err)(e.message);
      return e.code;
    }
    deps.err(`${e instanceof FormatError ? 'format: ' : ''}${e?.message ?? e} — nothing written`);
    return 1;
  }
}

async function runInner(argv, deps) {
  const o = parseArgs(argv, deps.cwd);
  if (o.fork && deps.env.GITHUB_ACTIONS === 'true') throw refuse('a fork rehearsal (--rpc, --from) runs on a local machine only, never in a workflow');
  const rbRel = rulebookFile(o.line);
  const rbPath = path.join(deps.root, rbRel);
  let rbBytes;
  let rb;
  try {
    rbBytes = fs.readFileSync(rbPath);
    rb = JSON.parse(rbBytes.toString('utf8'));
  } catch (e) {
    throw refuse(`${rbRel}: ${e.message}`);
  }
  const problem = rulebookProblem(rb, o.line);
  if (problem) throw refuse(`${rbRel}: ${problem}`);
  // the implied line's switch comes before every mode: an inactive line reads and writes nothing
  // (the realized line has no switch: rulebookProblem refuses an "active" key there)
  if (o.line === 'implied' && !rb.active) throw new Exit(0, `${rb.series}: INACTIVE (${rbRel} active is false) — nothing read, nothing written`);
  const rulebookSha256 = sha256(rbBytes);
  const out = o.out ?? path.join(deps.root, 'keeper', 'dryrun');

  if (o.collectOnly) return collectOnly(rb, out, deps);
  if (!o.dryRun) {
    if (rb.inception.date == null) throw new Exit(0, `${rb.series}: NOT IN FORCE (${rbRel} inception is null) — nothing read, nothing written`);
    if (o.line !== 'realized') throw refuse(`${rb.series}: ${rbRel} inception is set, but the implied line has no in-force path (no decision check, no anchor) — see docs/vol-index.md "Later wiring"`);
    if (o.out) throw refuse(`${rb.series}: --out is for --dry-run and --collect-only; the line in force is written to ${o.fork ? 'keeper/dryrun' : 'trackrecord'}/record-${rb.series}.jsonl`);
    return runRealizedInForce(o, rb, rulebookSha256, deps, rbPath, rbRel);
  }
  return o.line === 'realized' ? runRealized(o, rb, rulebookSha256, out, deps, rbPath) : runImplied(o, rb, rulebookSha256, out, deps, rbPath);
}

// ----------------------------------------------------------------- realized

/**
 * The bars of the realized line: the --offline files, or Binance REST (the
 * server time is read once per run). isFinal(day): has the UTC day ended?
 * fetchDay(day): that day's bars, complete or accepted. The dry run and the
 * line in force read their bars through this one function.
 */
function realizedSource(o, L, gaps, deps) {
  const symbol = L.source.symbol;
  let serverTime = null;
  const binance = o.offline ? null : binanceRest({ host: L.source.host, klinesPath: L.source.path, fetchImpl: deps.fetch, wait: deps.wait });
  const time = async () => (serverTime ??= await binance.time());
  const isFinal = async (day) => (o.offline ? offlineDayIsFinal(o.offline, symbol, day) : binanceDayIsFinal(binance, symbol, day, await time()));

  /** One UTC day, complete or accepted: {close, lastBar, rows, sha, gaps, gapAccepted, fetchedAt}. */
  const fetchDay = async (day) => {
    let minutes;
    if (o.offline) {
      minutes = offlineDay(o.offline, symbol, day);
      if (minutes == null) throw new Exit(0, `${L.series}: no offline file for ${day} under ${o.offline} — a day not there yet; nothing written for line ${addDays(day, 1)} or later`);
    } else {
      const st = await time();
      const a = await binanceDayOnce(binance, symbol, day, st);
      const b = await binanceDayOnce(binance, symbol, day, st);
      if (canonicalMinuteText(a) !== canonicalMinuteText(b)) throw new Exit(1, `${L.series}: two fetches of ${day} differ (${a.length} vs ${b.length} rows) — nothing written; the next run fetches again`);
      minutes = a;
    }
    const text = canonicalMinuteText(minutes);
    const sha = sha256(text);
    const rows = minutes.length;
    let g = null;
    let gapAccepted = null;
    if (rows !== DAY_MIN) {
      g = minuteGaps(minutes, day);
      const entry = gaps.find((e) => e.day === day && e.sha256 === sha);
      if (!entry) {
        const missing = g.map((x) => `${x.from}-${x.to} (${x.minutes} min)`).join(', ');
        deps.err(`${L.series}: ${day} has ${rows} of ${DAY_MIN} 1-minute bars; missing ${missing}; canonical text sha256 ${sha}`);
        deps.err(`${L.series}: acceptance entry needed: ${JSON.stringify({ series: L.series, day, sha256: sha, missing: g })}`);
        throw new Exit(1, `${L.series}: ${day} is incomplete and not accepted — nothing written for line ${addDays(day, 1)} or later`);
      }
      if (!sameMissing(entry.missing, g)) throw refuse(`${L.series}: acceptance entry ${entry.id} matches the sha256 of ${day} but its missing list differs from the bars (${JSON.stringify(g)})`);
      gapAccepted = entry.id;
    }
    const { close, lastBar } = dayClose(minutes);
    return { close, lastBar, rows, sha, gaps: g, gapAccepted, fetchedAt: o.offline ? null : new Date(deps.now()).toISOString() };
  };
  return { isFinal, fetchDay };
}

/**
 * The line of day D after `prev` (prev null: the first line, which fetches
 * its 31 window days and, when the first close is null, the close it
 * carries). The dry run and the line in force build it with this one
 * function; they differ only in `shadow` (every dry-run line) and
 * `inception` (the first line in force).
 */
async function nextRealizedLine({ o, L, src, prev, D, rule, run, deps, shadow, inception = null }) {
  const day = addDays(D, -1);
  const host = L.source.host.replace(/^https?:\/\//, '');
  const symbol = L.source.symbol;
  const { fetchDay } = src;
  let window;
  let carriedFrom = null;
  let sources = null;
  let last;
  if (prev) {
    last = await fetchDay(day);
    window = [...prev.window.slice(1), [day, last.close]];
    // after the first line only [date, close]: the source record of that day is on the first line
    if (window[0][1] == null) carriedFrom = prev.window[0][1] != null ? prev.window[0] : prev.carriedFrom.slice(0, 2);
  } else {
    window = [];
    sources = [];
    for (const d of windowDates(D, L.windowDays)) {
      const f = await fetchDay(d);
      window.push([d, f.close]);
      sources.push(f.gapAccepted ? [d, f.rows, f.sha, f.gapAccepted] : [d, f.rows, f.sha]);
      last = f;
    }
    if (window[0][1] == null) {
      // first line: the carried day with its source record, like an entry of `sources`
      for (let k = 1; k <= L.windowDays && !carriedFrom; k++) {
        const d = addDays(window[0][0], -k);
        const f = await fetchDay(d);
        if (f.close != null) carriedFrom = f.gapAccepted ? [d, f.close, f.rows, f.sha, f.gapAccepted] : [d, f.close, f.rows, f.sha];
      }
      if (!carriedFrom) throw new Exit(1, `${L.series}: no close in the ${L.windowDays} days before ${window[0][0]} to carry into the first line — nothing written`);
    }
  }
  const { variance, value, returns } = realizedFromWindow(window, carriedFrom, L);
  const source = { host, symbol, interval: L.source.interval, day, rows: last.rows, sha256: last.sha, lastBar: last.lastBar, finalBy: `${D}T00:00`, fetchedAt: last.fetchedAt, ...(o.offline ? { via: 'offline' } : {}) };
  return buildRealizedLine({
    prev, date: D, observedAt: new Date(deps.now()).toISOString(), value, variance, window, carriedFrom, returns, source, sources,
    gaps: last.gaps, gapAccepted: last.gapAccepted, rule, run, shadow, inception,
  });
}

async function runRealized(o, L, rulebookSha256, out, deps, rbPath) {
  const rule = { rulebookSha256, windowDays: L.windowDays, yearDays: L.yearDays, sampling: L.sampling, mean: L.mean };
  const recPath = path.join(out, `record-${L.series}.jsonl`);
  const records = readLines(recPath);
  const gaps = readGaps(o.gaps ?? path.join(deps.root, 'keeper', 'vol-index-gaps.json'));
  const run = runUrl(deps.env);

  let prev = records.at(-1) ?? null;
  let D;
  if (!prev) {
    if (!o.replay) throw refuse(`${L.series}: the record under ${out} is empty and there is no --replay; the first line's date is undefined (inception.date is null)`);
    D = o.replay.from;
  } else {
    if (o.replay && records[0].date !== o.replay.from) throw refuse(`${L.series}: --replay starts ${o.replay.from} but the record under ${out} starts ${records[0].date}`);
    if (JSON.stringify(prev.rule) !== JSON.stringify(rule)) throw refuse(`${L.series}: the rulebook or rule differs from the last line's (rulebookSha256 ${prev.rule?.rulebookSha256?.slice(0, 12)}… vs ${rulebookSha256.slice(0, 12)}…); use a new --out`);
    D = addDays(prev.date, 1);
  }
  const to = o.replay?.to ?? null;

  // the source: offline files, or Binance REST (server time read once)
  const src = realizedSource(o, L, gaps, deps);

  let written = 0;
  for (;;) {
    if (to && D > to) {
      deps.log(`${L.series}: replay complete through ${to} (${written} line(s) written this run)`);
      return 0;
    }
    const day = addDays(D, -1);
    if (!(await src.isFinal(day))) {
      deps.log(`${L.series}: ${day} has not ended (or its next-day bar is not there yet) — ${written} line(s) written this run`);
      return 0;
    }
    const line = await nextRealizedLine({ o, L, src, prev, D, rule, run, deps, shadow: true });
    const rc = recompute(deps, L.series, records, line, null, rbPath);
    if (!rc.ok) throw new Exit(1, `${L.series}: independent recompute (scripts/verify-vol.mjs) rejected line ${D} — nothing written\n${rc.out}`);
    appendLine(recPath, line);
    records.push(line);
    written++;
    deps.log(`${L.series} ${D} ${line.value}${line.late ? ' (late)' : ''}${line.gaps ? ` gap accepted ${line.gapAccepted}` : ''}`);
    prev = line;
    D = addDays(D, 1);
  }
}

// ------------------------------------------------------- realized, in force

export const GIWA_RPC = 'https://sepolia-rpc.giwa.io';
export const GIWA_CHAIN_ID = 91342;
const ANCHOR_GAS = 60_000n; // as the other daily series (keeper/leverage-index.mjs)
const SETNAV_GAS = 120_000n; // as keeper/leverage-index.mjs (setNav measured at 36,137 gas)

/**
 * The files of the realized line in force, under the repository root. A fork
 * rehearsal (fork = true) reads and writes the record, anchors, marks and the
 * vault registry under keeper/dryrun/ (as keeper/leverage-index.mjs and
 * keeper/deploy-mark-vault.mjs on a fork) and writes nothing under trackrecord/.
 */
export function inForcePaths(root, series, fork = false) {
  const out = fork ? path.join(root, 'keeper', 'dryrun') : path.join(root, 'trackrecord');
  const keeper = fork ? path.join(root, 'keeper', 'dryrun') : path.join(root, 'keeper');
  return {
    records: path.join(out, `record-${series}.jsonl`),
    anchors: path.join(out, `anchors-${series}.jsonl`),
    marks: path.join(keeper, `marks-${series}.jsonl`),
    vaults: path.join(keeper, 'leverage-vaults.json'),
    gaps: path.join(root, 'keeper', 'vol-index-gaps.json'),
    ledger: path.join(root, 'trackrecord', 'decisions.jsonl'),
    trackrecord: path.join(root, 'trackrecord'),
  };
}

/**
 * Is the realized line in force? Returns {entry} when its inception decision
 * is, else {msg, anchored}. The same checks as keeper/leverage-index.mjs
 * (the decision is in the ledger the decision anchor appends to, its file
 * still hashes to the ledger's value and contains the rulebook's sha256),
 * with one difference: this decision is effective on the day it is anchored
 * and the first line is dated the next UTC day, so its effectiveFrom (the
 * date in its id) must be the day before inception.date. anchored = the
 * decision IS in the ledger (an anchor cannot be undone) but the files no
 * longer agree with it: the caller refuses instead of reporting NOT IN FORCE
 * with exit 0 every day.
 */
export function decisionProblem(P, rb, rulebookSha) {
  const id = rb.inception?.decision;
  if (!rb.inception?.date || !id) return { anchored: false, msg: 'NOT IN FORCE: inception.date / inception.decision are null' };
  const entry = readLines(P.ledger).find((d) => d.id === id);
  if (!entry) return { anchored: false, msg: `NOT IN FORCE: decision not anchored or does not pin this rulebook (${id} is not in trackrecord/decisions.jsonl)` };
  const broken = (why) => ({ anchored: true, msg: `NOT IN FORCE: ${why}` });
  const file = path.join(P.trackrecord, entry.file);
  if (!fs.existsSync(file)) return broken(`${entry.file} missing`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== entry.sha256) return broken(`${entry.file} no longer hashes to the ledger's value`);
  if (!bytes.toString('utf8').includes(rulebookSha)) return broken(`${id} does not contain the rulebook sha256 ${rulebookSha}`);
  if (!isDate(entry.effectiveFrom)) return broken(`decision ${id} has no effective date in the ledger (effectiveFrom ${JSON.stringify(entry.effectiveFrom)})`);
  const firstLine = addDays(entry.effectiveFrom, 1);
  if (firstLine !== rb.inception.date) return broken(`decision ${id} is effective from ${entry.effectiveFrom}, so the first line is dated ${firstLine}, but the rulebook's inception.date is ${rb.inception.date}`);
  return { entry };
}

/** viem, its local signer and the read-back helpers: loaded only when the in-force path signs (a dry run needs Node built-ins only). */
let chainModules = null;
async function chainLib() {
  if (!chainModules) {
    const [viem, accounts, readback] = await Promise.all([import('viem'), import('viem/accounts'), import('./readback.mjs')]);
    const abi = viem.parseAbi([
      'function setNav(uint256 newNavPerShare, uint256 indexLevel)',
      'function navPerShare() view returns (uint256)',
      'function keeper() view returns (address)',
      'function symbol() view returns (string)',
      'function depositCap() view returns (uint256)',
    ]);
    chainModules = { viem, accounts, readback, abi };
  }
  return chainModules;
}

/** The signer of anchors and marks: KEEPER_PK, signed here and sent raw (the public endpoint holds no key); null without the key. */
async function makeSigner(deps) {
  const pk = deps.env.KEEPER_PK;
  if (!pk) return null;
  const { viem, accounts } = await chainLib();
  const chain = viem.defineChain({ id: GIWA_CHAIN_ID, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [GIWA_RPC] } } });
  const transport = deps.transport ?? ((rpc) => viem.http(rpc));
  const account = accounts.privateKeyToAccount(pk);
  const pc = viem.createPublicClient({ chain, transport: transport(GIWA_RPC), pollingInterval: deps.pollingInterval ?? 2000 });
  return { pc, wallet: viem.createWalletClient({ account, chain, transport: transport(GIWA_RPC) }), address: account.address };
}

/**
 * The signer of a fork rehearsal: the account --from, which the local fork
 * node (--rpc) holds unlocked — viem sends eth_sendTransaction there and the
 * node signs. No key is read here and nothing is sent anywhere but --rpc.
 */
async function forkSigner(o, deps) {
  const { viem } = await chainLib();
  const chain = viem.defineChain({ id: GIWA_CHAIN_ID, name: 'GIWA Sepolia (local fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [o.rpc] } } });
  const transport = deps.transport ?? ((rpc) => viem.http(rpc));
  const address = viem.getAddress(o.from);
  const pc = viem.createPublicClient({ chain, transport: transport(o.rpc), pollingInterval: deps.pollingInterval ?? 1000 });
  return { pc, wallet: viem.createWalletClient({ account: address, chain, transport: transport(o.rpc) }), address };
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

/** The anchor of one line: a zero-value self-send, calldata `qxpi-<series>:` + the line's hash (as keeper/leverage-index.mjs). */
async function anchorLine(signer, series, line, anchorsPath, deps) {
  const { viem } = await chainLib();
  const hash = await sendNonceSafe(
    () => signer.wallet.sendTransaction({ to: signer.address, value: 0n, data: viem.toHex(`qxpi-${series}:` + line.hash), gas: ANCHOR_GAS }),
    deps.wait
  );
  const rc = await signer.pc.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Exit(1, `anchor of #${line.seq} ${line.date} reverted (${hash})`);
  appendLine(anchorsPath, { date: line.date, seq: line.seq, headHash: line.hash, txHash: hash });
  deps.log(`  anchored #${line.seq} ${line.date} in ${hash} (block ${rc.blockNumber})`);
}

/**
 * The display vault's share price for a value x, in the contract's unit of
 * 1e-6: n6 = floor(x x 1,000,000) — the unrounded record value cut (a
 * truncation that rounds down), with no decimal rounding.
 */
export function markUnits(x) {
  if (!(typeof x === 'number' && Number.isFinite(x) && x >= 0)) throw new Error(`mark: the value ${x} is not a finite number >= 0`);
  return BigInt(Math.floor(x * 1e6));
}

/** Marks the display vault to the line's value: navPerShare = indexLevel = n6, in steps inside the contract's 25% bound — only a vault with deposit cap 0. */
async function markDisplayVault({ signer, vault, ticker, gate, line, marksPath, registry, deps }) {
  const { viem, readback, abi } = await chainLib();
  const { pc, wallet, address } = signer;
  const target = markUnits(line.value);
  const indexLevel = target;
  if (target === 0n) throw new Exit(1, `the value ${line.value} of #${line.seq} ${line.date} is below 0.000001: n6 = 0, which the vault cannot show (the contract refuses a share price of 0) — no mark sent`);
  const read = (functionName, blockNumber) => pc.readContract({ address: vault, abi, functionName, ...(blockNumber != null ? { blockNumber } : {}) });
  // every testnet vault has the same keeper key, so the keeper check alone accepts any of them
  const symbol = await read('symbol');
  if (symbol !== ticker) throw new Exit(1, `vault ${vault} is ${JSON.stringify(symbol)}, not ${ticker} — ${registry} names the wrong vault; no mark sent`);
  const keeper = viem.getAddress(await read('keeper'));
  if (keeper !== viem.getAddress(address)) throw new Exit(1, `vault ${vault} keeper is ${keeper}, not the signer ${address} — no mark sent`);
  // a display vault takes no deposits (keeper/deploy-mark-vault.mjs DISPLAY_ONLY): a cap other than 0 stops every mark
  const cap = await read('depositCap');
  if (cap !== 0n) throw new Exit(1, `REFUSED: vault ${vault} has deposit cap ${cap}, not 0 — a display vault takes no deposits; no mark sent. Raising the cap is not allowed by the inception decision; a person decides`);
  const cur = await read('navPerShare');
  if (gate.mode === 'halt') {
    const move = Number(target) / Number(cur) - 1;
    if (Math.abs(move) > gate.pct / 100) {
      throw new Exit(1, `MARK HALTED: the value moves the vault ${(move * 100).toFixed(2)}% (navPerShare ${cur} → ${target}), beyond the ±${gate.pct}% gate — nothing sent; a person decides`);
    }
  }
  // After a write, a simulation runs at a block >= that write's receipt (as in
  // keeper/leverage-index.mjs): GIWA's public endpoint is load-balanced, and a
  // node behind the last step would judge the next step against the old
  // navPerShare. Repeated only while the node lacks the block; a revert is final.
  let floor = null;
  const simulate = async (data, what) => {
    if (floor == null) return pc.call({ account: address, to: vault, data });
    const { value } = await readback.retryRead(async () => pc.call({ account: address, to: vault, data, blockNumber: await readback.blockAtLeast(pc, floor) }), {
      what: `simulation of ${what} at a block >= ${floor}`,
      retryIf: (e) => readback.notYetReason(e) != null,
      ...(deps.readTiming ?? {}),
    });
    return value;
  };
  const steps = markSteps(cur, target);
  const reach = steps.length ? steps.at(-1) : cur;
  // at navPerShare 3 or below a 25% step rounds to zero and nothing can move the vault
  if (reach !== target) throw new Exit(1, `vault ${vault} cannot reach navPerShare ${target} from ${cur}: the contract's 25% bound rounds to zero at ${reach} — nothing sent; a person decides`);
  deps.log(`  vault ${vault}: navPerShare ${cur} → target ${target} (n6 of the value ${line.value})${steps.length ? ` in ${steps.length} step(s)` : ' — already there'}`);
  for (let k = 0; k < steps.length; k++) {
    const next = steps[k];
    const data = viem.encodeFunctionData({ abi, functionName: 'setNav', args: [next, indexLevel] });
    await simulate(data, `setNav step ${k + 1}/${steps.length}`); // a revert stops here, before anything is sent
    const tx = await sendNonceSafe(() => wallet.sendTransaction({ to: vault, data, gas: SETNAV_GAS }), deps.wait);
    const rc = await pc.waitForTransactionReceipt({ hash: tx });
    if (rc.status !== 'success') throw new Exit(1, `setNav step ${k + 1}/${steps.length} reverted (${tx})`);
    floor = rc.blockNumber;
    appendLine(marksPath, { date: line.date, seq: line.seq, step: k + 1, of: steps.length, nav: Number(next), indexLevel: Number(indexLevel), tx, block: Number(rc.blockNumber) });
    const rb = await readback.retryRead(
      async () => {
        const v = await read('navPerShare', rc.blockNumber);
        if (v !== next) throw new Error(`navPerShare ${v} at block ${rc.blockNumber}, expected ${next}`);
        return v;
      },
      { what: `navPerShare after step ${k + 1}`, ...(deps.readTiming ?? {}) }
    );
    deps.log(`    step ${k + 1}/${steps.length}: navPerShare ${next} tx=${tx} block ${rc.blockNumber}${rb.reads > 1 ? ` (read back at read ${rb.reads})` : ''}`);
  }
}

/** The realized line in force: in force? → anchor what is unanchored → the new lines → the display vault's mark. */
async function runRealizedInForce(o, L, rulebookSha256, deps, rbPath, rbRel) {
  const P = inForcePaths(deps.root, L.series, o.fork);
  if (o.fork) deps.log(`${L.series}: FORK REHEARSAL — node ${o.rpc}, signer ${o.from} (unlocked on that node; KEEPER_PK is not read); record, anchors, marks and the vault registry under keeper/dryrun/, nothing written under trackrecord/`);
  const rel = (p) => path.relative(deps.root, p);
  const records = readLines(P.records);
  // Before the first line, "not in force" is the normal state (exit 0). Once
  // the record has a line it is a refusal: an edit to the pinned rulebook JSON
  // or to the ledger would otherwise stop the series every day with exit 0.
  const stop = (msg) =>
    records.length
      ? refuse(`${L.series}: ${rel(P.records)} already holds ${records.length} line(s), so the series has started — ${msg}. Was ${rbRel} or the decision ledger changed after inception?`)
      : new Exit(0, `${L.series}: ${msg}`);
  const d = decisionProblem(P, L, rulebookSha256);
  // An anchored decision that the files no longer satisfy is never "not yet": the anchor cannot be undone.
  if (d.msg && d.anchored && !records.length) throw refuse(`${L.series}: the inception decision ${L.inception.decision} is anchored, but ${d.msg.replace(/^NOT IN FORCE: /, '')} — the series cannot start. Restore ${rbRel} to the bytes the decision pins (or anchor a postponement decision); never edit an anchored decision`);
  if (d.msg) throw stop(d.msg);
  if (deps.now() < dayMs(L.inception.date)) throw stop(`NOT IN FORCE: the first line is dated ${L.inception.date} (inception.date) and is not written before ${L.inception.date}T00:00Z`);
  const inception = { decision: d.entry.id, decisionSha256: d.entry.sha256 };
  const rule = { rulebookSha256, windowDays: L.windowDays, yearDays: L.yearDays, sampling: L.sampling, mean: L.mean };
  if (records.length) {
    const first = records[0];
    if (first.date !== L.inception.date) throw refuse(`${L.series}: ${rel(P.records)} starts ${first.date}, not on inception.date ${L.inception.date}`);
    if (first.inception?.decision !== inception.decision) throw refuse(`${L.series}: the first line of ${rel(P.records)} names the decision ${first.inception?.decision}, not ${inception.decision}`);
    if (JSON.stringify(records.at(-1).rule) !== JSON.stringify(rule)) throw refuse(`${L.series}: the rule of the last line differs from this run's (${JSON.stringify(records.at(-1).rule)} vs ${JSON.stringify(rule)}) — a rule change needs its own decision`);
  }
  const gaps = readGaps(P.gaps);
  deps.log(`${L.ticker} (${L.series}) in force: decision ${inception.decision} · first line ${L.inception.date} · rulebook ${rulebookSha256.slice(0, 12)}… · ${records.length} line(s) in ${rel(P.records)}`);

  const signer = o.anchor ? (o.fork ? await forkSigner(o, deps) : await makeSigner(deps)) : null;
  if (o.anchor && !signer) deps.log('--anchor requested but KEEPER_PK is not set — lines are written unanchored; the next run with the key anchors them first');
  if (!o.anchor) deps.log('--anchor not passed — no on-chain anchor attempted for this run.');
  /** A line on disk whose anchor fails stays written: the next run anchors it first. Nothing is marked. */
  const anchor = async (line) => {
    try {
      await anchorLine(signer, L.series, line, P.anchors, deps);
    } catch (e) {
      const msg = e instanceof Exit ? e.message : (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0];
      throw new Exit(1, `${L.series}: line #${line.seq} ${line.date} is written but its anchor failed: ${msg} — no mark; the next run anchors it first`);
    }
  };

  // 2. a line written by an earlier run but not anchored is anchored first
  if (signer) {
    const anchors = readLines(P.anchors);
    for (const line of records) {
      if (anchors.some((a) => a.seq === line.seq)) continue;
      deps.log(`  #${line.seq} ${line.date} has no anchor — anchoring it first`);
      await anchor(line);
    }
  }

  // 3. every closed UTC day since the last line, in order
  const src = realizedSource({ offline: null }, L, gaps, deps);
  const run = runUrl(deps.env);
  const host = L.source.host.replace(/^https?:\/\//, '');
  /** A Binance failure names the host, the day and what was not written. */
  const fromSource = async (what, D, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Exit) throw e;
      throw new Exit(1, `${L.series}: Binance (${host}) failed while ${what} ${addDays(D, -1)}: ${e?.message ?? e} — nothing written for ${D}; the next run continues from the last line`);
    }
  };
  let prev = records.at(-1) ?? null;
  let written = 0;
  for (;;) {
    const D = prev ? addDays(prev.date, 1) : L.inception.date;
    const day = addDays(D, -1); // the UTC day whose close line D adds
    if (deps.now() < dayMs(D)) {
      deps.log(`${L.series}: line ${D} not written: the runner's clock (${new Date(deps.now()).toISOString()}) is before ${D}T00:00Z — a day is never written before it has ended`);
      break;
    }
    if (!(await fromSource('checking the end of', D, () => src.isFinal(day)))) {
      // a source that still calls the day open a full day after it ended has a stuck clock or stuck bars
      if (deps.now() >= dayMs(D) + DAY_MS) throw new Exit(1, `${L.series}: Binance says ${day} has not ended (no closed 1-minute bar at or after ${D}T00:00Z), but the runner's clock is ${new Date(deps.now()).toISOString()}, more than a day later — the source is stuck; nothing written for ${D}`);
      deps.log(`${L.series}: ${day} has not ended (or its next-day bar is not there yet) — line ${D} not written`);
      break;
    }
    const line = await fromSource('fetching the 1-minute bars up to', D, () => nextRealizedLine({ o: { offline: null }, L, src, prev, D, rule, run, deps, shadow: false, inception: prev ? null : inception }));
    const rc = recompute(deps, L.series, records, line, null, rbPath);
    if (!rc.ok) throw new Exit(1, `${L.series}: independent recompute (scripts/verify-vol.mjs) rejected line ${D} — nothing appended, nothing anchored, no mark\n${rc.out}`);
    appendLine(P.records, line);
    records.push(line);
    written++;
    deps.log(`${L.series} #${line.seq} ${D} ${line.value}${line.late ? ' (late)' : ''}${line.gaps ? ` gap accepted ${line.gapAccepted}` : ''} · head ${line.hash.slice(0, 16)}…`);
    deps.log(`  #${line.seq} ${D} recomputed by scripts/verify-vol.mjs before it was appended — agrees`);
    if (signer) await anchor(line);
    prev = line;
  }
  if (!written) deps.log(`${L.series}: no new line`);

  // 4. the display vault follows the record: after the anchor, from the last line
  const last = records.at(-1);
  if (!last) return 0;
  let vaults;
  try {
    vaults = fs.existsSync(P.vaults) ? JSON.parse(fs.readFileSync(P.vaults, 'utf8')) : {};
  } catch (e) {
    throw refuse(`${rel(P.vaults)}: ${e.message} — line #${last.seq} ${last.date} is written${signer ? ' and anchored' : ''}; no mark`);
  }
  const v = vaults[L.series];
  if (!v?.address) {
    deps.log(`${L.series}: no vault — marks skipped`);
    return 0;
  }
  if (!v.gate) {
    deps.log(`${L.series}: mark gate not set — marks skipped`);
    return 0;
  }
  if (!signer) {
    deps.log(`${L.series}: no signer — marks skipped`);
    return 0;
  }
  if (!readLines(P.anchors).some((a) => a.seq === last.seq && a.headHash === last.hash)) {
    deps.log(`${L.series}: #${last.seq} ${last.date} is not anchored — marks skipped (the anchor goes first)`);
    return 0;
  }
  if (!['step', 'halt'].includes(v.gate.mode) || (v.gate.mode === 'halt' && !(v.gate.pct > 0))) throw refuse(`${rel(P.vaults)} ${L.series}.gate must be {"mode":"step"} or {"mode":"halt","pct":<number>} (got ${JSON.stringify(v.gate)})`);
  try {
    const chainId = await signer.pc.getChainId();
    if (chainId !== v.chainId) throw new Exit(1, `RPC is chain ${chainId}, the vault entry says ${v.chainId}`);
    const { viem } = await chainLib();
    await markDisplayVault({ signer, vault: viem.getAddress(v.address), ticker: L.ticker, gate: v.gate, line: last, marksPath: P.marks, registry: rel(P.vaults), deps });
  } catch (e) {
    const msg = e instanceof Exit ? e.message : (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0];
    deps.err(`${L.ticker} vault marks FAILED after line #${last.seq} was written and anchored: ${msg}`);
    if (deps.env.GITHUB_ACTIONS === 'true') deps.log(`::error title=${L.ticker} vault marks failed::${msg}`);
    return 1;
  }
  return 0;
}

// ------------------------------------------------------------------ implied

const tsName = (usOut) => new Date(Math.floor(usOut / 1000)).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';

async function fetchSnapshot(L, deps) {
  const deribit = deribitRest({ host: L.source.host, calls: L.source.calls, fetchImpl: deps.fetch, wait: deps.wait });
  const inst = await deribit.instruments(); // instruments first,
  const book = await deribit.bookSummary(); // quotes second: the snapshot time is this call's usOut
  return { host: deribit.host, inst, book };
}

async function runImplied(o, L, rulebookSha256, out, deps, rbPath) {
  const rule = {
    rulebookSha256,
    constantMaturityMinutes: L.constantMaturityMinutes,
    yearMinutes: L.yearMinutes,
    price: L.price,
    validQuote: L.validQuote,
    cutoff: `${L.cutoff.rule}:${L.cutoff.count}`,
    forward: L.forward,
  };
  const recPath = path.join(out, `record-${L.series}.jsonl`);
  const records = readLines(recPath);
  const prev = records.at(-1) ?? null;
  if (prev && JSON.stringify(prev.rule) !== JSON.stringify(rule)) throw refuse(`${L.series}: the rulebook or rule differs from the last line's; use a new --out`);

  let snap;
  if (o.fromSnapshot) {
    const read = (f) => {
      try {
        const bytes = zlib.gunzipSync(fs.readFileSync(f));
        return { bytes, json: JSON.parse(bytes.toString('utf8')) };
      } catch (e) {
        throw new Exit(1, `${L.series}: cannot read ${f}: ${e.message}`);
      }
    };
    snap = { host: L.source.host.replace(/^https?:\/\//, ''), inst: read(o.instruments), book: read(o.fromSnapshot) };
  } else {
    const today = dateOf(deps.now());
    if (prev && prev.date >= today) throw new Exit(0, `${L.series}: a line for ${prev.date} exists — nothing to do`);
    snap = await fetchSnapshot(L, deps);
  }
  const inst = parseDeribit(snap.inst.json, 'get_instruments');
  const book = parseDeribit(snap.book.json, 'get_book_summary_by_currency');
  const usOut = book.usOut;
  const date = dateOf(Math.floor(usOut / 1000));
  if (prev && date === prev.date) throw new Exit(0, `${L.series}: a line for ${date} exists — nothing to do`);
  if (prev && date < prev.date) throw refuse(`${L.series}: snapshot of ${date} is older than the last line (${prev.date})`);

  const rows = joinQuotes(inst.result, book.result);
  const result = computeImplied(rows, usOut, { cm: L.constantMaturityMinutes, ym: L.yearMinutes, cutoff: L.cutoff.count });
  const line = buildImpliedLine({
    prev, observedAt: new Date(deps.now()).toISOString(), usOut, host: snap.host, rows: book.result.length, expiries: expiryList(rows),
    rawSha256: { instruments: sha256(snap.inst.bytes), bookSummary: sha256(snap.book.bytes) },
    result, quotesMode: o.quotes, rule, run: runUrl(deps.env), shadow: true,
  });
  const sidecar = o.quotes === 'hash' ? { sha: line.quotesSha256, quotes: result.quotes } : null;
  const rc = recompute(deps, L.series, records, line, sidecar, rbPath);
  if (!rc.ok) throw new Exit(1, `${L.series}: independent recompute (scripts/verify-vol.mjs) rejected the line of ${date} — nothing written\n${rc.out}`);
  if (sidecar) {
    fs.mkdirSync(path.join(out, 'quotes'), { recursive: true });
    fs.writeFileSync(path.join(out, 'quotes', `${sidecar.sha}.json`), JSON.stringify(sidecar.quotes));
  }
  appendLine(recPath, line);
  deps.log(`${L.series} ${date} ${line.value ?? `null (${line.reason})`} at ${line.snapshot.at}`);
  return 0;
}

/** --collect-only: the two raw responses, gzipped, and one manifest line. No value. */
async function collectOnly(L, out, deps) {
  const snap = await fetchSnapshot(L, deps);
  const inst = parseDeribit(snap.inst.json, 'get_instruments');
  const book = parseDeribit(snap.book.json, 'get_book_summary_by_currency');
  const ts = tsName(book.usOut);
  const names = [`deribit-instruments-btc-option-${ts}.json.gz`, `deribit-book-summary-btc-option-${ts}.json.gz`];
  const gz = [zlib.gzipSync(snap.inst.bytes), zlib.gzipSync(snap.book.bytes)];
  fs.mkdirSync(out, { recursive: true });
  for (const n of names) if (fs.existsSync(path.join(out, n))) throw new Exit(1, `${L.series}: ${n} already exists under ${out} — nothing written`);
  names.forEach((n, i) => fs.writeFileSync(path.join(out, n), gz[i]));
  const entry = {
    at: new Date(Math.floor(book.usOut / 1000)).toISOString(),
    usOut: book.usOut,
    files: names,
    sha256Raw: [sha256(snap.inst.bytes), sha256(snap.book.bytes)],
    sha256Gz: [sha256(gz[0]), sha256(gz[1])],
    rows: [inst.result.length, book.result.length],
  };
  appendLine(path.join(out, 'collect-manifest.jsonl'), entry);
  deps.log(`${L.series}: collected ${names.join(' + ')} (${entry.rows.join(' / ')} rows) at ${entry.at}`);
  return 0;
}

export { quotesSha256 };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
