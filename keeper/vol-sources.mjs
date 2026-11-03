/**
 * BTC volatility index (working name) — data sources. Fetching only; no
 * computation. Read-only public endpoints, no key:
 *   Binance spot   GET /api/v3/time, GET /api/v3/klines (1-minute bars)
 *   Deribit        GET /api/v2/public/get_instruments, get_book_summary_by_currency
 * and the offline bar files of --offline. No other host stands in for either.
 *
 * Retries: at most 3 attempts per call, waiting 2 s then 4 s, on a network
 * error, a time-out, HTTP 429 or 5xx. Binance calls are spaced at least 250 ms
 * apart. One attempt (request and body) is given at most 30 s.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseKlines, parseOfflineLine, checkDayMinutes, dayMs, MINUTE_MS, DAY_MS, stamp } from './vol-realized.mjs';

export const RETRY_WAITS_MS = [2000, 4000];
export const BINANCE_SPACING_MS = 250;
export const FETCH_TIMEOUT_MS = 30000;

const retryable = (e) =>
  e?.retry === true || e?.name === 'TimeoutError' || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(String(e?.message));

async function withRetry(fn, wait) {
  let last;
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!retryable(e) || attempt === RETRY_WAITS_MS.length) throw e;
      await wait(RETRY_WAITS_MS[attempt]);
    }
  }
  throw last;
}

async function getBytes(fetchImpl, url, timeoutMs) {
  // the signal also bounds reading the body
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status} from ${url.split('?')[0]}`), { retry: true });
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${url.split('?')[0]}: ${bytes.toString('utf8').slice(0, 200)}`), { status: r.status });
  return bytes;
}

/** Binance spot REST client (read-only, no key). */
export function binanceRest({ host, klinesPath = '/api/v3/klines', fetchImpl = globalThis.fetch, wait, clock = () => Date.now(), timeoutMs = FETCH_TIMEOUT_MS }) {
  let lastCall = -Infinity;
  async function getJSON(url) {
    return withRetry(async () => {
      const gap = lastCall + BINANCE_SPACING_MS - clock();
      if (gap > 0) await wait(gap);
      lastCall = clock();
      const bytes = await getBytes(fetchImpl, url, timeoutMs);
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error(`Binance answered non-JSON from ${url.split('?')[0]}`);
      }
    }, wait);
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
      return parseKlines(await getJSON(`${host}${klinesPath}?${q}`));
    },
  };
}

/** Has UTC day `day` ended on Binance? True when a 1-minute bar opening at or after the next 00:00 is closed. */
export async function binanceDayIsFinal(binance, symbol, day, serverTime) {
  const next = dayMs(day) + DAY_MS;
  const rows = await binance.klines(symbol, next, null, 1);
  return rows.length > 0 && rows[0].openMs >= next && rows[0].closeMs < serverTime;
}

/** The closed 1-minute bars opening in [day 00:00, next 00:00), in two pages of at most 1,000. */
export async function binanceDayOnce(binance, symbol, day, serverTime) {
  const start = dayMs(day);
  const end = start + DAY_MS;
  const rows = [];
  for (let s = start; s < end; s += 1000 * MINUTE_MS) {
    const e = Math.min(s + 1000 * MINUTE_MS, end) - 1;
    rows.push(...(await binance.klines(symbol, s, e, 1000)));
  }
  const inDay = rows.filter((m) => m.openMs >= start && m.openMs < end && m.closeMs < serverTime);
  checkDayMinutes(inDay, day);
  return inDay;
}

/**
 * Offline bars: <dir>/btcusdt-1m-<YYYY-MM-DD>.csv (the symbol in lower case),
 * one UTC day per file, one line "openTimeMs,open,high,low,close" (values as
 * the source wrote them), opening time ascending, no header. null when the
 * file does not exist (the day is not there yet); [] for a file with no line
 * (a day with no bar).
 */
export function offlineDay(dir, symbol, day) {
  const f = path.join(dir, `${symbol.toLowerCase()}-1m-${day}.csv`);
  if (!fs.existsSync(f)) return null;
  const minutes = fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l)
    .map(parseOfflineLine);
  checkDayMinutes(minutes, day);
  return minutes;
}

/**
 * Has UTC day `day` ended, offline? The day's own file must exist, and a bar
 * opening at or after the next 00:00 must exist: the next day's file has a
 * line, or (that file being present but empty) a later file does. A missing
 * file ends the search: false (a day without a file is a day not there yet).
 */
export function offlineDayIsFinal(dir, symbol, day) {
  if (offlineDay(dir, symbol, day) == null) return false;
  for (let k = 1; k <= 31; k++) {
    const d = new Date(dayMs(day) + k * DAY_MS).toISOString().slice(0, 10);
    const m = offlineDay(dir, symbol, d);
    if (m == null) return false;
    if (m.length > 0) return true;
  }
  return false;
}

/** Deribit public REST client (read-only, no key). Returns raw bytes with the parsed JSON. */
export function deribitRest({ host, calls, fetchImpl = globalThis.fetch, wait, timeoutMs = FETCH_TIMEOUT_MS }) {
  async function get(pathq, what) {
    return withRetry(async () => {
      const bytes = await getBytes(fetchImpl, `${host}${pathq}`, timeoutMs);
      let json;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error(`Deribit ${what}: answer is not JSON`);
      }
      return { bytes, json };
    }, wait);
  }
  return {
    host: host.replace(/^https?:\/\//, ''),
    instruments: () => get(calls[0], 'get_instruments'),
    bookSummary: () => get(calls[1], 'get_book_summary_by_currency'),
  };
}

export { stamp };
