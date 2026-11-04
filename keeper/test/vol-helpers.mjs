/**
 * Test helpers for the BTC volatility index (working name). Everything here is
 * SYNTHETIC — generated closes, 1-minute bars and option tables — never market
 * data. Fake Binance / Deribit servers answer the keeper's calls in-process
 * (no network).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.join(KEEPER, '..');
export const DAY_MS = 86_400_000;
export const MIN_MS = 60_000;
export const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
export const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => dateOf(dayMs(d) + n * DAY_MS);

// every scratch folder a test makes is removed when the test process exits
const made = [];
process.on('exit', () => {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // nothing to do: a folder that cannot be removed stays in the temp directory
    }
  }
});

export function tmpDir(tag = 'vol') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-test-`));
  made.push(d);
  return d;
}

/** A line's rulebook file in the repository. */
export const rulebookPath = (line) => path.join(KEEPER, 'rulebooks', line === 'realized' ? 'qvol.json' : `volbtc-${line}.json`);

/**
 * A scratch repository root holding the implied rulebook with "active": true.
 * The implied line is off in the repository (active false); its code is tested
 * from this root, with the repository's values otherwise unchanged.
 */
export function impliedOnRoot() {
  const root = tmpDir('vol-implied-on');
  const rb = JSON.parse(fs.readFileSync(rulebookPath('implied'), 'utf8'));
  rb.active = true;
  fs.mkdirSync(path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', 'volbtc-implied.json'), JSON.stringify(rb, null, 2) + '\n');
  return root;
}

export const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

// ------------------------------------------------------------ closes / bars

/** A deterministic synthetic close series (two decimals), n values. */
export function syntheticCloses(n, start = 60000) {
  const out = [];
  for (let k = 0; k < n; k++) out.push(Math.round(start * Math.exp(0.04 * Math.sin(k * 1.7) + 0.002 * k) * 100) / 100);
  return out;
}

/**
 * Synthetic 1-minute bars of one UTC day: a path from prevClose to close with
 * a small wiggle; the 23:59 minute closes at `close` exactly. `drop` = minute
 * indexes (0 … 1439) to leave out. Prices have two decimals.
 */
export function dayMinutes(day, prevClose, close, drop = new Set()) {
  const start = dayMs(day);
  const out = [];
  let o = prevClose;
  for (let k = 0; k < 1440; k++) {
    const f = (k + 1) / 1440;
    const c = k === 1439 ? close : Math.round((prevClose + (close - prevClose) * f) * (1 + 0.002 * Math.sin(k / 37)) * 100) / 100;
    if (!drop.has(k)) out.push({ openMs: start + k * MIN_MS, o, h: Math.max(o, c), l: Math.min(o, c), c });
    o = c;
  }
  return out;
}

/** {day: minutes[]} for `n` consecutive days from `first`, with closes from syntheticCloses (index 0 = the day before `first`). */
export function syntheticDays(first, n, { drop = {}, empty = new Set() } = {}) {
  const closes = syntheticCloses(n + 1);
  const days = {};
  for (let k = 0; k < n; k++) {
    const d = addDays(first, k);
    days[d] = empty.has(d) ? [] : dayMinutes(d, closes[k], closes[k + 1], drop[d] ?? new Set());
  }
  return { days, closes };
}

/** Writes the --offline files: <dir>/btcusdt-1m-<day>.csv. */
export function writeOffline(dir, days) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [d, mins] of Object.entries(days)) {
    fs.writeFileSync(path.join(dir, `btcusdt-1m-${d}.csv`), mins.map((m) => `${m.openMs},${m.o},${m.h},${m.l},${m.c}`).join('\n') + (mins.length ? '\n' : ''));
  }
}

const klineRow = (m) => [m.openMs, m.o.toFixed(8), m.h.toFixed(8), m.l.toFixed(8), m.c.toFixed(8), '1.00000000', m.openMs + MIN_MS - 1, '1.0', 1, '0.5', '0.5', '0'];

/**
 * A fake Binance spot REST server. `serverTime` (ms); bars with closeTime >=
 * serverTime are returned like Binance's in-progress bar. `tamper(callNo, rows)`
 * may change an answer. Returns {fetch, calls}.
 */
export function fakeBinance(days, serverTime, { tamper } = {}) {
  const all = Object.values(days).flat().sort((a, b) => a.openMs - b.openMs);
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/api/v3/time') return new Response(JSON.stringify({ serverTime }), { status: 200 });
    if (u.pathname === '/api/v3/klines') {
      const s = Number(u.searchParams.get('startTime'));
      const e = u.searchParams.has('endTime') ? Number(u.searchParams.get('endTime')) : Infinity;
      const lim = Number(u.searchParams.get('limit'));
      let rows = all.filter((m) => m.openMs >= s && m.openMs <= e && m.openMs <= serverTime).slice(0, lim).map(klineRow);
      if (tamper) rows = tamper(calls.length, rows) ?? rows;
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

// ------------------------------------------------------------ option tables

/** Standard normal CDF (Hart 1968 / West 2005 double-precision form). */
export function normCdf(x) {
  const a = Math.abs(x);
  let c;
  if (a > 37) c = 0;
  else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * a + 1.75566716318264;
      b = b * a + 16.064177579207;
      b = b * a + 86.7807322029461;
      b = b * a + 296.564248779674;
      b = b * a + 637.333633378831;
      b = b * a + 793.826512519948;
      b = b * a + 440.413735824752;
      c = c / b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Black-76, undiscounted (dollar value at expiry). */
export function black76(F, K, T, sigma) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + (v * v) / 2) / v;
  const d2 = d1 - v;
  return { call: F * normCdf(d1) - K * normCdf(d2), put: K * normCdf(-d2) - F * normCdf(-d1) };
}

/**
 * A synthetic Deribit-shaped table: flat
 * volatility sigma, strikes F x 0.2 … 5 every F x 0.1%, expiries `days` after
 * the snapshot; BTC price q = Black-76 dollar value / F, bid = q - h, ask =
 * q + h, h = min(1e-6, q / 2). usOut is a whole millisecond.
 */
export function syntheticTable({ F = 60000, sigma = 0.6, days = [20, 40], usOut = 4102444800000000 } = {}) {
  const snapMs = Math.floor(usOut / 1000);
  const instruments = [];
  const book = [];
  for (const dd of days) {
    const exp = snapMs + dd * DAY_MS;
    const T = (dd * 1440) / 525600;
    const step = F * 0.001;
    for (let k = Math.round(F * 0.2); k <= F * 5 + 1e-9; k += step) {
      const K = Math.round(k);
      const { call, put } = black76(F, K, T, sigma);
      for (const [type, val] of [['call', call], ['put', put]]) {
        const name = `BTC-SYN${dd}D-${K}-${type === 'call' ? 'C' : 'P'}`;
        const q = Math.max(val, 0) / F;
        const h = Math.min(1e-6, q / 2);
        instruments.push({ instrument_name: name, expiration_timestamp: exp, strike: K, option_type: type, kind: 'option', quote_currency: 'BTC' });
        book.push({ instrument_name: name, bid_price: q > 0 ? q - h : null, ask_price: q > 0 ? q + h : null, underlying_price: F });
      }
    }
  }
  return { instruments, book, usOut };
}

/**
 * A small hand-made table: `terms` = [{days, F?, rows: [[strike, callBid, callAsk, putBid, putAsk], …]}]
 * (null = no quote; a row with call = undefined lists only the put, and the
 * reverse). Returns {instruments, book, usOut}.
 */
export function handTable(terms, usOut = 4102444800000000, { minutes } = {}) {
  const snapMs = Math.floor(usOut / 1000); // expiries are whole milliseconds, like Deribit's
  const instruments = [];
  const book = [];
  terms.forEach((t, i) => {
    const exp = t.expMs ?? (minutes ? snapMs + minutes[i] * MIN_MS : snapMs + t.days * DAY_MS);
    for (const [K, cb, ca, pb, pa] of t.rows) {
      for (const [type, bid, ask] of [['call', cb, ca], ['put', pb, pa]]) {
        if (bid === undefined) continue;
        const name = `BTC-T${i}-${K}-${type === 'call' ? 'C' : 'P'}`;
        instruments.push({ instrument_name: name, expiration_timestamp: exp, strike: K, option_type: type, kind: 'option', quote_currency: 'BTC' });
        book.push({ instrument_name: name, bid_price: bid, ask_price: ask, underlying_price: t.F ?? 100 });
      }
    }
  });
  return { instruments, book, usOut };
}

/** A fake Deribit public REST server for one table. `breakWith` replaces an answer. Returns {fetch, calls}. */
export function fakeDeribit({ instruments, book, usOut }, { breakWith } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const name = u.pathname.split('/').pop();
    if (breakWith?.[name]) return breakWith[name]();
    const result = name === 'get_instruments' ? instruments : name === 'get_book_summary_by_currency' ? book : null;
    if (!result) return new Response('{}', { status: 404 });
    const us = name === 'get_book_summary_by_currency' ? usOut : usOut - 5000;
    return new Response(JSON.stringify({ jsonrpc: '2.0', result, usIn: us - 200, usOut: us, usDiff: 200, testnet: false }), { status: 200 });
  };
  return { fetch, calls };
}

/** Writes a table as the two saved raw responses (gz) for --from-snapshot / --instruments. */
export function writeSnapshot(dir, { instruments, book, usOut }) {
  fs.mkdirSync(dir, { recursive: true });
  const inst = path.join(dir, 'inst.json.gz');
  const bk = path.join(dir, 'book.json.gz');
  fs.writeFileSync(inst, zlib.gzipSync(JSON.stringify({ jsonrpc: '2.0', result: instruments, usIn: usOut - 5200, usOut: usOut - 5000, usDiff: 200, testnet: false })));
  fs.writeFileSync(bk, zlib.gzipSync(JSON.stringify({ jsonrpc: '2.0', result: book, usIn: usOut - 200, usOut, usDiff: 200, testnet: false })));
  return { inst, book: bk };
}

/** Runs the CLI in-process with captured output. */
export async function cli(run, argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, { log: (m) => out.push(String(m)), err: (m) => err.push(String(m)), wait: async () => {}, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A line without the fields that depend on when it was written. */
export function timeless(line) {
  const { observedAt, late, keeper, hash, prevHash, ...rest } = line;
  if (rest.source) rest.source = { ...rest.source, fetchedAt: null };
  return rest;
}
