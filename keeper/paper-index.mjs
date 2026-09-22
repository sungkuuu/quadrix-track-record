/**
 * Paper-index keeper for qREV (Revenue Index), qDEFI (DeFi Index), and the
 * two sleeve baskets Barbell (BTC / working capital) and Triens (BTC /
 * working capital / Quality).
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
 *   node keeper/paper-index.mjs --index qrev    --dry-run
 *   node keeper/paper-index.mjs --index qdefi   --dry-run
 *   node keeper/paper-index.mjs --index qai     --dry-run
 *   node keeper/paper-index.mjs --index barbell --dry-run
 *   node keeper/paper-index.mjs --index triens  --dry-run
 *   node keeper/paper-index.mjs --index qrev             # writes trackrecord/
 *   KEEPER_PK=0x... node keeper/paper-index.mjs --index qrev --anchor
 *
 * qAI (2026-09-22, qai.json): a market-cap sector tracker of the AI theme,
 * the same family as qDEFI. Two differences from every other leg here. (a) Its
 * universe needs BOTH classification sources to agree on the run day —
 * CoinMarketCap's AI-family tag union INTERSECT CoinGecko's
 * artificial-intelligence / ai-agents categories — so the keeper reads CMC's
 * unauthenticated public listing endpoint (no API key exists in this
 * repository) and freezes membership if either source is unreachable. (b) It
 * can hold CASH: the cap is a HARD cap and empty seats are not refilled, so a
 * quarter with fewer than N eligible names, or a residue the cap cannot
 * redistribute, sits in a constant 1.0 cash unit earning nothing (qai.md §6,
 * D8 draft). Cash rides in `units.__CASH__` at price 1 so the tolerance and
 * mark-to-market code paths treat it as one more position, exactly as the
 * research engine does; the record reports it as a top-level `cashWeight`.
 * NOT IN FORCE: qai.json has `inception: null` and the workflow step is
 * disabled.
 *
 * Sleeve indexes (2026-09-22, barbell.json / triens.json): Barbell and Triens
 * hold sleeves, not a single ranked basket — a monetary sleeve (BTC alone, a
 * list and not a screen), a working-capital sleeve, and for Triens a Quality
 * sleeve screened out of the SAME universe and the same data path as qREV,
 * with one gate qREV does not have (issuance <= holder revenue) and no
 * valuation ranking. Sleeve weights reset at the quarterly reconstitution and
 * drift in between; there is no band and no conditional switch.
 *
 * The working-capital sleeve has no asset to hold: there is no fiat-backed
 * stablecoin canonical on GIWA yet. The PAPER record therefore holds a proxy
 * — a synthetic $1 unit accruing the 3-month T-bill rate daily (FRED DTB3,
 * keeper/working-capital.mjs) — and stamps `wcProxy: "DTB3"` on every record
 * line so the level is never read as a held asset. Neither index is in force:
 * both rulebooks are drafts, `inception` is null in both, and the workflow
 * steps for them are disabled until an inception decision is anchored.
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
import { rankingFor } from './rulebook-schedule.mjs';
import { loadDTB3, rateOn, accrue, WC_PROXY_ID } from './working-capital.mjs';

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
if (!['qrev', 'qdefi', 'qai', 'qx20', 'barbell', 'triens'].includes(INDEX)) {
  console.error('usage: node keeper/paper-index.mjs --index qrev|qdefi|qai|qx20|barbell|triens [--dry-run] [--anchor]');
  process.exit(2);
}
/** Indexes whose book is a set of sleeves rather than one ranked basket. */
const SLEEVE_INDEXES = new Set(['barbell', 'triens']);
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
  // Census gate (owner 2026-09-22; value-capture.md §8, triens.md §8). A symbol
  // whose registry entry says the control-address census was never finished
  // carries a weekly series that is TOTAL supply with `excluded: 0` — for a
  // fixed-supply-looking token that series is flat, and a flat series measures
  // issuance as zero. It is not a measurement, it is an unfinished one. The
  // rulebook says such a name falls back to the market-data supply series with
  // the fallback disclosed, which is what the research engine does
  // (qquality-backtest.py ONCHAIN_SKIP). Before this date every leg read the
  // registry for these names regardless; see docs/paper-index.md.
  const censusIncomplete = supplyRegistry?.[sym]?.census_status === 'incomplete';
  const weekly = censusIncomplete ? null : supplyWeekly[sym];
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
      return {
        value: Math.max(0, s1 - s0) * priceNow,
        source: censusIncomplete ? 'coingecko-census-incomplete' : 'coingecko',
        s0,
        s1,
      };
    }
  }
  return {
    value: null,
    source: censusIncomplete ? 'unavailable-census-incomplete' : 'unavailable',
    s0: null,
    s1: circulatingNow,
  };
}

function listingAgeDays(mkt, dateStr) {
  if (!mkt.athDate && !mkt.atlDate) return null;
  const dates = [mkt.athDate, mkt.atlDate].filter(Boolean).map((d) => Date.parse(d));
  const earliest = Math.min(...dates);
  return (Date.parse(dateStr + 'T00:00:00Z') - earliest) / 86_400_000;
}

/**
 * Every candidate in the revenue universe with each eligibility gate
 * evaluated. Shared by the qREV leg and by Triens's Quality sleeve, which
 * screens the SAME universe from the SAME sources (DefiLlama holder revenue,
 * the supply registry with its CoinGecko fallback, CoinGecko market data) —
 * the two differ in what they do with the issuance number, not in how they
 * measure it.
 *
 * `elig` is a rulebook eligibility block. `issuanceGateTheta` is null for
 * qREV, where issuance nets the WEIGHT (value-capture.md §4) and never gates;
 * Triens passes 1, where issuance IS a gate (triens.md §2, owner 2026-09-21).
 * With theta null this function produces exactly the gate set and the
 * `eligible` verdict qREV had before it was factored out.
 */
async function evaluateRevenueUniverse(dateStr, markets, elig, { issuanceGateTheta = null } = {}) {
  const supplyRegistry = JSON.parse(fs.readFileSync(path.join(HERE, 'supply', 'registry.json'), 'utf8'));
  const supplyWeeklyRaw = JSON.parse(fs.readFileSync(path.join(HERE, 'supply', 'supply-weekly.json'), 'utf8'));
  const supplyWeekly = {};
  for (const [sym, byDate] of Object.entries(supplyWeeklyRaw)) {
    supplyWeekly[sym] = Object.fromEntries(Object.entries(byDate).map(([d, v]) => [d, { circulating: v.circulating }]));
  }

  const candidates = await buildQrevUniverse(dateStr, markets);
  const sourceStats = { defillamaOk: 0, defillamaFail: 0, issuanceOnchain: 0, issuanceCoingecko: 0, issuanceUnavailable: 0, issuanceCensusIncomplete: 0 };

  const evaluated = [];
  for (const c of candidates) {
    sourceStats.defillamaOk++;
    const gate = {};
    gate.mcapOk = c.mkt.marketCap >= elig.minCirculatingMarketCapUSD;
    gate.volOk = (c.mkt.volume24h ?? 0) >= elig.minVolume24hUSD;
    const age = listingAgeDays(c.mkt, dateStr);
    gate.ageOk = age == null ? false : age >= elig.minListingAgeDays;

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
    else if (issuance.source.startsWith('coingecko')) sourceStats.issuanceCoingecko++;
    else sourceStats.issuanceUnavailable++;
    if (issuance.source.endsWith('census-incomplete')) sourceStats.issuanceCensusIncomplete++;
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
    gate.hrFloorOk = effectiveHr12m != null && effectiveHr12m >= elig.minHolderRevenueTrailing12mUSD;
    gate.monthsOk = c.posMonths >= elig.minConsecutivePositiveRevenueMonths;
    gate.trapOk =
      effectiveHr12m != null &&
      hr30NetOfMonthlyIssuance >= elig.valueTrapFilter.thresholdFraction * (effectiveHr12m / 12);
    gate.chainNetBurnOk = c.isChain ? effectiveHr12m != null && netRevenue12m > 0 : true;
    gate.chainIssuanceMeasured = c.isChain ? issuance.value != null : true;

    // issuance / holder revenue over the trailing 12 months. A chain token is
    // already net of its own issuance (netBurn12m), so its ratio is 0 once it
    // passes the net-burn test — the same convention as the research engine
    // (qquality-backtest.py eligible(), chains='netburn').
    const issuanceRatio = c.isChain
      ? (gate.chainNetBurnOk ? 0 : Infinity)
      : issuance.value == null || !(c.hr12mGross > 0)
        ? Infinity
        : issuance.value / c.hr12mGross;
    if (issuanceGateTheta != null) {
      // triens.md §2 / D7: the gate, and "issuance unknown" FAILS it —
      // Infinity above covers both the unmeasured case and hr12m <= 0.
      gate.issuanceGateOk = issuanceRatio <= issuanceGateTheta;
    }

    const eligible =
      gate.mcapOk &&
      gate.volOk &&
      gate.ageOk &&
      gate.hrFloorOk &&
      gate.monthsOk &&
      gate.trapOk &&
      gate.chainNetBurnOk &&
      (gate.issuanceGateOk ?? true);
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
      issuanceRatio: Number.isFinite(issuanceRatio) ? Math.round(issuanceRatio * 100) / 100 : null,
      netRevenue12m: Math.round(netRevenue12m),
      phr: Number.isFinite(phr) ? Math.round(phr * 10) / 10 : null,
      posMonths: c.posMonths,
      listingAgeDays: age == null ? null : Math.round(age),
      gate,
      eligible,
    });
  }
  return { evaluated, sourceStats };
}

/**
 * Rank buffer + exit hysteresis, shared by qREV and the Quality sleeve. The
 * two differ only in `rank` (qREV: P/HR ascending; Quality: net revenue
 * descending) — the seat mechanics are the same rule, written once.
 */
function resolveMembership({ evaluated, incumbents, onNotice, ranking, rank, shortRule }) {
  const eligibleRanked = evaluated.filter((e) => e.eligible).sort(rank);

  const kept = bufferedMembership(
    eligibleRanked.map((e) => ({ symbol: e.symbol })),
    incumbents,
    ranking.rankBuffer.entryMaxRank,
    ranking.rankBuffer.exitMinRank,
    ranking.targetCount
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
  if (finalMembers.size < ranking.targetCount) {
    console.log(
      `  universe short: ${finalMembers.size} member(s) vs target ${ranking.targetCount} ` +
        `(${eligibleRanked.length} eligible this run) — ${shortRule}`
    );
  }

  const memberRows = [...finalMembers].map(
    (sym) => evaluated.find((e) => e.symbol === sym) || { symbol: sym, marketCap: null, netRevenue12m: 0 }
  );
  return { memberRows, finalMembers, nextOnNotice, eligibleCount: eligibleRanked.length };
}

async function computeQrevMembers(dateStr, markets, incumbents, onNotice) {
  const rb = RULEBOOK;
  const ranking = rankingFor(rb, dateStr); // targetCount / rank buffer as they stand on dateStr (dated decisions in ranking.scheduled)
  console.log(
    `  ranking parameters for ${dateStr}: targetCount ${ranking.targetCount}, rank buffer enter ≤ ${ranking.rankBuffer.entryMaxRank} / exit > ${ranking.rankBuffer.exitMinRank}` +
      (ranking.appliedSchedule ? ` (scheduled change ${ranking.appliedSchedule.decision ?? ''} effective ${ranking.appliedSchedule.effectiveFrom})` : ' (base rulebook values)')
  );

  const { evaluated, sourceStats } = await evaluateRevenueUniverse(dateStr, markets, rb.eligibility);
  const { memberRows, finalMembers, nextOnNotice } = resolveMembership({
    evaluated,
    incumbents,
    onNotice,
    ranking,
    rank: (a, b) => a.phr - b.phr, // cheapest P/HR first
    shortRule: 'rulebook §12 applies, held as-is',
  });

  printRevenueLedger('  --- qREV eligibility ledger (all candidates considered) ---', evaluated, finalMembers, (a, b) => (a.phr ?? Infinity) - (b.phr ?? Infinity));
  return { memberRows, evaluated, nextOnNotice, sourceStats };
}

/** Full pass/fail ledger for every candidate considered — this is what makes
 *  "why isn't X in the basket" answerable with numbers instead of asserted. */
function printRevenueLedger(header, evaluated, finalMembers, sortFn, extra = () => '') {
  console.log(header);
  const rows = [...evaluated].sort(sortFn);
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
        extra(e) +
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
  const ranking = rankingFor(rb, dateStr); // same dated-parameter resolution as qREV; qDEFI has no scheduled entry today
  const kept = bufferedMembership(
    eligibleRanked.map((e) => ({ symbol: e.symbol })),
    incumbents,
    ranking.rankBuffer.entryMaxRank,
    ranking.rankBuffer.exitMinRank,
    ranking.targetCount
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
//  qAI — universe, eligibility, ranking, weighting
// =========================================================================
const QAI_EXCLUSIONS = JSON.parse(fs.readFileSync(path.join(HERE, 'rulebooks', 'qai-exclusions.json'), 'utf8'));
/** Cash rides inside `units` as one more position priced at a constant 1.0,
 *  so the tolerance test and the daily mark treat it exactly like a name —
 *  the same shape the research engine used (`__CASH__` in its unit book). */
const CASH_SYM = '__CASH__';

/** CoinMarketCap tags, live, from the PUBLIC data-api listing endpoint —
 *  unauthenticated, the same endpoint family `docs/research/ai/fetch-cmc-weekly.py`
 *  used for its weekly snapshots (that one takes `listings/historical?date=`;
 *  this one is the "latest" sibling, because a daily keeper needs today's
 *  tags and a historical snapshot for today does not exist yet at 00:25 UTC).
 *  There is no CMC_API_KEY secret in this repository and this call needs none.
 *
 *  Top 1000 by market cap. The eligibility floor is $150M and CMC rank 1000
 *  sat near $9M when this was written, so the cut is far below anything that
 *  can pass — but the count is logged every run so a shrinking window is
 *  visible before it bites.
 *
 *  FAILURE MODE (rulebook §8): no fallback. If this throws, the run throws,
 *  no record is written for the day, and a missing day is never backfilled —
 *  which is what "membership is frozen" means for a source that decides
 *  membership. Two quarters of that is a §12 condition for the owner. */
async function fetchCmcTagMap(dateKey) {
  const key = `cmc-listing-tags-${dateKey}.json`;
  const cached = cacheGet(key, DAY);
  if (cached) return new Map(Object.entries(cached));
  const url =
    'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing' +
    '?start=1&limit=1000&sortBy=market_cap&sortType=desc&convert=USD&cryptoType=all&tagType=all&audited=false';
  const raw = await fetchJSON(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const list = raw?.data?.cryptoCurrencyList;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('CoinMarketCap listing returned no rows — membership source down (qai.md §8)');
  }
  const out = {};
  for (const c of list) {
    const sym = String(c.symbol || '').toUpperCase();
    if (!sym || out[sym]) continue; // highest-cap listing per symbol wins, as on the CoinGecko side
    out[sym] = c.tags || [];
  }
  cacheSet(key, out);
  return new Map(Object.entries(out));
}

/** Tag-priority bucket, used ONLY for a symbol the disclosure table does not
 *  cover. Same ladder as docs/research/ai/ai-backtest.py's classify_bucket.
 *
 *  NOTE (open, flagged for the owner): qai.md §8's fallback row and appendix B
 *  D6 say a name missing from the bucket table is HELD BACK from inclusion,
 *  while §1 and the owner's 2026-09-22 decision say the bucket is a disclosure
 *  column and "never a rule". Those two cannot both hold. This keeper follows
 *  §1 — the bucket never gates — and stamps `bucketSource: "tag-fallback"` on
 *  the row so the table's coverage gap is visible in the record instead of
 *  silently removing names. If the owner closes D6 the other way, this
 *  function becomes an exclusion. */
function qaiBucketFallback(tags) {
  const t = new Set(tags);
  const any = (...xs) => xs.some((x) => t.has(x));
  if (any('analytics', 'data-availability', 'storage', 'filesharing', 'indexing', 'enterprise-solutions')) return 'C';
  if (any('depin', 'distributed-computing', 'iot', 'zero-knowledge-proofs', 'privacy', 'privacy-blockchain')) return 'A';
  if (any('ai-agents', 'ai-agent-launchpad', 'defai', 'layer-1', 'platform', 'smart-contracts', 'interoperability', 'oracles', 'account-abstraction')) return 'B';
  return 'D';
}

/** The disclosure trio for one symbol: bucket (A/B/C/D), origin chain and
 *  whether it could be held on GIWA. All three are informational — the owner's
 *  2026-09-22 decision put the paper index on the FULL universe, non-EVM names
 *  included, and made holdability a column rather than a screen. */
function qaiDisclosure(sym, tags) {
  const row = RULEBOOK.disclosure?.table?.[sym];
  if (row) return { bucket: row.bucket, bucketSource: 'table', originChain: row.originChain, holdableOnGiwa: row.holdableOnGiwa };
  return { bucket: qaiBucketFallback(tags), bucketSource: 'tag-fallback', originChain: '미확인', holdableOnGiwa: '미확인' };
}

/** §3 structural exclusions, read from keeper/rulebooks/qai-exclusions.json. */
function qaiExcludedReason(sym, tags) {
  const t = new Set(tags);
  for (const [name, rule] of Object.entries(QAI_EXCLUSIONS.tagRules || {})) {
    const hit = (rule.cmcTags || []).find((x) => t.has(x));
    if (hit) return `${name}:${hit}`;
  }
  for (const [name, rule] of Object.entries(QAI_EXCLUSIONS.namedSymbols || {})) {
    if (rule.symbolPattern) {
      if (new RegExp(rule.symbolPattern).test(sym)) return `named:${name}`;
    } else if (name === sym) {
      return `named:${name}`;
    }
  }
  return null;
}

/**
 * Both sources, intersected, on the run day.
 *
 * CoinGecko side: the union of the `artificial-intelligence` and `ai-agents`
 * categories, which also carries this leg's price / market cap / volume /
 * ath-atl rows (the top-500 markets pull does not reach far enough down —
 * several eligible AI names sit outside the top 500 by market cap).
 * CoinMarketCap side: tags only. A name must appear on both.
 */
async function computeQaiMembers(dateStr, incumbents) {
  const rb = RULEBOOK;
  const cgRows = [];
  for (const cat of rb.universe.coingeckoCategories) {
    cgRows.push(...(await fetchCoinGeckoCategory(cat, dateStr)));
  }
  const cmcTags = await fetchCmcTagMap(dateStr);
  console.log(`  sources: CoinGecko AI categories ${cgRows.length} rows (${rb.universe.coingeckoCategories.join(' + ')}), CoinMarketCap tagged listings ${cmcTags.size}`);

  const AI_TAGS = new Set(rb.universe.cmcAiTags);
  const chainTag = rb.universe.chainRule.tag;
  const chainException = new Set(rb.universe.chainRule.exceptionTags);

  const evaluated = [];
  const seen = new Set();
  const chainDropped = [];
  for (const coin of cgRows) {
    if (seen.has(coin.symbol)) continue; // highest-cap listing per symbol
    seen.add(coin.symbol);
    if (QX20_EXCLUDE.has(coin.symbol)) continue;

    const tags = cmcTags.get(coin.symbol);
    if (!tags) continue; // not in CMC's top 1000 at all — the intersection cannot be satisfied
    const matched = [...AI_TAGS].filter((t) => tags.includes(t));
    if (matched.length === 0) continue; // CoinGecko says AI, CoinMarketCap does not — out (§1)

    const excl = qaiExcludedReason(coin.symbol, tags);
    if (excl) continue;

    // §1 general-purpose chain rule: layer-1 is out unless the chain itself is
    // the AI product (generative-ai / ai-agents). ai-big-data alone never counts.
    if (tags.includes(chainTag) && !tags.some((t) => chainException.has(t))) {
      chainDropped.push({ symbol: coin.symbol, marketCap: coin.marketCap, tags: matched });
      continue;
    }

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
      tagsMatched: matched,
      ...qaiDisclosure(coin.symbol, tags),
      gate,
      eligible,
    });
  }

  const eligibleRanked = evaluated.filter((e) => e.eligible).sort((a, b) => b.marketCap - a.marketCap);
  const ranking = rankingFor(rb, dateStr);
  const kept = bufferedMembership(
    eligibleRanked.map((e) => ({ symbol: e.symbol })),
    incumbents.filter((s) => s !== CASH_SYM),
    ranking.rankBuffer.entryMaxRank,
    ranking.rankBuffer.exitMinRank,
    ranking.targetCount
  );
  const memberRows = kept.map((sym) => evaluated.find((e) => e.symbol === sym)).filter(Boolean);
  printQaiLedger(evaluated, new Set(kept), chainDropped);
  const emptySeats = Math.max(0, ranking.targetCount - memberRows.length);
  if (eligibleRanked.length < 5) {
    console.log(`  §12-1 WATCH: only ${eligibleRanked.length} eligible name(s) this reconstitution (floor 5) — recorded as-is, cash holds the rest.`);
  }
  return {
    memberRows,
    evaluated,
    eligibleCount: eligibleRanked.length,
    emptySeats,
    sourceStats: { coingeckoAiCategoryRows: cgRows.length, cmcTaggedListings: cmcTags.size, evaluated: evaluated.length, eligible: eligibleRanked.length },
  };
}

function printQaiLedger(evaluated, finalMembers, chainDropped) {
  console.log('  --- qAI eligibility ledger (every name both sources call AI) ---');
  const rows = [...evaluated].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  for (const e of rows) {
    const failed = Object.entries(e.gate).filter(([, ok]) => !ok).map(([k]) => k);
    const tag = finalMembers.has(e.symbol) ? 'IN ' : failed.length ? 'OUT' : 'buf';
    console.log(
      `  [${tag}] ${e.symbol.padEnd(9)} mcap=${Math.round(e.marketCap ?? 0)} vol24h=${Math.round(e.volume24h ?? 0)} ` +
        `age=${e.listingAgeDays ?? '—'}d bucket=${e.bucket}(${e.bucketSource}) chain=${e.originChain} giwa=${e.holdableOnGiwa} ` +
        `tags=${e.tagsMatched.join('+')}` +
        (failed.length ? `  FAILED: ${failed.join(',')}` : '')
    );
  }
  console.log('  --- dropped by the general-purpose chain rule (§1: layer-1 without generative-ai/ai-agents) ---');
  for (const c of [...chainDropped].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))) {
    console.log(`  [CHAIN] ${c.symbol.padEnd(9)} mcap=${Math.round(c.marketCap ?? 0)} aiTags=${c.tags.join('+')} + layer-1`);
  }
}

/** Market-cap weighting with a HARD 35% cap (qai.md §4/§5). Unlike applyCap
 *  above — which raises the cap to 1/n so the weights always sum to 1 — this
 *  one leaves a residue it cannot redistribute unallocated, and the caller
 *  holds that residue as cash. Same algorithm as the research engine's
 *  cap_weights (docs/research/ai/ai-backtest.py). */
function weightQai(memberRows, cap = RULEBOOK.weighting.cap.maxWeight) {
  const total = memberRows.reduce((s, m) => s + (m.marketCap || 0), 0);
  if (total <= 0) return [];
  const w = new Map(memberRows.map((m) => [m.symbol, (m.marketCap || 0) / total]));
  const capped = new Set();
  for (let i = 0; i <= w.size; i++) {
    let excess = 0;
    for (const [s, v] of w) {
      if (!capped.has(s) && v > cap) {
        excess += v - cap;
        w.set(s, cap);
        capped.add(s);
      }
    }
    if (excess <= 1e-12) break;
    const uncapped = [...w].reduce((t, [s, v]) => (capped.has(s) ? t : t + v), 0);
    if (uncapped <= 0) break; // nowhere to put it — it becomes cash
    for (const [s, v] of w) if (!capped.has(s)) w.set(s, v + (v / uncapped) * excess);
  }
  return memberRows.map((m) => ({ symbol: m.symbol, weight: w.get(m.symbol) }));
}

// =========================================================================
//  Weighting
// =========================================================================
/** Net-revenue weighting with a floor and an iterative cap. qREV weights its
 *  whole basket this way (value-capture.md §4); Triens weights its Quality
 *  SLEEVE this way (triens.md §4-§5, same floor, same cap, cap measured
 *  inside the sleeve) — one function, called with the cap that applies. */
function weightQrev(memberRows, floorFraction, cap = RULEBOOK.weighting.cap.maxWeight) {
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
  return applyCap(base, cap);
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
 *  regardless of tolerance). Returns the new unit map.
 *
 *  `portfolioValue` is the book the DRIFTED weights are measured against;
 *  `targetValue` is the book a traded name is sized into. They are the same
 *  number for qREV and qDEFI (one book). They differ for a Triens Quality
 *  sleeve whose sleeve value has just been reset at the sleeve level: drift is
 *  still measured against what the sleeve was worth before the reset, and the
 *  trade is sized into what it is worth after. */
function applyToleranceAndTrade(targetWeights, priceNow, prevUnits, portfolioValue, toleranceFraction, capFraction, targetValue = portfolioValue) {
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
      newUnits[symbol] = (targetValue * target) / px;
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

// =========================================================================
//  Sleeve indexes — Barbell (BTC / working capital), Triens (+ Quality)
// =========================================================================
/**
 * These two hold SLEEVES, not one ranked basket. What a sleeve index does on a
 * given day:
 *
 *   every day        mark BTC at today's price, accrue the working-capital
 *                    proxy by one day per calendar day since the last run,
 *                    mark the Quality names (Triens). No trading.
 *   reconstitution   (first run after a quarter boundary) recompute the
 *                    Quality basket, work out the sleeve targets including the
 *                    empty-seat spill, and reset the sleeves to target unless
 *                    every one of them is already within the tolerance.
 *
 * Interest accrued in working capital therefore stays in that sleeve between
 * resets and is redistributed only at the quarterly reset — which is what the
 * backtest did (barbell_common.py: weekly accrual, quarterly reset).
 */

/** Last-known-price carry (qX20 §9, cited by barbell.md §9 and triens.md §9):
 *  a held constituent with no price today is marked at its last known price
 *  for at most this many consecutive runs. After that the run FAILS rather
 *  than reporting a level built on a price nobody has seen in four runs. */
const MAX_STALE_RUNS = 3;

function priceWithCarry(sym, priceNow, stale) {
  const live = priceNow[sym];
  if (live > 0) {
    stale[sym] = { price: live, runs: 0 };
    return live;
  }
  const s = stale[sym];
  if (!s || !(s.price > 0)) {
    throw new Error(`${sym}: no price today and no carried price — the book cannot be marked (rulebook §9)`);
  }
  s.runs = (s.runs ?? 0) + 1;
  if (s.runs > MAX_STALE_RUNS) {
    throw new Error(
      `${sym}: no live price for ${s.runs} consecutive runs (limit ${MAX_STALE_RUNS}, rulebook §9) — run stopped, no record written`
    );
  }
  console.warn(`  ${sym}: no live price today — marked at the last known ${s.price} (carry ${s.runs} of ${MAX_STALE_RUNS})`);
  return s.price;
}

/** Sleeve target weights on a reconstitution day. Empty Quality seats spill to
 *  working capital, 1/N of the Quality sleeve each (triens.md §6, owner
 *  2026-09-21 D4) — not to BTC, which would quietly make the product 70-80%
 *  BTC and a different product from the one the name describes. */
function sleeveTargets(rb, seatsFilled, targetCount) {
  const t = {
    monetary: rb.sleeves.monetary.targetWeight,
    workingCapital: rb.sleeves.workingCapital.targetWeight,
  };
  if (rb.sleeves.quality) {
    const filled = Math.max(0, Math.min(seatsFilled ?? 0, targetCount));
    t.quality = rb.sleeves.quality.targetWeight * (filled / targetCount);
    t.workingCapital += rb.sleeves.quality.targetWeight * ((targetCount - filled) / targetCount);
  }
  return t;
}

/** Triens's Quality sleeve: the qREV universe and the qREV data path, with the
 *  issuance ratio as a GATE (θ = 1) instead of a weight adjustment, and ranked
 *  by net revenue instead of by P/HR. Everything else — the gates, the rank
 *  buffer, the two-quarter hysteresis, the 2% floor, the 35% cap — is the same
 *  rule, run by the same code. */
async function computeQualityMembers(dateStr, markets, incumbents, onNotice, ranking) {
  const rb = RULEBOOK;
  const theta = rb.eligibility.issuanceGate.theta;
  const byNetRevenue = (a, b) => (b.netRevenue12m ?? 0) - (a.netRevenue12m ?? 0);

  const { evaluated, sourceStats } = await evaluateRevenueUniverse(dateStr, markets, rb.eligibility, {
    issuanceGateTheta: theta,
  });
  const { memberRows, finalMembers, nextOnNotice, eligibleCount } = resolveMembership({
    evaluated,
    incumbents,
    onNotice,
    ranking,
    rank: byNetRevenue,
    shortRule: 'the empty seats go to the working-capital sleeve (rulebook §6)',
  });

  printRevenueLedger(
    `  --- ${rb.ticker} quality-sleeve ledger (issuance gate θ ≤ ${theta}; all candidates considered) ---`,
    evaluated,
    finalMembers,
    byNetRevenue,
    (e) => ` netRev12m=${e.netRevenue12m} issuance/hr=${e.issuanceRatio ?? '∞ (unmeasured or no revenue)'}`
  );
  if (eligibleCount < rb.viability.minimumEligibleNames) {
    console.log(
      `  viability: ${eligibleCount} eligible name(s), below the rulebook's floor of ${rb.viability.minimumEligibleNames} (§12-1). ` +
        'The level is still recorded — it is a record of what the rule would have done, including the quarters where the rule says do not launch.'
    );
  }
  return { memberRows, evaluated, nextOnNotice, sourceStats, eligibleCount };
}

async function runSleeveIndex() {
  const rb = RULEBOOK;
  const dateStr = todayUTC();
  const prevRecord = lastLine(RECORDS_PATH);

  if (!DRY_RUN && prevRecord && prevRecord.date >= dateStr) {
    // No basket vault exists for these indexes (and cannot while GIWA carries
    // no canonical BTC), so unlike qREV there is nothing left to re-post.
    console.log(`${INDEX}: record for ${dateStr} already exists (append-only — not rewritten)`);
    return;
  }

  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null;
  const hasQuality = !!rb.sleeves.quality;
  let qUnits = state?.sleeves?.quality?.units ?? null;
  const incumbents = qUnits ? Object.keys(qUnits) : [];
  const onNotice = new Set(state?.onNotice ?? []);
  const stale = { ...(state?.stalePrices ?? {}) };

  console.log(`\n=== ${rb.ticker} (${rb.name}) — ${dateStr}${DRY_RUN ? ' [DRY RUN]' : ''} ===`);
  console.log(
    `NOT IN FORCE — rules-only level; inception ${rb.inception.date ?? 'not anchored'}, ` +
      `working capital held as the ${WC_PROXY_ID} proxy (keeper/rulebooks/${INDEX}.json)`
  );

  const markets = await fetchCoinGeckoMarketsTop500(dateStr);
  const marketsBySym = bySymbol(markets);
  const priceNow = Object.fromEntries([...marketsBySym.entries()].map(([s, m]) => [s, m.price]));

  // ---------------------------------------------- working-capital accrual
  const { series: dtb3, source: wcSource } = await loadDTB3({ cacheDir: CACHE_DIR, dateKey: dateStr });
  const wcPrev = state?.sleeves?.workingCapital ?? null;
  const wcUnitValuePrev = wcPrev?.unitValue ?? 1;
  const { factor: wcFactor, days: wcDays } = accrue(dtb3, wcPrev?.lastAccrual ?? dateStr, dateStr);
  const wcUnitValue = wcUnitValuePrev * wcFactor;
  const wcRate = rateOn(dtb3, dateStr);
  console.log(
    `working capital (${WC_PROXY_ID} proxy): unit ${wcUnitValuePrev.toFixed(8)} → ${wcUnitValue.toFixed(8)} ` +
      `over ${wcDays.length} day(s) (+${((wcFactor - 1) * 100).toFixed(6)}%), DTB3 ${wcRate.rate}% p.a. as of ${wcRate.asOf} [${wcSource}]`
  );

  // ------------------------------------------------- mark the existing book
  const btcSym = rb.sleeves.monetary.assets[0];
  const btcPrice = priceWithCarry(btcSym, priceNow, stale);
  const qPrices = {};
  if (qUnits) for (const sym of Object.keys(qUnits)) qPrices[sym] = priceWithCarry(sym, priceNow, stale);
  const priceAll = { ...priceNow, ...qPrices, [btcSym]: btcPrice };

  const qBookValue = (units) =>
    units ? Object.entries(units).reduce((sum, [sym, u]) => sum + u * (priceAll[sym] ?? 0), 0) : 0;

  let btcUnits = state?.sleeves?.monetary?.units?.[btcSym] ?? null;
  let wcUnits = wcPrev?.units ?? null;
  let btcValue = btcUnits ? btcUnits * btcPrice : 0;
  let wcValue = wcUnits ? wcUnits * wcUnitValue : 0;
  let qValue = qBookValue(qUnits);
  let level = state ? btcValue + wcValue + qValue : rb.genesisLevel;

  const shouldReconstitute = !state || state.lastReconQuarter !== quarterKey(dateStr);
  const tol = rb.reconstitution.tolerance.thresholdPoints / 100;
  let reconstituted = false;
  let nextOnNotice = onNotice;
  let qualityRows = [];
  let seats = state?.seats ?? (hasQuality ? { filled: 0, target: rankingFor(rb, dateStr).targetCount } : null);
  let targets = state?.targets ?? null;
  const sourceInfo = {
    marketsSource,
    workingCapital: { proxy: WC_PROXY_ID, source: wcSource, ratePercent: wcRate.rate, rateAsOf: wcRate.asOf },
  };

  if (shouldReconstitute) {
    reconstituted = true;
    console.log(`reconstitution (${state ? 'quarterly trigger' : 'genesis'}) — quarter ${quarterKey(dateStr)}`);
    let qualityWeights = null;

    if (hasQuality) {
      const ranking = rankingFor(rb, dateStr); // only the Quality sleeve has a ranking block at all
      console.log(
        `  ranking parameters for ${dateStr}: targetCount ${ranking.targetCount}, rank buffer enter ≤ ${ranking.rankBuffer.entryMaxRank} / exit > ${ranking.rankBuffer.exitMinRank}` +
          (ranking.appliedSchedule ? ` (scheduled change ${ranking.appliedSchedule.decision ?? ''} effective ${ranking.appliedSchedule.effectiveFrom})` : ' (base rulebook values)') +
          `; issuance gate θ ≤ ${rb.eligibility.issuanceGate.theta}, ranked by net revenue (descending)`
      );
      const res = await computeQualityMembers(dateStr, markets, incumbents, onNotice, ranking);
      nextOnNotice = res.nextOnNotice;
      sourceInfo.defillama = res.sourceStats;
      qualityRows = res.memberRows;
      seats = { filled: qualityRows.length, target: ranking.targetCount, eligible: res.eligibleCount };
      qualityWeights = weightQrev(
        qualityRows,
        rb.weighting.floor.fractionOfPositiveNetRevenueSum,
        rb.weighting.cap.maxWeight
      );
      for (const w of qualityWeights) if (!priceAll[w.symbol]) priceAll[w.symbol] = priceNow[w.symbol];
    }

    targets = sleeveTargets(rb, seats?.filled, seats?.target ?? 1);

    if (!state) {
      level = rb.genesisLevel;
      btcValue = level * targets.monetary;
      wcValue = level * targets.workingCapital;
      qValue = hasQuality ? level * targets.quality : 0;
      console.log(`  genesis: level ${level} split into the sleeve targets below (no prior book to compare against)`);
    } else {
      const drifted = { monetary: btcValue / level, workingCapital: wcValue / level };
      if (hasQuality) drifted.quality = qValue / level;
      let worst = { sleeve: null, gap: -1 };
      for (const k of Object.keys(targets)) {
        const gap = Math.abs(targets[k] - (drifted[k] ?? 0));
        console.log(
          `  sleeve ${k.padEnd(15)} target ${(targets[k] * 100).toFixed(1).padStart(5)}%  drifted ${((drifted[k] ?? 0) * 100).toFixed(1).padStart(5)}%  gap ${(gap * 100).toFixed(1)}pp`
        );
        if (gap > worst.gap) worst = { sleeve: k, gap };
      }
      if (worst.gap < tol) {
        console.log(
          `  every sleeve is within the ${rb.reconstitution.tolerance.thresholdPoints}-point tolerance ` +
            `(worst ${(worst.gap * 100).toFixed(1)}pp, ${worst.sleeve}) — no value moves between sleeves`
        );
      } else {
        console.log(
          `  sleeve reset: ${worst.sleeve} is ${(worst.gap * 100).toFixed(1)}pp from target, outside the ` +
            `${rb.reconstitution.tolerance.thresholdPoints}-point tolerance — every sleeve goes back to target`
        );
        btcValue = level * targets.monetary;
        wcValue = level * targets.workingCapital;
        qValue = hasQuality ? level * targets.quality : 0;
      }
    }

    btcUnits = btcValue / btcPrice;
    wcUnits = wcValue / wcUnitValue;

    if (hasQuality) {
      // Inside the sleeve: the qREV per-name rule (5 points, cap always cut),
      // measured against the sleeve's pre-trade value and sized into its
      // post-reset value.
      const driftBase = qBookValue(qUnits) || qValue;
      qUnits = applyToleranceAndTrade(qualityWeights, priceAll, qUnits, driftBase, tol, rb.weighting.cap.maxWeight, qValue);
      // The reconstitution moves no money in or out of the index, so the book
      // has to stay whole: the tolerance-retained names leave a residual, and
      // it is normalised away inside the sleeve — the same thing the research
      // engine does by renormalising its weight vector after the tolerance
      // substitution (qquality-backtest.py run()).
      const traded = qBookValue(qUnits);
      if (traded > 0 && qValue > 0) {
        const k = qValue / traded;
        if (Math.abs(k - 1) > 1e-12) {
          if (Math.abs(k - 1) > 0.005) console.log(`  quality sleeve normalised by ×${k.toFixed(6)} after the per-name tolerance (residual kept inside the sleeve)`);
          for (const sym of Object.keys(qUnits)) qUnits[sym] *= k;
        }
      }
    }
  } else {
    console.log('mark-to-market only — no reconstitution, no drift band, no trading');
    if (!targets) targets = sleeveTargets(rb, seats?.filled, seats?.target ?? 1);
  }

  // The book after whatever the day did.
  btcValue = btcUnits * btcPrice;
  wcValue = wcUnits * wcUnitValue;
  qValue = qBookValue(qUnits);
  level = btcValue + wcValue + qValue;

  const r4 = (x) => Math.round(x * 10000) / 10000;
  const members = [
    {
      symbol: btcSym,
      sleeve: 'monetary',
      weight: r4(btcValue / level),
      price: btcPrice,
      units: btcUnits,
      marketCap: marketsBySym.get(btcSym)?.marketCap ?? null,
    },
    {
      symbol: 'WC',
      sleeve: 'workingCapital',
      weight: r4(wcValue / level),
      price: Math.round(wcUnitValue * 1e8) / 1e8,
      units: wcUnits,
      proxy: WC_PROXY_ID,
      ratePercent: wcRate.rate,
      rateAsOf: wcRate.asOf,
    },
  ];
  for (const [sym, u] of Object.entries(qUnits ?? {})) {
    const row = qualityRows.find((m) => m.symbol === sym);
    const m = {
      symbol: sym,
      sleeve: 'quality',
      weight: r4((u * (priceAll[sym] ?? 0)) / level),
      price: priceAll[sym] ?? null,
      units: u,
      marketCap: marketsBySym.get(sym)?.marketCap ?? null,
    };
    if (row) {
      m.holderRevenue12m = row.holderRevenue12m ?? null;
      m.issuance12m = row.issuance12m ?? null;
      m.netRevenue12m = row.netRevenue12m ?? null;
      m.issuanceRatio = row.issuanceRatio ?? null;
      m.issuanceSource = row.issuanceSource ?? null;
    }
    members.push(m);
  }

  const record = {
    seq: prevRecord ? prevRecord.seq + 1 : 0,
    date: dateStr,
    observedAt: new Date().toISOString(),
    index: RULEBOOK.ticker,
    level: Math.round(level * 1e6) / 1e6,
    wcProxy: WC_PROXY_ID,
    sleeves: {
      monetary: { targetWeight: targets.monetary, weight: r4(btcValue / level), value: Math.round(btcValue * 1e6) / 1e6 },
      workingCapital: {
        targetWeight: Math.round(targets.workingCapital * 1e6) / 1e6,
        weight: r4(wcValue / level),
        value: Math.round(wcValue * 1e6) / 1e6,
        unitValue: Math.round(wcUnitValue * 1e8) / 1e8,
        proxy: WC_PROXY_ID,
        ratePercent: wcRate.rate,
        rateAsOf: wcRate.asOf,
        daysAccrued: wcDays.length,
      },
      ...(hasQuality
        ? {
            quality: {
              targetWeight: Math.round(targets.quality * 1e6) / 1e6,
              weight: r4(qValue / level),
              value: Math.round(qValue * 1e6) / 1e6,
              seatsFilled: seats?.filled ?? 0,
              seatsTarget: seats?.target ?? null,
              emptySeats: Math.max(0, (seats?.target ?? 0) - (seats?.filled ?? 0)),
            },
          }
        : {}),
    },
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
      {
        updatedAt: record.observedAt,
        level,
        sleeves: {
          monetary: { units: { [btcSym]: btcUnits } },
          workingCapital: { units: wcUnits, unitValue: wcUnitValue, lastAccrual: dateStr, proxy: WC_PROXY_ID },
          ...(hasQuality ? { quality: { units: qUnits ?? {} } } : {}),
        },
        targets,
        seats,
        lastReconQuarter: shouldReconstitute ? quarterKey(dateStr) : state?.lastReconQuarter,
        onNotice: [...nextOnNotice],
        stalePrices: stale,
      },
      null,
      2
    ) + '\n'
  );

  console.log(
    `${RULEBOOK.ticker} #${record.seq} ${dateStr} level=${record.level} sleeves=${Object.keys(record.sleeves).length} ` +
      `members=${members.length} reconstituted=${reconstituted} head=${record.hash.slice(0, 16)}…`
  );
  console.log('book:');
  for (const m of [...members].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
    const extra =
      m.sleeve === 'workingCapital'
        ? ` ${WC_PROXY_ID} unit=${m.price} (${m.ratePercent}% p.a. as of ${m.rateAsOf})`
        : m.sleeve === 'quality' && m.netRevenue12m != null
          ? ` netRev12m=${m.netRevenue12m} issuance/hr=${m.issuanceRatio ?? '—'} (${m.issuanceSource ?? '—'})`
          : '';
    console.log(`  ${m.sleeve.padEnd(14)} ${m.symbol.padEnd(8)} ${((m.weight ?? 0) * 100).toFixed(1).padStart(5)}%  price=${m.price ?? '—'}${extra}`);
  }
  if (hasQuality) {
    console.log(
      `quality seats: ${record.sleeves.quality.seatsFilled}/${record.sleeves.quality.seatsTarget} filled, ` +
        `${record.sleeves.quality.emptySeats} empty seat(s) → working capital ` +
        `(target ${(record.sleeves.workingCapital.targetWeight * 100).toFixed(1)}%)`
    );
  }

  // No basket vault exists for either sleeve index; this call is the same
  // no-op path every index takes when basket.vault is null.
  await markBasket({
    index: INDEX,
    basket: RULEBOOK.basket,
    level,
    navBase: RULEBOOK.basket?.navBase ?? RULEBOOK.genesisLevel,
    prices: priceAll,
    members: members.map((m) => m.symbol),
    reconstituted,
    dryRun: DRY_RUN,
    keeperDir: HERE,
    date: dateStr,
  });

  await maybeAnchor(record, dateStr);
}

/** The anchor step, identical for every record-writing leg: calldata-as-
 *  commitment on GIWA Sepolia under the prefix `qxpi-{index}:`, a genuine
 *  no-op when KEEPER_PK is absent. Nonce-safe: the keeper key is shared with
 *  the other crons and the desk. */
async function maybeAnchor(record, dateStr) {
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

async function main() {
  if (INDEX === 'qx20') return markQx20Basket();
  if (SLEEVE_INDEXES.has(INDEX)) return runSleeveIndex();

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

  // qAI holds names below the top-500 cut (KAITO, GRT and the like), so the
  // two AI category pulls — which carry price and market cap of their own —
  // are overlaid onto the daily price map on EVERY run, not only at a
  // reconstitution. Without this a mark-to-market day would silently value a
  // held name at nothing. Cash is priced at a constant 1.0 (qai.md §6: no
  // interest) so it rides through the tolerance and mark paths as a position.
  if (INDEX === 'qai') {
    for (const cat of RULEBOOK.universe.coingeckoCategories) {
      for (const row of await fetchCoinGeckoCategory(cat, dateStr)) {
        if (!(priceNow[row.symbol] > 0) && row.price > 0) priceNow[row.symbol] = row.price;
        if (!marketsBySym.has(row.symbol)) marketsBySym.set(row.symbol, row);
      }
    }
    priceNow[CASH_SYM] = 1;
  }

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
  // qAI only: seat accounting for the record line, and the disclosure trio per
  // member carried in state so a mark-to-market day can restate it without
  // re-reading the classification sources (membership is frozen between
  // reconstitutions anyway — qai.md §8).
  let qaiCounts = state?.qaiCounts ?? null;
  let qaiMeta = state?.qaiMeta ?? {};

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
    } else if (INDEX === 'qai') {
      const res = await computeQaiMembers(dateStr, incumbents);
      memberRows = res.memberRows;
      sourceInfo.categoryUniverse = res.sourceStats;
      qaiCounts = { eligibleCount: res.eligibleCount, emptySeats: res.emptySeats };
      weights = weightQai(memberRows);
      // Empty seats and whatever the hard cap could not redistribute are cash
      // (qai.md §6). Carried as one more position at price 1 so the tolerance
      // test and the daily mark need no special case.
      const invested = weights.reduce((t, w) => t + w.weight, 0);
      const cashFrac = Math.max(0, 1 - invested);
      qaiMeta = Object.fromEntries(
        memberRows.map((m) => [m.symbol, { bucket: m.bucket, bucketSource: m.bucketSource, originChain: m.originChain, holdableOnGiwa: m.holdableOnGiwa }])
      );
      console.log(
        `  seats ${memberRows.length}/${RULEBOOK.ranking.targetCount} filled (${res.eligibleCount} eligible, ` +
          `${res.emptySeats} empty) — cash ${(cashFrac * 100).toFixed(2)}%`
      );
      if (cashFrac > 1e-9) weights = [...weights, { symbol: CASH_SYM, weight: cashFrac }];
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
      if (INDEX === 'qai' && w.symbol !== CASH_SYM) {
        out.volume24h = row.volume24h ?? null;
        out.bucket = row.bucket ?? null;
        out.bucketSource = row.bucketSource ?? null;
        out.originChain = row.originChain ?? null;
        out.holdableOnGiwa = row.holdableOnGiwa ?? null;
      }
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
    members = Object.entries(units).map(([sym, u]) => {
      const out = {
        symbol: sym,
        weight: level ? Math.round(((u * (priceNow[sym] ?? 0)) / level) * 10000) / 10000 : null,
        price: priceNow[sym] ?? null,
        marketCap: marketsBySym.get(sym)?.marketCap ?? null,
      };
      if (INDEX === 'qai' && sym !== CASH_SYM) {
        out.volume24h = marketsBySym.get(sym)?.volume24h ?? null;
        const meta = qaiMeta[sym] ?? {};
        out.bucket = meta.bucket ?? '미확인';
        out.bucketSource = meta.bucketSource ?? '미확인';
        out.originChain = meta.originChain ?? '미확인';
        out.holdableOnGiwa = meta.holdableOnGiwa ?? '미확인';
      }
      return out;
    });
  }

  // qAI: cash is a position in the BOOK but not a member of the INDEX. It is
  // split out of the member list and reported as a top-level weight next to
  // the seat accounting (qai.md §2/§6), so a reader can tell "three seats went
  // unfilled" from "the cap left a residue" without re-deriving either.
  let qaiExtras = null;
  if (INDEX === 'qai') {
    const cashRow = members.find((m) => m.symbol === CASH_SYM);
    members = members.filter((m) => m.symbol !== CASH_SYM);
    qaiExtras = {
      eligibleCount: qaiCounts?.eligibleCount ?? null,
      emptySeats: qaiCounts?.emptySeats ?? null,
      cashWeight: cashRow ? cashRow.weight : 0,
    };
  }

  const record = {
    seq: prevRecord ? prevRecord.seq + 1 : 0,
    date: dateStr,
    observedAt: new Date().toISOString(),
    index: RULEBOOK.ticker,
    level: Math.round(level * 1e6) / 1e6,
    members,
    reconstituted,
    ...(qaiExtras ?? {}),
    sources: sourceInfo,
    prevHash: prevRecord ? prevRecord.hash : null,
  };
  record.hash = sha256(JSON.stringify(record));

  fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });
  fs.appendFileSync(RECORDS_PATH, JSON.stringify(record) + '\n');
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        updatedAt: record.observedAt,
        level,
        units,
        lastReconQuarter: shouldReconstitute ? quarterKey(dateStr) : state?.lastReconQuarter,
        onNotice: [...nextOnNotice],
        ...(INDEX === 'qai' ? { qaiCounts, qaiMeta } : {}),
      },
      null,
      2
    ) + '\n'
  );

  console.log(`${RULEBOOK.ticker} #${record.seq} ${dateStr} level=${record.level} members=${members.length} reconstituted=${reconstituted} head=${record.hash.slice(0, 16)}…`);
  console.log('basket:');
  for (const m of [...members].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
    const extra = INDEX === 'qrev' ? ` P/HR=${m.phr ?? '—'} netRev12m=${m.netRevenue12m ?? '—'} issuance12m=${m.issuance12m ?? '—'} (${m.issuanceSource ?? '—'})` : '';
    const qai =
      INDEX === 'qai'
        ? ` vol24h=${m.volume24h ?? '—'} bucket=${m.bucket ?? '—'}(${m.bucketSource ?? '—'}) chain=${m.originChain ?? '—'} giwa=${m.holdableOnGiwa ?? '—'}`
        : '';
    console.log(`  ${m.symbol.padEnd(8)} ${((m.weight ?? 0) * 100).toFixed(1).padStart(5)}%  mcap=${m.marketCap ?? '—'}${extra}${qai}`);
  }
  if (qaiExtras) {
    console.log(
      `  ${'CASH'.padEnd(8)} ${((qaiExtras.cashWeight ?? 0) * 100).toFixed(1).padStart(5)}%  ` +
        `(eligible ${qaiExtras.eligibleCount ?? '—'}, empty seats ${qaiExtras.emptySeats ?? '—'}, priced 1.0, no interest — qai.md §6)`
    );
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

  await maybeAnchor(record, dateStr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
