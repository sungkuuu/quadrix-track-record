/**
 * BTC volatility index (working name) — implied line, pure functions.
 *
 * Model-free 30-day variance from listed option quotes (the variance-swap
 * replication used by the best-known equity volatility index; source document:
 * Cboe, "Cboe Volatility Index Mathematics Methodology", formula (1) and the
 * constant-maturity interpolation), applied to Deribit BTC options, which are
 * quoted and settled in BTC. Draft, not in force — docs/vol-index.md.
 *
 * No network, no files, no clock. scripts/verify-vol.mjs recomputes the same
 * lines without importing this file.
 *
 * Steps for one snapshot (usOut = the quote response's server time, µs):
 *   minutes   M = floor((expiration_ms * 1000 - usOut) / 60,000,000); only M >= 1
 *   terms     near = the furthest expiry with M <= 43,200; next = the nearest with M > 43,200
 *   ladder    per term: strikes that have BOTH a call and a put instrument, ascending
 *   valid     bid > 0 and ask > bid (a missing bid or ask is invalid); price = (bid + ask) / 2 in BTC
 *   K*        among ladder strikes with a valid call and put, min |c - p| (tie: lower strike)
 *   F         K* / (1 - (c* - p*))           (no rate input — it is inside F);
 *             1 - (c* - p*) <= 0 → no forward → cannot compute (k0-quote-invalid)
 *   K0        highest ladder strike <= F; its call and put must both be valid
 *   puts      below K0 downwards, invalid skipped; two invalid in a row end the walk
 *   calls     above K0 upwards, the same; at K0 the price is the mean of call and put
 *   Q~        dollar value at expiry of a BTC premium q = q x F
 *   variance  in this order: term_i = (dK_i / (K_i x K_i)) x Q~_i, summed in ascending
 *             strike order; x = F / K0 - 1; (2 / T) x sum - (1 / T) x (x x x),  T = M / 525,600
 *   30 days   V30 = [T1 s1 (M2 - 43200)/(M2 - M1) + T2 s2 (43200 - M1)/(M2 - M1)] x 525600 / 43200
 *   value     100 x sqrt(V30), two decimals; null with a reason when it cannot be computed
 * The line carries every expiry of the joined instruments (snapshot.expiries),
 * so the expiry choice can be checked from the line alone.
 */
import crypto from 'node:crypto';

export const SERIES = 'volbtc-implied';
export const REASONS = ['no-bracket', 'no-atm-pair', 'k0-quote-invalid', 'no-otm-puts', 'no-otm-calls', 'non-positive-variance'];

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const r2 = (x) => Math.round(x * 100) / 100;

export class FormatError extends Error {}

/** A Deribit JSON-RPC response → {result, usOut}. Throws FormatError on an error answer or a changed shape. */
export function parseDeribit(json, what) {
  if (!json || typeof json !== 'object') throw new FormatError(`${what}: response is not a JSON object`);
  if (json.error) throw new FormatError(`${what}: Deribit error ${JSON.stringify(json.error).slice(0, 200)}`);
  if (!Array.isArray(json.result)) throw new FormatError(`${what}: "result" is not an array`);
  if (!Number.isSafeInteger(json.usOut)) throw new FormatError(`${what}: "usOut" is not an integer`);
  return { result: json.result, usOut: json.usOut };
}

/**
 * Joins the two calls by instrument name. Only instruments present in both
 * are kept. Rows: {name, expMs, strike, type: 'C'|'P', bid, ask, underlying}.
 * Throws FormatError when a field the computation reads is missing or of the
 * wrong type, or when an instrument is not a BTC-quoted option (the forward
 * relation below holds only for premiums quoted in the underlying).
 */
export function joinQuotes(instruments, book) {
  const inst = new Map();
  for (const r of instruments) {
    if (!r || typeof r.instrument_name !== 'string') throw new FormatError('instruments: a row has no instrument_name');
    if (!Number.isSafeInteger(r.expiration_timestamp)) throw new FormatError(`instruments: ${r.instrument_name} has no integer expiration_timestamp`);
    if (!(typeof r.strike === 'number' && Number.isFinite(r.strike) && r.strike > 0)) throw new FormatError(`instruments: ${r.instrument_name} has no positive strike`);
    if (r.option_type !== 'call' && r.option_type !== 'put') throw new FormatError(`instruments: ${r.instrument_name} option_type is ${JSON.stringify(r.option_type)}`);
    if (r.kind != null && r.kind !== 'option') throw new FormatError(`instruments: ${r.instrument_name} kind is ${JSON.stringify(r.kind)}`);
    if (r.quote_currency != null && r.quote_currency !== 'BTC') throw new FormatError(`instruments: ${r.instrument_name} is quoted in ${JSON.stringify(r.quote_currency)}, not BTC`);
    if (inst.has(r.instrument_name)) throw new FormatError(`instruments: ${r.instrument_name} listed twice`);
    inst.set(r.instrument_name, r);
  }
  const seen = new Set();
  const rows = [];
  for (const b of book) {
    if (!b || typeof b.instrument_name !== 'string') throw new FormatError('book summary: a row has no instrument_name');
    if (!('bid_price' in b) || !('ask_price' in b)) throw new FormatError(`book summary: ${b.instrument_name} has no bid_price/ask_price field`);
    for (const k of ['bid_price', 'ask_price']) {
      const v = b[k];
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) throw new FormatError(`book summary: ${b.instrument_name} ${k} is ${JSON.stringify(v)}`);
    }
    if (seen.has(b.instrument_name)) throw new FormatError(`book summary: ${b.instrument_name} listed twice`);
    seen.add(b.instrument_name);
    const i = inst.get(b.instrument_name);
    if (!i) continue; // only in the quote call: dropped
    rows.push({
      name: b.instrument_name,
      expMs: i.expiration_timestamp,
      strike: i.strike,
      type: i.option_type === 'call' ? 'C' : 'P',
      bid: b.bid_price,
      ask: b.ask_price,
      underlying: typeof b.underlying_price === 'number' ? b.underlying_price : null,
    });
  }
  return rows;
}

/** Minutes from the snapshot to an expiry: integer µs difference, floored once. */
export const minutesTo = (expMs, usOut) => Math.floor((expMs * 1000 - usOut) / 60000000);

/** bid > 0 and ask > bid; a missing (null) bid or ask is invalid. */
export const isValid = (bid, ask) => typeof bid === 'number' && typeof ask === 'number' && bid > 0 && ask > bid;

/** The near and next expiries (ms) around the constant maturity, or null. */
export function pickTerms(expiries, usOut, cm) {
  let near = null;
  let next = null;
  for (const e of [...new Set(expiries)].sort((a, b) => a - b)) {
    const M = minutesTo(e, usOut);
    if (M < 1) continue;
    if (M <= cm) near = { expMs: e, M };
    else if (!next) next = { expMs: e, M };
  }
  return near && next ? { near, next } : null;
}

/**
 * The core sum, written on dollar values at expiry so that the same function
 * takes a dollar-quote adapter (Q~ = e^{RT} x mid) or the BTC-quote adapter
 * (Q~ = q x F). `strikes` ascending (the selected set), `Qt` the matching
 * values. sigma^2 = (2/T) * sum (dK/K^2) * Q~ - (1/T) * (F/K0 - 1)^2.
 */
export function termVariance({ strikes, Qt, F, K0, T }) {
  const n = strikes.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const K = strikes[i];
    const dK = i === 0 ? strikes[1] - strikes[0] : i === n - 1 ? strikes[n - 1] - strikes[n - 2] : (strikes[i + 1] - strikes[i - 1]) / 2;
    sum = sum + (dK / (K * K)) * Qt[i];
  }
  const x = F / K0 - 1;
  return (2 / T) * sum - (1 / T) * (x * x);
}

/** 30-day variance from the two terms, evaluated in the written order. */
export function interpolate({ M1, s1, M2, s2, cm, ym }) {
  const T1 = M1 / ym;
  const T2 = M2 / ym;
  return (((T1 * s1 * (M2 - cm)) / (M2 - M1) + (T2 * s2 * (cm - M1)) / (M2 - M1)) * ym) / cm;
}

/**
 * One term from its rows. Returns {term, fail} — term holds the fields obtained
 * so far (key order fixed); fail is a reason or null.
 */
export function computeTerm(role, expMs, M, rows, { ym, cutoff }) {
  const term = { role, expiry: new Date(expMs).toISOString(), minutes: M };
  const byStrike = new Map();
  for (const r of rows) {
    const s = byStrike.get(r.strike) ?? {};
    s[r.type] = r;
    byStrike.set(r.strike, s);
  }
  const ladder = [...byStrike.keys()].filter((k) => byStrike.get(k).C && byStrike.get(k).P).sort((a, b) => a - b);
  const mid = (r) => (r.bid + r.ask) / 2;
  const ok = (r) => isValid(r.bid, r.ask);
  const finish = (fail, extra = {}) => ({ term: { ...term, ...extra }, fail });

  // K*: min |c - p| over strikes with both quotes valid; tie → lower strike.
  let kStar = null;
  let best = Infinity;
  for (const k of ladder) {
    const { C, P } = byStrike.get(k);
    if (!ok(C) || !ok(P)) continue;
    const d = Math.abs(mid(C) - mid(P));
    if (d < best) {
      best = d;
      kStar = k;
    }
  }
  const exch = (k) => (k != null ? byStrike.get(k).C.underlying : null);
  if (kStar == null) return finish('no-atm-pair', { exchangeForward: null });
  const cS = mid(byStrike.get(kStar).C);
  const pS = mid(byStrike.get(kStar).P);
  const den = 1 - (cS - pS);
  term.atm = kStar;
  // c* - p* >= 1 BTC: K* / (1 - (c* - p*)) is no forward (infinite or negative)
  if (!(den > 0)) return finish('k0-quote-invalid', { exchangeForward: exch(kStar) });
  const F = kStar / den;
  term.forward = F;

  let i0 = -1;
  for (let i = 0; i < ladder.length; i++) if (ladder[i] <= F) i0 = i;
  if (i0 < 0) return finish('k0-quote-invalid', { exchangeForward: exch(kStar) });
  const K0 = ladder[i0];
  term.k0 = K0;
  const at0 = byStrike.get(K0);
  if (!ok(at0.C) || !ok(at0.P)) return finish('k0-quote-invalid', { exchangeForward: exch(kStar) });

  const walk = (dir, type) => {
    const used = [];
    let run = 0;
    for (let i = i0 + dir; i >= 0 && i < ladder.length; i += dir) {
      const r = byStrike.get(ladder[i])[type];
      if (ok(r)) {
        used.push({ K: ladder[i], q: mid(r) });
        run = 0;
      } else if (++run >= cutoff) break;
    }
    return used;
  };
  const puts = walk(-1, 'P').reverse();
  const calls = walk(1, 'C');
  term.putsUsed = puts.length;
  term.callsUsed = calls.length;
  if (puts.length === 0) return finish('no-otm-puts', { exchangeForward: exch(kStar) });
  if (calls.length === 0) return finish('no-otm-calls', { exchangeForward: exch(kStar) });

  const sel = [...puts, { K: K0, q: (mid(at0.C) + mid(at0.P)) / 2 }, ...calls];
  const variance = termVariance({ strikes: sel.map((s) => s.K), Qt: sel.map((s) => s.q * F), F, K0, T: M / ym });
  term.variance = variance;
  return finish(variance > 0 ? null : 'non-positive-variance', { exchangeForward: exch(kStar) });
}

/**
 * The whole computation for one snapshot. Both terms are computed as far as
 * each gets; the reason is the near term's failure if any, else the next
 * term's, else a non-positive V30.
 * Returns {value, variance30, reason, terms, quotes}.
 */
export function computeImplied(rows, usOut, { cm, ym, cutoff }) {
  const pick = pickTerms(rows.map((r) => r.expMs), usOut, cm);
  if (!pick) return { value: null, variance30: null, reason: 'no-bracket', terms: [], quotes: [] };
  const terms = [];
  const fails = [];
  const quotes = [];
  for (const [role, t] of [['near', pick.near], ['next', pick.next]]) {
    const tr = rows.filter((r) => r.expMs === t.expMs);
    const { term, fail } = computeTerm(role, t.expMs, t.M, tr, { ym, cutoff });
    terms.push(term);
    fails.push(fail);
    const sorted = [...tr].sort((a, b) => a.strike - b.strike || (a.type === b.type ? 0 : a.type === 'C' ? -1 : 1));
    for (const r of sorted) quotes.push([role, r.strike, r.type, r.bid, r.ask]);
  }
  const fail = fails[0] ?? fails[1];
  if (fail) return { value: null, variance30: null, reason: fail, terms, quotes };
  const v30 = interpolate({ M1: terms[0].minutes, s1: terms[0].variance, M2: terms[1].minutes, s2: terms[1].variance, cm, ym });
  if (!(v30 > 0)) return { value: null, variance30: null, reason: 'non-positive-variance', terms, quotes };
  return { value: Math.round(100 * Math.sqrt(v30) * 100) / 100, variance30: v30, reason: null, terms, quotes };
}

/**
 * Every expiry of the joined instruments (both calls), ascending, as ISO
 * strings — the candidates the expiry choice is made from (expiries with
 * M < 1 included; the choice skips them).
 */
export const expiryList = (rows) => [...new Set(rows.map((r) => r.expMs))].sort((a, b) => a - b).map((e) => new Date(e).toISOString());

/** The sha256 a hashed line carries in place of the quotes: sha256(JSON.stringify(quotes)). */
export const quotesSha256 = (quotes) => sha256(JSON.stringify(quotes));

/**
 * An implied line in the fixed key order. quotesMode 'embed' carries the
 * quotes and each term's exchangeForward; 'hash' carries quotesSha256 instead
 * and no exchangeForward. snapshot.expiries (expiryList) is in both.
 */
export function buildImpliedLine(p) {
  if (!Array.isArray(p.expiries)) throw new Error('buildImpliedLine: expiries (expiryList of the joined rows) is required');
  const at = new Date(Math.floor(p.usOut / 1000)).toISOString();
  const date = at.slice(0, 10);
  const terms = p.result.terms.map((t) => {
    if (p.quotesMode === 'embed') return t;
    const { exchangeForward, ...rest } = t;
    return rest;
  });
  const line = {
    seq: p.prev ? p.prev.seq + 1 : 0,
    date,
    observedAt: p.observedAt,
    index: SERIES,
    value: p.result.value,
    variance30: p.result.variance30,
    ...(p.result.value == null ? { reason: p.result.reason } : {}),
    snapshot: { at, usOut: p.usOut, host: p.host, rows: p.rows, expiries: p.expiries, rawSha256: { instruments: p.rawSha256.instruments, bookSummary: p.rawSha256.bookSummary } },
    terms,
    ...(p.quotesMode === 'embed' ? { quotes: p.result.quotes } : { quotesSha256: quotesSha256(p.result.quotes) }),
    rule: p.rule,
    keeper: { lagSeconds: Math.floor((Math.floor(p.usOut / 1000) - Date.parse(`${date}T00:00:00Z`)) / 1000), run: p.run },
    ...(p.shadow ? { shadow: true } : {}),
    ...(p.inception ? { inception: p.inception } : {}),
    prevHash: p.prev ? p.prev.hash : null,
  };
  line.hash = sha256(JSON.stringify(line));
  return line;
}
