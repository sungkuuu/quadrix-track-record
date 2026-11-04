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
 * A run that continues a record first reads the last line's day again (its
 * offline file, or one more fetch) and stops (exit 1, nothing written) when
 * the bars are not those the line records. With --daily <file> (Binance daily
 * candles) each new line's newest window day (every window day on the first
 * line) must close where its daily candle closes, else exit 1; without
 * --daily the dry run reads no daily candle (and prints nothing about it).
 *
 * Realized, in force (no --dry-run; the daily paper-index step runs
 * `--line realized --anchor` with KEEPER_PK in its environment):
 *   1. in force? With inception.date null in keeper/rulebooks/qvol.json:
 *      NOT IN FORCE, exit 0, nothing else read, nothing written. Otherwise
 *      inception.decision must be an id <YYYY-MM-DD>-qvol-inception, be in
 *      trackrecord/decisions.jsonl (the ledger the decision anchor appends
 *      to) effective on the date in its id, its file must still hash to the
 *      ledger's value and carry this rulebook's sha256, and it must be
 *      effective on the day before inception.date: the decision is effective
 *      on the day it is anchored and the first line is dated the next UTC
 *      day. An id of another form, a decision not in the ledger yet, or a
 *      run before inception.date 00:00 UTC, is NOT IN FORCE (exit 0, nothing
 *      written, no request); a decision in the ledger that the files no
 *      longer satisfy is refused (exit 2), and so is any of these once the
 *      record has a line. Then the record as a whole, once per run before
 *      anything is sent or appended: scripts/verify-vol.mjs recomputes every
 *      line (seq, hash chain, dates, windows, values, the rule against the
 *      rulebook JSON), no line is dated after the runner's clock, none is a
 *      dry-run line, and only the first carries this decision's inception —
 *      else refused (exit 2), nothing sent, nothing appended. Then a run that
 *      can anchor (it has the key) reads the decision's own anchor
 *      transaction (the ledger's txHash): it must be on chain, successful, a
 *      zero-value self-send from the signer with calldata qxdec:<the decision
 *      file's sha256> — else NOT IN FORCE, exit 1, nothing read from Binance,
 *      nothing written;
 *   2. the last anchor is read again (a run that can anchor): its
 *      transaction must still be on chain and be the signer's self-send of
 *      that line's hash — one that is gone (dropped, as by a reorg) has its
 *      line anchored again here (and the anchor before it is read the same
 *      way); one that is another key's or carries other calldata is refused
 *      (exit 2), nothing sent. Every transaction's receipt is waited for at
 *      most RECEIPT_TIMEOUT_MS (5 minutes): past it, exit 1 with the line left
 *      on disk without an anchor entry (the next run anchors it first; a
 *      second anchor transaction with the same calldata is harmless).
 *      A line an earlier run wrote but did not anchor is anchored first, never
 *      on trust: every anchor entry must name a line of the record by seq,
 *      date and hash, only the last lines may be unanchored, and each is
 *      recomputed by scripts/verify-vol.mjs (the first line on its own, a
 *      later one after the line before it) before its anchor is sent — any
 *      of these failing is refused (exit 2), nothing sent — and the bars it
 *      records are read again from Binance (the first line: every window
 *      day): other bars, exit 1, nothing sent;
 *   3. before the first new line of a run, the bars of the last line's day
 *      are read again (one more fetch): other bars than the line records stop
 *      the run (exit 1, nothing written, the message names the day and both
 *      sha256) for a person; an anchored line whose day the source changed
 *      later goes on only once a person confirms that change in
 *      keeper/vol-index-source-checks.json. Then every closed UTC day since
 *      the last line, in order — the first line is dated inception.date and
 *      no day before it is ever written: the same line a dry run builds
 *      (same fields, same order), without "shadow" and with inception
 *      {decision, decisionSha256} on the first line → the daily-candle gate:
 *      Binance's daily candle of D-1 (on the first line: of every window day,
 *      in one request) must close where the 1-minute bars close that day, as
 *      String(Number(close)) — a difference stops the run (exit 1, nothing
 *      written; once a person confirms it in keeper/vol-index-source-checks.json
 *      the next run writes the line from the 1-minute bars) →
 *      scripts/verify-vol.mjs recomputes the line as above (a mismatch: exit
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
 *      before, and only when the entry's deployTx is the signer's own
 *      contract creation of that address (in the entry's block), its
 *      symbol() is the rulebook's ticker, its
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
 *   --daily <file>            (realized, --dry-run) Binance daily candles (the JSON array of GET /api/v3/klines
 *                             interval=1d, .gz allowed): each new line's window closes are checked against them
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
 * failed is written, and the next run anchors it first) — among them the
 * source checks (a day read again that differs from its line, a daily
 * candle that differs from the 1-minute close), a decision whose anchor
 * transaction is not the signer's, and a receipt that does not come within
 * RECEIPT_TIMEOUT_MS — or a vault mark that failed or was refused (the
 * registry's deployment not the keeper's) after the line was written and
 * anchored; 2 = configuration or a record that is not what the keeper wrote
 * (bad option, bad rulebook, acceptance or source-check file, an anchored
 * inception decision that the files no longer satisfy, a record that does
 * not verify as a whole, an unanchored line before an anchored one, an
 * anchor entry that does not name its line or is not the keeper's anchor).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sha256, dayMs, dateOf, addDays, isDate, canonicalMinuteText, minuteGaps, dayClose, realizedFromWindow, windowDates, buildRealizedLine, parseKlines, DAY_MIN, DAY_MS, SERIES,
} from './vol-realized.mjs';
import { parseDeribit, joinQuotes, computeImplied, buildImpliedLine, expiryList, quotesSha256, FormatError } from './vol-implied.mjs';
import { binanceRest, binanceDayIsFinal, binanceDayOnce, offlineDay, offlineDayIsFinal, deribitRest, RETRY_WAITS_MS, BINANCE_SPACING_MS, FETCH_TIMEOUT_MS } from './vol-sources.mjs';
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
  const valued = ['--line', '--out', '--from-snapshot', '--instruments', '--replay', '--offline', '--gaps', '--quotes', '--rpc', '--from', '--daily'];
  const flags = ['--dry-run', '--collect-only', '--anchor'];
  const o = { line: null, dryRun: false, collectOnly: false, anchor: false, out: null, fromSnapshot: null, instruments: null, replay: null, offline: null, gaps: null, daily: null, quotes: 'embed', rpc: null, from: null, fork: false };
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
    else if (a === '--daily') o.daily = path.resolve(cwd, v);
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
  const realizedOnly = ['--replay', '--offline', '--gaps', '--daily', '--anchor', '--rpc', '--from'];
  const impliedOnly = ['--collect-only', '--from-snapshot', '--instruments', '--quotes'];
  for (const a of o.line === 'realized' ? impliedOnly : realizedOnly) if (seen.has(a)) throw refuse(`${a} is for --line ${o.line === 'realized' ? 'implied' : 'realized'}`);
  for (const a of ['--replay', '--offline', '--gaps', '--daily', '--from-snapshot']) if (seen.has(a) && !o.dryRun) throw refuse(`${a} is accepted only with --dry-run`);
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

/**
 * keeper/vol-index-source-checks.json — absent until a person confirms a
 * difference that the source checks of the line in force found (the next run
 * then goes on; the record is never changed):
 *   {id, series, day, check: "refetch", recorded, served, note, confirmedAt}
 *     the bars of `day`, read again before the series continues from the
 *     anchored line built from them, no longer hash to `recorded` (that
 *     line's source.sha256) but to `served`;
 *   {id, series, day, check: "daily-close", minuteClose, dailyClose, note, confirmedAt}
 *     Binance's daily candle of `day` closes at `dailyClose` (null: none),
 *     the day's 1-minute bars at `minuteClose`.
 * An entry is used only when every one of these values matches what the run
 * reads; an entry never makes the keeper anchor a line it did not write.
 */
export function readSourceChecks(file) {
  if (!fs.existsSync(file)) return [];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw refuse(`source check file ${file}: ${e.message}`);
  }
  if (!Array.isArray(list)) throw refuse(`source check file ${file}: not a JSON array`);
  const close = (x) => x === null || (typeof x === 'string' && x !== '');
  for (const e of list) {
    const base = typeof e?.id === 'string' && e.id !== '' && e.series === SERIES && isDate(e.day);
    const refetch = e?.check === 'refetch' && /^[0-9a-f]{64}$/.test(e.recorded ?? '') && /^[0-9a-f]{64}$/.test(e.served ?? '') && e.recorded !== e.served;
    const daily = e?.check === 'daily-close' && close(e.minuteClose) && close(e.dailyClose) && e.minuteClose !== e.dailyClose;
    if (!base || !(refetch || daily)) {
      throw refuse(`source check file ${file}: entry ${JSON.stringify(e).slice(0, 160)} needs id, series "${SERIES}", day, and check "refetch" with recorded and served (two different sha256) or check "daily-close" with minuteClose and dailyClose (two different closes)`);
    }
  }
  return list;
}

/**
 * --daily <file> (dry run): Binance daily candles as its REST API answers
 * GET /api/v3/klines?interval=1d — a JSON array of klines, gzipped when the
 * name ends in .gz — as Map(day → close as String(Number(close))).
 */
export function readDaily(file) {
  let rows;
  try {
    const bytes = fs.readFileSync(file);
    rows = parseKlines(JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8')));
  } catch (e) {
    throw refuse(`--daily ${file}: ${e.message}`);
  }
  const closes = new Map();
  for (const c of rows) {
    if (c.openMs % DAY_MS !== 0) throw refuse(`--daily ${file}: a candle opens at ${new Date(c.openMs).toISOString()}, not at 00:00 UTC — not daily candles`);
    const day = dateOf(c.openMs);
    if (closes.has(day) && closes.get(day) !== String(c.c)) throw refuse(`--daily ${file}: two candles of ${day} with different closes`);
    closes.set(day, String(c.c));
  }
  return closes;
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

/** One GET of Binance JSON with the retry policy of keeper/vol-sources.mjs: at most 3 attempts, 2 s then 4 s apart, on a network error, a time-out (30 s per attempt), HTTP 429 or 5xx. */
async function getJsonWithRetry(url, fetchImpl, wait) {
  const where = url.split('?')[0];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status} from ${where}`), { retry: true });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${where}: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Binance answered non-JSON from ${where}`);
      }
    } catch (e) {
      const again = e?.retry === true || e?.name === 'TimeoutError' || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(String(e?.message));
      if (!again || attempt >= RETRY_WAITS_MS.length) throw e;
      await wait(RETRY_WAITS_MS[attempt]);
    }
  }
}

/**
 * Binance's daily candles (interval 1d) of the UTC days first … last, in one
 * request: Map(day → close as String(Number(close)), the form a line's closes
 * take). Only a candle that opens at a day's 00:00 UTC and is closed by the
 * server time counts.
 */
export async function binanceDailyCloses({ host, klinesPath, symbol, first, last, serverTime, fetchImpl, wait }) {
  const start = dayMs(first);
  const q = new URLSearchParams({ symbol, interval: '1d', startTime: String(start), endTime: String(dayMs(last) + DAY_MS - 1), limit: String(Math.round((dayMs(last) - start) / DAY_MS) + 1) });
  await wait(BINANCE_SPACING_MS);
  const closes = new Map();
  for (const c of parseKlines(await getJsonWithRetry(`${host}${klinesPath}?${q}`, fetchImpl, wait))) {
    if (c.openMs % DAY_MS === 0 && c.openMs >= start && c.openMs <= dayMs(last) && c.closeMs < serverTime) closes.set(dateOf(c.openMs), String(c.c));
  }
  return closes;
}

/**
 * The bars of the realized line: the --offline files, or Binance REST (the
 * server time is read once per run). isFinal(day): has the UTC day ended?
 * fetchDay(day): that day's bars, complete or accepted. refetch(day): the
 * day's bars read once more, as the source serves them now. dailyCloses(days):
 * the daily candles' closes of those days — from Binance in force, from
 * --daily in a dry run (null in a dry run without it). The dry run and the
 * line in force read their bars through this one function.
 */
function realizedSource(o, L, gaps, deps, daily = null) {
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

  /** One day's bars read once more (one fetch; offline: its file again), as the source serves them now: {sha, rows, close, lastBar}. */
  const refetch = async (day) => {
    let minutes;
    if (o.offline) {
      minutes = offlineDay(o.offline, symbol, day);
      if (minutes == null) throw new Exit(1, `${L.series}: no offline file for ${day} under ${o.offline} — the last line was built from that day, which cannot be read again; nothing written`);
    } else minutes = await binanceDayOnce(binance, symbol, day, await time());
    return { sha: sha256(canonicalMinuteText(minutes)), rows: minutes.length, ...dayClose(minutes) };
  };

  /** The daily candles' closes of `days` (consecutive): Map(day → String(close)); null in a dry run without --daily. */
  const dailyCloses = async (days) => {
    if (daily) return daily;
    if (o.dryRun) return null;
    return binanceDailyCloses({ host: L.source.host, klinesPath: L.source.path, symbol, first: days[0], last: days.at(-1), serverTime: await time(), fetchImpl: deps.fetch, wait: deps.wait });
  };
  return { isFinal, fetchDay, refetch, dailyCloses };
}

/**
 * The days whose bars a line records: its newest window day (source.day);
 * with `all`, on the first line, every day of `sources` and the carried day
 * too. Each with the row count, the canonical text's sha256 and the close
 * the line holds for it.
 */
function recordedDays(line, all) {
  const W = line.window.length - 1;
  const newest = { day: line.source.day, rows: line.source.rows, sha: line.source.sha256, close: line.window[W][1], lastBar: line.source.lastBar };
  if (!all || !Array.isArray(line.sources)) return [newest];
  const days = line.sources.map(([day, rows, sha], k) => (day === newest.day ? newest : { day, rows, sha, close: line.window[k][1] }));
  if (Array.isArray(line.carriedFrom) && line.carriedFrom.length >= 4) {
    const [day, close, rows, sha] = line.carriedFrom;
    days.unshift({ day, rows, sha, close });
  }
  return days;
}

/**
 * Do the bars a line was built from still come from the source? Each
 * recorded day is read once more; its canonical text must hash to the
 * sha256 the line records, with the same row count, the same last bar and
 * the close the line holds for that day. The first difference, or null.
 */
async function sourceChange(line, src, all = false) {
  for (const want of recordedDays(line, all)) {
    const got = await src.refetch(want.day);
    if (got.sha !== want.sha || got.rows !== want.rows || got.close !== want.close || (want.lastBar !== undefined && got.lastBar !== want.lastBar)) return { want, got };
  }
  return null;
}
const barsText = (x) => `${x.rows} rows, close ${x.close}${x.lastBar ? ` (bar ${x.lastBar})` : ''}, canonical text sha256 ${x.sha}`;
const sourceChangeText = (series, line, { want, got }) =>
  `${series}: SOURCE CHANGED — line #${line.seq} ${line.date} was built from the bars of ${want.day} (${barsText(want)}), but the source now serves ${barsText(got)}`;

/**
 * The daily-candle gate: the close the 1-minute bars give each window day a
 * line adds (the newest day; every window day on the first line) must be the
 * close of the source's daily candle of that day, as String(Number(close)).
 * Every difference [{day, minute, daily (null: no candle)}], in day order.
 */
async function dailyDifferences(line, first, src) {
  const days = first ? line.window : [line.window.at(-1)];
  const closes = await src.dailyCloses(days.map(([d]) => d));
  const out = [];
  for (const [day, c] of days) {
    const minute = c == null ? null : String(c);
    const daily = closes.get(day) ?? null;
    if (minute !== daily) out.push({ day, minute, daily });
  }
  return out;
}
const dailyText = (series, D, { day, minute, daily }, where) =>
  `${series}: DAILY CLOSE DIFFERS — the 1-minute bars close ${day} at ${minute}, ${where} ${daily == null ? 'has no closed daily candle of that day' : `closes it at ${daily}`}; nothing written for line ${D}`;

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
  const daily = o.daily ? readDaily(o.daily) : null;
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
  const src = realizedSource(o, L, gaps, deps, daily);

  // a record continued: before its first new line, the day of the line it continues from is read again
  let recheck = !!prev;
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
    if (recheck) {
      recheck = false;
      const ch = await sourceChange(prev, src);
      if (ch) throw new Exit(1, `${sourceChangeText(L.series, prev, ch)} — nothing written: the dry run does not continue from a line whose day the source no longer confirms`);
    }
    const line = await nextRealizedLine({ o, L, src, prev, D, rule, run, deps, shadow: true });
    if (daily) {
      const [dd] = await dailyDifferences(line, !prev, src);
      if (dd) throw new Exit(1, dailyText(L.series, D, dd, `the daily candle in ${o.daily}`));
    }
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
/** How long the keeper waits for one transaction's receipt (an anchor, a setNav step) before it gives up: exit 1, the line stays on disk. */
export const RECEIPT_TIMEOUT_MS = 300_000;
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
    checks: path.join(root, 'keeper', 'vol-index-source-checks.json'),
    ledger: path.join(root, 'trackrecord', 'decisions.jsonl'),
    trackrecord: path.join(root, 'trackrecord'),
  };
}

/**
 * Is the realized line in force? Returns {entry} when its inception decision
 * is, else {msg, anchored}. The id must be <YYYY-MM-DD>-<series>-inception
 * (a decision of another series is never this one's) and the ledger must date
 * it on the date in its id. The same checks as keeper/leverage-index.mjs
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
  // only an inception decision of this series starts it: <YYYY-MM-DD>-qvol-inception
  const form = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${rb.series}-inception$`).exec(String(id));
  if (!form || !isDate(form[1])) return { anchored: false, msg: `NOT IN FORCE: inception.decision ${JSON.stringify(id)} is not an inception decision of this series (an id <YYYY-MM-DD>-${rb.series}-inception)` };
  const entry = readLines(P.ledger).find((d) => d.id === id);
  if (!entry) return { anchored: false, msg: `NOT IN FORCE: decision not anchored or does not pin this rulebook (${id} is not in trackrecord/decisions.jsonl)` };
  const broken = (why) => ({ anchored: true, msg: `NOT IN FORCE: ${why}` });
  const file = path.join(P.trackrecord, entry.file);
  if (!fs.existsSync(file)) return broken(`${entry.file} missing`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== entry.sha256) return broken(`${entry.file} no longer hashes to the ledger's value`);
  if (!bytes.toString('utf8').includes(rulebookSha)) return broken(`${id} does not contain the rulebook sha256 ${rulebookSha}`);
  if (!isDate(entry.effectiveFrom)) return broken(`decision ${id} has no effective date in the ledger (effectiveFrom ${JSON.stringify(entry.effectiveFrom)})`);
  if (entry.effectiveFrom !== form[1]) return broken(`decision ${id} is effective from ${entry.effectiveFrom} in the ledger, not on the date in its id`);
  const firstLine = addDays(entry.effectiveFrom, 1);
  if (firstLine !== rb.inception.date) return broken(`decision ${id} is effective from ${entry.effectiveFrom}, so the first line is dated ${firstLine}, but the rulebook's inception.date is ${rb.inception.date}`);
  return { entry };
}

/**
 * The record of the line in force as a whole, once per run before anything is
 * sent or appended: no line dated after the runner's clock (line D is never
 * written before D 00:00 UTC), no dry-run line ("shadow"), the first line's
 * inception is this decision {decision, decisionSha256} and no later line
 * carries one, and scripts/verify-vol.mjs (a child process, on a copy of the
 * file) recomputes every line — seq, hash chain, dates, windows, values, the
 * rule against the rulebook JSON. The first problem, or null.
 */
function recordProblem(deps, series, recPath, records, inception, rbPath) {
  const today = dateOf(deps.now());
  for (const l of records) {
    if (!(l.date <= today)) return `line #${l.seq} is dated ${l.date}, after the runner's clock (${new Date(deps.now()).toISOString()}): a day is never written before it has ended`;
    if ('shadow' in l) return `line #${l.seq} ${l.date} is a dry-run line ("shadow")`;
    if (l.seq !== 0 && 'inception' in l) return `line #${l.seq} ${l.date} carries an inception; only the first line does`;
  }
  const inc = records[0].inception;
  if (inc?.decision !== inception.decision || inc?.decisionSha256 !== inception.decisionSha256) return `the first line names the decision ${JSON.stringify(inc)}, not ${JSON.stringify(inception)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${series}-record-`));
  try {
    fs.copyFileSync(recPath, path.join(tmp, `record-${series}.jsonl`));
    const r = spawnSync(process.execPath, [deps.verifyScript, '--dir', tmp, '--line', 'realized', '--rulebook', rbPath, '--recompute-only', '--quiet'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    if (r.status !== 0) return `scripts/verify-vol.mjs rejects it:\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return null;
}

/**
 * Which lines of the record carry an anchor (trackrecord/anchors-qvol.jsonl)?
 * Every anchor entry must name a line of the record by seq, date and hash —
 * an entry whose line is gone or whose line no longer hashes to the entry's
 * headHash means the record changed after it was anchored. Only the last
 * lines can be unanchored: a run anchors unanchored lines first, in order, so
 * an unanchored line before an anchored one was not left by a run. Any of
 * these is refused (exit 2) before anything is sent. Returns the index of the
 * first unanchored line (records.length when every line has an anchor).
 */
export function anchorCoverage(series, records, anchors, where) {
  for (const a of anchors) {
    const line = records.find((l) => l.seq === a.seq);
    if (!line) throw refuse(`${series}: ${where} names an anchor of #${a.seq} ${a.date}, a line the record does not hold — the record lost a line after it was anchored; nothing sent. A person restores the record from the repository's history (an anchored line is never removed or edited)`);
    if (a.headHash !== line.hash || a.date !== line.date) throw refuse(`${series}: the anchor of #${a.seq} in ${where} names ${a.date} with head ${a.headHash}, but line #${line.seq} is ${line.date} with hash ${line.hash} — the line changed after it was anchored; nothing sent. A person restores the record from the repository's history (an anchored line is never removed or edited)`);
  }
  const has = records.map((l) => anchors.some((a) => a.seq === l.seq));
  const first = has.indexOf(false);
  if (first < 0) return records.length;
  const later = has.indexOf(true, first);
  if (later >= 0) throw refuse(`${series}: line #${records[first].seq} ${records[first].date} has no anchor in ${where}, but line #${records[later].seq} after it has one — only the last lines of the record can be unanchored (a run anchors them first, in order); nothing sent`);
  return first;
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

const NOT_FOUND = new Set(['TransactionNotFoundError', 'TransactionReceiptNotFoundError']);
const notFound = (e) => {
  for (let c = e, i = 0; c && i < 10; c = c.cause, i++) if (NOT_FOUND.has(c.name)) return true;
  return false;
};
/** A chain error in one line: viem's short message, with the node's own words when it gives them. */
const shortError = (e) => {
  const head = (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0];
  const details = typeof e?.details === 'string' ? e.details.split('\n')[0] : '';
  return details && !head.includes(details) ? `${head} (${details})` : head;
};

/**
 * A transaction and its receipt, read through the signer's node. A node
 * that does not know the hash is asked again within the read-back time
 * (keeper/readback.mjs, 30 s); null when it still does not — the transaction
 * is not on chain (never sent, or dropped by a reorg). Other errors throw.
 */
async function readTx(signer, hash, deps) {
  const { readback } = await chainLib();
  try {
    const { value } = await readback.retryRead(async () => ({ tx: await signer.pc.getTransaction({ hash }), rc: await signer.pc.getTransactionReceipt({ hash }) }), {
      what: `transaction ${hash}`,
      retryIf: notFound,
      ...(deps.readTiming ?? {}),
    });
    return value;
  } catch (e) {
    if (e instanceof readback.ReadTimeout) return null;
    throw e;
  }
}

/**
 * Is `hash` a successful zero-value self-send from the signer whose calldata
 * is `calldata` (the form of every anchor: scripts/anchor-decision.mjs sends
 * `qxdec:` + a decision's sha256, this keeper `qxpi-qvol:` + a line's hash)?
 * {problem: why not | null, missing: not on chain, block}.
 */
async function selfSendCheck(signer, hash, calldata, deps) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) return { problem: `is not a transaction hash (${JSON.stringify(hash)})`, missing: false };
  const { viem } = await chainLib();
  const t = await readTx(signer, hash, deps);
  if (!t) return { problem: 'is not on chain', missing: true };
  const me = viem.getAddress(signer.address);
  let problem = null;
  if (t.rc.status !== 'success' || t.rc.blockNumber == null) problem = `did not succeed (receipt status ${t.rc.status})`;
  else if (viem.getAddress(t.tx.from) !== me) problem = `was sent by ${t.tx.from}, not by the signer ${me}`;
  else if (!t.tx.to || viem.getAddress(t.tx.to) !== me) problem = `is not a self-send (to ${t.tx.to ?? 'no address: a contract creation'})`;
  else if (t.tx.value != null && t.tx.value !== 0n) problem = `carries a value of ${t.tx.value} wei`;
  else if (String(t.tx.input).toLowerCase() !== viem.toHex(calldata).toLowerCase()) problem = `does not carry ${calldata}`;
  return { problem, missing: false, block: t.rc.blockNumber };
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

/**
 * A transaction's receipt, waited for at most RECEIPT_TIMEOUT_MS (deps.receiptTimeoutMs
 * in tests): past it, Exit(1) — the transaction may still be mined later.
 */
async function receiptOf(pc, hash, what, deps) {
  const ms = deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  try {
    return await pc.waitForTransactionReceipt({ hash, timeout: ms });
  } catch (e) {
    if (e?.name === 'WaitForTransactionReceiptTimeoutError') throw new Exit(1, `no receipt for ${what} ${hash} within ${ms / 1000} s`);
    throw e;
  }
}

/** The anchor of one line: a zero-value self-send, calldata `qxpi-<series>:` + the line's hash (as keeper/leverage-index.mjs). */
async function anchorLine(signer, series, line, anchorsPath, deps) {
  const { viem } = await chainLib();
  const hash = await sendNonceSafe(
    () => signer.wallet.sendTransaction({ to: signer.address, value: 0n, data: viem.toHex(`qxpi-${series}:` + line.hash), gas: ANCHOR_GAS }),
    deps.wait
  );
  const rc = await receiptOf(signer.pc, hash, `the anchor of #${line.seq}`, deps);
  if (rc.status !== 'success') throw new Exit(1, `anchor of #${line.seq} ${line.date} reverted (${hash})`);
  appendLine(anchorsPath, { date: line.date, seq: line.seq, headHash: line.hash, txHash: hash });
  deps.log(`  anchored #${line.seq} ${line.date} in ${hash} (block ${rc.blockNumber})`);
}

/**
 * Is the registry entry's deployTx the keeper's own creation of `vault`? A
 * contract creation (no `to`) sent by the signer, successful, whose receipt
 * names `vault` as the contract it created, in the block the entry gives
 * (when it gives one). {problem: why not | null, block}.
 */
async function deploymentCheck(signer, v, vault, deps) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(v.deployTx))) return { problem: `its deployTx is ${JSON.stringify(v.deployTx ?? null)}, not a transaction hash` };
  const { viem } = await chainLib();
  const t = await readTx(signer, v.deployTx, deps);
  const me = viem.getAddress(signer.address);
  if (!t) return { problem: `its deployTx ${v.deployTx} is not on chain` };
  if (t.rc.status !== 'success') return { problem: `its deployTx ${v.deployTx} did not succeed` };
  if (t.tx.to != null) return { problem: `its deployTx ${v.deployTx} is not a contract creation (it is sent to ${t.tx.to})` };
  if (viem.getAddress(t.tx.from) !== me) return { problem: `its deployTx ${v.deployTx} was sent by ${t.tx.from}, not by the keeper ${me}` };
  if (!t.rc.contractAddress || viem.getAddress(t.rc.contractAddress) !== vault) return { problem: `its deployTx ${v.deployTx} created ${t.rc.contractAddress ?? 'no contract'}, not ${vault}` };
  if (v.block != null && t.rc.blockNumber !== BigInt(v.block)) return { problem: `its deployTx ${v.deployTx} is in block ${t.rc.blockNumber}, not in block ${v.block} as the entry says` };
  return { problem: null, block: t.rc.blockNumber };
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
    const rc = await receiptOf(pc, tx, `setNav step ${k + 1}/${steps.length}`, deps);
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
  // the record as a whole, once per run, before anything is sent or appended
  if (records.length) {
    const why = recordProblem(deps, L.series, P.records, records, inception, rbPath);
    if (why) {
      const [head, ...details] = why.split('\n');
      throw refuse(
        `${L.series}: the record does not verify: ${head} — nothing sent, nothing appended, no mark. A person restores ${rel(P.records)} from the repository's history ` +
          `(an anchored line is never edited or removed; a line that is not anchored and not the keeper's is removed by a commit)${details.length ? `\n${details.join('\n')}` : ''}`
      );
    }
    deps.log(`  ${rel(P.records)}: ${records.length} line(s) recomputed as a whole by scripts/verify-vol.mjs — agrees`);
  }

  const signer = o.anchor ? (o.fork ? await forkSigner(o, deps) : await makeSigner(deps)) : null;
  if (o.anchor && !signer) deps.log('--anchor requested but KEEPER_PK is not set — lines are written unanchored; the next run with the key anchors them first');
  if (!o.anchor) deps.log('--anchor not passed — no on-chain anchor attempted for this run.');
  // the decision's own anchor, read once per run by every run that can anchor: a ledger line alone does not start the series
  if (signer) {
    let c;
    try {
      c = await selfSendCheck(signer, d.entry.txHash, `qxdec:${d.entry.sha256}`, deps);
    } catch (e) {
      throw new Exit(1, `${L.series}: the chain failed while reading the inception decision's anchor ${d.entry.txHash}: ${shortError(e)} — nothing read from Binance, nothing written, nothing sent; the next run reads it again`);
    }
    if (c.problem) throw new Exit(1, `${L.series}: NOT IN FORCE: the inception decision ${d.entry.id} is in trackrecord/decisions.jsonl, but its anchor transaction ${d.entry.txHash} ${c.problem} — the decision anchor is a self-send from the keeper key with calldata qxdec:<the decision file's sha256>; nothing read from Binance, nothing written, nothing sent`);
    deps.log(`  decision ${d.entry.id}: anchored in ${d.entry.txHash} (block ${c.block}) — the signer's self-send of qxdec:<its sha256>`);
  }
  /** A line on disk whose anchor fails stays written: the next run anchors it first. Nothing is marked. */
  const anchor = async (line) => {
    try {
      await anchorLine(signer, L.series, line, P.anchors, deps);
    } catch (e) {
      const msg = e instanceof Exit ? e.message : shortError(e);
      const late = /^no receipt for /.test(msg) ? ' (if that transaction is mined later, the line has two anchor transactions with the same calldata: harmless, the anchors file names the later one)' : '';
      throw new Exit(1, `${L.series}: line #${line.seq} ${line.date} is written but its anchor failed: ${msg} — no mark; the next run anchors it first${late}`);
    }
  };

  // the source of every day this run reads: Binance REST (server time read once)
  const src = realizedSource({ offline: null, dryRun: false }, L, gaps, deps);
  const host = L.source.host.replace(/^https?:\/\//, '');
  /** A Binance failure names the host, the day it was reading and what was not written. */
  const fromSource = async (what, day, D, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Exit) throw e;
      throw new Exit(1, `${L.series}: Binance (${host}) failed while ${what} ${day}: ${e?.message ?? e} — nothing written for ${D}; the next run continues from the last line`);
    }
  };
  const nextDate = records.length ? addDays(records.at(-1).date, 1) : L.inception.date;
  const reread = new Set(); // lines whose days were read again in this run

  /**
   * F2: the day of the line the series continues from, read once more. A
   * difference stops the run (exit 1, nothing written) for a person — unless
   * the line is anchored and the source changed the day after the line was
   * written, and a person has confirmed exactly that change (check "refetch").
   */
  const recheckLast = async (last, D) => {
    const ch = await fromSource('reading again the bars of', last.source.day, D, () => sourceChange(last, src));
    if (!ch) {
      deps.log(`  #${last.seq} ${last.date}: the bars of ${last.source.day} read again from Binance — the same as the line records`);
      return;
    }
    const revised = lastAnchored && ch.got.sha !== ch.want.sha;
    const entry = revised ? readSourceChecks(P.checks).find((e) => e.check === 'refetch' && e.day === ch.want.day && e.recorded === ch.want.sha && e.served === ch.got.sha) : null;
    if (entry) {
      deps.log(`  #${last.seq} ${last.date}: the bars of ${ch.want.day} changed after the line was written (sha256 ${ch.want.sha} → ${ch.got.sha}) — confirmed by ${entry.id} in ${rel(P.checks)}; the line stays as written`);
      return;
    }
    if (revised) deps.err(`${L.series}: the entry a person adds once the source is found to have changed ${ch.want.day} after the line was written: ${JSON.stringify({ series: L.series, day: ch.want.day, check: 'refetch', recorded: ch.want.sha, served: ch.got.sha })}`);
    throw new Exit(1,
      `${sourceChangeText(L.series, last, ch)} — nothing written, nothing anchored, no mark. ` +
        (revised
          ? `The line is anchored: a person checks the day at the source; if the source changed it after the line was written, the printed entry (with an id and a note) goes into ${rel(P.checks)} and the next run continues — the line stays as written`
          : lastAnchored
            ? 'The bars still hash to the line\'s sha256 but the line holds another row count, close or last bar: the line is not what those bars give; a person checks'
            : 'The line has no anchor: if the source never served those bars, the line did not come from it — a person removes it (and every line after it) by a commit, and the next run writes those days again')
    );
  };

  /**
   * F12: the daily-candle gate before line D is written. A difference stops
   * the run (exit 1, nothing written) unless a person has confirmed exactly
   * that difference (check "daily-close"); the line is then written from the
   * 1-minute bars, as the definition says.
   */
  const dailyGate = async (line, first, D) => {
    const diffs = await fromSource('reading the daily candles up to', addDays(D, -1), D, () => dailyDifferences(line, first, src));
    const open = [];
    let entries = null;
    for (const dd of diffs) {
      entries ??= readSourceChecks(P.checks);
      const entry = entries.find((e) => e.check === 'daily-close' && e.day === dd.day && e.minuteClose === dd.minute && e.dailyClose === dd.daily);
      if (entry) deps.log(`  ${dd.day}: Binance's daily candle ${dd.daily == null ? 'is missing' : `closes at ${dd.daily}`}, the 1-minute bars at ${dd.minute} — confirmed by ${entry.id} in ${rel(P.checks)}; the line is written from the 1-minute bars, as the definition says`);
      else open.push(dd);
    }
    if (open.length) {
      const dd = open[0];
      deps.err(`${L.series}: the entry a person adds once the 1-minute bars of ${dd.day} are found right: ${JSON.stringify({ series: L.series, day: dd.day, check: 'daily-close', minuteClose: dd.minute, dailyClose: dd.daily })}`);
      throw new Exit(1, `${dailyText(L.series, D, dd, "Binance's daily candle")}${open.length > 1 ? ` (and ${open.length - 1} more day(s))` : ''}, nothing anchored, no mark. A person compares the two at the source; if the 1-minute bars are right, the printed entry (with an id and a note) goes into ${rel(P.checks)} and the next run writes the line`);
    }
    if (!diffs.length) deps.log(first ? `  #0 ${D}: Binance's daily candles of the ${line.window.length} window days close where the 1-minute bars close them` : `  #${line.seq} ${D}: Binance's daily candle of ${addDays(D, -1)} closes at ${String(line.window.at(-1)[1])}, where the 1-minute bars close it`);
  };

  // 2. a line written by an earlier run but not anchored is anchored first — never on trust:
  //    only the last lines of the record can be unanchored; each is recomputed by
  //    scripts/verify-vol.mjs (the first line on its own, a later one after the line before
  //    it), and the bars it records are read again from Binance (the first line: every day
  //    of its window), before its anchor is sent
  const anchors = readLines(P.anchors);
  let firstUnanchored = anchorCoverage(L.series, records, anchors, rel(P.anchors));
  // F8: the last anchor is read again — still on chain (a reorg can drop it: that line is then
  // anchored again, with the lines after it) and the keeper's anchor of that very line
  const dropped = new Set();
  if (signer) {
    for (let k = firstUnanchored - 1; k >= 0; k--) {
      const line = records[k];
      const a = anchors.filter((x) => x.seq === line.seq).at(-1); // the anchor the file names last for that line
      let c;
      try {
        c = await selfSendCheck(signer, a.txHash, `qxpi-${L.series}:${line.hash}`, deps);
      } catch (e) {
        throw new Exit(1, `${L.series}: the chain failed while reading the anchor of #${line.seq} ${line.date} (${a.txHash}): ${shortError(e)} — nothing written, nothing sent; the next run reads it again`);
      }
      if (c.missing) {
        deps.log(`  the anchor of #${line.seq} ${line.date} (${a.txHash}) is not on chain any more (dropped, as by a reorg) — #${line.seq} is anchored again`);
        dropped.add(line.seq);
        firstUnanchored = k;
        continue;
      }
      if (c.problem) {
        throw refuse(
          `${L.series}: the anchor of #${line.seq} ${line.date} in ${rel(P.anchors)} (${a.txHash}) ${c.problem} — it is not the keeper's anchor of that line; nothing sent. ` +
            'An anchor entry is written only by the keeper, after its transaction\'s receipt: a person checks who wrote this one'
        );
      }
      deps.log(`  last anchor: #${line.seq} ${line.date} in ${a.txHash} (block ${c.block}) — on chain, the signer's self-send of this line's hash`);
      break;
    }
  }
  if (signer) {
    for (let k = firstUnanchored; k < records.length; k++) {
      const line = records[k];
      deps.log(`  #${line.seq} ${line.date} has no anchor${dropped.has(line.seq) ? ' on chain' : ''} — anchoring it first`);
      const rc = recompute(deps, L.series, records.slice(0, k), line, null, rbPath);
      if (!rc.ok) {
        throw refuse(
          `${L.series}: line #${line.seq} ${line.date} has no anchor, and scripts/verify-vol.mjs rejects it (${k ? `after #${records[k - 1].seq}` : 'on its own'}) — it is not anchored: nothing sent, nothing appended, no mark. ` +
            `A line the keeper did not write and check is never anchored with its key; a person removes it (and every line after it) by a commit, and the next run writes those days again\n${rc.out}`
        );
      }
      deps.log(`  #${line.seq} ${line.date} recomputed by scripts/verify-vol.mjs before its anchor — agrees`);
      const ch = await fromSource('reading again the bars of', line.source.day, nextDate, () => sourceChange(line, src, k === 0));
      if (ch) {
        throw new Exit(1,
          `${sourceChangeText(L.series, line, ch)} — #${line.seq} has no anchor and is not anchored: nothing sent, nothing appended, no mark. ` +
            'If the source never served those bars, the line did not come from it: a person removes it (and every line after it) by a commit, and the next run writes those days again'
        );
      }
      reread.add(line.seq);
      deps.log(`  #${line.seq} ${line.date}: the bars it records read again from Binance (${k === 0 ? `${recordedDays(line, true).length} days` : line.source.day}) — the same`);
      await anchor(line);
    }
  }
  const lastAnchored = !!signer || firstUnanchored === records.length; // does the last line carry an anchor now?

  // 3. every closed UTC day since the last line, in order
  const run = runUrl(deps.env);
  let prev = records.at(-1) ?? null;
  // before the first new line, the day of the line it is built on is read again (once per run)
  let recheck = !!prev && !reread.has(prev.seq);
  let written = 0;
  for (;;) {
    const D = prev ? addDays(prev.date, 1) : L.inception.date;
    const day = addDays(D, -1); // the UTC day whose close line D adds
    if (deps.now() < dayMs(D)) {
      deps.log(`${L.series}: line ${D} not written: the runner's clock (${new Date(deps.now()).toISOString()}) is before ${D}T00:00Z — a day is never written before it has ended`);
      break;
    }
    if (!(await fromSource('checking the end of', day, D, () => src.isFinal(day)))) {
      // a source that still calls the day open a full day after it ended has a stuck clock or stuck bars
      if (deps.now() >= dayMs(D) + DAY_MS) throw new Exit(1, `${L.series}: Binance says ${day} has not ended (no closed 1-minute bar at or after ${D}T00:00Z), but the runner's clock is ${new Date(deps.now()).toISOString()}, more than a day later — the source is stuck; nothing written for ${D}`);
      deps.log(`${L.series}: ${day} has not ended (or its next-day bar is not there yet) — line ${D} not written`);
      break;
    }
    if (recheck) {
      recheck = false;
      await recheckLast(prev, D);
    }
    const line = await fromSource('fetching the 1-minute bars up to', day, D, () => nextRealizedLine({ o: { offline: null }, L, src, prev, D, rule, run, deps, shadow: false, inception: prev ? null : inception }));
    await dailyGate(line, !prev, D);
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
    const vault = viem.getAddress(v.address);
    // F10: the entry must name the vault the keeper itself deployed (keeper/deploy-mark-vault.mjs writes it from that receipt)
    const dep = await deploymentCheck(signer, v, vault, deps);
    if (dep.problem) throw new Exit(1, `REFUSED: ${rel(P.vaults)} ${L.series} names ${vault}, but ${dep.problem} — the entry does not name the keeper's own display vault; no mark sent. A person corrects the entry from the deployment log beside it (mark-vaults.jsonl)`);
    deps.log(`  vault ${vault}: created by the signer in ${v.deployTx} (block ${dep.block}), as the registry says`);
    await markDisplayVault({ signer, vault, ticker: L.ticker, gate: v.gate, line: last, marksPath: P.marks, registry: rel(P.vaults), deps });
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
