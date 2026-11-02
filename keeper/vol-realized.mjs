/**
 * BTC volatility index (working name) — realized line, pure functions.
 *
 * No network, no files, no clock. keeper/vol-index.mjs does the fetching and
 * writing; scripts/verify-vol.mjs recomputes the same lines without importing
 * this file.
 *
 * Definition (draft, not in force — docs/vol-index.md):
 *   C_d        = close of UTC day d = close of the 1-minute bar that opened
 *                latest that day (d 00:00 <= open < d+1 00:00; normally 23:59)
 *   r_d        = ln(C_d / C_{d-1})
 *   variance(D)= (365 / 30) x sum of r_d^2, d = D-30 … D-1 (30 returns, 31 closes)
 *   value(D)   = 100 x sqrt(variance(D)), rounded to two decimals
 * The mean is taken as zero. The denominator is always the window length. A
 * UTC day with no bar at all has no close (null in the line's window); for the
 * computation its close is the previous close (return 0), so the next return
 * spans both days. Evaluation order, in binary64:
 *   1. C_d = Number(close)   2. r_d = ln(C_d / C_{d-1})
 *   3. S = 0; S = S + r_d * r_d in ascending date order
 *   4. variance = (365 / 30) * S   5. x = 100 * sqrt(variance)
 *   6. published value = floor(x * 100 + 0.5) / 100 (half up, never half to even)
 */
import crypto from 'node:crypto';

export const SERIES = 'volbtc-realized';
export const MINUTE_MS = 60_000;
export const DAY_MIN = 1440;
export const DAY_MS = DAY_MIN * MINUTE_MS;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const dayMs = (date) => Date.parse(`${date}T00:00:00Z`);
export const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, n) => dateOf(dayMs(date) + n * DAY_MS);
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayMs(s)) && dateOf(dayMs(s)) === s;
export const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
export const stamp = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Half up on y (never half to even): n = floor(y + 0.5). */
export const halfUp = (y) => Math.floor(y + 0.5);
/** Two decimals, half up (x is never negative here): y = x * 100, n = halfUp(y), n / 100. */
export const r2 = (x) => halfUp(x * 100) / 100;

/**
 * Binance kline rows → minutes {openMs, closeMs, o, h, l, c} (Numbers). A time
 * of 10^15 or more is microseconds. Throws on a malformed row.
 */
export function parseKlines(raw) {
  if (!Array.isArray(raw)) throw new Error(`klines: expected an array, got ${typeof raw}`);
  return raw.map((r) => {
    if (!Array.isArray(r) || r.length < 7) throw new Error(`klines: malformed row ${JSON.stringify(r).slice(0, 120)}`);
    let openMs = Number(r[0]);
    let closeMs = Number(r[6]);
    if (openMs >= 1e15) openMs = Math.floor(openMs / 1000);
    if (closeMs >= 1e15) closeMs = Math.floor(closeMs / 1000);
    return minuteFrom(openMs, closeMs, r[1], r[2], r[3], r[4]);
  });
}

/** One offline CSV line "openTimeMs,open,high,low,close" → a minute (closeMs = open + 59,999). */
export function parseOfflineLine(line) {
  const f = line.split(',');
  if (f.length !== 5) throw new Error(`offline bars: expected 5 fields, got ${f.length} in "${line.slice(0, 80)}"`);
  const openMs = Number(f[0]);
  return minuteFrom(openMs, openMs + MINUTE_MS - 1, f[1], f[2], f[3], f[4]);
}

function minuteFrom(openMs, closeMs, o0, h0, l0, c0) {
  const [o, h, l, c] = [o0, h0, l0, c0].map(Number);
  if (!Number.isInteger(openMs) || openMs % MINUTE_MS !== 0) throw new Error(`bars: open time ${openMs} is not on the minute grid`);
  if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) throw new Error(`bars: non-positive or missing price at ${stamp(openMs)}`);
  if (!(l <= Math.min(o, c) && Math.max(o, c) <= h)) throw new Error(`bars: inconsistent bar at ${stamp(openMs)} (o ${o} h ${h} l ${l} c ${c})`);
  return { openMs, closeMs, o, h, l, c };
}

/** Throws unless the minutes open inside UTC day `day`, strictly ascending. */
export function checkDayMinutes(minutes, day) {
  const start = dayMs(day);
  const end = start + DAY_MS;
  for (let i = 0; i < minutes.length; i++) {
    const t = minutes[i].openMs;
    if (t < start || t >= end) throw new Error(`bars: ${stamp(t)} is outside ${day}`);
    if (i > 0 && t <= minutes[i - 1].openMs) throw new Error(`bars: out of order or repeated at ${stamp(t)}`);
  }
}

/**
 * The canonical text of a day's 1-minute bars, whose sha256 a line records:
 * one line per minute, `${openTimeMs},${String(Number(o))},…,${String(Number(c))}\n`.
 * The same value written with other digits gives the same text.
 */
export function canonicalMinuteText(minutes) {
  let s = '';
  for (const m of minutes) s += `${m.openMs},${String(Number(m.o))},${String(Number(m.h))},${String(Number(m.l))},${String(Number(m.c))}\n`;
  return s;
}

/** Missing minutes of a day: [{from: "HH:MM", to: "HH:MM", minutes}] (both ends are missing minutes). */
export function minuteGaps(minutes, day) {
  const start = dayMs(day);
  const present = new Set(minutes.map((m) => m.openMs));
  const gaps = [];
  let run = null;
  for (let k = 0; k < DAY_MIN; k++) {
    const t = start + k * MINUTE_MS;
    if (!present.has(t)) {
      if (!run) run = { from: t, to: t, minutes: 0 };
      run.to = t;
      run.minutes++;
    } else if (run) {
      gaps.push(run);
      run = null;
    }
  }
  if (run) gaps.push(run);
  return gaps.map((g) => ({ from: hhmm(g.from), to: hhmm(g.to), minutes: g.minutes }));
}

/**
 * A day's close: the close of the 1-minute bar that opened latest that day
 * (normally 23:59); lastBar = that bar's open time "HH:MM". {close: null,
 * lastBar: null} for a day with no bar.
 */
export function dayClose(minutes) {
  let last = null;
  for (const m of minutes) if (!last || m.openMs > last.openMs) last = m;
  return last ? { close: last.c, lastBar: hhmm(last.openMs) } : { close: null, lastBar: null };
}

/**
 * Value from a window of closes [[date, close|null] × (windowDays + 1)], dates
 * ascending; `carried` = [date, close] stands in for a null first close.
 * Returns {variance, value, returns} — returns = days D-30 … D-1 with a close.
 */
export function realizedFromWindow(window, carried, { windowDays, yearDays }) {
  if (!Array.isArray(window) || window.length !== windowDays + 1) throw new Error(`window: expected ${windowDays + 1} closes, got ${window?.length}`);
  let prev = window[0][1] ?? (carried ? carried[1] : null);
  if (!(typeof prev === 'number' && prev > 0)) throw new Error('window: no first close (and nothing carried from before the window)');
  let S = 0;
  let returns = 0;
  for (let i = 1; i < window.length; i++) {
    const c = window[i][1];
    if (c != null) returns++;
    const cur = c == null ? prev : c;
    const r = Math.log(cur / prev);
    S = S + r * r;
    prev = cur;
  }
  const variance = (yearDays / windowDays) * S;
  const value = r2(100 * Math.sqrt(variance));
  return { variance, value, returns };
}

/** The window dates of line D: D-(windowDays+1) … D-1. */
export function windowDates(date, windowDays) {
  const out = [];
  for (let k = windowDays + 1; k >= 1; k--) out.push(addDays(date, -k));
  return out;
}

/**
 * A realized line in the fixed key order (the hash depends on it). Optional
 * fields are present only when they apply.
 */
export function buildRealizedLine(p) {
  const line = {
    seq: p.prev ? p.prev.seq + 1 : 0,
    date: p.date,
    observedAt: p.observedAt,
    index: SERIES,
    value: p.value,
    variance: p.variance,
    ...(p.observedAt.slice(0, 10) > p.date ? { late: true } : {}),
    window: p.window,
    ...(p.window[0][1] == null ? { carriedFrom: p.carriedFrom } : {}),
    returns: p.returns,
    source: p.source,
    ...(p.sources ? { sources: p.sources } : {}),
    ...(p.gaps ? { gaps: p.gaps, gapAccepted: p.gapAccepted } : {}),
    rule: p.rule,
    keeper: { lagSeconds: Math.floor((Date.parse(p.observedAt) - dayMs(p.date)) / 1000), run: p.run },
    ...(p.shadow ? { shadow: true } : {}),
    ...(p.inception ? { inception: p.inception } : {}),
    prevHash: p.prev ? p.prev.hash : null,
  };
  line.hash = sha256(JSON.stringify(line));
  return line;
}
