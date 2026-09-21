/**
 * Paper-index keeper for qREV (Revenue Index) and qDEFI (DeFi Index).
 *
 * These are RULES-ONLY index levels: no vault, no capital, not in force until
 * an owner decision anchors an inception date (keeper/rulebooks/{index}.json
 * `inception` is null until then). This script computes what the index level
 * WOULD be, daily, so a track record exists before any money follows it —
 * same "pipeline before capital" posture as scripts/track-record.mjs.
 *
 * Two indexes, two rulebooks (keeper/rulebooks/qrev.json, qdefi.json), two
 * independent record chains (trackrecord/record-{index}.jsonl). Never
 * concatenated, never backfilled — a day the run misses is simply absent.
 *
 * Reconstitution is QUARTERLY (first run after 00:00 UTC on Jan/Apr/Jul/Oct
 * 1st). Between reconstitutions there is no trading and no drift band: the
 * book is only marked to market. See keeper/rulebooks/*.json for every
 * parameter as data, and docs/paper-index.md for the full write-up.
 *
 * Usage:
 *   node keeper/paper-index.mjs --index qrev  --dry-run
 *   node keeper/paper-index.mjs --index qdefi --dry-run
 *   node keeper/paper-index.mjs --index qrev             # writes trackrecord/
 *   KEEPER_PK=0x... node keeper/paper-index.mjs --index qrev --anchor
 *
 * --dry-run writes to keeper/dryrun/{state,record,anchors}-{index}.* instead
 * of keeper/state-{index}.json / trackrecord/{record,anchors}-{index}.jsonl,
 * and (unlike the real path) does not de-duplicate by date, so it can be run
 * more than once in a single day to exercise both the reconstitution and the
 * mark-to-market code paths.
 *
 * --anchor mirrors scripts/track-record.mjs's anchor step exactly (GIWA
 * Sepolia, self-send, calldata-as-commitment) but with prefix `qxpi-{index}:`
 * instead of `qxtr:`. It is a genuine no-op — skipped with a clear log line —
 * whenever KEEPER_PK is not set, in dry-run or otherwise.
 *
 * Basket marking (2026-09-16, keeper/basket-mark.mjs): a rulebook whose
 * `basket` block names a deployed QuadrixBasketVault makes the run, after the
 * record is written, post navPerShare and every constituent's reference price
 * to that vault (band-stepped) and, on a reconstitution day, write
 * keeper/pending-registry-{index}.json with the registry change it would
 * announce. `--index qx20` runs ONLY that leg for qX20: its book is
 * keeper/state.json (written by update-nav.mjs, which keeps marking the
 * NAV-tracker vault and is not changed); no record line, no anchor.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { markBasket } from './basket-mark.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CACHE_DIR = path.join(HERE, 'cache');
const DRYRUN_DIR = path.join(HERE, 'dryrun');
const TRACKRECORD_DIR = path.join(ROOT, 'trackrecord');

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(DRYRUN_DIR, { recursive: true });

// --------------------------------------------------------------- CLI + args
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const INDEX = opt('--index', null);
if (!['qrev', 'qdefi', 'qx20'].includes(INDEX)) {
  console.error('usage: node keeper/paper-index.mjs --index qrev|qdefi|qx20 [--dry-run] [--anchor]');
  process.exit(2);
}
const DRY_RUN = flag('--dry-run');
const DO_ANCHOR = flag('--anchor');

const RULEBOOK = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', `${INDEX}.json`), 'utf8'));

const STATE_PATH = DRY_RUN
  ? path.join(DRYRUN_DIR, `state-${INDEX}.json`)
  : path.join(HERE, `state-${INDEX}.json`);
const RECORDS_PATH = DRY_RUN
  ? path.join(DRYRUN_DIR, `record-${INDEX}.jsonl`)
  : path.join(TRACKRECORD_DIR, `record-${INDEX}.jsonl`);
const ANCHORS_PATH = DRY_RUN
  ? path.join(DRYRUN_DIR, `anchors-${INDEX}.jsonl`)
  : path.join(TRACKRECORD_DIR, `anchors-${INDEX}.jsonl`);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** `ruby -e 'sleep N'` pacing, per instruction — never the shell `sleep`. Used
 *  only in front of CoinGecko calls that are not already cached, to stay
 *  inside the free-tier rate limit. */
function pace(seconds) {
  try {
    execFileSync('ruby', ['-e', `sleep ${seconds}`]);
  } catch {
    // ruby unavailable — fall back to a busy-wait-free JS sleep via Atomics
    const ms = seconds * 1000;
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(dateStr, days) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ caching
function cacheGet(key, ttlMs) {
  const p = path.join(CACHE_DIR, key);
  if (!fs.existsSync(p)) return null;
  const age = Date.now() - fs.statSync(p).mtimeMs;
  if (age > ttlMs) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function cacheSet(key, data) {
  fs.writeFileSync(path.join(CACHE_DIR, key), JSON.stringify(data));
}
/** ttlMs: how long a cached response is considered fresh. Historical
 *  (date-specific) responses are cached "forever" (10 years) since they never
 *  change; daily-changing ones (markets, categories, protocol lists) get a
 *  same-day TTL so a second dry-run in one session reuses them. */
const DAY = 24 * 60 * 60 * 1000;
const FOREVER = 3650 * DAY;

/** Retries a 429 (rate limit) with backoff — CoinGecko's free tier throttles
 *  hard on back-to-back calls (observed while testing both indexes
 *  sequentially with a cold cache). Any other non-OK status fails fast. */
async function fetchJSON(url, opts, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, opts);
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < retries) {
      pace(8 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${r.status} for ${url}`);
  }
}

// ------------------------------------------------------- market data (CG/CP)
let marketsSource = 'none';

/** CoinGecko coins/markets, paginated to top 500 (2 pages of 250 — the free
 *  tier's per_page ceiling). CoinPaprika fallback is PRICE ONLY (per spec):
 *  it cannot reconstruct market-cap rank well enough to drive a
 *  reconstitution, only to mark an already-held book. */
async function fetchCoinGeckoMarketsTop500(dateKey) {
  const key = `cg-markets-top500-${dateKey}.json`;
  const cached = cacheGet(key, DAY);
  if (cached) {
    marketsSource = 'coingecko (cached)';
    return cached;
  }
  try {
    const pages = [];
    for (const page of [1, 2]) {
      const url =
        'https://api.coingecko.com/api/v3/coins/markets' +
        `?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
      const raw = await fetchJSON(url);
      if (!Array.isArray(raw)) throw new Error('unexpected CoinGecko markets shape');
      pages.push(...raw);
      pace(2);
    }
    const rows = pages.map((c) => ({
      id: c.id,
      symbol: String(c.symbol).toUpperCase(),
      price: c.current_price,
      marketCap: c.market_cap,
      volume24h: c.total_volume,
      circulatingSupply: c.circulating_supply,
      athDate: c.ath_date,
      atlDate: c.atl_date,
    }));
    marketsSource = 'coingecko';
    cacheSet(key, rows);
    return rows;
  } catch (e) {
    console.warn(`CoinGecko markets fetch failed (${e.message}) — falling back to CoinPaprika for prices only`);
    const raw = await fetchJSON('https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=500');
    marketsSource = 'coinpaprika (price-only fallback)';
    const rows = raw.map((c) => ({
      id: c.id,
      symbol: String(c.symbol).toUpperCase(),
      price: c.quotes?.USD?.price,
      marketCap: c.quotes?.USD?.market_cap,
      volume24h: c.quotes?.USD?.volume_24h,
      circulatingSupply: null, // not usable for issuance math
      athDate: null,
      atlDate: null,
    }));
    return rows;
  }
}

/** First (highest-market-cap, since CG's own array is already cap-sorted)
 *  occurrence per symbol wins — a handful of tickers collide (e.g. multiple
 *  small tokens sharing a symbol) and the big name should win the slot. */
function bySymbol(rows) {
  const m = new Map();
  for (const r of rows) if (!m.has(r.symbol)) m.set(r.symbol, r);
  return m;
}

async function fetchCoinGeckoCategory(categoryId, dateKey) {
  const key = `cg-category-${categoryId}-${dateKey}.json`;
  const cached = cacheGet(key, DAY);
  if (cached) return cached;
  pace(5); // breathing room after whatever CoinGecko call preceded this one
  const rows = [];
  for (const page of [1, 2]) {
    const url =
      'https://api.coingecko.com/api/v3/coins/markets' +
      `?vs_currency=usd&category=${categoryId}&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
    const raw = await fetchJSON(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    rows.push(
      ...raw.map((c) => ({
        id: c.id,
        symbol: String(c.symbol).toUpperCase(),
        price: c.current_price,
        marketCap: c.market_cap,
        volume24h: c.total_volume,
        circulatingSupply: c.circulating_supply,
        athDate: c.ath_date,
        atlDate: c.atl_date,
      }))
    );
    pace(2);
  }
  cacheSet(key, rows);
  return rows;
}

/** market_cap / price at a past date, from CoinGecko's /history endpoint —
 *  which does NOT return circulating_supply directly (checked empirically,
 *  2026-09-15), only current_price/market_cap/total_volume. mcap/price is
 *  exactly the same proxy the Python backtest harness uses for its own
 *  point-in-time supply snapshots (qrev-backtest.py: `SUPPLY = mcap/price`),
 *  so this fallback is consistent with the reference implementation. */
async function coinGeckoHistoricalSupply(coingeckoId, dateStr) {
  const [y, m, d] = dateStr.split('-');
  const cgDate = `${d}-${m}-${y}`; // CoinGecko wants DD-MM-YYYY
  const key = `cg-history-${coingeckoId}-${dateStr}.json`;
  let data = cacheGet(key, FOREVER);
  if (!data) {
    // The free tier throttles hard right after a big paginated markets/
    // category pull. Pace BEFORE the call (not just after a success) and
    // retry once with a longer backoff on 429 before giving up.
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      pace(attempt === 0 ? 3 : 12);
      try {
        data = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${coingeckoId}/history?date=${cgDate}`);
        cacheSet(key, data);
      } catch (e) {
        if (attempt === 2) {
          console.warn(`  CoinGecko history fetch failed for ${coingeckoId} @ ${dateStr} (after ${attempt + 1} attempts): ${e.message}`);
          return null;
        }
      }
    }
  }
  const md = data?.market_data;
  if (!md?.current_price?.usd || !md?.market_cap?.usd) return null;
  return md.market_cap.usd / md.current_price.usd;
}

// -------------------------------------------------------------- DefiLlama
async function fetchDefiLlamaProtocols(dateKey) {
  const key = `defillama-protocols-${dateKey}.json`;
  const cached = cacheGet(key, DAY);
  if (cached) return cached;
  const data = await fetchJSON('https://api.llama.fi/protocols');
  cacheSet(key, data);
  return data;
}
async function fetchDefiLlamaChains(dateKey) {
  const key = `defillama-chains-${dateKey}.json`;
  const cached = cacheGet(key, DAY);
  if (cached) return cached;
  const data = await fetchJSON('https://api.llama.fi/chains');
  cacheSet(key, data);
  return data;
}
/** Per-protocol dailyHoldersRevenue series. Cached for the day — this is the
 *  one endpoint with NO fallback (rulebook §8: no substitute source exists
 *  for this definition), so a failure here drops that protocol's symbol for
 *  today's run rather than guessing. */
async function fetchDefiLlamaFeesSeries(slug, dateKey) {
  const key = `defillama-fees-${slug}-${dateKey}.json`;
  const cached = cacheGet(key, DAY);
  if (cached) return cached;
  try {
    const data = await fetchJSON(`https://api.llama.fi/summary/fees/${slug}?dataType=dailyHoldersRevenue`);
    const series = Array.isArray(data.totalDataChart) ? data.totalDataChart : [];
    cacheSet(key, series);
    return series;
  } catch (e) {
    console.warn(`  DefiLlama fees fetch failed for ${slug}: ${e.message}`);
    return null;
  }
}

function sumWindow(series, endDateStr, days) {
  const end = Date.parse(endDateStr + 'T00:00:00Z');
  const start = end - days * 86_400_000;
  let s = 0;
  for (const [ts, v] of series) {
    const t = ts * 1000;
    if (t >= start && t < end) s += Number(v) || 0;
  }
  return s;
}
/** Consecutive 30-day buckets ending at `endDateStr`, counted while positive
 *  — same bucketing as qrev-backtest.py's `months_positive` (30-day windows,
 *  not calendar months). */
function monthsPositive(series, endDateStr, maxMonths) {
  let n = 0;
  for (let k = 0; k < maxMonths; k++) {
    const bucketEnd = Date.parse(endDateStr + 'T00:00:00Z') - k * 30 * 86_400_000;
    const bucketStart = bucketEnd - 30 * 86_400_000;
    let s = 0;
    for (const [ts, v] of series) {
      const t = ts * 1000;
      if (t >= bucketStart && t < bucketEnd) s += Number(v) || 0;
    }
    if (s > 0) n++;
    else break;
  }
  return n;
}

// --------------------------------------------------------- shared exclusions
// Same universe carve-outs as keeper/update-nav.mjs's EXCLUDE (qX20 rulebook
// §3), which both qREV and qDEFI's rulebooks reference wholesale.
const QX20_EXCLUDE = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'FEI', 'TUSD', 'USDP', 'WBTC', 'LEO', 'TON',
  'OKB', 'OMG', 'LTC', 'XMR', 'DASH', 'ZEC', 'PIVX', 'XVG', 'KMD',
  'USDS', 'USDE', 'USD1', 'PYUSD', 'FDUSD', 'USDD', 'USDF', 'RLUSD', 'USDT0', 'USDG',
  'WETH', 'STETH', 'WSTETH', 'WEETH', 'WBETH', 'CBBTC', 'BSC-USD', 'JITOSOL',
  'SUSDE', 'SUSDS', 'BTCB', 'KHYPE', 'USDTB', 'BFUSD', 'SYRUPUSDC', 'PAXG',
  'WBT', 'BGB', 'GT', 'KCS', 'FIGR_HELOC', 'USYC', 'BUIDL',
]);
// qDEFI-specific additions (§3): LP/vault shares and staking derivatives whose
// underlying governance token is already a separate member.
const QDEFI_EXTRA_EXCLUDE = new Set([
  'JLP', 'BNSOL', 'MSOL', 'OSETH', 'STKAAVE', 'SENA', 'TBTC', 'CBXRP', 'CRVUSD',
]);

// ------------------------------------------------------------- cap function
/** Iterative proportional cap-and-redistribute — identical in shape to
 *  keeper/update-nav.mjs's applyCap. "Immediate trim" per the rulebook means
 *  this runs once at reconstitution with no drift corridor above the cap,
 *  not that the iteration itself is skipped. */
function applyCap(weights, cap) {
  const w = new Map(weights.map((x) => [x.symbol, x.weight]));
  cap = Math.max(cap, 1 / w.size);
  const capped = new Set();
  for (let i = 0; i < w.size; i++) {
    let excess = 0;
    for (const [s, v] of w) {
      if (!capped.has(s) && v > cap) {
        excess += v - cap;
        w.set(s, cap);
        capped.add(s);
      }
    }
    if (excess <= 0) break;
    const uncapped = [...w].reduce((t, [s, v]) => (capped.has(s) ? t : t + v), 0);
    if (uncapped <= 0) break;
    for (const [s, v] of w) if (!capped.has(s)) w.set(s, v + (v / uncapped) * excess);
  }
  return weights.map((x) => ({ symbol: x.symbol, weight: w.get(x.symbol) }));
}

// ----------------------------------------------------- rank-buffer membership
/** Same shape as update-nav.mjs's targetMembership, parameterised by the
 *  rulebook's entry/exit ranks and target count. */
function bufferedMembership(ranked, incumbents, entryMaxRank, exitMinRank, targetCount) {
  const rank = new Map(ranked.map((m, i) => [m.symbol, i + 1]));
  let members = incumbents.filter((s) => (rank.get(s) ?? Infinity) <= exitMinRank);
  for (const m of ranked.slice(0, entryMaxRank)) {
    if (!members.includes(m.symbol)) members.push(m.symbol);
  }
  if (members.length > targetCount) {
    members = members.sort((a, b) => rank.get(a) - rank.get(b)).slice(0, targetCount);
  }
  for (const m of ranked) {
    if (members.length >= targetCount) break;
    if (!members.includes(m.symbol)) members.push(m.symbol);
  }
  return members;
}

// =========================================================================
//  qREV — universe, eligibility, ranking, weighting
// =========================================================================
async function buildQrevUniverse(dateStr, markets) {
  const map = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', 'qrev-protocol-map.json'), 'utf8'));
  const marketsBySym = bySymbol(markets);

  // Group adapters by symbol. Rows with sym === '-' carry no ticker in this
  // snapshot of the map and are skipped (known gap — see docs/paper-index.md;
  // it affects Ethereum's, BSC's and a few other chain adapters, not any
  // protocol-token row). "CC" (Canton) is explicitly named in the rulebook as
  // having no liquid token (§12-4) and is dropped for the same reason even
  // though it does carry a symbol in the map.
  const bySym = new Map();
  for (const row of map) {
    if (row.sym === '-' || row.sym === 'CC') continue;
    if (!bySym.has(row.sym)) bySym.set(row.sym, []);
    bySym.get(row.sym).push(row);
  }

  const EXCLUDED_CATS = new Set(['Launchpad', 'Meme', 'Gamified Mining']);
  const protocolSymbols = [];
  const chainSymbols = [];
  for (const [sym, rows] of bySym) {
    if (QX20_EXCLUDE.has(sym)) continue;
    const cats = new Set(rows.map((r) => r.cat));
    const isChainToken = rows.every((r) => r.cat === 'Chain');
    if (isChainToken) {
      chainSymbols.push({ sym, slugs: rows.map((r) => r.slug) });
      continue;
    }
    // A symbol whose only adapters are all excluded categories is dropped
    // entirely; a symbol with a mix (e.g. CAKE: AMM + Prediction + Lottery)
    // keeps ALL its adapter revenue, matching the rulebook's own worked
    // example (§ D4 default: gambling-adapter revenue is summed in).
    const allExcluded = [...cats].every((c) => EXCLUDED_CATS.has(c));
    if (allExcluded) continue;
    protocolSymbols.push({ sym, slugs: rows.filter((r) => !EXCLUDED_CATS.has(r.cat) || cats.size > 1).map((r) => r.slug) });
  }

  async function fetchAggregatedSeries(slugs, dateKey) {
    const merged = new Map(); // day -> value
    let anyOk = false;
    for (const slug of slugs) {
      const series = await fetchDefiLlamaFeesSeries(slug, dateKey);
      if (series == null) continue;
      anyOk = true;
      for (const [ts, v] of series) merged.set(ts, (merged.get(ts) || 0) + (Number(v) || 0));
    }
    return anyOk ? [...merged.entries()].sort((a, b) => a[0] - b[0]) : null;
  }

  const dateKey = dateStr;
  const candidates = [];
  for (const { sym, slugs } of protocolSymbols) {
    const mkt = marketsBySym.get(sym);
    if (!mkt || !mkt.marketCap) continue; // not even priced — cannot evaluate
    const series = await fetchAggregatedSeries(slugs, dateKey);
    if (series == null) continue; // DefiLlama fetch failed for every adapter
    const hr12m = sumWindow(series, dateStr, 365);
    const hr30 = sumWindow(series, dateStr, 30);
    const posMonths = monthsPositive(series, dateStr, 12);
    candidates.push({ sym, mkt, hr12mGross: hr12m, hr30, posMonths, isChain: false, slugs });
  }
  for (const { sym, slugs } of chainSymbols) {
    const mkt = marketsBySym.get(sym);
    if (!mkt || !mkt.marketCap) continue;
    const series = await fetchAggregatedSeries(slugs, dateKey);
    if (series == null) continue;
    const hr12m = sumWindow(series, dateStr, 365); // gross burn/buyback, netted below
    const hr30 = sumWindow(series, dateStr, 30);
    const posMonths = monthsPositive(series, dateStr, 12);
    candidates.push({ sym, mkt, hr12mGross: hr12m, hr30, posMonths, isChain: true, slugs });
  }
  return candidates;
}

async function issuanceValue12m(sym, coingeckoId, priceNow, circulatingNow, dateStr, supplyRegistry, supplyWeekly) {
  const targetPast = daysBefore(dateStr, 365);
  const weekly = supplyWeekly[sym];
  if (weekly && Object.keys(weekly).length) {
    const dates = Object.keys(weekly).sort();
    const earliest = dates[0];
    if (earliest <= targetPast) {
      // nearest weekly date at or before targetPast (within 10 days)
      let best = null;
      for (const d of dates) {
        if (d <= targetPast) best = d;
        else break;
      }
      if (best && Math.abs(Date.parse(best) - Date.parse(targetPast)) <= 10 * DAY) {
        // Both endpoints must come from the same definition. The registry counts
        // voluntary lock-ups as issued; CoinGecko's circulating figure does not, so
        // mixing the two under-states issuance (AERO: registry 1.74B a year ago vs
        // CoinGecko 0.99B today → "zero issuance"). Use the registry's latest week
        // for s1 and only fall through to CoinGecko when the registry has no
        // recent point — then both endpoints come from CoinGecko.
        const latest = dates[dates.length - 1];
        if (Math.abs(Date.parse(dateStr) - Date.parse(latest)) <= 10 * DAY) {
          const s0 = weekly[best].circulating;
          const s1 = weekly[latest].circulating;
          if (s0 != null && s1 != null) {
            return { value: Math.max(0, s1 - s0) * priceNow, source: 'onchain-registry', s0, s1 };
          }
        }
      }
    }
  }
  // CoinGecko fallback: mcap/price at (today - 365d) approximates circulating
  // supply then (see coinGeckoHistoricalSupply doc comment).
  if (coingeckoId) {
    const s0 = await coinGeckoHistoricalSupply(coingeckoId, targetPast);
    const s1 = circulatingNow;
    if (s0 != null && s1 != null) {
      return { value: Math.max(0, s1 - s0) * priceNow, source: 'coingecko', s0, s1 };
    }
  }
  return { value: null, source: 'unavailable', s0: null, s1: circulatingNow };
}

function listingAgeDays(mkt, dateStr) {
  if (!mkt.athDate && !mkt.atlDate) return null;
  const dates = [mkt.athDate, mkt.atlDate].filter(Boolean).map((d) => Date.parse(d));
  const earliest = Math.min(...dates);
  return (Date.parse(dateStr + 'T00:00:00Z') - earliest) / 86_400_000;
}

async function computeQrevMembers(dateStr, markets, incumbents, onNotice) {
  const rb = RULEBOOK;
  const supplyRegistry = JSON.parse(fs.readFileSync(path.join(HERE, 'supply', 'registry.json'), 'utf8'));
  const supplyWeeklyRaw = JSON.parse(fs.readFileSync(path.join(HERE, 'supply', 'supply-weekly.json'), 'utf8'));
  const supplyWeekly = {};
  for (const [sym, byDate] of Object.entries(supplyWeeklyRaw)) {
    supplyWeekly[sym] = Object.fromEntries(Object.entries(byDate).map(([d, v]) => [d, { circulating: v.circulating }]));
  }

  const candidates = await buildQrevUniverse(dateStr, markets);
  const sourceStats = { defillamaOk: 0, defillamaFail: 0, issuanceOnchain: 0, issuanceCoingecko: 0, issuanceUnavailable: 0 };

  const evaluated = [];
  for (const c of candidates) {
    sourceStats.defillamaOk++;
    const gate = {};
    gate.mcapOk = c.mkt.marketCap >= rb.eligibility.minCirculatingMarketCapUSD;
    gate.volOk = (c.mkt.volume24h ?? 0) >= rb.eligibility.minVolume24hUSD;
    const age = listingAgeDays(c.mkt, dateStr);
    gate.ageOk = age == null ? false : age >= rb.eligibility.minListingAgeDays;

    const reg = supplyRegistry[c.sym];
    const issuance = await issuanceValue12m(
      c.sym,
      reg?.coingecko_id || null,
      c.mkt.price,
      c.mkt.circulatingSupply,
      dateStr,
      supplyRegistry,
      supplyWeekly
    );
    if (issuance.source === 'onchain-registry') sourceStats.issuanceOnchain++;
    else if (issuance.source === 'coingecko') sourceStats.issuanceCoingecko++;
    else sourceStats.issuanceUnavailable++;
    // Protocol tokens: the universe/eligibility TEST is on gross hr1y
    // (rulebook §1 — issuance nets the WEIGHT, not the gate); if issuance is
    // unavailable, net revenue for weighting purposes falls back to gross
    // (a documented bias toward slightly overweighting undmeasured names,
    // flagged via issuanceSource in the record).
    // Chain tokens: the TEST ITSELF is netBurn12m > 0 (rulebook §1), so an
    // unmeasurable issuance must NOT default to "assume zero dilution" —
    // that would silently wave chain tokens into the universe on a data gap
    // instead of a genuine positive net-burn result. Fail the gate instead.
    const netRevenue12m = issuance.value == null ? c.hr12mGross : c.hr12mGross - issuance.value;

    const hr30NetOfMonthlyIssuance = c.isChain && issuance.value != null ? c.hr30 - issuance.value / 12 : c.hr30;
    const effectiveHr12m = c.isChain ? (issuance.value == null ? null : netRevenue12m) : c.hr12mGross;
    gate.hrFloorOk = effectiveHr12m != null && effectiveHr12m >= rb.eligibility.minHolderRevenueTrailing12mUSD;
    gate.monthsOk = c.posMonths >= rb.eligibility.minConsecutivePositiveRevenueMonths;
    gate.trapOk =
      effectiveHr12m != null &&
      hr30NetOfMonthlyIssuance >= rb.eligibility.valueTrapFilter.thresholdFraction * (effectiveHr12m / 12);
    gate.chainNetBurnOk = c.isChain ? effectiveHr12m != null && netRevenue12m > 0 : true;
    gate.chainIssuanceMeasured = c.isChain ? issuance.value != null : true;

    const eligible = gate.mcapOk && gate.volOk && gate.ageOk && gate.hrFloorOk && gate.monthsOk && gate.trapOk && gate.chainNetBurnOk;
    const phr = effectiveHr12m > 0 ? c.mkt.marketCap / effectiveHr12m : Infinity;

    evaluated.push({
      symbol: c.sym,
      isChain: c.isChain,
      price: c.mkt.price,
      marketCap: c.mkt.marketCap,
      volume24h: c.mkt.volume24h,
      holderRevenue12m: effectiveHr12m == null ? null : Math.round(effectiveHr12m),
      holderRevenue12mGross: Math.round(c.hr12mGross),
      issuance12m: issuance.value == null ? null : Math.round(issuance.value),
      issuanceSource: issuance.source,
      netRevenue12m: Math.round(netRevenue12m),
      phr: Number.isFinite(phr) ? Math.round(phr * 10) / 10 : null,
      posMonths: c.posMonths,
      listingAgeDays: age == null ? null : Math.round(age),
      gate,
      eligible,
    });
  }

  // Rank by P/HR ascending among those passing every gate.
  const eligibleRanked = evaluated
    .filter((e) => e.eligible)
    .sort((a, b) => a.phr - b.phr);

  const kept = bufferedMembership(
    eligibleRanked.map((e) => ({ symbol: e.symbol })),
    incumbents,
    rb.ranking.rankBuffer.entryMaxRank,
    rb.ranking.rankBuffer.exitMinRank,
    rb.ranking.targetCount
  );

  // Exit hysteresis: an incumbent NOT retained by the buffer above (failed a
  // gate outright, or ranked worse than exitMinRank) gets one more quarter if
  // it isn't already onNotice; it exits now if it was already onNotice.
  const nextOnNotice = new Set();
  const finalMembers = new Set(kept);
  for (const sym of incumbents) {
    if (kept.includes(sym)) continue; // back in good standing, notice clears
    const evalRow = evaluated.find((e) => e.symbol === sym);
    if (onNotice.has(sym)) {
      console.log(`  ${sym}: exits (failed a second consecutive quarter — hysteresis exhausted)`);
      continue;
    }
    if (!evalRow || evalRow.marketCap == null) {
      console.log(`  ${sym}: exits (no data at all this quarter — cannot extend hysteresis without a price)`);
      continue;
    }
    console.log(`  ${sym}: kept on hysteresis notice (failed a gate or rank buffer this quarter; one more quarter)`);
    finalMembers.add(sym);
    nextOnNotice.add(sym);
  }
  if (finalMembers.size < rb.ranking.targetCount) {
    console.log(
      `  universe short: ${finalMembers.size} member(s) vs target ${rb.ranking.targetCount} ` +
        `(${eligibleRanked.length} eligible this run) — rulebook §12 applies, held as-is`
    );
  }

  const memberRows = [...finalMembers].map(
    (sym) => evaluated.find((e) => e.symbol === sym) || { symbol: sym, marketCap: null, netRevenue12m: 0 }
  );

  printQrevLedger(evaluated, finalMembers);
  return { memberRows, evaluated, nextOnNotice, sourceStats };
}

/** Full pass/fail ledger for every candidate considered — this is what makes
 *  "why isn't X in the basket" answerable with numbers instead of asserted. */
function printQrevLedger(evaluated, finalMembers) {
  console.log('  --- qREV eligibility ledger (all candidates considered) ---');
  const rows = [...evaluated].sort((a, b) => (a.phr ?? Infinity) - (b.phr ?? Infinity));
  for (const e of rows) {
    const g = e.gate;
    const failed = Object.entries(g)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    const tag = finalMembers.has(e.symbol) ? 'IN ' : failed.length ? 'OUT' : 'buf'; // buf = eligible but not selected by rank buffer
    console.log(
      `  [${tag}] ${e.symbol.padEnd(7)} ${e.isChain ? 'chain' : 'proto'} mcap=${Math.round(e.marketCap ?? 0)} ` +
        `hr12m=${e.holderRevenue12m ?? '—'} hrGross=${e.holderRevenue12mGross} phr=${e.phr ?? '—'} ` +
        `months=${e.posMonths} age=${e.listingAgeDays ?? '—'}d issuance=${e.issuance12m ?? '—'}(${e.issuanceSource})` +
        (failed.length ? `  FAILED: ${failed.join(',')}` : '')
    );
  }
}

// =========================================================================
//  qDEFI — universe, eligibility, ranking, weighting
// =========================================================================
const QDEFI_TOKEN_MAP = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', 'qdefi-token-map.json'), 'utf8'));

async function computeQdefiMembers(dateStr, markets, incumbents) {
  const rb = RULEBOOK;
  const dateKey = dateStr;
  const categoryRows = await fetchCoinGeckoCategory('decentralized-finance-defi', dateKey);
  const protocols = await fetchDefiLlamaProtocols(dateKey);
  const chains = await fetchDefiLlamaChains(dateKey);
  const chainTokenSymbols = new Set(chains.map((c) => (c.tokenSymbol || '').toUpperCase()).filter(Boolean));

  const llamaByGecko = new Map();
  const llamaBySymbol = new Map();
  for (const p of protocols) {
    if (p.gecko_id) {
      if (!llamaByGecko.has(p.gecko_id)) llamaByGecko.set(p.gecko_id, []);
      llamaByGecko.get(p.gecko_id).push(p);
    }
    const sym = (p.symbol || '').toUpperCase();
    if (sym && sym !== '-') {
      if (!llamaBySymbol.has(sym)) llamaBySymbol.set(sym, []);
      llamaBySymbol.get(sym).push(p);
    }
  }
  const DEFI_FAMILY = new Set(rb.universe.defiFamilyCategories);

  const evaluated = [];
  const seen = new Set();
  for (const coin of categoryRows) {
    if (seen.has(coin.symbol)) continue; // keep the highest-cap listing per symbol
    seen.add(coin.symbol);
    if (QX20_EXCLUDE.has(coin.symbol) || QDEFI_EXTRA_EXCLUDE.has(coin.symbol)) continue;
    const mapEntry = QDEFI_TOKEN_MAP[coin.symbol] && typeof QDEFI_TOKEN_MAP[coin.symbol] === 'object' ? QDEFI_TOKEN_MAP[coin.symbol] : null;
    if (mapEntry?.exclude) continue; // manual map (§3): e.g. PUMP — launchpad, symbol collision must not decide
    // §1: chains are out, oracles stay in — unless the manual map says the token's
    // primary adapter is a DeFi protocol (HYPE: perps/spot DEX first, L1 second).
    if (chainTokenSymbols.has(coin.symbol) && !mapEntry?.chainListingIgnored) continue;

    let matches = llamaByGecko.get(coin.id) || llamaBySymbol.get(coin.symbol) || [];
    if (mapEntry?.primaryProtocol) {
      const primary = protocols.filter((p) => p.slug === mapEntry.primaryProtocol || p.parentProtocol === `parent#${mapEntry.primaryProtocol}`);
      if (primary.length) matches = primary;
      if (mapEntry.category) matches = [{ ...(matches[0] || {}), category: mapEntry.category }, ...matches];
    }
    // Oracles (LINK, PYTH, ...) are explicitly INCLUDED per rulebook §1 ("오
    // 라클은 포함") even though DefiLlama's own category label for them
    // ("Oracle", or in LINK's case "Services"/"Requests Oracle") is not in
    // the DeFi-family allowlist above — the allowlist governs everything
    // else, but this is a named, closed policy override, not an open
    // decision, so it is applied unconditionally here.
    const isOracle = matches.some((p) => /oracle/i.test(p.category || ''));
    const isDefiFamily = isOracle || matches.some((p) => DEFI_FAMILY.has(p.category));
    if (!isDefiFamily) continue;

    const gate = {};
    gate.mcapOk = (coin.marketCap ?? 0) >= rb.eligibility.minCirculatingMarketCapUSD;
    gate.volOk = (coin.volume24h ?? 0) >= rb.eligibility.minVolume24hUSD;
    const age = listingAgeDays(coin, dateStr);
    gate.ageOk = age == null ? false : age >= rb.eligibility.minListingAgeDays;
    const eligible = gate.mcapOk && gate.volOk && gate.ageOk;

    evaluated.push({
      symbol: coin.symbol,
      price: coin.price,
      marketCap: coin.marketCap,
      volume24h: coin.volume24h,
      listingAgeDays: age == null ? null : Math.round(age),
      category: matches.find((p) => DEFI_FAMILY.has(p.category) || /oracle/i.test(p.category || ''))?.category ?? null,
      gate,
      eligible,
    });
  }

  const eligibleRanked = evaluated.filter((e) => e.eligible).sort((a, b) => b.marketCap - a.marketCap);
  const kept = bufferedMembership(
    eligibleRanked.map((e) => ({ symbol: e.symbol })),
    incumbents,
    rb.ranking.rankBuffer.entryMaxRank,
    rb.ranking.rankBuffer.exitMinRank,
    rb.ranking.targetCount
  );
  // No hysteresis for qDEFI (rulebook: exitHysteresis.enabled = false).
  const memberRows = kept.map((sym) => evaluated.find((e) => e.symbol === sym)).filter(Boolean);
  printQdefiLedger(evaluated, new Set(kept));
  return { memberRows, evaluated, sourceStats: { categoryRows: categoryRows.length, protocols: protocols.length } };
}

function printQdefiLedger(evaluated, finalMembers) {
  console.log('  --- qDEFI eligibility ledger (all category candidates considered) ---');
  const rows = [...evaluated].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  for (const e of rows) {
    const failed = Object.entries(e.gate)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    const tag = finalMembers.has(e.symbol) ? 'IN ' : failed.length ? 'OUT' : 'buf';
    console.log(
      `  [${tag}] ${e.symbol.padEnd(7)} cat=${e.category ?? '—'} mcap=${Math.round(e.marketCap ?? 0)} ` +
        `vol24h=${Math.round(e.volume24h ?? 0)} age=${e.listingAgeDays ?? '—'}d` +
        (failed.length ? `  FAILED: ${failed.join(',')}` : '')
    );
  }
}

// =========================================================================
//  Weighting
// =========================================================================
function weightQrev(memberRows, floorFraction) {
  const positiveSum = memberRows.reduce((s, m) => s + Math.max(0, m.netRevenue12m ?? 0), 0);
  let base;
  if (positiveSum <= 0) {
    // §4 fallback: all-negative quarter -> weight by gross trailing revenue.
    console.log('  all members net-revenue-negative this quarter — falling back to gross-revenue weighting (§4)');
    const grossSum = memberRows.reduce((s, m) => s + Math.max(0, m.holderRevenue12m ?? 0), 0) || 1;
    base = memberRows.map((m) => ({ symbol: m.symbol, weight: Math.max(0, m.holderRevenue12m ?? 0) / grossSum }));
  } else {
    const floor = floorFraction * positiveSum;
    const adj = memberRows.map((m) => ({ symbol: m.symbol, raw: Math.max(m.netRevenue12m ?? 0, floor) }));
    const total = adj.reduce((s, x) => s + x.raw, 0) || 1;
    base = adj.map((x) => ({ symbol: x.symbol, weight: x.raw / total }));
  }
  return applyCap(base, RULEBOOK.weighting.cap.maxWeight);
}

function weightQdefi(memberRows) {
  const total = memberRows.reduce((s, m) => s + (m.marketCap || 0), 0) || 1;
  const base = memberRows.map((m) => ({ symbol: m.symbol, weight: (m.marketCap || 0) / total }));
  return applyCap(base, RULEBOOK.weighting.cap.maxWeight);
}

// =========================================================================
//  Tolerance / no-trade logic at reconstitution
// =========================================================================
/** Compares each target weight to its drifted (mark-to-market) weight from
 *  the existing unit book, and only trades a name if the gap is >= the
 *  tolerance OR the drifted weight is above the cap (which is always cut,
 *  regardless of tolerance). Returns the new unit map. */
function applyToleranceAndTrade(targetWeights, priceNow, prevUnits, portfolioValue, toleranceFraction, capFraction) {
  const drifted = {};
  if (prevUnits) {
    for (const [sym, u] of Object.entries(prevUnits)) {
      const px = priceNow[sym];
      drifted[sym] = px ? (u * px) / portfolioValue : 0;
    }
  }
  const newUnits = {};
  for (const { symbol, weight: target } of targetWeights) {
    const px = priceNow[symbol];
    if (!px) continue; // no price today — cannot hold or trade into it
    const cur = drifted[symbol] ?? 0;
    const diffPts = Math.abs(target - cur) * 100;
    const overCap = cur > capFraction;
    const isNewName = !(prevUnits && symbol in prevUnits);
    if (!isNewName && !overCap && diffPts < toleranceFraction * 100) {
      // within tolerance and not over cap — leave the unit count alone
      newUnits[symbol] = prevUnits[symbol];
    } else {
      newUnits[symbol] = (portfolioValue * target) / px;
    }
  }
  return newUnits;
}

// =========================================================================
//  Main
// =========================================================================
function quarterKey(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}
function quarterStartDate(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qStartMonth).padStart(2, '0')}-01`;
}

function lastLine(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

/**
 * qX20 is not a paper index: its book lives in keeper/state.json, written by
 * update-nav.mjs (which keeps posting the NAV-tracker vault and is not
 * touched). This leg marks the qX20 BASKET vault from that same book — the
 * same code path as the paper indexes — and writes no record and no anchor.
 */
async function markQx20Basket() {
  const dateStr = todayUTC();
  const statePath = path.join(HERE, 'state.json');
  if (!fs.existsSync(statePath)) throw new Error('keeper/state.json (the qX20 model book) is missing');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(`\n=== ${RULEBOOK.ticker} basket mark — ${dateStr}${DRY_RUN ? ' [DRY RUN]' : ''} (book: keeper/state.json @ ${state.updatedAt}) ===`);

  const markets = await fetchCoinGeckoMarketsTop500(dateStr);
  const priceNow = Object.fromEntries([...bySymbol(markets).entries()].map(([s, m]) => [s, m.price]));
  let level = 0;
  const members = [];
  for (const [sym, u] of Object.entries(state.units)) {
    members.push(sym);
    if (priceNow[sym] > 0) level += u * priceNow[sym];
    else console.warn(`  ${sym}: no live price today — left out of the level (RUNBOOK failure mode 6)`);
  }
  console.log(`level ${level.toFixed(6)} from ${members.length} constituents (update-nav.mjs's last posted level ${state.level})`);

  // Membership only moves at update-nav.mjs's monthly reconstitution, so any
  // difference between the book and the vault's registry IS a reconstitution
  // for the purpose of the pending-registry file.
  await markBasket({
    index: INDEX,
    basket: RULEBOOK.basket,
    level,
    navBase: RULEBOOK.basket?.navBase ?? RULEBOOK.genesisLevel,
    prices: priceNow,
    members,
    reconstituted: true,
    dryRun: DRY_RUN,
    keeperDir: HERE,
    date: dateStr,
  });
}

async function main() {
  if (INDEX === 'qx20') return markQx20Basket();

  const dateStr = todayUTC();
  const prevRecord = lastLine(RECORDS_PATH);

  if (!DRY_RUN && prevRecord && prevRecord.date >= dateStr) {
    console.log(`${INDEX}: record for ${dateStr} already exists (append-only — not rewritten)`);
    // The basket may still need today's marks (a re-run after a failed
    // chain leg, or the operator re-marking during an auction): mark it from
    // the state the earlier run left, without touching the record.
    const st = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null;
    if (st?.units && RULEBOOK.basket?.vault) {
      const mk = await fetchCoinGeckoMarketsTop500(dateStr);
      const px = Object.fromEntries([...bySymbol(mk).entries()].map(([s, m]) => [s, m.price]));
      let lv = 0;
      for (const [sym, u] of Object.entries(st.units)) if (px[sym] > 0) lv += u * px[sym];
      await markBasket({
        index: INDEX, basket: RULEBOOK.basket, level: lv || st.level,
        navBase: RULEBOOK.basket.navBase ?? RULEBOOK.genesisLevel, prices: px,
        members: Object.keys(st.units), reconstituted: prevRecord.reconstituted === true,
        dryRun: DRY_RUN, keeperDir: HERE, date: dateStr,
      });
    }
    return;
  }

  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null;
  const incumbents = state?.units ? Object.keys(state.units) : [];
  const onNotice = new Set(state?.onNotice ?? []);

  console.log(`\n=== ${RULEBOOK.ticker} (${RULEBOOK.name}) — ${dateStr}${DRY_RUN ? ' [DRY RUN]' : ''} ===`);

  const markets = await fetchCoinGeckoMarketsTop500(dateStr);
  const marketsBySym = bySymbol(markets);
  const priceNow = Object.fromEntries([...marketsBySym.entries()].map(([s, m]) => [s, m.price]));

  // Reconstitute if there's no prior state (genesis), or the calendar quarter
  // has changed since the last reconstitution — "first run after 00:00 UTC on
  // Jan/Apr/Jul/Oct 1" reduces to exactly this for a keeper that runs daily.
  const shouldReconstitute = !state || state.lastReconQuarter !== quarterKey(dateStr);
  void quarterStartDate; // kept for documentation/tests; the daily-run keeper doesn't need the exact day boundary

  let units = state?.units ?? null;
  let level = state?.level ?? null;
  let reconstituted = false;
  let members = [];
  let sourceInfo = { marketsSource };
  let nextOnNotice = onNotice;

  if (shouldReconstitute) {
    reconstituted = true;
    console.log(`reconstitution (${state ? 'quarterly trigger' : 'genesis'}) — quarter ${quarterKey(dateStr)}`);

    let memberRows, weights;
    if (INDEX === 'qrev') {
      const res = await computeQrevMembers(dateStr, markets, incumbents, onNotice);
      memberRows = res.memberRows;
      nextOnNotice = res.nextOnNotice;
      sourceInfo.defillama = res.sourceStats;
      weights = weightQrev(memberRows, RULEBOOK.weighting.floor.fractionOfPositiveNetRevenueSum);
    } else {
      const res = await computeQdefiMembers(dateStr, markets, incumbents);
      memberRows = res.memberRows;
      sourceInfo.categoryUniverse = res.sourceStats;
      weights = weightQdefi(memberRows);
    }

    if (!units) {
      // Genesis: no prior book to compare against — trade straight into target.
      level = RULEBOOK.genesisLevel;
      units = Object.fromEntries(
        weights.map((w) => [w.symbol, priceNow[w.symbol] ? (level * w.weight) / priceNow[w.symbol] : 0])
      );
    } else {
      // Mark the OLD book to today's prices first, so "drifted weight" means
      // something, then apply the 5-point tolerance / always-cut-above-35%.
      let value = 0;
      for (const [sym, u] of Object.entries(units)) if (priceNow[sym]) value += u * priceNow[sym];
      level = value || level;
      units = applyToleranceAndTrade(
        weights,
        priceNow,
        units,
        level,
        RULEBOOK.reconstitution.tolerance.thresholdPoints / 100,
        RULEBOOK.weighting.cap.maxWeight
      );
    }

    members = weights.map((w) => {
      const row = memberRows.find((m) => m.symbol === w.symbol) || {};
      const out = { symbol: w.symbol, weight: Math.round(w.weight * 10000) / 10000, price: priceNow[w.symbol] ?? null, marketCap: row.marketCap ?? null };
      if (INDEX === 'qrev') {
        out.holderRevenue12m = row.holderRevenue12m ?? null;
        out.issuance12m = row.issuance12m ?? null;
        out.netRevenue12m = row.netRevenue12m ?? null;
        out.issuanceSource = row.issuanceSource ?? null;
        out.phr = row.phr ?? null;
      }
      return out;
    });
  } else {
    console.log('mark-to-market only — no reconstitution, no drift band, no trading');
    let value = 0;
    for (const [sym, u] of Object.entries(units)) {
      if (priceNow[sym]) value += u * priceNow[sym];
      else console.warn(`  ${sym}: no live price today, valued at last known contribution`);
    }
    level = value || level;
    members = Object.entries(units).map(([sym, u]) => ({
      symbol: sym,
      weight: level ? Math.round(((u * (priceNow[sym] ?? 0)) / level) * 10000) / 10000 : null,
      price: priceNow[sym] ?? null,
      marketCap: marketsBySym.get(sym)?.marketCap ?? null,
    }));
  }

  const record = {
    seq: prevRecord ? prevRecord.seq + 1 : 0,
    date: dateStr,
    observedAt: new Date().toISOString(),
    index: RULEBOOK.ticker,
    level: Math.round(level * 1e6) / 1e6,
    members,
    reconstituted,
    sources: sourceInfo,
    prevHash: prevRecord ? prevRecord.hash : null,
  };
  record.hash = sha256(JSON.stringify(record));

  fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });
  fs.appendFileSync(RECORDS_PATH, JSON.stringify(record) + '\n');
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      { updatedAt: record.observedAt, level, units, lastReconQuarter: shouldReconstitute ? quarterKey(dateStr) : state?.lastReconQuarter, onNotice: [...nextOnNotice] },
      null,
      2
    ) + '\n'
  );

  console.log(`${RULEBOOK.ticker} #${record.seq} ${dateStr} level=${record.level} members=${members.length} reconstituted=${reconstituted} head=${record.hash.slice(0, 16)}…`);
  console.log('basket:');
  for (const m of [...members].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
    const extra = INDEX === 'qrev' ? ` P/HR=${m.phr ?? '—'} netRev12m=${m.netRevenue12m ?? '—'} issuance12m=${m.issuance12m ?? '—'} (${m.issuanceSource ?? '—'})` : '';
    console.log(`  ${m.symbol.padEnd(8)} ${((m.weight ?? 0) * 100).toFixed(1).padStart(5)}%  mcap=${m.marketCap ?? '—'}${extra}`);
  }

  // ------------------------------------------------- basket marks (on-chain)
  // After the record, never before: the record is the product; the vault
  // follows it. Skips with a log line when the rulebook has no vault, the
  // key is absent, or this is a dry run (keeper/basket-mark.mjs).
  await markBasket({
    index: INDEX,
    basket: RULEBOOK.basket,
    level,
    navBase: RULEBOOK.basket?.navBase ?? RULEBOOK.genesisLevel,
    prices: priceNow,
    members: members.map((m) => m.symbol),
    reconstituted,
    dryRun: DRY_RUN,
    keeperDir: HERE,
    date: dateStr,
  });

  // --------------------------------------------------------------- anchor
  const giwaSepolia = defineChain({
    id: 91342,
    name: 'GIWA Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  });
  if (DO_ANCHOR) {
    const pk = process.env.KEEPER_PK;
    if (!pk) {
      console.log(`--anchor requested but KEEPER_PK is not set — skipping anchor (no-op), record above is unanchored.`);
    } else {
      const account = privateKeyToAccount(pk);
      const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
      const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
      // Shared key across crons and the desk: on a nonce race, wait and resend
      // (viem refetches the nonce per call); anything else is rethrown.
      let hash;
      for (let attempt = 0; ; attempt++) {
        try {
          hash = await wallet.sendTransaction({
            to: account.address,
            value: 0n,
            data: toHex(`qxpi-${INDEX}:` + record.hash),
          });
          break;
        } catch (e) {
          if (attempt >= 4 || !/nonce/i.test(String(e && e.message))) throw e;
          await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        }
      }
      await publicClient.waitForTransactionReceipt({ hash });
      fs.appendFileSync(ANCHORS_PATH, JSON.stringify({ date: dateStr, seq: record.seq, headHash: record.hash, txHash: hash }) + '\n');
      console.log(`anchored on GIWA Sepolia: ${hash}`);
    }
  } else {
    console.log('--anchor not passed — no on-chain anchor attempted for this run.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
