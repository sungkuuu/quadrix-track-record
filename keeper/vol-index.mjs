/**
 * BTC volatility index (working name) — keeper CLI for its two lines,
 * `qvol` (realized) and `volbtc-implied`. DRAFT: neither line is in force, no
 * line is written to trackrecord/ by this build, and this file has no anchor
 * step and reads no key. What the series is and is not: docs/vol-index.md.
 *
 * Realized, one run (--dry-run): read the last line → is the next day D over
 * (Binance server time and D's first closed 1-minute bar)? → fetch D-1's
 * 1-minute bars twice and compare the canonical text → 1,440 bars, or an
 * accepted gap whose sha256 matches, else stop (exit 1, nothing written) →
 * build the line → have scripts/verify-vol.mjs recompute it on its own (a
 * child process, the new line after the record's last line with --tail, the
 * rule against the rulebook JSON; non-zero = discard, exit 1) → append → next day.
 *
 * Implied, one run (--dry-run): a line for today already → nothing to do →
 * get_instruments, then get_book_summary_by_currency (or the saved raw
 * responses of --from-snapshot) → value or null with a reason → recompute →
 * append. A missed day is never filled in.
 *
 * Usage:
 *   node keeper/vol-index.mjs --line realized --dry-run --replay 2019-03-04..2019-03-31 --out keeper/dryrun
 *   node keeper/vol-index.mjs --line implied --collect-only --out <dir>
 *   node keeper/vol-index.mjs --line implied --dry-run --from-snapshot <book.json.gz> --instruments <inst.json.gz>
 *
 * Options:
 *   --line realized|implied   required
 *   --dry-run                 write lines under --out only; every line carries "shadow": true
 *   --out <dir>               default keeper/dryrun/ (gitignored)
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
 * file, no network call. This build has no in-force path.
 *
 * Exit codes: 0 = done, nothing to do, not in force, inactive; 1 = data failure (nothing
 * written for the failed day); 2 = configuration (bad option, bad rulebook or
 * acceptance file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sha256, dayMs, dateOf, addDays, isDate, canonicalMinuteText, minuteGaps, dayClose, realizedFromWindow, windowDates, buildRealizedLine, DAY_MIN, SERIES,
} from './vol-realized.mjs';
import { parseDeribit, joinQuotes, computeImplied, buildImpliedLine, expiryList, quotesSha256, FormatError } from './vol-implied.mjs';
import { binanceRest, binanceDayIsFinal, binanceDayOnce, offlineDay, offlineDayIsFinal, deribitRest } from './vol-sources.mjs';

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
  const valued = ['--line', '--out', '--from-snapshot', '--instruments', '--replay', '--offline', '--gaps', '--quotes'];
  const flags = ['--dry-run', '--collect-only'];
  const o = { line: null, dryRun: false, collectOnly: false, out: null, fromSnapshot: null, instruments: null, replay: null, offline: null, gaps: null, quotes: 'embed' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!valued.includes(a) && !flags.includes(a)) throw refuse(`unknown option ${a}`);
    if (seen.has(a)) throw refuse(`${a} given twice`);
    seen.add(a);
    if (flags.includes(a)) {
      o[a === '--dry-run' ? 'dryRun' : 'collectOnly'] = true;
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
    else if (a === '--replay') {
      const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
      if (!m || !isDate(m[1]) || !isDate(m[2]) || m[2] < m[1]) throw refuse(`--replay must be FROM..TO with FROM <= TO (got ${v})`);
      o.replay = { from: m[1], to: m[2] };
    }
  }
  if (o.line !== 'realized' && o.line !== 'implied') throw refuse(`--line must be realized or implied (got ${o.line})`);
  const realizedOnly = ['--replay', '--offline', '--gaps'];
  const impliedOnly = ['--collect-only', '--from-snapshot', '--instruments', '--quotes'];
  for (const a of o.line === 'realized' ? impliedOnly : realizedOnly) if (seen.has(a)) throw refuse(`${a} is for --line ${o.line === 'realized' ? 'implied' : 'realized'}`);
  for (const a of ['--replay', '--offline', '--gaps', '--from-snapshot']) if (seen.has(a) && !o.dryRun) throw refuse(`${a} is accepted only with --dry-run`);
  if (!!o.fromSnapshot !== !!o.instruments) throw refuse('--from-snapshot and --instruments go together');
  if (o.quotes !== 'embed' && o.quotes !== 'hash') throw refuse(`--quotes must be embed or hash (got ${o.quotes})`);
  if (o.collectOnly && (o.fromSnapshot || o.dryRun || seen.has('--quotes'))) throw refuse('--collect-only takes no --dry-run, --from-snapshot or --quotes (it computes nothing)');
  return o;
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
 * What the code implements; anything else in a line's rulebook JSON (rulebookFile)
 * is refused (exit 2). Common to both lines: line, id (realized "qvol",
 * implied "volbtc"), the inception, the owner-pending list and the display
 * decimals (display only: the record path never reads them). The implied line
 * has the active switch; the realized line has none (in force = inception only).
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
    throw refuse(`${rb.series}: ${rbRel} inception is set, but this build has no in-force path (no decision check, no anchor) — see docs/vol-index.md "Later wiring"`);
  }
  return o.line === 'realized' ? runRealized(o, rb, rulebookSha256, out, deps, rbPath) : runImplied(o, rb, rulebookSha256, out, deps, rbPath);
}

// ----------------------------------------------------------------- realized

async function runRealized(o, L, rulebookSha256, out, deps, rbPath) {
  const rule = { rulebookSha256, windowDays: L.windowDays, yearDays: L.yearDays, sampling: L.sampling, mean: L.mean };
  const recPath = path.join(out, `record-${L.series}.jsonl`);
  const records = readLines(recPath);
  const gaps = readGaps(o.gaps ?? path.join(deps.root, 'keeper', 'vol-index-gaps.json'));
  const symbol = L.source.symbol;
  const host = L.source.host.replace(/^https?:\/\//, '');
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

  let written = 0;
  for (;;) {
    if (to && D > to) {
      deps.log(`${L.series}: replay complete through ${to} (${written} line(s) written this run)`);
      return 0;
    }
    const day = addDays(D, -1);
    if (!(await isFinal(day))) {
      deps.log(`${L.series}: ${day} has not ended (or its next-day bar is not there yet) — ${written} line(s) written this run`);
      return 0;
    }
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
    const line = buildRealizedLine({
      prev, date: D, observedAt: new Date(deps.now()).toISOString(), value, variance, window, carriedFrom, returns, source, sources,
      gaps: last.gaps, gapAccepted: last.gapAccepted, rule, run, shadow: true,
    });
    const rc = recompute(deps, L.series, records, line, null, rbPath);
    if (!rc.ok) throw new Exit(1, `${L.series}: independent recompute (scripts/verify-vol.mjs) rejected line ${D} — nothing written\n${rc.out}`);
    appendLine(recPath, line);
    records.push(line);
    written++;
    deps.log(`${L.series} ${D} ${value}${line.late ? ' (late)' : ''}${line.gaps ? ` gap accepted ${line.gapAccepted}` : ''}`);
    prev = line;
    D = addDays(D, 1);
  }
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
