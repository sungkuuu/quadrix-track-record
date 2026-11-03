#!/usr/bin/env node
/**
 * Verifier for the two lines of the BTC volatility index (working name):
 * record-qvol.jsonl (realized) and record-volbtc-implied.jsonl in --dir.
 *
 * Standalone on purpose: it imports nothing from keeper/ and re-states the
 * definition in its own code (docs/vol-index.md), so the keeper's numbers are
 * checked by a second implementation. Node built-ins only. To be merged into
 * scripts/verify.mjs when the series is wired (docs/vol-index.md, "Later wiring").
 *
 * Every line: key order, sha256 hash chain (hash = sha256(JSON.stringify(line
 * minus hash)), prevHash), seq from 0.
 * Realized: dates consecutive; window = the 31 dates D-31 … D-1 and its first
 * 30 entries = the previous line's last 30; carriedFrom when (and only when)
 * the first close is null — on the first line with its source record
 * [date, close, rows, sha256(, acceptance id)], later [date, close] equal to
 * what the previous line implies; returns; source and gaps consistent;
 * variance and value recomputed from the window.
 * Implied: dates ascending (missing days are counted, not failures); snapshot
 * time from usOut; the expiry choice re-made from snapshot.expiries and usOut;
 * every field of terms, value, variance30 and reason recomputed from quotes +
 * terms[].expiry + snapshot.usOut (a line with quotesSha256 is recomputed
 * when <dir>/quotes/<sha>.json is there, else counted as not recomputable).
 * Realized: variance and value (unrounded, as computed) agree within a relative
 * 1e-9. Implied: variances within a relative 1e-9, published values exactly.
 *
 * Usage:
 *   node scripts/verify-vol.mjs --dir <dir> [--line realized|implied] [--rulebook <file>]... [--tail] [--recompute-only] [--quiet]
 * --rulebook <file>: a line's rulebook JSON (keeper/rulebooks/volbtc-<line>.json;
 *   its "line" key says which). Every line of that series must carry the rule
 *   the file implies (its sha256 and values). Give it once per line to check
 *   both. A series without its rulebook is only checked to carry the
 *   implemented definition, the same on every line.
 * --tail: the first line of each file is the record's last line, already
 *   verified; it is not recomputed (its hash is still checked) and the lines
 *   after it are checked against it (seq, prevHash, dates, window, carriedFrom,
 *   rule). The keeper uses this for each new line.
 * --recompute-only: no network (this build never uses the network either way).
 * Exit 0 = every check passed (or no file: "not started"); 1 = a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const DIR = arg('--dir');
const ONLY = arg('--line');
const RULEBOOKS = args.flatMap((a, i) => (a === '--rulebook' ? [args[i + 1]] : []));
const QUIET = args.includes('--quiet');
const TAIL = args.includes('--tail');
if (!DIR || (ONLY && ONLY !== 'realized' && ONLY !== 'implied') || RULEBOOKS.some((f) => !f || f.startsWith('--'))) {
  console.error('usage: node scripts/verify-vol.mjs --dir <dir> [--line realized|implied] [--rulebook <file>]... [--tail] [--recompute-only] [--quiet]');
  process.exit(2);
}

const H = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The rule each series must carry, from its rulebook JSON (only with --rulebook).
const RULE = {};
const RULEBOOK_OF = {};
for (const file of RULEBOOKS) {
  try {
    const bytes = fs.readFileSync(file);
    const rb = JSON.parse(bytes.toString('utf8'));
    if (rb.line !== 'realized' && rb.line !== 'implied') throw new Error('the "line" key must be realized or implied');
    if (RULE[rb.line]) throw new Error(`a second rulebook for the ${rb.line} line`);
    if (ONLY && rb.line !== ONLY) throw new Error(`a rulebook of the ${rb.line} line, but --line ${ONLY}`);
    RULE[rb.line] = rb.line === 'realized'
      ? { rulebookSha256: H(bytes), windowDays: rb.windowDays, yearDays: rb.yearDays, sampling: rb.sampling, mean: rb.mean }
      : {
          rulebookSha256: H(bytes), constantMaturityMinutes: rb.constantMaturityMinutes, yearMinutes: rb.yearMinutes, price: rb.price,
          validQuote: rb.validQuote, cutoff: `${rb.cutoff.rule}:${rb.cutoff.count}`, forward: rb.forward,
        };
    RULEBOOK_OF[rb.line] = file;
  } catch (e) {
    console.error(`--rulebook ${file}: ${e.message}`);
    process.exit(2);
  }
}
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const t0 = (d) => Date.parse(d + 'T00:00:00Z');
const shift = (d, k) => ymd(t0(d) + k * DAY);
const roundHalfUp2 = (x) => Math.floor(x * 100 + 0.5) / 100;
const relDiff = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
const TOL = 1e-9;

const fails = [];
let maxRel = 0;
const fail = (series, seq, msg) => fails.push(`${series} seq ${seq}: ${msg}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new Error(`${path.basename(file)} line ${i + 1}: not JSON (${e.message})`);
    }
  });
}

function checkChain(series, lines) {
  const base = TAIL ? lines[0].seq : 0;
  lines.forEach((L, i) => {
    if (L.seq !== base + i) fail(series, L.seq, `seq should be ${base + i}`);
    const { hash, ...rest } = L;
    if (H(JSON.stringify(rest)) !== hash) fail(series, L.seq, 'hash does not match the line');
    if (i === 0 ? !TAIL && L.prevHash !== null : L.prevHash !== lines[i - 1].hash) fail(series, L.seq, 'prevHash does not match the previous line');
  });
}

const checkRuleAgainstRulebook = (series, L, line) => {
  const want = RULE[line];
  if (want && !same(L.rule, want)) fail(series, L.seq, `rule differs from the rulebook (${RULEBOOK_OF[line]})`);
};

// ============================================================== realized

const REALIZED_KEYS = ['seq', 'date', 'observedAt', 'index', 'value', 'variance', 'late', 'window', 'carriedFrom', 'returns', 'source', 'sources', 'gaps', 'gapAccepted', 'rule', 'keeper', 'shadow', 'inception', 'prevHash', 'hash'];
const REALIZED_OPTIONAL = new Set(['late', 'carriedFrom', 'sources', 'gaps', 'gapAccepted', 'shadow', 'inception']);

function verifyRealized(lines) {
  const S = 'qvol';
  checkChain(S, lines);
  let lateCount = 0;
  let gapLines = 0;
  for (let i = TAIL ? 1 : 0; i < lines.length; i++) {
    const L = lines[i];
    const P = i > 0 ? lines[i - 1] : null;
    const keys = Object.keys(L);
    let pos = -1;
    for (const k of keys) {
      const p = REALIZED_KEYS.indexOf(k);
      if (p < 0 || p <= pos) fail(S, L.seq, `key "${k}" unknown or out of order`);
      pos = Math.max(pos, p);
    }
    for (const k of REALIZED_KEYS) if (!REALIZED_OPTIONAL.has(k) && !(k in L)) fail(S, L.seq, `missing key "${k}"`);
    if (L.index !== S) fail(S, L.seq, `index is ${L.index}`);
    const R = L.rule ?? {};
    const W = R.windowDays;
    if (!(Number.isSafeInteger(W) && W > 0 && Number.isSafeInteger(R.yearDays) && R.yearDays > 0)) {
      fail(S, L.seq, 'rule.windowDays / rule.yearDays missing');
      continue;
    }
    if (R.sampling !== '1d-close-00:00-utc' || R.mean !== 'zero' || 'barMinutes' in R) fail(S, L.seq, 'rule is not the implemented definition');
    if (i > 0 && !same(L.rule, lines[0].rule)) fail(S, L.seq, 'rule differs from the first line');
    checkRuleAgainstRulebook(S, L, 'realized');
    if (P && L.date !== shift(P.date, 1)) fail(S, L.seq, `date ${L.date} does not follow ${P.date}`);

    // window: W + 1 closes, dates D-(W+1) … D-1
    const win = L.window;
    if (!Array.isArray(win) || win.length !== W + 1) {
      fail(S, L.seq, `window must hold ${W + 1} entries`);
      continue;
    }
    for (let k = 0; k <= W; k++) {
      const want = shift(L.date, k - (W + 1));
      const e = win[k];
      if (!Array.isArray(e) || e.length !== 2 || e[0] !== want) fail(S, L.seq, `window[${k}] should be dated ${want}`);
      else if (!(e[1] === null || (typeof e[1] === 'number' && e[1] > 0 && Number.isFinite(e[1])))) fail(S, L.seq, `window[${k}] close is not a positive number or null`);
    }
    if (P && Array.isArray(P.window) && !same(win.slice(0, W), P.window.slice(1))) fail(S, L.seq, 'window does not continue the previous line');

    // carriedFrom: first line [date, close, rows, sha256(, acceptance id when rows < 1440)], later [date, close]
    let carry = null;
    if (win[0][1] === null) {
      carry = L.carriedFrom;
      const base =
        Array.isArray(carry) && typeof carry[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(carry[0]) && carry[0] < win[0][0] && typeof carry[1] === 'number' && carry[1] > 0 && Number.isFinite(carry[1]);
      if (L.seq === 0) {
        const rowsOk = base && Number.isSafeInteger(carry[2]) && carry[2] >= 1 && carry[2] <= 1440 && /^[0-9a-f]{64}$/.test(carry[3] ?? '');
        const idOk = rowsOk && (carry[2] === 1440 ? carry.length === 4 : carry.length === 5 && typeof carry[4] === 'string' && carry[4] !== '');
        if (!idOk) fail(S, L.seq, 'carriedFrom on the first line must be [an earlier date, a close, rows, sha256] (+ the acceptance id when rows < 1440)');
      } else {
        if (!base || carry.length !== 2) fail(S, L.seq, 'carriedFrom must be [an earlier date, a close]');
        if (P) {
          const expect = P.window[0][1] !== null ? P.window[0] : P.carriedFrom?.slice(0, 2);
          if (!same(carry, expect)) fail(S, L.seq, 'carriedFrom is not the close the previous line implies');
        }
      }
    } else if ('carriedFrom' in L) fail(S, L.seq, 'carriedFrom present although the first close is there');

    // recompute: the closes with a null day standing at the previous close
    let cPrev = win[0][1] !== null ? win[0][1] : carry?.[1];
    let acc = 0;
    let withClose = 0;
    for (let k = 1; k <= W; k++) {
      let c = win[k][1];
      if (c !== null) withClose++;
      else c = cPrev;
      const r = Math.log(c / cPrev);
      acc += r * r;
      cPrev = c;
    }
    const variance = (R.yearDays / W) * acc;
    const value = 100 * Math.sqrt(variance); // no decimal rounding: the line records x as computed
    const rd = relDiff(variance, L.variance);
    const rv = relDiff(value, L.value);
    maxRel = Math.max(maxRel, rd, rv);
    if (!(rd <= TOL)) fail(S, L.seq, `variance ${L.variance} vs recomputed ${variance}`);
    if (!(typeof L.value === 'number' && rv <= TOL)) fail(S, L.seq, `value ${L.value} vs recomputed ${value}`);
    if (L.returns !== withClose) fail(S, L.seq, `returns ${L.returns} vs ${withClose} days with a close`);

    // source and gaps
    const src = L.source ?? {};
    const dm1 = shift(L.date, -1);
    if (src.day !== dm1) fail(S, L.seq, `source.day should be ${dm1}`);
    if (src.finalBy !== `${L.date}T00:00`) fail(S, L.seq, 'source.finalBy');
    if (!(Number.isSafeInteger(src.rows) && src.rows >= 0 && src.rows <= 1440)) fail(S, L.seq, 'source.rows out of range');
    if (!/^[0-9a-f]{64}$/.test(src.sha256 ?? '')) fail(S, L.seq, 'source.sha256');
    if ((src.rows === 0) !== (src.lastBar === null)) fail(S, L.seq, 'source.lastBar must be null exactly when the day has no bar');
    if (src.lastBar !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(src.lastBar ?? '')) fail(S, L.seq, 'source.lastBar must be the latest 1-minute bar\'s open time "HH:MM"');
    if ((src.rows === 0) !== (win[W][1] === null)) fail(S, L.seq, "the last close must be null exactly when the source day has no bar");
    if (src.rows < 1440) {
      gapLines++;
      const sum = Array.isArray(L.gaps) ? L.gaps.reduce((a, g) => a + g.minutes, 0) : -1;
      if (sum !== 1440 - src.rows) fail(S, L.seq, `gaps cover ${sum} minutes, the day misses ${1440 - src.rows}`);
      if (typeof L.gapAccepted !== 'string' || !L.gapAccepted) fail(S, L.seq, 'gapAccepted missing for an incomplete day');
    } else if ('gaps' in L || 'gapAccepted' in L) fail(S, L.seq, 'gaps on a complete day');
    if (L.seq === 0) {
      const s = L.sources;
      if (!Array.isArray(s) || s.length !== W + 1) fail(S, L.seq, `the first line needs sources for all ${W + 1} window days`);
      else {
        s.forEach((e, k) => {
          if (e[0] !== win[k][0]) fail(S, L.seq, `sources[${k}] date`);
          if (e[1] < 1440 && typeof e[3] !== 'string') fail(S, L.seq, `sources[${k}] is incomplete without an acceptance id`);
          if ((e[1] === 0) !== (win[k][1] === null)) fail(S, L.seq, `sources[${k}] rows vs window close`);
        });
        if (s[W][1] !== src.rows || s[W][2] !== src.sha256) fail(S, L.seq, 'sources[last] differs from source');
      }
    } else if ('sources' in L) fail(S, L.seq, 'sources only on the first line');

    // time fields
    const late = L.observedAt.slice(0, 10) > L.date;
    if (late) lateCount++;
    if (late ? L.late !== true : 'late' in L) fail(S, L.seq, 'late must be true exactly when observedAt is after the date');
    if (L.keeper?.lagSeconds !== Math.floor((Date.parse(L.observedAt) - t0(L.date)) / 1000)) fail(S, L.seq, 'keeper.lagSeconds');
  }
  const checked = TAIL ? lines.slice(1) : lines;
  return { lines: checked.length, first: checked[0]?.date, last: checked.at(-1)?.date, late: lateCount, gapDays: gapLines, shadow: checked.filter((l) => l.shadow).length };
}

// =============================================================== implied

const IMPLIED_KEYS = ['seq', 'date', 'observedAt', 'index', 'value', 'variance30', 'reason', 'snapshot', 'terms', 'quotes', 'quotesSha256', 'rule', 'keeper', 'shadow', 'inception', 'prevHash', 'hash'];
const IMPLIED_OPTIONAL = new Set(['reason', 'quotes', 'quotesSha256', 'shadow', 'inception']);
const TERM_KEYS = ['role', 'expiry', 'minutes', 'atm', 'forward', 'k0', 'putsUsed', 'callsUsed', 'variance', 'exchangeForward'];

/** One term, re-derived from its quotes: [[strike, 'C'|'P', bid, ask], …]. Returns {t, why}. */
function rederiveTerm(role, expiry, M, qs, ym, cutoff) {
  const t = { role, expiry, minutes: M };
  const strikes = [...new Set(qs.map((q) => q[0]))].sort((a, b) => a - b);
  const call = {};
  const put = {};
  for (const [k, ty, b, a] of qs) (ty === 'C' ? call : put)[k] = { b, a };
  const lad = strikes.filter((k) => call[k] && put[k]);
  const good = (x) => typeof x.b === 'number' && typeof x.a === 'number' && x.b > 0 && x.a > x.b;
  const m = (x) => (x.b + x.a) / 2;
  let ks = null;
  let gapMin = Infinity;
  for (const k of lad) {
    if (!good(call[k]) || !good(put[k])) continue;
    const g = Math.abs(m(call[k]) - m(put[k]));
    if (g < gapMin) {
      gapMin = g;
      ks = k;
    }
  }
  if (ks === null) return { t, why: 'no-atm-pair' };
  const den = 1 - (m(call[ks]) - m(put[ks]));
  t.atm = ks;
  if (!(den > 0)) return { t, why: 'k0-quote-invalid' }; // no forward
  const F = ks / den;
  t.forward = F;
  const below = lad.filter((k) => k <= F);
  if (below.length === 0) return { t, why: 'k0-quote-invalid' };
  const K0 = below[below.length - 1];
  t.k0 = K0;
  if (!good(call[K0]) || !good(put[K0])) return { t, why: 'k0-quote-invalid' };
  const at = lad.indexOf(K0);
  const pick = (from, step, side) => {
    const got = [];
    let bad = 0;
    for (let j = from; j >= 0 && j < lad.length; j += step) {
      const x = side[lad[j]];
      if (good(x)) {
        got.push([lad[j], m(x)]);
        bad = 0;
      } else {
        bad += 1;
        if (bad === cutoff) break;
      }
    }
    return got;
  };
  const P = pick(at - 1, -1, put);
  const C = pick(at + 1, 1, call);
  t.putsUsed = P.length;
  t.callsUsed = C.length;
  if (P.length === 0) return { t, why: 'no-otm-puts' };
  if (C.length === 0) return { t, why: 'no-otm-calls' };
  const chosen = [...P.reverse(), [K0, (m(call[K0]) + m(put[K0])) / 2], ...C];
  const T = M / ym;
  let s = 0;
  for (let j = 0; j < chosen.length; j++) {
    const K = chosen[j][0];
    const lo = j === 0 ? chosen[j][0] : chosen[j - 1][0];
    const hi = j === chosen.length - 1 ? chosen[j][0] : chosen[j + 1][0];
    const dK = j === 0 || j === chosen.length - 1 ? hi - lo : (hi - lo) / 2;
    s += (dK / (K * K)) * (chosen[j][1] * F);
  }
  const x = F / K0 - 1;
  const var1 = (2 / T) * s - (1 / T) * (x * x);
  t.variance = var1;
  return { t, why: var1 > 0 ? null : 'non-positive-variance' };
}

function verifyImplied(lines, dir) {
  const S = 'volbtc-implied';
  checkChain(S, lines);
  let missingDays = 0;
  let hashedSkipped = 0;
  const nulls = {};
  for (let i = TAIL ? 1 : 0; i < lines.length; i++) {
    const L = lines[i];
    const keys = Object.keys(L);
    let pos = -1;
    for (const k of keys) {
      const p = IMPLIED_KEYS.indexOf(k);
      if (p < 0 || p <= pos) fail(S, L.seq, `key "${k}" unknown or out of order`);
      pos = Math.max(pos, p);
    }
    for (const k of IMPLIED_KEYS) if (!IMPLIED_OPTIONAL.has(k) && !(k in L)) fail(S, L.seq, `missing key "${k}"`);
    if (('quotes' in L) === ('quotesSha256' in L)) fail(S, L.seq, 'exactly one of quotes / quotesSha256');
    if (L.index !== S) fail(S, L.seq, `index is ${L.index}`);
    const R = L.rule ?? {};
    const cm = R.constantMaturityMinutes;
    const ym = R.yearMinutes;
    const cutoff = Number(/^consecutive-invalid:(\d+)$/.exec(R.cutoff ?? '')?.[1]);
    if (!(cm > 0 && ym > 0 && cutoff > 0) || R.price !== 'top-of-book-mid' || R.validQuote !== 'bid>0 && ask>bid' || R.forward !== 'K/(1-(c-p))') {
      fail(S, L.seq, 'rule is not the implemented definition');
      continue;
    }
    if (i > 0 && !same(L.rule, lines[0].rule)) fail(S, L.seq, 'rule differs from the first line');
    checkRuleAgainstRulebook(S, L, 'implied');
    const us = L.snapshot?.usOut;
    if (!Number.isSafeInteger(us)) {
      fail(S, L.seq, 'snapshot.usOut');
      continue;
    }
    if (!same(Object.keys(L.snapshot), ['at', 'usOut', 'host', 'rows', 'expiries', 'rawSha256'])) fail(S, L.seq, `snapshot fields ${Object.keys(L.snapshot).join(',')}`);
    // the expiry choice, re-made from the listed expiries: near = furthest with 1 <= M <= cm, next = nearest with M > cm
    const ex = L.snapshot.expiries;
    let pickNear = null;
    let pickNext = null;
    if (!Array.isArray(ex) || ex.some((e, j) => typeof e !== 'string' || !Number.isFinite(Date.parse(e)) || new Date(Date.parse(e)).toISOString() !== e || (j > 0 && !(Date.parse(e) > Date.parse(ex[j - 1]))))) {
      fail(S, L.seq, 'snapshot.expiries must be ISO times, strictly ascending');
      continue;
    }
    for (const e of ex) {
      const M = Math.floor((Date.parse(e) * 1000 - us) / 60000000);
      if (M < 1) continue;
      if (M <= cm) pickNear = e;
      else if (pickNext === null) pickNext = e;
    }
    const at = new Date(Math.floor(us / 1000)).toISOString();
    if (L.snapshot.at !== at) fail(S, L.seq, `snapshot.at should be ${at}`);
    if (L.date !== at.slice(0, 10)) fail(S, L.seq, 'date is not the snapshot date');
    if (i > 0) {
      const gap = Math.round((t0(L.date) - t0(lines[i - 1].date)) / DAY);
      if (gap < 1) fail(S, L.seq, 'dates must ascend');
      else missingDays += gap - 1;
    }
    if (L.keeper?.lagSeconds !== Math.floor((Math.floor(us / 1000) - t0(L.date)) / 1000)) fail(S, L.seq, 'keeper.lagSeconds');
    if (L.value === null) nulls[L.reason] = (nulls[L.reason] ?? 0) + 1;
    // the expiry choice needs no quotes: checked on hashed lines too
    if (!Array.isArray(L.terms)) {
      fail(S, L.seq, 'terms is not an array');
      continue;
    }
    if (L.terms.length === 0) {
      if (pickNear !== null && pickNext !== null) fail(S, L.seq, `no terms, but the listed expiries bracket ${cm} minutes (${pickNear}, ${pickNext})`);
    } else if (L.terms[0]?.expiry !== pickNear || L.terms[1]?.expiry !== pickNext) {
      fail(S, L.seq, `terms expire ${L.terms[0]?.expiry}, ${L.terms[1]?.expiry}; the listed expiries give ${pickNear}, ${pickNext}`);
    }

    let quotes = L.quotes;
    if (!quotes) {
      const side = path.join(dir, 'quotes', `${L.quotesSha256}.json`);
      if (!fs.existsSync(side)) {
        hashedSkipped++;
        continue;
      }
      quotes = JSON.parse(fs.readFileSync(side, 'utf8'));
      if (H(JSON.stringify(quotes)) !== L.quotesSha256) {
        fail(S, L.seq, 'quotes file does not match quotesSha256');
        continue;
      }
      if (L.terms.some((t) => 'exchangeForward' in t)) fail(S, L.seq, 'a hashed line carries no exchangeForward');
    }
    // quotes order: near first, strike ascending, C before P
    const rank = (q) => [q[0] === 'near' ? 0 : 1, q[1], q[2] === 'C' ? 0 : 1];
    for (let j = 1; j < quotes.length; j++) {
      const a = rank(quotes[j - 1]);
      const b = rank(quotes[j]);
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))) {
        fail(S, L.seq, `quotes out of order at ${j}`);
        break;
      }
    }

    // re-derive
    let want;
    if (L.terms.length === 0) {
      want = { value: null, variance30: null, reason: 'no-bracket', terms: [] };
      if (quotes.length !== 0) fail(S, L.seq, 'a no-bracket line carries no quotes');
    } else if (L.terms.length !== 2 || L.terms[0].role !== 'near' || L.terms[1].role !== 'next') {
      fail(S, L.seq, 'terms must be [near, next]');
      continue;
    } else {
      const got = [];
      for (const term of L.terms) {
        const M = Math.floor((Date.parse(term.expiry) * 1000 - us) / 60000000);
        const qs = quotes.filter((q) => q[0] === term.role).map((q) => q.slice(1));
        got.push(rederiveTerm(term.role, term.expiry, M, qs, ym, cutoff));
      }
      const [n, x] = got;
      if (!(n.t.minutes >= 1 && n.t.minutes <= cm && x.t.minutes > cm)) fail(S, L.seq, `terms do not bracket ${cm} minutes (${n.t.minutes}, ${x.t.minutes})`);
      const why = n.why ?? x.why;
      want = { value: null, variance30: null, reason: why, terms: got.map((g) => g.t) };
      if (!why) {
        const T1 = n.t.minutes / ym;
        const T2 = x.t.minutes / ym;
        // same written order as the definition: T1 s1 (M2 - cm) / (M2 - M1) + …
        const v30 = (((T1 * n.t.variance * (x.t.minutes - cm)) / (x.t.minutes - n.t.minutes) + (T2 * x.t.variance * (cm - n.t.minutes)) / (x.t.minutes - n.t.minutes)) * ym) / cm;
        if (v30 > 0) want = { value: roundHalfUp2(100 * Math.sqrt(v30)), variance30: v30, reason: null, terms: want.terms };
        else want.reason = 'non-positive-variance';
      }
    }
    if (L.value !== want.value) fail(S, L.seq, `value ${L.value} vs recomputed ${want.value}`);
    if ((L.reason ?? null) !== want.reason) fail(S, L.seq, `reason ${L.reason} vs recomputed ${want.reason}`);
    if ((L.variance30 === null) !== (want.variance30 === null)) fail(S, L.seq, 'variance30 null-ness');
    else if (want.variance30 !== null) {
      const rd = relDiff(L.variance30, want.variance30);
      maxRel = Math.max(maxRel, rd);
      if (!(rd <= TOL)) fail(S, L.seq, `variance30 ${L.variance30} vs ${want.variance30}`);
    }
    want.terms.forEach((wt, j) => {
      const lt = L.terms[j];
      const lk = Object.keys(lt).filter((k) => k !== 'exchangeForward');
      const wk = Object.keys(wt);
      if (!same(lk, wk)) fail(S, L.seq, `terms[${j}] fields ${lk.join(',')} vs ${wk.join(',')}`);
      for (const k of wk) {
        if (k === 'forward' || k === 'variance') {
          const rd = relDiff(lt[k], wt[k]);
          maxRel = Math.max(maxRel, rd);
          if (!(rd <= TOL)) fail(S, L.seq, `terms[${j}].${k} ${lt[k]} vs ${wt[k]}`);
        } else if (lt[k] !== wt[k]) fail(S, L.seq, `terms[${j}].${k} ${lt[k]} vs ${wt[k]}`);
      }
      if (Object.keys(lt).some((k) => !TERM_KEYS.includes(k))) fail(S, L.seq, `terms[${j}] has an unknown key`);
    });
  }
  const checked = TAIL ? lines.slice(1) : lines;
  return { lines: checked.length, first: checked[0]?.date, last: checked.at(-1)?.date, missingDays, nullByReason: nulls, hashedNotRecomputed: hashedSkipped, shadow: checked.filter((l) => l.shadow).length };
}

// ================================================================== main

const report = {};
for (const [line, file, fn] of [
  ['realized', 'record-qvol.jsonl', verifyRealized],
  ['implied', 'record-volbtc-implied.jsonl', verifyImplied],
]) {
  if (ONLY && ONLY !== line) continue;
  const f = path.join(DIR, file);
  if (!fs.existsSync(f)) {
    report[line] = 'not started';
    continue;
  }
  try {
    const lines = readJsonl(f);
    report[line] = lines.length ? fn(lines, DIR) : 'empty';
  } catch (e) {
    fails.push(`${line}: ${e.message}`);
  }
}
if (!QUIET || fails.length) {
  console.log(JSON.stringify({ dir: DIR, report, rulebook: { realized: RULE.realized?.rulebookSha256 ?? 'not checked', implied: RULE.implied?.rulebookSha256 ?? 'not checked' }, tail: TAIL, maxRelativeDiff: maxRel, failures: fails.length }, null, 1));
  for (const f of fails.slice(0, 50)) console.log(`FAIL ${f}`);
}
process.exit(fails.length ? 1 : 0);
