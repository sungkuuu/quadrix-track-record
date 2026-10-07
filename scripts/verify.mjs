#!/usr/bin/env node
/**
 * Independent track-record verifier — no dependencies, Node 18+.
 *
 * Verifies, without trusting Quadrix:
 *   1. every record's hash is the SHA-256 of its own contents (tamper check),
 *   2. every record embeds the previous record's hash (append-only chain),
 *   3. every anchored head hash exists on GIWA Sepolia as confirmed calldata
 *      (`qxtr:<hash>` in a transaction Quadrix cannot rewrite or backdate),
 *   4. every record has an anchor (a record without one has no checkable date)
 *      and every record's list of decisions in force matches the ledger,
 *   5. every anchored decision document still hashes to the value committed on
 *      chain (`qxdec:<hash>`) and that transaction is confirmed.
 *
 * GIWA Sepolia is a testnet. What the anchors prove is that Quadrix did not
 * rewrite or backdate a record; the proof lasts as long as that chain's history.
 *
 * Anyone can run it against the published data:
 *
 *   node verify.mjs --base https://quadrix.finance
 *
 * or against local files from the repo:
 *
 *   node verify.mjs --dir ./trackrecord
 *
 * By default every published series is verified, each walked from its own
 * genesis (separate chains on purpose — spec §8): the DRY_RUN rehearsal
 * (record.jsonl, 2026-08-13 → 08-30, closed), the LIVE series (record-live.jsonl,
 * genesis 2026-09-01), the five paper-index series (record-{qrev,qdefi,qai,
 * barbell,triens}.jsonl, anchor prefix `qxpi-<index>:`), the two leverage
 * series (record-{qbtc2x,qeth2x}.jsonl, same prefix form; reported as "not
 * started" while neither file nor an inception decision exists), and qX20's
 * daily closes (qx20-daily.jsonl). qX20 is not hash-chained: each close names the
 * keeper's setNav transaction, and the check is that the transaction exists,
 * succeeded, went to a qX20 vault, carries the stated level, and sits in the
 * stated block at the stated time. It does not prove the close was the day's
 * last mark — the vault's full transaction list on the explorer shows that.
 *
 * The leverage series (qBTC2X, qETH2X — keeper/leverage-index.mjs) are also
 * RECOMPUTED: each line's level, book, check log and day statistics follow
 * from the previous line's book, this line's 15-minute bars and the rule the
 * line states, by the arithmetic written out below (leverage section) — this
 * file does not import the keeper's code, so the two implementations check
 * each other. The genesis line must name this index's anchored inception
 * decision (`<date>-<index>-paper-inception`, effective on the genesis date)
 * whose text contains the rulebook JSON's sha256; that JSON
 * (keeper/rulebooks/<index>.json, mirrored as rulebook-<index>.json) must hash
 * to it and hold the rule every line states; the genesis bar must be the last
 * bar of the day before; no line may be written before its own day began, and
 * with an RPC its anchor's block may not be older than the line's own day; a
 * model-liquidation line must name the entry in which a person accepted it
 * (`liquidationAccepted`).
 *
 * What VERIFIED does not cover: that the bars are the ones Binance serves
 * (--refetch-bars compares them; a difference is REVISED, a failure only with
 * --strict-source); who sent an anchor; the vault marks; that the accepting
 * entry exists in keeper/leverage-gaps.json (the repository's history shows it).
 *
 * Options:
 *   --base <url>     fetch <base>/trackrecord/… (the site's mirror)
 *   --dir <path>     read the files from a local directory
 *   --series <name>  dry | live | qrev | qdefi | qai | barbell | triens | qbtc2x |
 *                    qeth2x | qx20 | all (default: all). The paper indexes are
 *                    keeper/paper-index.mjs's rules-only levels: same hash-chain
 *                    shape, anchor prefix `qxpi-<index>:`, no `decisions` field.
 *   --rpc <url>      JSON-RPC endpoint (default: https://sepolia-rpc.giwa.io)
 *   --recompute-only no network: hashes, chains and the leverage recompute only
 *                    (no anchor, qX20 or decision-anchor RPC; decision documents
 *                    are still hashed). The leverage keeper runs this before it
 *                    appends a line.
 *   --refetch-bars   leverage series: fetch every line's day again from Binance
 *                    and compare the 1-minute text's sha256 and the 15-minute
 *                    bars; a difference prints REVISED (not a failure unless
 *                    --strict-source — a line's own bars are the record).
 *   --allow-rehearsal accept leverage lines marked "rehearsal" (keeper/dryrun/
 *                    output, throwaway rule values). Without it such a line fails.
 *
 * The point of this file is that you can read all of it. If you don't trust
 * the copy served by the site, verify the same data with your own code —
 * the hashing is plain SHA-256 over each record line minus its `hash` field.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = opt('--base', null);
const DIR = opt('--dir', BASE ? null : './trackrecord');
const RPC = opt('--rpc', 'https://sepolia-rpc.giwa.io');
const SERIES = opt('--series', 'all');
const RECOMPUTE_ONLY = args.includes('--recompute-only');
const REFETCH_BARS = args.includes('--refetch-bars');
const STRICT_SOURCE = args.includes('--strict-source');
const ALLOW_REHEARSAL = args.includes('--allow-rehearsal');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function loadBytes(name) {
  if (BASE) {
    const url = `${BASE.replace(/\/$/, '')}/trackrecord/${name}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} -> HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fs.readFileSync(path.join(DIR, name));
}

async function loadLines(name) {
  let text;
  if (BASE) {
    const url = `${BASE.replace(/\/$/, '')}/trackrecord/${name}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} -> HTTP ${r.status}`);
    text = await r.text();
  } else {
    text = fs.readFileSync(path.join(DIR, name), 'utf8');
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// A public RPC will occasionally refuse a call; that is a network hiccup, not a
// failed verification, so retry briefly before giving up on that check.
async function rpc(method, params, attempt = 0) {
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) {
    // HTTP 429 is the public endpoint rate-limiting a full run: back off longer.
    if (attempt < 5) {
      const wait = /429/.test(e.message) ? 2000 * 2 ** attempt : 500 * (attempt + 1);
      await new Promise((res) => setTimeout(res, wait));
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${e.message} (after ${attempt + 1} attempts)`);
  }
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

// Optional: absent on a chain that has published no decisions yet.
let decisions = [];
/** The latest inception decision of a leverage index (a postponement is a later one — red team F07b). */
const latestInception = (index) =>
  decisions.filter((d) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${index}-paper-inception$`).test(d.id)).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1) ?? null;
try {
  decisions = await loadLines('decisions.jsonl');
} catch {
  decisions = [];
}

const SERIES_FILES = {
  dry: { label: 'DRY_RUN', records: 'record.jsonl', anchors: 'anchors.jsonl', anchorPrefix: 'qxtr:', checkDecisions: true },
  live: { label: 'LIVE', records: 'record-live.jsonl', anchors: 'anchors-live.jsonl', anchorPrefix: 'qxtr:', checkDecisions: true },
  // Paper-index series (qREV, qDEFI) — keeper/paper-index.mjs. Rules-only
  // levels, no vault, not in force until an inception decision is anchored.
  // They carry no `decisions` field (that ledger is scoped to the LIVE book)
  // and anchor under their own calldata prefix, `qxpi-<index>:`, distinct
  // from the operating record's `qxtr:` — same hash-chain shape otherwise,
  // so the generic per-record checks below need no series-specific code.
  qrev: { label: 'QREV', records: 'record-qrev.jsonl', anchors: 'anchors-qrev.jsonl', anchorPrefix: 'qxpi-qrev:', checkDecisions: false },
  qdefi: { label: 'QDEFI', records: 'record-qdefi.jsonl', anchors: 'anchors-qdefi.jsonl', anchorPrefix: 'qxpi-qdefi:', checkDecisions: false },
  qai: { label: 'QAI', records: 'record-qai.jsonl', anchors: 'anchors-qai.jsonl', anchorPrefix: 'qxpi-qai:', checkDecisions: false },
  barbell: { label: 'QDUO (barbell)', records: 'record-barbell.jsonl', anchors: 'anchors-barbell.jsonl', anchorPrefix: 'qxpi-barbell:', checkDecisions: false },
  triens: { label: 'QTRI (triens)', records: 'record-triens.jsonl', anchors: 'anchors-triens.jsonl', anchorPrefix: 'qxpi-triens:', checkDecisions: false },
  // Leverage stage A (keeper/leverage-index.mjs): a synthetic daily-reset 2x
  // level computed from Binance spot bars. Same chain and anchor shape, plus
  // the recompute (leverage section below).
  qbtc2x: { label: 'QBTC2X', records: 'record-qbtc2x.jsonl', anchors: 'anchors-qbtc2x.jsonl', anchorPrefix: 'qxpi-qbtc2x:', checkDecisions: false, leverage: { index: 'qbtc2x', ticker: 'qBTC2X', symbol: 'BTCUSDT' } },
  qeth2x: { label: 'QETH2X', records: 'record-qeth2x.jsonl', anchors: 'anchors-qeth2x.jsonl', anchorPrefix: 'qxpi-qeth2x:', checkDecisions: false, leverage: { index: 'qeth2x', ticker: 'qETH2X', symbol: 'ETHUSDT' } },
};
const ALL = [...Object.keys(SERIES_FILES), 'qx20'];
if (SERIES !== 'all' && !ALL.includes(SERIES)) {
  console.error(`--series must be one of ${ALL.join(', ')} or all (got ${SERIES})`);
  process.exit(2);
}
const totals = { records: 0, anchors: 0, series: [] };

async function verifySeries(key) {
  const f = SERIES_FILES[key];
  let records, anchors;
  if (f.leverage) {
    // A leverage series exists from its inception decision on. Before that,
    // neither file exists and nothing is wrong ("not started").
    const inception = latestInception(f.leverage.index);
    records = await loadLines(f.records).catch(() => null);
    anchors = await loadLines(f.anchors).catch(() => null);
    // an empty record file is no series either (red team F03 E)
    if (records !== null && records.length === 0) records = null;
    if (anchors !== null && anchors.length === 0 && records === null) anchors = null;
    if (records === null && anchors === null) {
      // The decision is anchored on or before its date; the genesis line is
      // written by the first keeper run after that date's 00:00 UTC. Until the
      // end of the effective day the missing file is "pending", not a failure.
      const today = new Date().toISOString().slice(0, 10);
      if (inception && today <= inception.effectiveFrom) {
        console.log(`\n[${f.label}] pending — inception decision ${inception.id} is effective from ${inception.effectiveFrom}; the genesis line is written by the first keeper run after ${inception.effectiveFrom}T00:00Z (a failure if ${f.records} is still missing after that UTC day)`);
        totals.series.push(`${f.label} pending (inception ${inception.effectiveFrom})`);
      } else if (inception) fail(`${f.label}: inception decision ${inception.id} (effective ${inception.effectiveFrom}) is anchored but ${f.records} is missing`);
      else {
        console.log(`\n[${f.label}] not started — no ${f.records} and no inception decision`);
        totals.series.push(`${f.label} not started`);
      }
      return;
    }
    if (records === null) {
      fail(`${f.label}: ${f.anchors} exists but ${f.records} is missing`);
      return;
    }
    if (anchors === null) {
      if (!RECOMPUTE_ONLY) fail(`${f.label}: ${f.records} exists but ${f.anchors} is missing`);
      anchors = [];
    }
  } else {
    try {
      records = await loadLines(f.records);
      anchors = await loadLines(f.anchors);
    } catch (e) {
      fail(`${f.label}: series files unreadable (${e.message})`);
      return;
    }
  }
  totals.records += records.length;
  totals.anchors += anchors.length;
  const first = records[0]?.date ?? '—';
  const last = records[records.length - 1]?.date ?? '—';
  totals.series.push(`${f.label} ${records.length} records ${first} → ${last}`);

  console.log(`\n[${f.label}] chain — ${records.length} record(s), ${f.records}`);
  let prevHash = null;
  for (const rec of records) {
    const { hash, ...rest } = rec;
    const computed = sha256(JSON.stringify(rest));
    if (computed !== hash) {
      fail(`#${rec.seq} ${rec.date}: stored hash ${hash.slice(0, 12)}… != computed ${computed.slice(0, 12)}…`);
    } else if (rec.prevHash !== prevHash) {
      fail(`#${rec.seq} ${rec.date}: prevHash does not match record #${rec.seq - 1} (chain break)`);
    } else {
      // rec.mode (DRY_RUN/LIVE) is the operating-record label; paper-index
      // records instead carry rec.index (QREV/QDEFI) and rec.level — either
      // is printed, whichever the record shape has.
      ok(`#${rec.seq} ${rec.date} ${rec.mode ?? rec.index} head ${hash.slice(0, 12)}…${rec.benchmarks?.missing ? ' (benchmarks recorded as missing)' : ''}`);
    }
    prevHash = rec.hash;

    // A record's decision list must match the ledger for that date, in both
    // directions: nothing dropped from the record, nothing added to it.
    // Paper-index series (qREV/qDEFI) carry no `decisions` field at all —
    // that ledger is scoped to the LIVE operating record — so this check is
    // skipped for them (f.checkDecisions === false), not run-and-ignored.
    if (f.checkDecisions) {
      const expected = decisions
        .filter((d) => d.effectiveFrom <= rec.date)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      const carried = rec.decisions ?? [];
      if (carried.length !== expected.length) {
        fail(`#${rec.seq} ${rec.date}: carries ${carried.length} decision(s), ledger says ${expected.length}`);
      } else {
        for (let i = 0; i < expected.length; i++) {
          if (carried[i].id !== expected[i].id || carried[i].sha256 !== expected[i].sha256) {
            fail(`#${rec.seq} ${rec.date}: decision ${carried[i].id} does not match the ledger`);
          }
        }
      }
    }
  }

  if (f.leverage) await verifyLeverage(f, records);
  if (RECOMPUTE_ONLY) {
    console.log(`\n[${f.label}] anchors not checked (--recompute-only)`);
    return;
  }

  console.log(`\n[${f.label}] anchors — ${anchors.length} on-chain commitment(s) via ${RPC}`);
  for (const a of anchors) {
    const rec = records.find((r) => r.seq === a.seq);
    if (!rec) {
      fail(`anchor seq ${a.seq}: no matching record`);
      continue;
    }
    if (rec.hash !== a.headHash) {
      fail(`anchor seq ${a.seq}: headHash does not match record hash`);
      continue;
    }
    const expected = '0x' + Buffer.from(f.anchorPrefix + a.headHash, 'utf8').toString('hex');
    let tx;
    try {
      tx = await rpc('eth_getTransactionByHash', [a.txHash]);
    } catch (e) {
      fail(`anchor seq ${a.seq}: rpc unavailable — ${e.message}`);
      continue;
    }
    if (!tx) {
      fail(`anchor seq ${a.seq}: tx ${a.txHash} not found on chain`);
      continue;
    }
    const receipt = await rpc('eth_getTransactionReceipt', [a.txHash]);
    if (!receipt || receipt.status !== '0x1') {
      fail(`anchor seq ${a.seq}: tx ${a.txHash} not confirmed`);
      continue;
    }
    if ((tx.input || '').toLowerCase() !== expected.toLowerCase()) {
      fail(`anchor seq ${a.seq}: calldata does not carry ${f.anchorPrefix}${a.headHash.slice(0, 12)}…`);
      continue;
    }
    // Leverage lines: the anchor's block time is when the line demonstrably existed. It cannot be older than the
    // line's own day, and how much later than observedAt it came is printed (a line rewritten as "on time" shows
    // here — red team F03 D; final review F-1 for the day bound).
    let when = '';
    if (f.leverage) {
      let block = null;
      try {
        block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
      } catch (e) {
        fail(`anchor seq ${a.seq}: block unavailable — ${e.message}`);
        continue;
      }
      const blockMs = parseInt(block.timestamp, 16) * 1000;
      const observed = Date.parse(rec.observedAt);
      // The anchor carries the line's hash, so the line existed when this block was made. A block before the
      // line's own day began is a line written before its day (a failure). A block a little before observedAt
      // is the runner's clock and the chain's clock disagreeing: printed, not failed.
      if (blockMs < lev.day0(rec.date)) {
        fail(`anchor seq ${a.seq} ${a.date}: block time ${new Date(blockMs).toISOString()} is before ${rec.date}T00:00Z — the line was anchored before its own day began`);
        continue;
      }
      const afterH = (blockMs - observed) / 3_600_000;
      when = `, ${new Date(blockMs).toISOString()}${afterH >= 1 ? ` — ${afterH.toFixed(1)} h after observedAt` : blockMs < observed ? ` — ${Math.ceil((observed - blockMs) / 1000)} s before observedAt (clock difference)` : ''}`;
    }
    ok(`seq ${a.seq} ${a.date} anchored in ${a.txHash.slice(0, 14)}… (block ${parseInt(receipt.blockNumber, 16)}${when})`);
  }
  // Every record must have exactly one anchor — a record without one is a
  // claim nobody can check the date of.
  for (const rec of records) {
    if (!anchors.some((a) => a.seq === rec.seq)) fail(`#${rec.seq} ${rec.date}: no anchor for this record`);
  }
}

// ------------------------------------------------------------------ leverage
// qBTC2X / qETH2X stage A. A line D carries the 15-minute bars of UTC day
// D - 1 and the book left at its end; the previous line's book plus this
// line's bars and rule determine everything else in it. Written here from the
// rule's text (not from keeper/leverage-step.mjs) so that the keeper's line
// is accepted only when a second implementation agrees.
//
// The rule, per 15-minute bar in open order, from the previous bar's close:
//   d      = bars of 15 minutes since the previous bar's open (1 <= d < 4096)
//   debt   C <- C * (1 + r/100/365)^(15d/1440)          (r = rule.ratePct; 1 when r = 0)
//   low    if -C >= lltv * A * min(1, low/prevClose): model liquidation (level 0, series ends)
//   close  A <- A * close/prevClose; E = A + C
//   trade  at the day's last bar always (the daily reset); at a check bar of
//          period n (a UTC grid time m*n lies in [this close, next close)) when
//          |A| >= T * E. Equity after a trade at cost c = costBp/1e4:
//          E2 = (E + c*A)/(1 + c*lam) if lam*E - A >= 0 else (E - c*A)/(1 - c*lam);
//          then A = lam*E2, C = E2 - A.
const checkedDecisionIds = new Set();
const lev = {
  HOST: 'data-api.binance.vision', // the rule's only price source (no fallback); --refetch-bars asks this host, never one a line names
  DAY: 86_400_000,
  day0: (date) => Date.parse(`${date}T00:00:00Z`),
  nextDate: (date, k = 1) => new Date(Date.parse(`${date}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10),
  round: (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits,
  hm: (ms) => new Date(ms).toISOString().slice(11, 16),
  at: (ms) => new Date(ms).toISOString().slice(0, 16),
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
};

/** Recompute one book over one day's bars. `bars` = [[openMs, o, h, l, c]], `p` = {lam, n, T, c, r, lltv}. */
function levDay(book, bars, p, wantLog) {
  let A = book.A, C = book.C, E = book.E;
  let refClose = book.lastClose;
  let refOpen = Date.parse(`${book.lastBar}:00Z`);
  const log = [];
  let trades = 0, triggers = 0, turnover = 0, costSum = 0, worstLtv = null, worstBar = null, liq = null;
  for (let k = 0; k < bars.length; k++) {
    const [openMs, , , low, close] = bars[k];
    const steps = (openMs - refOpen) / 900_000;
    if (!Number.isInteger(steps) || steps < 1 || steps >= 4096) throw new Error(`bar ${lev.at(openMs)}: ${steps} steps after the previous bar`);
    if (p.r !== 0) C = C * Math.pow(1 + p.r / 100 / 365, (steps * 15) / 1440);
    const atLow = A * Math.min(1, low / refClose);
    const ltv = -C / atLow;
    if (worstLtv === null || ltv > worstLtv) { worstLtv = ltv; worstBar = lev.hm(openMs); }
    if (-C >= p.lltv * atLow) {
      const eqLow = atLow + C;
      liq = { bar: lev.hm(openMs), ltvLow: lev.round(ltv, 6) };
      if (wantLog) log.push({ t: lev.at(openMs + 900_000) + 'Z', bar: lev.hm(openMs), lambdaBefore: eqLow > 0 ? lev.round(atLow / eqLow, 6) : null, action: 'liquidated', notional: 0, cost: 0, lambdaAfter: null, level: 0 });
      A = 0; C = 0; E = 0; refClose = close; refOpen = openMs;
      break;
    }
    A = A * (close / refClose);
    E = A + C;
    const last = k === bars.length - 1;
    // check bar: the first UTC grid time at or after this close, and how many lie before the next close
    let grid = null, gridCount = 0;
    if (!last) {
      const closeMin = openMs / 60_000 + 15;
      const nextCloseMin = bars[k + 1][0] / 60_000 + 15;
      for (let m = Math.ceil(closeMin / p.n); m * p.n < nextCloseMin; m++) { if (grid === null) grid = m * p.n; gridCount++; }
    }
    const action = last ? 'reset' : grid !== null && Math.abs(A) >= p.T * E ? 'trigger' : 'none';
    const lamBefore = A / E;
    let after = E, q = 0, cost = 0;
    if (action !== 'none') {
      after = p.lam * E - A >= 0 ? (E + p.c * A) / (1 + p.c * p.lam) : (E - p.c * A) / (1 - p.c * p.lam);
      q = p.lam * after - A;
      cost = (p.c * Math.abs(q)) / E;
      A = p.lam * after;
      C = after - A;
      trades += 1;
      if (action === 'trigger') triggers += 1;
      turnover += Math.abs(q) / E;
      costSum += cost;
    }
    if (wantLog && (last || grid !== null)) {
      const entry = { t: lev.at(last ? openMs + 900_000 : grid * 60_000) + 'Z', bar: lev.hm(openMs), lambdaBefore: lev.round(lamBefore, 6), action, notional: lev.round(q / E, 8), cost: lev.round(cost, 8), lambdaAfter: lev.round(A / after, 6), level: lev.round(100 * after, 6) };
      if (!last && gridCount > 1) entry.gridTimes = gridCount;
      log.push(entry);
    }
    E = after;
    refClose = close;
    refOpen = openMs;
  }
  const lastBar = bars.length ? lev.at(refOpen) : book.lastBar;
  return {
    book: { A, C, E, lastBar, lastClose: bars.length ? refClose : book.lastClose },
    log,
    stats: { trades, triggers, turnover: lev.round(turnover, 8), cost: lev.round(costSum, 8), maxLtvLow: worstLtv === null ? null : { value: lev.round(worstLtv, 6), bar: worstBar } },
    liq,
  };
}

async function refetchDay(host, symbol, date) {
  const start = lev.day0(date), end = start + lev.DAY;
  const rows = [];
  for (let s = start; s < end; s += 60_000_000) {
    const url = `https://${host}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${s}&endTime=${Math.min(s + 60_000_000, end) - 1}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${host}`);
    for (const k of await r.json()) {
      let t = Number(k[0]);
      if (t >= 1e15) t = Math.floor(t / 1000);
      if (t >= start && t < end) rows.push([t, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])]);
    }
  }
  const text = rows.map((m) => `${m[0]},${String(m[1])},${String(m[2])},${String(m[3])},${String(m[4])}\n`).join('');
  const q = new Map();
  for (const [t, o, h, l, c] of rows) {
    const slot = Math.floor(t / 900_000) * 900_000;
    const b = q.get(slot);
    if (!b) q.set(slot, [lev.hm(slot), o, h, l, c, 1]);
    else { b[2] = Math.max(b[2], h); b[3] = Math.min(b[3], l); b[4] = c; b[5] += 1; }
  }
  return { sha: sha256(text), bars: [...q.values()] };
}

async function verifyLeverage(f, records) {
  const L = f.leverage;
  console.log(`\n[${f.label}] recompute — ${records.length} line(s) from bars, rule and the previous book`);
  if (!records.length) return;
  const g = records[0];
  const bad = (rec, msg) => fail(`${f.label} #${rec.seq} ${rec.date}: ${msg}`);
  const rule = g.rule;
  const rehearsal = g.rehearsal ?? null;
  // genesis
  if (g.seq !== 0 || g.prevHash !== null) bad(g, 'the first line is not a genesis line (seq 0, prevHash null)');
  if (g.index !== L.ticker) bad(g, `index ${g.index}, expected ${L.ticker}`);
  if (rehearsal !== null && !ALLOW_REHEARSAL) bad(g, `marked as a rehearsal ("${rehearsal}") — not a published series line (pass --allow-rehearsal for keeper/dryrun/ output)`);
  if (!rule || rule.target !== 2 || rule.reset !== 'daily-00:00-utc' || rule.barMinutes !== 15 || !(rule.lltv > 0 && rule.lltv < 1)) bad(g, `rule ${JSON.stringify(rule)} is not a daily-reset 2x rule on 15-minute bars`);
  else if (!(Number.isInteger(rule.checkMinutes) && rule.checkMinutes >= 15 && rule.checkMinutes < 1440 && rule.checkMinutes % 15 === 0 && 1440 % rule.checkMinutes === 0) || !(rule.trigger > rule.target) || !(rule.costBp >= 0) || !(rule.ratePct >= 0)) bad(g, `rule values ${JSON.stringify(rule)} are outside the allowed grid`);
  const startBook = { A: rule.target, C: 1 - rule.target, E: 1 };
  const gb = g.bars?.[0];
  if (!Array.isArray(g.bars) || g.bars.length !== 1) bad(g, 'genesis carries exactly one bar (the last of the day before)');
  else if (!lev.same(g.book, { ...startBook, lastBar: `${lev.nextDate(g.date, -1)}T${gb[0]}`, lastClose: gb[4] })) bad(g, `genesis book ${JSON.stringify(g.book)} is not {A: ${startBook.A}, C: ${startBook.C}, E: 1} at the last close of ${lev.nextDate(g.date, -1)}`);
  // C: the genesis bar is the day's last bar — 23:45 on a full day; on a day with an accepted gap, every
  // minute after that bar is in the recorded gaps (red team F03 C)
  if (Array.isArray(gb)) {
    const slot0 = Date.parse(`${lev.nextDate(g.date, -1)}T${gb[0]}:00Z`);
    const dayEnd = lev.day0(g.date);
    if ((g.sources?.rows ?? 0) >= 1440) {
      if (gb[0] !== '23:45' || gb[5] !== 15) bad(g, `genesis bar ${gb[0]} (${gb[5]} minutes) is not the full 23:45 bar of ${lev.nextDate(g.date, -1)}`);
    } else {
      const missing = new Set();
      for (const x of g.gaps ?? []) {
        const a = Date.parse(`${lev.nextDate(g.date, -1)}T${x.from}:00Z`), z = Date.parse(`${lev.nextDate(g.date, -1)}T${x.to}:00Z`);
        for (let t = a; t <= z; t += 60_000) missing.add(t);
      }
      let after = 0;
      for (let t = slot0 + 900_000; t < dayEnd; t += 60_000) if (!missing.has(t)) after++;
      if (after > 0) bad(g, `genesis bar ${gb[0]} is not the last bar of ${lev.nextDate(g.date, -1)}: ${after} minute(s) after it are neither in the bar nor in the recorded gaps`);
    }
  }
  if (g.level !== 100) bad(g, `genesis level ${g.level}, expected 100`);
  if (!lev.same(g.dayStats, { trades: 0, triggers: 0, turnover: 0, cost: 0, maxLtvLow: null }) || g.liquidated !== null || !lev.same(g.slots, [])) bad(g, 'the genesis line carries day statistics, checks or a liquidation — it holds only the starting book');
  if (!rule?.also?.length && (g.levels !== undefined || g.books !== undefined)) bad(g, 'levels / books present without level.also in the rule');
  if (rule?.also?.length) {
    if (!lev.same(g.books, Object.fromEntries(rule.also.map((a) => [a.id, g.book])))) bad(g, 'genesis books differ from the primary book');
    if (!lev.same(g.levels, Object.fromEntries(rule.also.map((a) => [a.id, 100])))) bad(g, 'genesis levels differ from 100');
  }
  const inc = g.inception ?? {};
  if (rehearsal === null) {
    // B: this index's inception decision, dated the genesis day — not any decision effective that day
    if (inc.decision !== `${g.date}-${L.index}-paper-inception`) bad(g, `inception.decision ${inc.decision} is not ${g.date}-${L.index}-paper-inception`);
    // A: the rule every line states is the rulebook JSON's, byte for byte bound by its sha256
    let rbBytes = null;
    for (const name of [`rulebook-${L.index}.json`]) {
      try { rbBytes = await loadBytes(name); } catch { rbBytes = null; }
    }
    if (!rbBytes && !BASE) {
      const local = path.join(DIR, '..', 'keeper', 'rulebooks', `${L.index}.json`);
      if (fs.existsSync(local)) rbBytes = fs.readFileSync(local);
    }
    if (!rbBytes) bad(g, `rulebook JSON unavailable (rulebook-${L.index}.json${BASE ? '' : ` or ../keeper/rulebooks/${L.index}.json`}) — the line's rule cannot be bound to it`);
    else if (sha256(rbBytes) !== rule?.rulebookSha256) bad(g, `rule.rulebookSha256 ${String(rule?.rulebookSha256).slice(0, 12)}… is not the rulebook JSON's ${sha256(rbBytes).slice(0, 12)}… (a rulebook changed after inception needs its own decision)`);
    else {
      let rb = null;
      try { rb = JSON.parse(rbBytes.toString('utf8')); } catch (e) { bad(g, `rulebook JSON unreadable (${e.message})`); }
      if (rb) {
        const want = {
          rulebookSha256: rule.rulebookSha256, target: rb.product?.target, reset: rb.product?.reset, checkMinutes: rb.check?.minutes, trigger: rb.check?.trigger,
          barMinutes: rb.underlying?.barMinutes, lltv: rb.model?.lltv, costBp: rb.level?.primary?.costBp, ratePct: rb.level?.primary?.ratePct,
          ...(rb.level?.also?.length ? { also: rb.level.also.map((a) => ({ id: a.id, costBp: a.costBp, ratePct: a.ratePct })) } : {}),
        };
        if (!lev.same(rule, want)) bad(g, `rule ${JSON.stringify(rule)} is not the rulebook JSON's ${JSON.stringify(want)}`);
        if (rb.ticker !== L.ticker || rb.underlying?.symbol !== L.symbol || rb.inception?.date !== g.date || rb.inception?.decision !== inc.decision) bad(g, `rulebook JSON names ${rb.ticker} ${rb.underlying?.symbol}, inception ${rb.inception?.date} ${rb.inception?.decision} — not this series`);
      }
    }
    const d = decisions.find((x) => x.id === inc.decision);
    if (!d) bad(g, `inception decision ${inc.decision} is not in decisions.jsonl`);
    else {
      checkedDecisionIds.add(d.id);
      if (inc.decisionSha256 !== d.sha256) bad(g, `inception.decisionSha256 differs from the ledger's ${d.sha256.slice(0, 12)}…`);
      if (d.effectiveFrom !== g.date) bad(g, `inception decision is effective from ${d.effectiveFrom}, the genesis line is dated ${g.date}`);
      let text = '';
      try { text = (await loadBytes(d.file)).toString('utf8'); } catch (e) { bad(g, `decision document unreadable (${e.message})`); }
      if (text && !text.includes(rule.rulebookSha256)) bad(g, `decision ${d.id} does not contain the rulebook sha256 ${rule.rulebookSha256}`);
    }
  }
  let refetchOk = 0;
  for (let k = 0; k < records.length; k++) {
    const rec = records[k];
    const before = failures;
    const D = rec.date;
    const day = lev.nextDate(D, -1);
    if (k > 0) {
      const prev = records[k - 1];
      if (D !== lev.nextDate(prev.date)) bad(rec, `date follows ${prev.date} (every UTC day has its line)`);
      if (!lev.same(rec.rule, rule)) bad(rec, 'rule differs from the genesis line');
      if ((rec.rehearsal ?? null) !== rehearsal) bad(rec, 'rehearsal marker differs from the genesis line');
      if (prev.liquidated) bad(rec, `a line after the model liquidation of #${prev.seq}`);
    }
    if (rec.index !== L.ticker) bad(rec, `index ${rec.index}`);
    if (rec.seq !== k) bad(rec, `seq ${rec.seq} at position ${k} (a series is numbered from 0 without gaps)`);
    if (k > 0 && !rule?.also?.length && (rec.levels !== undefined || rec.books !== undefined)) bad(rec, 'levels / books present without level.also in the rule');
    // bars: inside [day 00:00, D 00:00), ascending, on the 15-minute grid, consistent
    const start = lev.day0(day);
    const parsed = [];
    let n1m = 0, prevT = -Infinity, shape = true;
    for (const b of rec.bars ?? []) {
      const t = Date.parse(`${day}T${b[0]}:00Z`);
      const [o, h, l, c, n] = b.slice(1);
      if (!(t >= start && t < start + lev.DAY && t % 900_000 === 0 && t > prevT && Number.isInteger(n) && n >= 1 && n <= 15 && l > 0 && l <= Math.min(o, c) && Math.max(o, c) <= h)) shape = false;
      prevT = t; n1m += n;
      parsed.push([t, o, h, l, c]);
    }
    if (!shape) bad(rec, 'bars are not ascending 15-minute bars of the day with low <= open, close <= high and 1..15 minutes each');
    const s = rec.sources ?? {};
    if (s.host !== lev.HOST || s.symbol !== L.symbol || s.interval !== '1m' || s.finalBy !== `${D}T00:00Z` || !/^[0-9a-f]{64}$/.test(String(s.sha256)) || !Number.isInteger(s.rows) || s.rows > 1440) bad(rec, `sources ${JSON.stringify(s)} are not this day's Binance 1-minute bars`);
    if (k > 0 && n1m !== s.rows) bad(rec, `the bars hold ${n1m} 1-minute bars, sources.rows says ${s.rows}`);
    if (s.rows < 1440) {
      const gaps = rec.gaps;
      let missing = 0, okGaps = Array.isArray(gaps) && typeof rec.gapAccepted === 'string' && rec.gapAccepted.length > 0;
      const perSlot = new Map();
      let prevEnd = -1;
      for (const x of gaps ?? []) {
        const a = Date.parse(`${day}T${x.from}:00Z`), z = Date.parse(`${day}T${x.to}:00Z`);
        if (!(z >= a && (z - a) / 60_000 + 1 === x.minutes && a > prevEnd)) okGaps = false;
        prevEnd = z;
        missing += x.minutes;
        for (let t = a; t <= z; t += 60_000) perSlot.set(Math.floor(t / 900_000), (perSlot.get(Math.floor(t / 900_000)) ?? 0) + 1);
      }
      if (missing !== 1440 - s.rows) okGaps = false;
      if (k > 0) for (const b of rec.bars) {
        const slot = Math.floor(Date.parse(`${day}T${b[0]}:00Z`) / 900_000);
        if ((perSlot.get(slot) ?? 0) !== 15 - b[5]) okGaps = false;
      }
      if (!okGaps) bad(rec, `${s.rows} 1-minute bars, but gaps / gapAccepted do not account for the ${1440 - s.rows} missing minute(s)`);
    } else if (rec.gaps !== undefined || rec.gapAccepted !== undefined) bad(rec, 'gaps recorded on a complete day');
    // a model-liquidation line is written only after a person accepted it (owner, 2026-10-06): it names the entry
    if (rec.liquidated && !(typeof rec.liquidationAccepted === 'string' && rec.liquidationAccepted.length > 0)) bad(rec, 'a model liquidation without liquidationAccepted — such a line is written only after a person accepts it in keeper/leverage-gaps.json');
    if (!rec.liquidated && rec.liquidationAccepted !== undefined) bad(rec, 'liquidationAccepted on a line without a model liquidation');
    // timing fields (red team F02: a line is never written before its day began)
    if (!(Date.parse(rec.observedAt) >= lev.day0(D))) bad(rec, `observedAt ${rec.observedAt} is before ${D}T00:00Z — a line is never written before its day began`);
    const late = rec.observedAt.slice(0, 10) > D;
    if ((rec.late ?? false) !== late || (rec.late !== undefined && rec.late !== true)) bad(rec, `late is ${rec.late}, observedAt ${rec.observedAt} says ${late}`);
    if (rec.keeper?.lagSeconds !== Math.floor((Date.parse(rec.observedAt) - lev.day0(D)) / 1000)) bad(rec, 'keeper.lagSeconds does not match observedAt');
    // the recompute
    if (k > 0 && failures === before) {
      const prev = records[k - 1];
      const p = { lam: rule.target, n: rule.checkMinutes, T: rule.trigger, c: rule.costBp / 1e4, r: rule.ratePct, lltv: rule.lltv };
      let main, also = [];
      try {
        main = levDay(prev.book, parsed, p, true);
        also = (rule.also ?? []).map((a) => [a.id, prev.books?.[a.id]?.E === 0 ? { book: prev.books[a.id] } : levDay(prev.books?.[a.id], parsed, { ...p, c: a.costBp / 1e4, r: a.ratePct }, false)]);
      } catch (e) {
        bad(rec, `cannot recompute: ${e.message}`);
        continue;
      }
      const lvl = lev.round(100 * main.book.E, 6);
      if (rec.level !== lvl) bad(rec, `level ${rec.level}, recomputed ${lvl}`);
      if (!lev.same(rec.book, main.book)) bad(rec, `book ${JSON.stringify(rec.book)}, recomputed ${JSON.stringify(main.book)}`);
      if (!lev.same(rec.dayStats, main.stats)) bad(rec, `dayStats ${JSON.stringify(rec.dayStats)}, recomputed ${JSON.stringify(main.stats)}`);
      if (!lev.same(rec.liquidated, main.liq)) bad(rec, `liquidated ${JSON.stringify(rec.liquidated)}, recomputed ${JSON.stringify(main.liq)}`);
      if (!lev.same(rec.slots, main.log)) {
        const i = rec.slots?.findIndex((x, j) => !lev.same(x, main.log[j])) ?? 0;
        bad(rec, `check log differs at entry ${i}: ${JSON.stringify(rec.slots?.[i])} vs recomputed ${JSON.stringify(main.log[i])}`);
      }
      if (also.length) {
        const levels = Object.fromEntries(also.map(([id, r]) => [id, lev.round(100 * r.book.E, 6)]));
        const books = Object.fromEntries(also.map(([id, r]) => [id, r.book]));
        if (!lev.same(rec.levels, levels) || !lev.same(rec.books, books)) bad(rec, 'levels / books of level.also differ from the recompute');
      }
    }
    if (REFETCH_BARS) {
      try {
        const r = await refetchDay(lev.HOST, L.symbol, day);
        const want = k === 0 ? r.bars.slice(-1) : r.bars;
        if (r.sha !== s.sha256 || !lev.same(want, rec.bars)) {
          totals.revised = (totals.revised ?? 0) + 1;
          console.log(`  REVISED ${L.index} ${D}: Binance now serves ${r.sha === s.sha256 ? 'the same 1-minute text but different 15-minute bars' : `different 1-minute bars (sha256 ${r.sha.slice(0, 12)}… vs ${String(s.sha256).slice(0, 12)}…)`} — the line's bars stand`);
          if (STRICT_SOURCE) bad(rec, 'source revised (--strict-source)');
        } else refetchOk++;
      } catch (e) {
        bad(rec, `--refetch-bars: ${e.message}`);
      }
    }
    if (failures === before) ok(`#${rec.seq} ${D} level ${rec.level}${rec.late ? ' (late)' : ''}${k > 0 ? ` — recomputed: ${rec.slots.length} check(s), ${rec.dayStats.triggers} trigger(s)` : ' — genesis'}${rec.liquidated ? ', MODEL LIQUIDATION (series ends)' : ''}`);
  }
  if (REFETCH_BARS) console.log(`  re-fetched ${refetchOk} day(s) unchanged`);
}

// qX20: the keeper's setNav(uint256 navPerShare, uint256 indexLevel) marks,
// one close per UTC day. The two vaults are the published qX20 contracts
// (docs §10); a close that points anywhere else fails.
const QX20_VAULTS = ['0x1d1115b961832dd921be78cf1362a531b69bcaa0', '0x2a165501dda6e430ff98e82682f53ca8465bb21f'];
const SETNAV = '0xec75710f';
async function verifyQx20() {
  let closes;
  try {
    // The site serves it under /trackrecord/; the repo keeps it under keeper/.
    closes = BASE || fs.existsSync(path.join(DIR, 'qx20-daily.jsonl'))
      ? await loadLines('qx20-daily.jsonl')
      : (await fs.promises.readFile(path.join(DIR, '..', 'keeper', 'qx20-daily.jsonl'), 'utf8'))
          .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (e) {
    fail(`QX20: qx20-daily.jsonl unreadable (${e.message})`);
    return;
  }
  totals.marks = closes.length;
  totals.series.push(`QX20 ${closes.length} daily closes ${closes[0]?.date ?? '—'} → ${closes[closes.length - 1]?.date ?? '—'}`);
  console.log(`\n[QX20] daily closes — ${closes.length}, each a setNav transaction on GIWA Sepolia`);
  let prevDate = '';
  for (const c of closes) {
    if (c.date <= prevDate) fail(`QX20 ${c.date}: out of order or repeated after ${prevDate}`);
    prevDate = c.date;
    let tx, receipt, block;
    try {
      tx = await rpc('eth_getTransactionByHash', [c.tx]);
      receipt = tx ? await rpc('eth_getTransactionReceipt', [c.tx]) : null;
      block = receipt ? await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
    } catch (e) {
      fail(`QX20 ${c.date}: rpc unavailable — ${e.message}`);
      continue;
    }
    if (!tx || !receipt || receipt.status !== '0x1' || !block) {
      fail(`QX20 ${c.date}: tx ${c.tx} missing or not confirmed`);
      continue;
    }
    const to = (tx.to || '').toLowerCase();
    const input = (tx.input || '').toLowerCase();
    const nav = Number(BigInt('0x' + input.slice(10, 74))) / 1e6;
    const level = Number(BigInt('0x' + input.slice(74, 138))) / 1e6;
    const at = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
    if (!QX20_VAULTS.includes(to) || to !== String(c.vault).toLowerCase()) fail(`QX20 ${c.date}: tx goes to ${to}, not the qX20 vault named`);
    else if (!input.startsWith(SETNAV)) fail(`QX20 ${c.date}: tx is not a setNav call`);
    else if (nav !== c.nav || level !== c.level) fail(`QX20 ${c.date}: chain says nav ${nav} level ${level}, file says ${c.nav} / ${c.level}`);
    else if (parseInt(receipt.blockNumber, 16) !== c.block || at !== c.at || at.slice(0, 10) !== c.date) fail(`QX20 ${c.date}: block/time on chain (${parseInt(receipt.blockNumber, 16)}, ${at}) differ from the file`);
    else ok(`${c.date} level ${c.level} — setNav in ${c.tx.slice(0, 14)}… (block ${c.block}, ${at})`);
  }
}

for (const key of SERIES === 'all' ? ALL : [SERIES]) {
  if (key === 'qx20') {
    if (RECOMPUTE_ONLY) console.log('\n[QX20] not checked (--recompute-only: it is an RPC check)');
    else await verifyQx20();
  } else await verifySeries(key);
}

// --recompute-only reads no network: only the documents that a checked series
// names are hashed (the leverage genesis line's decision), the others are not
// required to be present.
const decisionsToCheck = RECOMPUTE_ONLY ? decisions.filter((d) => checkedDecisionIds.has(d.id)) : decisions;
if (decisionsToCheck.length) {
  console.log(`\ndecisions — ${decisionsToCheck.length} anchored document(s)${RECOMPUTE_ONLY ? ' (documents hashed only — --recompute-only)' : ''}`);
  for (const d of decisionsToCheck) {
    let bytes;
    try {
      bytes = await loadBytes(d.file);
    } catch (e) {
      fail(`decision ${d.id}: document unreadable (${e.message})`);
      continue;
    }
    const computed = sha256(bytes);
    if (computed !== d.sha256) {
      fail(`decision ${d.id}: document hashes ${computed.slice(0, 12)}…, ledger says ${d.sha256.slice(0, 12)}… (edited since anchoring)`);
      continue;
    }
    if (RECOMPUTE_ONLY) {
      ok(`${d.id} document hashes to the ledger's value`);
      continue;
    }
    const expected = '0x' + Buffer.from('qxdec:' + d.sha256, 'utf8').toString('hex');
    let tx, receipt, block;
    try {
      tx = await rpc('eth_getTransactionByHash', [d.txHash]);
      receipt = tx ? await rpc('eth_getTransactionReceipt', [d.txHash]) : null;
      block = receipt ? await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
    } catch (e) {
      fail(`decision ${d.id}: rpc unavailable — ${e.message}`);
      continue;
    }
    if (!tx || !receipt || receipt.status !== '0x1') {
      fail(`decision ${d.id}: anchor tx ${d.txHash} missing or unconfirmed`);
      continue;
    }
    if ((tx.input || '').toLowerCase() !== expected.toLowerCase()) {
      fail(`decision ${d.id}: anchor calldata does not carry qxdec:${d.sha256.slice(0, 12)}…`);
      continue;
    }
    const stamped = block ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : 'unknown time';
    ok(`${d.id} anchored ${stamped} in ${d.txHash.slice(0, 14)}… (effective ${d.effectiveFrom})`);
  }
}

console.log(
  failures === 0
    ? `\nVERIFIED${RECOMPUTE_ONLY ? ' (recompute only — no anchor checked)' : ''} — ${totals.records} records, ${totals.anchors} ${RECOMPUTE_ONLY ? 'anchor lines listed (not checked)' : 'anchors'}, ${totals.marks ?? 0} qX20 closes, ${decisionsToCheck.length} decisions, 0 failures${totals.revised ? `, ${totals.revised} REVISED day(s) (source changed since the line; the line's bars are the record)` : ''}\n   ${totals.series.join('\n   ')}\n`
    : `\nFAILED — ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
