/**
 * Basket reconstitution planner — writes the work order the executor reads.
 *
 * On a reconstitution day the paper index trades at once; the basket vault
 * (QuadrixBasketVault v3.1 on GIWA Sepolia) cannot: a registry change waits
 * seven days behind announceRegistryChange, and every weight moves only
 * through a dutch auction. This script turns "what the book holds" versus
 * "what the vault holds" into one JSON plan, keeper/plans/{index}/{date}.json:
 *
 *   - adds / removes — the registry diff, with each add's mock address (null
 *     until the mock is deployed), its decimals and its FIRST reference
 *     price from two independent sources (the first post on an unset
 *     reference is band-free, so it is the one number nothing on chain
 *     bounds — hence two sources and a stated disagreement);
 *   - the announce tuple and decisionSha256 (null until a decision document
 *     is anchored — one naming THIS index — and always null for a weight-only
 *     change, which has nothing to announce; while a change is pending the
 *     announced tuple is carried verbatim, order included);
 *   - target weights (the book), current vault weights, and which names to
 *     trade: a registry change, a weight-only drift beyond the tolerance (5
 *     points), a name above the cap, and for the sleeve indexes (Barbell,
 *     Triens) a sleeve reset when any sleeve has drifted beyond the
 *     tolerance each mark a name — and a marked name trades its whole block
 *     (the basket; the Quality sleeve of Triens without a reset) to the
 *     book's weights, because the book re-weights every name of the block
 *     (computeTrades, planner spec of 2026-10-01);
 *   - an ordered auction list (sell, buy, sellAmount, duration) that moves
 *     value from the overweight traded names to the underweight ones, drains
 *     each removal to zero, and the weights expected after those fills. All
 *     of it is sized at the references on chain — the prices the contract
 *     fills at — and the book is valued at the same prices; the day's market
 *     price is kept beside them for the executor's 5% guard.
 *
 * Inputs: keeper/pending-registry-{index}.json when the daily run wrote one,
 * the keeper state (state-{index}.json; keeper/state.json for qX20), the
 * rulebook's basket block and tolerance/cap parameters, the day's CoinGecko
 * snapshot (keeper/cache, refetched if absent) plus CoinPaprika as the second
 * source, and one Multicall3 read of the vault (batched, paced — the public
 * RPC rate-limits a plain loop of ~120 calls).
 *
 * This script only READS the chain. It never sends a transaction, never
 * touches the rulebook, and never writes outside keeper/plans/ and the
 * ephemeral keeper/cache/.
 *
 * Usage:
 *   node keeper/basket-plan.mjs --index qrev
 *   node keeper/basket-plan.mjs --index qrev --date 2026-10-01 --mocks keeper/plans/qrev/mocks.json
 *   node keeper/basket-plan.mjs --index triens --rpc http://127.0.0.1:8545      # anvil rehearsal
 *
 * Options:
 *   --index      qx20 | qrev | qdefi | qai | barbell | triens (required)
 *   --date       YYYY-MM-DD, default today (UTC); names the plan file and the price cache
 *   --rpc        JSON-RPC URL, default the GIWA Sepolia public endpoint
 *   --pending    path of the pending-registry file (default keeper/pending-registry-{index}.json)
 *   --book       path of the keeper state to plan from (default per index)
 *   --mocks      JSON {SYMBOL: {address, decimals}} — deployed mocks for the adds
 *   --prices-b   JSON {SYMBOL: price} or a raw CoinPaprika tickers array (second source, offline)
 *   --decisions  decisions ledger (default trackrecord/decisions.jsonl)
 *   --decision   id in that ledger whose sha256 becomes decisionSha256
 *   --duration   auction duration in seconds (default 900)
 *   --out        plan path (default keeper/plans/{index}/{date}.json)
 *   --no-fetch   never call CoinGecko/CoinPaprika (cache or --prices-b only)
 *   --reweight-block  trade every block to the book although nothing in it is
 *                marked — only to resume a session whose registry change was
 *                executed but whose auctions did not finish (written to notes)
 *
 * The executor (keeper/basket-recon.mjs) imports the chain helpers exported
 * below; running this file directly writes the plan.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, defineChain, parseAbi, getAddress, isAddress } from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CACHE_DIR = path.join(HERE, 'cache');
export const PLANS_DIR = path.join(HERE, 'plans');
export const DECISIONS_LEDGER = path.join(ROOT, 'trackrecord', 'decisions.jsonl');

export const GIWA_RPC = 'https://sepolia-rpc.giwa.io';
export const GIWA_CHAIN_ID = 91342;
/** Multicall3, the canonical address on every chain including GIWA Sepolia
 *  (the site's desk reads through it). A chain without code there — a fresh
 *  anvil — falls back to sequential reads. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const INDEXES = ['qx20', 'qrev', 'qdefi', 'qai', 'barbell', 'triens'];
export const TICKER = { qx20: 'qX20', qrev: 'qREV', qdefi: 'qDEFI', qai: 'qAI', barbell: 'qDUO', triens: 'qTRI' };
/** Indexes whose book is sleeves, not one ranked basket (paper-index.mjs SLEEVE_INDEXES). */
export const SLEEVE_INDEXES = new Set(['barbell', 'triens']);
/** qAI's cash position rides in its units map; it is not an on-chain asset. */
const CASH_SYM = '__CASH__';

export const VAULT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function keeper() view returns (address)',
  'function assetCount() view returns (uint256)',
  'function assets(uint256) view returns (address)',
  'function isRegistryAsset(address) view returns (bool)',
  'function inRemoval(address) view returns (bool)',
  'function refPrice(address) view returns (uint256)',
  'function refPriceUpdatedAt(address) view returns (uint256)',
  'function navPerShare() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function pendingRegistryChange() view returns (bytes32)',
  'function pendingRegistryEta() view returns (uint256)',
  'function maxRefAge() view returns (uint256)',
  'function maxFillLossBps() view returns (uint256)',
  'function dailyLossBudgetBps() view returns (uint256)',
  'function biddingOpen() view returns (bool)',
  'function isBidder(address) view returns (bool)',
  'function auctionCount() view returns (uint256)',
  'function auctions(uint256) view returns (address sellAsset, address buyAsset, uint256 sellRemaining, uint64 startTime, uint64 duration, bool open)',
  'function curveFactorBps(uint256) view returns (uint256)',
  'function portfolioValueAtRef() view returns (uint256)',
  'function CURVE_START_PREMIUM_BPS() view returns (uint256)',
  'function REGISTRY_DELAY() view returns (uint256)',
  'function setRefPrice(address asset, uint256 price)',
  'function announceRegistryChange(address[] adds, address[] removes, bytes32 decisionSha256)',
  'function executeRegistryChange(address[] adds, address[] removes, bytes32 decisionSha256)',
  'function finalizeRemoval(address asset)',
  'function openAuction(address sellAsset, address buyAsset, uint256 sellAmount, uint64 duration) returns (uint256)',
  'function cancelAuction(uint256 id)',
  'function fill(uint256 id, uint256 sellTake) returns (uint256)',
  'function redeem(uint256 shares, address receiver) returns (uint256[])',
  'event RegistryChangeAnnounced(address[] adds, address[] removes, bytes32 decisionSha256, uint256 eta)',
  'event RegistryChangeExecuted(address[] adds, address[] removes, bytes32 decisionSha256)',
  'event RemovalFinalized(address indexed asset)',
  'event RefPricePosted(address indexed asset, uint256 price)',
  'event AuctionOpened(uint256 indexed id, address indexed sellAsset, address indexed buyAsset, uint256 sellAmount, uint64 duration)',
  'event AuctionFilled(uint256 indexed id, address indexed bidder, uint256 sellTaken, uint256 buyPaid, uint256 lossAtRef)',
  'error NotAP()', 'error NotKeeper()', 'error NotBidder()', 'error NavMoveTooLarge()', 'error ZeroNav()',
  'error ZeroShares()', 'error ZeroAmount()', 'error CapExceeded()', 'error LengthMismatch()',
  'error NotRegistryAsset()', 'error AlreadyRegistryAsset()', 'error AssetInRemoval()', 'error PriceUnset()',
  'error DailyBudgetExceeded()', 'error NoPendingChange()', 'error TimelockNotElapsed()', 'error ChangeMismatch()',
  'error RemovalNotDrained()', 'error NotInRemoval()', 'error AuctionClosed()', 'error AuctionExpired()',
  'error RefPriceStale()', 'error OwnableUnauthorizedAccount(address account)',
]);
export const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function faucetAmount() view returns (uint256)',
  'function faucet()',
]);

// ------------------------------------------------------------- chain access
export function chainFor(rpc, chainId = GIWA_CHAIN_ID) {
  return defineChain({
    id: chainId,
    name: chainId === GIWA_CHAIN_ID ? 'GIWA Sepolia' : `chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

export function isLocalRpc(rpc) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(rpc);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A paced, Multicall3-batched reader. `paceMs` is the gap between batches —
 *  1 s on the public endpoint (measured clean across six vaults), 0 locally. */
export async function makeReader(rpc, { chainId = GIWA_CHAIN_ID, paceMs } = {}) {
  const publicClient = createPublicClient({ chain: chainFor(rpc, chainId), transport: http(rpc) });
  const onchainId = await publicClient.getChainId();
  if (onchainId !== chainId) throw new Error(`RPC ${rpc} is chain ${onchainId}, expected ${chainId} (pass --chain-id for a fresh anvil)`);
  const code = await publicClient.getCode({ address: MULTICALL3 }).catch(() => undefined);
  const hasMulticall = !!code && code !== '0x';
  const pace = paceMs ?? (isLocalRpc(rpc) ? 0 : 1000);
  let batches = 0;
  async function batch(contracts) {
    if (contracts.length === 0) return [];
    if (batches++ > 0 && pace > 0) await sleep(pace);
    if (hasMulticall) {
      return publicClient.multicall({ contracts, multicallAddress: MULTICALL3, allowFailure: false, batchSize: 0 });
    }
    const out = [];
    for (const c of contracts) out.push(await publicClient.readContract(c));
    return out;
  }
  return { publicClient, batch, hasMulticall, pace, rpc, chainId };
}

/**
 * Everything the planner and the executor need to know about one vault, in
 * three batched rounds: the scalars, then assets(i), then per-asset balance /
 * reference / removal flag / decimals / symbol. BigInts stay BigInts.
 */
export async function readVault(reader, vault) {
  vault = getAddress(vault);
  const V = (functionName, args = []) => ({ address: vault, abi: VAULT_ABI, functionName, args });
  const [owner, keeper, assetCount, totalSupply, navPerShare, pendingRegistryChange, pendingRegistryEta, maxRefAge, maxFillLossBps, dailyLossBudgetBps, biddingOpen, auctionCount, premiumBps, registryDelay] =
    await reader.batch([
      V('owner'), V('keeper'), V('assetCount'), V('totalSupply'), V('navPerShare'), V('pendingRegistryChange'),
      V('pendingRegistryEta'), V('maxRefAge'), V('maxFillLossBps'), V('dailyLossBudgetBps'), V('biddingOpen'),
      V('auctionCount'), V('CURVE_START_PREMIUM_BPS'), V('REGISTRY_DELAY'),
    ]);
  const n = Number(assetCount);
  const addresses = (await reader.batch(Array.from({ length: n }, (_, i) => V('assets', [BigInt(i)])))).map((a) => getAddress(a));
  const per = await reader.batch(addresses.flatMap((a) => [
    { address: a, abi: ERC20_ABI, functionName: 'balanceOf', args: [vault] },
    V('refPrice', [a]), V('refPriceUpdatedAt', [a]), V('inRemoval', [a]),
    { address: a, abi: ERC20_ABI, functionName: 'decimals' },
    { address: a, abi: ERC20_ABI, functionName: 'symbol' },
  ]));
  const assets = addresses.map((address, i) => ({
    i,
    address,
    balance: per[i * 6],
    refPrice: per[i * 6 + 1],
    refPriceUpdatedAt: per[i * 6 + 2],
    inRemoval: per[i * 6 + 3],
    decimals: Number(per[i * 6 + 4]),
    onchainSymbol: per[i * 6 + 5],
  }));
  const block = await reader.publicClient.getBlock();
  return {
    vault, owner, keeper, assetCount: n, totalSupply, navPerShare, pendingRegistryChange, pendingRegistryEta,
    maxRefAge, maxFillLossBps, dailyLossBudgetBps, biddingOpen, auctionCount, premiumBps, registryDelay,
    assets, block: { number: block.number, timestamp: block.timestamp },
  };
}

// ---------------------------------------------------------------- arithmetic
/** price (USD, float) → the contract's refPrice unit (USD × 1e18 per base
 *  unit) for a token with `decimals`. Same as basket-mark.mjs toRefPrice. */
export function toRefPrice(priceUsd, decimals) {
  const scaled = BigInt(Math.round(priceUsd * 1e12));
  return (scaled * 10n ** 18n) / (10n ** 12n * 10n ** BigInt(decimals));
}

/** Mock decimals by price — gen-manifest.py's rule, so a new mock carries
 *  9–10 significant digits of reference price. A one-decimal slip here is a
 *  10× first-price error, which is why the executor re-reads decimals from
 *  the deployed mock and refuses on a mismatch. */
export function decimalsByPrice(priceUsd) {
  return Math.max(0, Math.min(18, Math.floor(Math.log10(priceUsd)) + 9));
}

export function bpsDiff(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  return Math.round((Math.abs(a - b) / a) * 10_000);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ files
export function loadRulebook(index) {
  const p = path.join(HERE, 'rulebooks', `${index}.json`);
  const raw = fs.readFileSync(p);
  return { rulebook: JSON.parse(raw), path: path.relative(ROOT, p), sha256: sha256(raw) };
}

export function loadDecisions(ledgerPath = DECISIONS_LEDGER) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function planPath(index, date) {
  return path.join(PLANS_DIR, index, `${date}.json`);
}

export function loadPlan(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** BigInts are written as decimal strings; everything else as-is. */
export function savePlan(p, plan) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(plan, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

/** The most recent plan for an index (by file name = date), or null. */
export function latestPlan(index) {
  const dir = path.join(PLANS_DIR, index);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** The record row for a date (null for qX20, which has no record series). */
export function recordRow(index, date) {
  if (index === 'qx20') return null;
  const p = path.join(ROOT, 'trackrecord', `record-${index}.jsonl`);
  if (!fs.existsSync(p)) return null;
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return rows.find((r) => r.date === date) ?? null;
}

// ------------------------------------------------------------ price sources
function cachePath(key) {
  return path.join(CACHE_DIR, key);
}
function readCache(key) {
  const p = cachePath(key);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeCache(key, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(key), JSON.stringify(data));
}

/** First occurrence per symbol wins (CoinGecko's array is cap-sorted), as in
 *  paper-index.mjs bySymbol. */
function priceMap(rows, pick) {
  const m = {};
  for (const r of rows) {
    const s = String(r.symbol || '').toUpperCase();
    const p = pick(r);
    if (s && m[s] == null && p > 0) m[s] = p;
  }
  return m;
}

/** CoinGecko key, as in paper-index.mjs: from 2026-09-29 the keyless
 *  endpoint answers 403 from GitHub's runners, so the plan sends
 *  COINGECKO_API_KEY when set (header only, never in a URL or a log line). */
const CG_KEY = (process.env.COINGECKO_API_KEY || '').trim();
const CG_PRO = (process.env.COINGECKO_API_PLAN || '').trim().toLowerCase() === 'pro';
const CG_BASE = CG_KEY && CG_PRO ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
const CG_OPTS = CG_KEY ? { headers: { [CG_PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: CG_KEY } } : undefined;

/** Source A: the day's CoinGecko top-500 snapshot — the same file and the
 *  same URL paper-index.mjs uses, so the plan prices what the record priced. */
export async function loadSourceA(date, allowFetch) {
  const key = `cg-markets-top500-${date}.json`;
  const cached = readCache(key);
  if (cached) return { prices: priceMap(cached, (c) => c.price), label: `coingecko (keeper/cache/${key})` };
  if (!allowFetch) return { prices: {}, label: 'coingecko (no cache, fetch disabled)' };
  const rows = [];
  for (const page of [1, 2]) {
    const url = `${CG_BASE}/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
    const r = await fetch(url, CG_OPTS);
    if (!r.ok) return { prices: priceMap(rows, (c) => c.price), label: `coingecko (HTTP ${r.status} on page ${page}; partial)` };
    const raw = await r.json();
    if (!Array.isArray(raw)) break;
    rows.push(...raw.map((c) => ({ id: c.id, symbol: String(c.symbol).toUpperCase(), price: c.current_price, marketCap: c.market_cap })));
    await sleep(2000);
  }
  if (rows.length) writeCache(key, rows);
  return { prices: priceMap(rows, (c) => c.price), label: `coingecko (fetched, cached as keeper/cache/${key})` };
}

/** Source B: CoinPaprika tickers (update-nav.mjs's fallback source), or a
 *  file — {SYMBOL: price} or the raw tickers array — for an offline run. */
export async function loadSourceB(date, fileArg, allowFetch) {
  if (fileArg) {
    const raw = JSON.parse(fs.readFileSync(fileArg, 'utf8'));
    const prices = Array.isArray(raw) ? priceMap(raw, (c) => c.quotes?.USD?.price ?? c.price) : raw;
    return { prices, label: `file ${fileArg}` };
  }
  const key = `cp-tickers-${date}.json`;
  const cached = readCache(key);
  if (cached) return { prices: priceMap(cached, (c) => c.quotes?.USD?.price), label: `coinpaprika (keeper/cache/${key})` };
  if (!allowFetch) return { prices: {}, label: 'coinpaprika (no cache, fetch disabled)' };
  const r = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=500');
  if (!r.ok) return { prices: {}, label: `coinpaprika (HTTP ${r.status})` };
  const raw = await r.json();
  writeCache(key, raw);
  return { prices: priceMap(raw, (c) => c.quotes?.USD?.price), label: `coinpaprika (fetched, cached as keeper/cache/${key})` };
}

// ------------------------------------------------------------------ the book
/** The keeper's book as {symbol: units} plus the sleeve of each name. */
export function readBook(index, bookPath, rulebook) {
  const st = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
  const units = {};
  const sleeveOf = {};
  const notes = [];
  if (SLEEVE_INDEXES.has(index)) {
    const btc = rulebook.sleeves.monetary.assets[0];
    units[btc] = st.sleeves.monetary.units[btc];
    sleeveOf[btc] = 'monetary';
    units.WC = st.sleeves.workingCapital.units;
    sleeveOf.WC = 'workingCapital';
    for (const [s, u] of Object.entries(st.sleeves.quality?.units ?? {})) {
      units[s] = u;
      sleeveOf[s] = 'quality';
    }
    return { units, sleeveOf, wcUnitValue: st.sleeves.workingCapital.unitValue ?? 1, targets: st.targets ?? null, state: st, notes };
  }
  for (const [s, u] of Object.entries(st.units)) {
    if (s === CASH_SYM) {
      notes.push(`cash position ${u} units in the book is not an on-chain asset — target weights are renormalised over the held names`);
      continue;
    }
    units[s] = u;
  }
  return { units, sleeveOf, wcUnitValue: null, targets: null, state: st, notes };
}

// ------------------------------------------------------------ trade planning
/**
 * Owner choice 3 of the planner spec of 2026-10-01 (§5, still open). true —
 * the spec's rule (§1.3 step 2, unit test 10): a name that the rulebook's own
 * tests mark (the tolerance, the cap, a sleeve's drift) makes its whole block
 * trade, as a registry change does. false — option ②: only a registry change
 * (an add, a removal not yet flagged on chain) or --reweight-block makes a
 * block trade, and a name marked by a rule test alone trades as before
 * (only against the other marked names). The plan records the value in
 * force as policy.blockOnRuleMarks.
 */
export const BLOCK_ON_RULE_MARKS = true;
/** The reason written on a name that is traded only because its block is. */
export const BLOCK_REASON = 'block: the book re-weighted every name of this block';

/**
 * When a plan leaves a block untraded, the largest gap between the vault and
 * the book among the block's names, as a note for the operator (no
 * threshold: it is printed whatever its size). A session stopped after its
 * registry change was executed leaves the entering names short, and a plan
 * made after that sees no add to mark it: without --reweight-block it plans
 * nothing for that block and the shortfall stays (second review of the
 * planner change, rehearsal ⑧c: 0 auctions). The note names the gap and the
 * flag. Pure; returns null when every name is traded.
 */
export function untradedGapNote(targets) {
  const held = targets.filter((t) => !t.traded && (t.bookUnits ?? (t.targetWeight > 0 ? 1 : 0)) > 0);
  if (held.length === 0) return null;
  const worst = held.reduce((m, t) => (Math.abs(t.currentWeight - t.targetWeight) > Math.abs(m.currentWeight - m.targetWeight) ? t : m));
  const gap = (worst.currentWeight - worst.targetWeight) * 100;
  return `untraded: ${held.length} name(s) of the book are not traded by this plan; the largest gap between the vault and the book among them is ${worst.symbol} ${gap >= 0 ? '+' : ''}${gap.toFixed(4)} pt — if an earlier session of an executed registry change was stopped before it finished, plan again with --reweight-block (workflow input reweight_block)`;
}

/**
 * The names whose reference on chain is further from the day's market price
 * than the executor's guard allows (policy.refDriftTolBps, the setting in
 * force — no new value), as a note for the operator: the executor will refuse
 * this plan until the next daily mark. Pure; null when every name is inside.
 */
export function referenceGuardNote(registry, marketRef, tolBps) {
  const off = [];
  for (const r of registry) {
    const m = marketRef[r.symbol];
    if (!(r.refPrice > 0n) || !(m > 0n)) continue;
    const bps = (Math.abs(Number(r.refPrice) - Number(m)) / Number(m)) * 10_000;
    if (bps > tolBps) off.push(`${r.symbol} ${(bps / 100).toFixed(2)}%`);
  }
  if (off.length === 0) return null;
  return `reference guard: ${off.join(', ')} from the day's market price, more than the executor's ${(tolBps / 100).toFixed(2)}% — the executor will refuse this plan; do not dispatch day7: wait for the next daily mark, then plan again`;
}

/**
 * Which names the rulebook says to trade, and the auctions that do it.
 * Pure over the rows given; exported so the executor can recompute residual
 * trades from live balances with the same rule.
 *
 * The vault follows the book. On a reconstitution the book does not trade
 * one name at a time: it sets the names its rule trades to their targets and
 * then scales EVERY unit of the block by one factor (paper-index.mjs
 * renormaliseBook, M9 2026-09-29; the Triens Quality sleeve by its own k;
 * qX20 re-weights every name when membership changes). So once any name of a
 * block is marked — an add, a removal not yet in removal on chain, a rule
 * test — every name of that block is traded to its book weight, and the
 * block's own value pays for it (planner spec 2026-10-01 §1.3). A block is
 * the whole basket for the ranked indexes; for the sleeve indexes it is the
 * Quality sleeve unless the sleeves reset, when it is every name.
 *
 * rows: [{symbol, address, decimals, balance (bigint), ref (bigint, USD×1e18 per
 *        base unit), targetWeight (0..1), isAdd, isRemove, inRemoval, sleeve,
 *        bookUnits}]
 * policy: {tolerancePoints, capMaxWeight, sleeve (bool), qualityCap, duration,
 *          minTradeUsd, blockOnRuleMarks}
 * forceTraded: symbols to trade regardless (they also open their block,
 * unless onlyForced); onlyForced: apply no rule and no block beyond them (the
 * executor's residual rounds stay inside the plan's set); reweightBlock: open
 * every block although nothing in it is marked (--reweight-block: resuming a
 * session whose registry change has already been executed).
 */
export function computeTrades(rows, policy, { forceTraded = null, onlyForced = false, reweightBlock = false } = {}) {
  const value = (r) => r.balance * r.ref; // USD × 1e18 (bigint)
  const total = rows.reduce((t, r) => t + value(r), 0n);
  const totalF = Number(total);
  const cur = (r) => (totalF > 0 ? Number(value(r)) / totalF : 0);
  const tol = policy.tolerancePoints / 100;
  const ruleOpens = policy.blockOnRuleMarks ?? BLOCK_ON_RULE_MARKS;

  const traded = new Set(forceTraded ?? []);
  const reasons = {};
  // Names whose mark says the book re-weighted their block.
  const opens = new Set(onlyForced ? [] : (forceTraded ?? []));
  const mark = (r, why, opensBlock = true) => {
    traded.add(r.symbol);
    reasons[r.symbol] = [...(reasons[r.symbol] ?? []), why];
    if (opensBlock) opens.add(r.symbol);
  };
  for (const r of rows) {
    if (r.isAdd) mark(r, 'add');
    // A removal already flagged on chain is the remnant of an earlier session
    // (option K drains it); it does not re-open its block — that would
    // re-trade the earlier session's rounding.
    if (r.isRemove) mark(r, 'remove', !r.inRemoval);
  }
  const capNote = [];
  let sleeveReset = false;
  if (onlyForced) {
    // residual round: the set is fixed, only the amounts are recomputed
  } else if (policy.sleeve) {
    // Sleeve rule (barbell.json / triens.json reconstitution.tolerance): if
    // EVERY sleeve is within the tolerance nothing moves between sleeves;
    // otherwise every sleeve resets to target. Inside the quality sleeve the
    // per-name rule applies against sleeve-internal weights, cap override
    // included.
    const sleeves = {};
    for (const r of rows) {
      const s = r.sleeve ?? 'quality';
      sleeves[s] ??= { cur: 0, tgt: 0 };
      sleeves[s].cur += cur(r);
      sleeves[s].tgt += r.targetWeight;
    }
    sleeveReset = Object.values(sleeves).some((s) => Math.abs(s.cur - s.tgt) >= tol);
    if (sleeveReset) {
      for (const r of rows) mark(r, 'sleeve reset');
      capNote.push(`sleeve reset: ${Object.entries(sleeves).map(([k, v]) => `${k} ${(v.cur * 100).toFixed(1)}%→${(v.tgt * 100).toFixed(1)}%`).join(', ')}`);
    } else {
      const q = sleeves.quality;
      if (q && q.cur > 0 && q.tgt > 0) {
        for (const r of rows.filter((x) => x.sleeve === 'quality')) {
          const ci = cur(r) / q.cur;
          const ti = r.targetWeight / q.tgt;
          if (Math.abs(ci - ti) >= tol) mark(r, `quality drift ${((ci - ti) * 100).toFixed(1)}pt`, ruleOpens);
          // Above the cap opens the block only where the book is not itself
          // above it: a vault that matches a book drifted over the cap is the
          // vault following the book, and the book trades no cap between
          // reconstitutions.
          if (policy.qualityCap && ci > policy.qualityCap + 1e-9) mark(r, `above quality cap ${(ci * 100).toFixed(1)}%`, ruleOpens && ti <= policy.qualityCap + 1e-9);
        }
      }
    }
  } else {
    for (const r of rows) {
      const c = cur(r);
      const d = c - r.targetWeight;
      if (!r.isAdd && !r.isRemove && Math.abs(d) >= tol) mark(r, `drift ${(d * 100).toFixed(1)}pt`, ruleOpens);
      if (policy.capMaxWeight && c > policy.capMaxWeight + 1e-9) mark(r, `above cap ${(c * 100).toFixed(1)}%`, ruleOpens && r.targetWeight <= policy.capMaxWeight + 1e-9);
    }
  }

  // Blocks: a marked name trades its whole block to the book (see above).
  if (!onlyForced) {
    const blocks = !policy.sleeve || sleeveReset
      ? [{ name: 'basket', rows }]
      : [{ name: 'quality sleeve', rows: rows.filter((r) => (r.sleeve ?? 'quality') === 'quality') }];
    for (const b of blocks) {
      const by = b.rows.filter((r) => opens.has(r.symbol)).map((r) => r.symbol);
      if (!reweightBlock && by.length === 0) continue;
      const added = b.rows.filter((r) => !traded.has(r.symbol));
      for (const r of added) mark(r, BLOCK_REASON, false);
      if (added.length) capNote.push(`block rule: every name of the ${b.name} is traded to its book weight (opened by ${by.length ? by.join(', ') : '--reweight-block'}; ${added.length} name(s) added: ${added.map((r) => r.symbol).join(', ')})`);
    }
  }

  // The untouched names keep their value; the traded names share what the
  // traded set holds today in proportion to their book targets (removes → 0).
  // With the block rule the traded set is a whole block, so its targets are
  // the book's weights rescaled to the block's share of the vault.
  const T = rows.filter((r) => traded.has(r.symbol));
  const tradedValue = T.reduce((t, r) => t + value(r), 0n);
  const tradedTargetW = T.reduce((t, r) => t + (r.isRemove ? 0 : r.targetWeight), 0);
  const deltas = new Map(); // symbol → bigint USD×1e18, + means buy
  for (const r of T) {
    const targetValue = r.isRemove || tradedTargetW <= 0
      ? 0n
      : BigInt(Math.round((r.targetWeight / tradedTargetW) * 1e12)) * tradedValue / 10n ** 12n;
    deltas.set(r.symbol, r.isRemove ? -value(r) : targetValue - value(r));
  }
  const bySym = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  const sells = [...deltas].filter(([, d]) => d < 0n).map(([s, d]) => ({ symbol: s, left: -d })).sort((a, b) => (b.left > a.left ? 1 : -1));
  const buys = [...deltas].filter(([, d]) => d > 0n).map(([s, d]) => ({ symbol: s, left: d })).sort((a, b) => (b.left > a.left ? 1 : -1));
  const minValue = BigInt(Math.round((policy.minTradeUsd ?? 1) * 1e18));

  const trades = [];
  const sold = new Map(); // seller symbol → base units already sliced off in earlier trades
  let si = 0;
  let bi = 0;
  while (si < sells.length && bi < buys.length) {
    const s = sells[si];
    const b = buys[bi];
    const v = s.left < b.left ? s.left : b.left;
    const sr = bySym[s.symbol];
    const br = bySym[b.symbol];
    if (v >= minValue) {
      const isLastForSeller = s.left - v < minValue;
      // A removal's last slice sells whatever REMAINS of the balance (drain:
      // the executor re-reads the live balance and sells exactly that). The
      // balance is zero after the fill only if nothing reached the vault
      // between that read and the fill — a creation or a plain transfer in
      // that window leaves a remnant, and finalizeRemoval refuses any nonzero
      // balance; the executor drains the remnant and finalizes right after the
      // fill. Only the remainder, not the whole pre-session balance — a
      // removal split over two buys would otherwise be booked twice here and
      // in expectedPostTradeWeights (the numbers the decision draft prints).
      const drain = sr.isRemove && isLastForSeller;
      const remaining = sr.balance - (sold.get(s.symbol) ?? 0n);
      const slice = v / sr.ref;
      const sellAmount = drain ? remaining : (slice < remaining ? slice : remaining);
      if (sellAmount > 0n) {
        sold.set(s.symbol, (sold.get(s.symbol) ?? 0n) + sellAmount);
        const buyAtFair = (sellAmount * sr.ref + br.ref - 1n) / br.ref;
        trades.push({
          seq: trades.length + 1,
          sell: s.symbol, sellAddress: sr.address, buy: b.symbol, buyAddress: br.address,
          sellAmount, sellValueUsd: Number(sellAmount * sr.ref) / 1e18,
          expectedBuyAtFair: buyAtFair,
          expectedBuyAtOpen: (buyAtFair * 10_200n + 9_999n) / 10_000n,
          duration: policy.duration,
          drain,
          reason: `${reasons[s.symbol]?.join('+') ?? '?'} → ${reasons[b.symbol]?.join('+') ?? '?'}`,
        });
      }
    }
    s.left -= v;
    b.left -= v;
    if (s.left < minValue) si++;
    if (b.left < minValue) bi++;
  }

  // Expected weights after every fill at the plan's own prices (fair point).
  const post = new Map(rows.map((r) => [r.symbol, value(r)]));
  for (const t of trades) {
    post.set(t.sell, post.get(t.sell) - t.sellAmount * bySym[t.sell].ref);
    post.set(t.buy, post.get(t.buy) + t.expectedBuyAtFair * bySym[t.buy].ref);
  }
  const postTotal = [...post.values()].reduce((a, b) => a + b, 0n);
  const expectedPostTradeWeights = rows.map((r) => ({
    symbol: r.symbol,
    weight: postTotal > 0n ? Number(post.get(r.symbol)) / Number(postTotal) : 0,
    targetWeight: r.targetWeight,
  }));

  // What the auctions can actually reach: the untraded names keep their
  // weight, so the traded set shares only its own value — its book targets
  // scaled by Σcurrent/Σtarget over the set. The executor verifies against
  // THIS. With a whole block traded it is the book weight itself (ranked
  // indexes) or the book's weight inside the sleeve times the sleeve's
  // share (Triens without a sleeve reset).
  const targets = rows.map((r) => ({
    symbol: r.symbol,
    ...(r.sleeve ? { sleeve: r.sleeve } : {}),
    ...(r.bookUnits != null ? { bookUnits: r.bookUnits } : {}),
    targetWeight: r.targetWeight,
    tradeTargetWeight: totalF > 0 ? Number(value(r) + (deltas.get(r.symbol) ?? 0n)) / totalF : 0,
    currentWeight: cur(r),
    driftPoints: Math.round((cur(r) - r.targetWeight) * 1000) / 10,
    traded: traded.has(r.symbol),
    reason: reasons[r.symbol]?.join('; ') ?? null,
  }));
  return { targets, trades, expectedPostTradeWeights, notes: capNote, totalValueUsd: totalF / 1e18 };
}

// ---------------------------------------------------------------------- main
function argParse(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  return { flag, opt };
}

/**
 * The rows computeTrades plans from (planner spec 2026-10-01 §1.3). Every
 * row is valued at the price the contract will fill at: a registry name at
 * its reference on chain (a name with no reference yet at source A, then its
 * last mark), an add at the first reference the session posts. The book is
 * valued at the SAME prices, so a block traded to these targets ends with
 * balances exactly proportional to the book's units, whatever the price
 * level. Pure; exported for keeper/test/plan-trades.test.mjs.
 *
 * registry: [{symbol, address, decimals, balance, refPrice, inRemoval}] (chain)
 * adds:     [{symbol, address, decimals, firstRefPrice}]
 * book:     readBook() — {units, sleeveOf}
 * priceA:   symbol → USD per token today (source A), or null
 * Returns {rows, marketRef}: marketRef[symbol] is the day's market price as a
 * reference (planRefPrice — what the executor's 5% guard compares with).
 */
export function planRows({ registry, adds, book, isSleeve, priceA }) {
  const rows = [];
  const marketRef = {};
  for (const r of registry) {
    const p = priceA(r.symbol);
    marketRef[r.symbol] = p > 0 ? toRefPrice(p, r.decimals) : r.refPrice; // a name without a price today is valued at its last mark
    rows.push({
      symbol: r.symbol, address: r.address, decimals: r.decimals, balance: r.balance,
      ref: r.refPrice > 0n ? r.refPrice : marketRef[r.symbol],
      chainRef: r.refPrice > 0n ? r.refPrice : null,
      targetWeight: 0,
      isAdd: false, isRemove: !book.units[r.symbol], inRemoval: r.inRemoval, sleeve: book.sleeveOf[r.symbol] ?? (isSleeve ? 'quality' : undefined),
      bookUnits: book.units[r.symbol] ?? 0,
    });
  }
  for (const a of adds) {
    rows.push({
      symbol: a.symbol, address: a.address, decimals: a.decimals, balance: 0n, ref: a.firstRefPrice, chainRef: null,
      targetWeight: 0, isAdd: true, isRemove: false, inRemoval: false, sleeve: book.sleeveOf[a.symbol] ?? (isSleeve ? 'quality' : undefined),
      bookUnits: book.units[a.symbol],
    });
  }
  const usdPerToken = (r) => (Number(r.ref) * 10 ** r.decimals) / 1e18;
  let bookValue = 0;
  for (const r of rows) {
    if (!r.bookUnits) continue;
    if (!(r.ref > 0n)) throw new Error(`${r.symbol}: no reference on chain and no price from source A for a book member`);
    bookValue += r.bookUnits * usdPerToken(r);
  }
  for (const r of rows) r.targetWeight = r.bookUnits ? (r.bookUnits * usdPerToken(r)) / bookValue : 0;
  return { rows, marketRef };
}

export async function buildPlan(o) {
  const index = o.index;
  const date = o.date;
  const { rulebook, path: rulebookPath, sha256: rulebookSha } = loadRulebook(index);
  const basket = rulebook.basket;
  if (!basket?.vault) throw new Error(`${index}: rulebook basket.vault is null — nothing to plan`);
  const isSleeve = SLEEVE_INDEXES.has(index);
  const log = (m) => console.log(`[plan:${index}] ${m}`);

  // ---- chain
  const reader = await makeReader(o.rpc, { chainId: o.chainId });
  log(`rpc ${o.rpc} (chain ${reader.chainId}, multicall3 ${reader.hasMulticall ? 'yes' : 'NO — sequential reads'}, pace ${reader.pace} ms)`);
  const v = await readVault(reader, basket.vault);
  log(`vault ${v.vault}: ${v.assetCount} assets, supply ${(Number(v.totalSupply) / 1e18).toFixed(0)} shares, nav ${(Number(v.navPerShare) / 1e6).toFixed(6)}, pending ${v.pendingRegistryChange === `0x${'0'.repeat(64)}` ? 'none' : `${v.pendingRegistryChange} (eta ${new Date(Number(v.pendingRegistryEta) * 1000).toISOString()})`}, block ${v.block.number}`);

  // ---- the book and the registry, joined by symbol through the rulebook
  const bookPath = o.book ?? (index === 'qx20' ? path.join(HERE, 'state.json') : path.join(HERE, `state-${index}.json`));
  const book = readBook(index, bookPath, rulebook);
  const addrToSym = {};
  const symMeta = {};
  for (const [sym, e] of Object.entries(basket.assets ?? {})) {
    const address = getAddress(typeof e === 'string' ? e : e.address);
    addrToSym[address] = sym;
    symMeta[sym] = { address, decimals: typeof e === 'string' ? null : e.decimals ?? null };
  }
  const registry = v.assets.map((a) => {
    // A registry asset the rulebook does not name yet (added on chain before
    // the rulebook caught up) is named by its own symbol, minus the mock
    // prefix — flagged so the rulebook edit is not forgotten.
    let symbol = addrToSym[a.address];
    let symbolSource = 'rulebook';
    if (!symbol) {
      symbol = a.onchainSymbol.replace(/^m(?=[A-Z0-9])/, '');
      symbolSource = 'onchain-symbol (NOT in rulebook basket.assets)';
    }
    return { ...a, symbol, symbolSource };
  });
  const registrySyms = new Set(registry.map((r) => r.symbol));
  const bookSyms = Object.keys(book.units);
  const addsSym = bookSyms.filter((s) => !registrySyms.has(s));
  const removesSym = registry.filter((r) => !book.units[r.symbol]).map((r) => r.symbol);
  log(`book ${path.relative(ROOT, bookPath)}: ${bookSyms.length} names; registry ${registry.length}; adds ${addsSym.join(',') || '—'}; removes ${removesSym.join(',') || '—'}`);

  // ---- pending-registry file (the daily run's work order), if any
  const pendingPath = o.pending ?? path.join(HERE, `pending-registry-${index}.json`);
  let pending = null;
  if (fs.existsSync(pendingPath)) {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    const pa = (pending.adds ?? []).map((x) => x.symbol).sort().join(',');
    const pr = (pending.removes ?? []).map((x) => x.symbol).sort().join(',');
    if (pa !== [...addsSym].sort().join(',') || pr !== [...removesSym].sort().join(',')) {
      throw new Error(`${path.relative(ROOT, pendingPath)} says adds [${pa}] removes [${pr}] but the book vs the registry says adds [${addsSym.join(',')}] removes [${removesSym.join(',')}] — resolve before planning`);
    }
    log(`pending file ${path.relative(ROOT, pendingPath)} agrees (written ${pending.date})`);
  }

  // ---- prices: two sources
  const A = await loadSourceA(date, !o.noFetch);
  const B = await loadSourceB(date, o.pricesB, !o.noFetch);
  const row = recordRow(index, date);
  const rowPrices = Object.fromEntries((row?.members ?? []).map((m) => [m.symbol, m.price]));
  const priceA = (sym) => {
    if (sym === 'WC') return book.wcUnitValue;
    if (A.prices[sym] > 0) return A.prices[sym];
    return rowPrices[sym] > 0 ? rowPrices[sym] : null;
  };
  const priceB = (sym) => (sym === 'WC' ? book.wcUnitValue : B.prices[sym] > 0 ? B.prices[sym] : null);
  log(`prices A: ${A.label}; B: ${B.label}${row ? `; record row ${date} seq ${row.seq} as fallback for A` : ''}`);

  // ---- mocks for the adds (deployed addresses), decimals, first prices
  // keeper/deploy-mocks.mjs writes one file per date keyed by index
  // ({qrev: {SYRUP: {address, decimals}}, …}) — every basket has its own mock
  // per name; a flat {SYMBOL: {address, decimals}} file is read as it is.
  const mocksRaw = o.mocks ? JSON.parse(fs.readFileSync(o.mocks, 'utf8')) : {};
  const mocks = mocksRaw[index] && typeof mocksRaw[index] === 'object' && !mocksRaw[index].address ? mocksRaw[index] : mocksRaw;
  const adds = [];
  for (const sym of addsSym) {
    const a = priceA(sym);
    const b = priceB(sym);
    if (!(a > 0)) throw new Error(`${sym}: no price from source A — cannot size a first reference`);
    const fromPending = (pending?.adds ?? []).find((x) => x.symbol === sym);
    const known = mocks[sym] ?? (fromPending?.address ? { address: fromPending.address, decimals: fromPending.decimals ?? null } : null);
    let address = known?.address && isAddress(known.address) ? getAddress(known.address) : null;
    let decimals = decimalsByPrice(a);
    let decimalsSource = 'price rule clamp(floor(log10 p)+9, 0, 18)';
    if (address) {
      const code = await reader.publicClient.getCode({ address }).catch(() => undefined);
      if (!code || code === '0x') throw new Error(`${sym}: ${address} has no code on this chain`);
      const [dec, osym] = await reader.batch([
        { address, abi: ERC20_ABI, functionName: 'decimals' },
        { address, abi: ERC20_ABI, functionName: 'symbol' },
      ]);
      if (Number(dec) !== decimals) log(`  ${sym}: deployed mock has ${dec} decimals, the price rule says ${decimals} — the chain wins; first price sized to ${dec}`);
      decimals = Number(dec);
      decimalsSource = `onchain ${address} (${osym})`;
    }
    adds.push({
      symbol: sym, address, decimals, decimalsSource,
      priceA: a, priceB: b, disagreementBps: bpsDiff(a, b),
      firstRefPrice: toRefPrice(a, decimals),
      firstRefPriceB: b > 0 ? toRefPrice(b, decimals) : null,
      targetUnits: book.units[sym],
    });
  }
  const removes = registry.filter((r) => removesSym.includes(r.symbol)).map((r) => ({
    symbol: r.symbol, address: r.address, decimals: r.decimals, balance: r.balance, inRemoval: r.inRemoval,
  }));

  // ---- decision hash
  // The sha pinned into the announcement must be THIS basket's decision: the
  // ledger names files `{date}-{index}-…`, and a sha of another basket's
  // document would be pinned on chain for good (the executor checks again).
  const decisionFile = `trackrecord/decisions/${date}-${index}-basket-reconstitution.md`;
  const belongsHere = (e) => e.file.includes(`-${index}-`) || `trackrecord/${e.file}` === decisionFile;
  const ledger = loadDecisions(o.decisions);
  let decisionSha256 = pending?.decisionSha256 ?? null;
  let decisionId = null;
  if (o.decision) {
    const d = ledger.find((e) => e.id === o.decision);
    if (!d) throw new Error(`decision ${o.decision} is not in ${path.relative(ROOT, o.decisions)}`);
    if (!belongsHere(d)) throw new Error(`decision ${d.id} (${d.file}) is not a ${index} decision — its sha would be pinned into this vault's announcement`);
    decisionSha256 = d.sha256;
    decisionId = d.id;
  } else if (decisionSha256) {
    const d = ledger.find((e) => e.sha256 === decisionSha256) ?? null;
    if (d && !belongsHere(d)) throw new Error(`${path.relative(ROOT, pendingPath)} carries decisionSha256 of ${d.id} (${d.file}), which is not a ${index} decision`);
    decisionId = d?.id ?? null;
  }

  // ---- carry a pending on-chain change forward (announce happened already)
  let carried = null;
  const ZERO32 = `0x${'0'.repeat(64)}`;
  const removesForTuple = removes.filter((r) => !r.inRemoval).map((r) => r.address);
  let announceTuple = null;
  if (v.pendingRegistryChange !== ZERO32) {
    const prevPath = latestPlan(index);
    const prev = prevPath ? loadPlan(prevPath) : null;
    if (!prev?.announce?.pendingHash || prev.announce.pendingHash.toLowerCase() !== v.pendingRegistryChange.toLowerCase()) {
      throw new Error(`the vault has a pending registry change ${v.pendingRegistryChange} that no plan in keeper/plans/${index}/ announced — refusing to plan over an unknown announcement`);
    }
    carried = { from: path.relative(ROOT, prevPath), announce: prev.announce, announceTuple: prev.announce.tuple, decisionSha256: prev.decisionSha256 };
    if (decisionSha256 && decisionSha256 !== prev.decisionSha256) log(`  decision ${decisionId ?? decisionSha256.slice(0, 12) + '…'} given today is not the announced one — the announcement's decisionSha256 is kept`);
    decisionSha256 = prev.decisionSha256;
    decisionId = prev.announce.decisionId ?? prev.decisionId ?? ledger.find((e) => e.sha256 === decisionSha256)?.id ?? null;
    log(`carrying the announced tuple from ${carried.from} (eta ${new Date(Number(v.pendingRegistryEta) * 1000).toISOString()})`);
    // The tuple is frozen by the announcement: the adds' addresses come from it.
    for (const ad of adds) {
      const prevAdd = (prev.adds ?? []).find((x) => x.symbol === ad.symbol);
      if (prevAdd?.address && prevAdd.address !== ad.address) throw new Error(`${ad.symbol}: address ${ad.address ?? 'null'} differs from the announced ${prevAdd.address}`);
      if (prevAdd?.address && !ad.address) ad.address = prevAdd.address;
    }
    // …and so is its ORDER: keccak(abi.encode(address[], address[], bytes32))
    // is order-sensitive, while the book's key order can change between the
    // announcement and day 7 (update-nav.mjs rebuilds qX20's units in rank
    // order). The announced tuple is carried verbatim; today's book may only
    // be checked against it as a set.
    const same = (a, b) => a.length === b.length && [...a].map((x) => String(x).toLowerCase()).sort().join() === [...b].map((x) => String(x).toLowerCase()).sort().join();
    const nowAdds = adds.map((a) => a.address);
    const prevTuple = prev.announce.tuple;
    if (!same(nowAdds, prevTuple.adds) || !same(removesForTuple, prevTuple.removes)) {
      throw new Error(`book vs announced tuple differ — adds [${nowAdds.join(',')}] / announced [${prevTuple.adds.join(',')}], removes [${removesForTuple.join(',')}] / announced [${prevTuple.removes.join(',')}] — the announcement cannot be amended; execute it or wait it out`);
    }
    announceTuple = prevTuple;
  } else if (adds.length + removesForTuple.length === 0) {
    // A weight-only change (drift, cap, sleeve reset) has nothing to announce.
    // An empty announcement is accepted by the contract and blocks the vault's
    // auctions for REGISTRY_DELAY, so the tuple stays null even with a decision.
    announceTuple = null;
  } else if (adds.every((a) => a.address) && decisionSha256) {
    announceTuple = { adds: adds.map((a) => a.address), removes: removesForTuple, decisionSha256: `0x${decisionSha256}` };
  }
  const weightOnly = adds.length + removesForTuple.length === 0;

  // ---- targets, tolerance, cap, trades
  const tolerancePoints = rulebook.reconstitution?.tolerance?.thresholdPoints ?? rulebook.reconstitution?.driftBand?.points ?? 5;
  const capMaxWeight = isSleeve ? null : rulebook.weighting?.cap?.maxWeight ?? null;
  const qualityCap = isSleeve ? rulebook.weighting?.cap?.maxWeight ?? null : null;
  // minTradeUsd ($1) carries no cited test (planner spec 2026-10-01, appendix
  // A; owner choice 2 keeps it until a value is tested or priced).
  // blockOnRuleMarks: owner choice 3, see BLOCK_ON_RULE_MARKS.
  // priceBasis: the auctions are sized at the references the contract fills
  // at (spec §1.3); priceA stays the market check of the 5% guard.
  const policy = { tolerancePoints, capMaxWeight, qualityCap, sleeve: isSleeve, duration: o.duration, minTradeUsd: 1, fill: 'fair', firstPriceTolBps: 200, refDriftTolBps: 500, blockOnRuleMarks: BLOCK_ON_RULE_MARKS, priceBasis: 'chain refPrice; an add at its first reference (source A)' };

  const { rows, marketRef } = planRows({ registry, adds, book, isSleeve, priceA });
  const plan0 = computeTrades(rows, policy, { reweightBlock: !!o.reweightBlock });
  log(`tolerance ${tolerancePoints} pt, cap ${capMaxWeight ?? qualityCap ?? '—'}${isSleeve ? ' (quality sleeve)' : ''}, duration ${o.duration} s; block rule on rule marks ${policy.blockOnRuleMarks ? 'yes' : 'no'}${o.reweightBlock ? '; --reweight-block' : ''}; vault value at the chain references $${plan0.totalValueUsd.toFixed(0)}`);
  for (const t of plan0.targets) {
    log(`  ${t.symbol.padEnd(7)} book ${(t.targetWeight * 100).toFixed(2).padStart(6)}%  vault ${(t.currentWeight * 100).toFixed(2).padStart(6)}%  drift ${String(t.driftPoints).padStart(6)} pt  ${t.traded ? `TRADE → ${(t.tradeTargetWeight * 100).toFixed(2)}% (${t.reason})` : 'hold'}`);
  }
  for (const t of plan0.trades) {
    log(`  #${t.seq} sell ${t.sell} → buy ${t.buy}: ${t.sellAmount} base units ($${t.sellValueUsd.toFixed(0)})${t.drain ? ' [drain]' : ''} ${t.duration}s`);
  }
  for (const n of plan0.notes) log(`  ${n}`);
  const gapNote = untradedGapNote(plan0.targets);
  if (gapNote) log(`  NOTE ${gapNote}`);
  // The executor refuses a session while a chain reference is more than
  // refDriftTolBps from the day's market price. Say so here, where nothing
  // has been sent: found by day7 only at its auctions stage, the registry
  // change is already executed by then.
  const guardNote = referenceGuardNote(registry, marketRef, policy.refDriftTolBps);
  if (guardNote) log(`  NOTE ${guardNote}`);

  const plan = {
    schema: 'basket-recon-plan/1',
    index, ticker: TICKER[index], date, generatedAt: new Date().toISOString(),
    chainId: reader.chainId, rpc: o.rpc, vault: v.vault,
    block: v.block,
    keeperRun: process.env.GITHUB_RUN_ID ? { id: process.env.GITHUB_RUN_ID, workflow: process.env.GITHUB_WORKFLOW ?? null } : null,
    sources: {
      book: path.relative(ROOT, bookPath),
      pending: pending ? path.relative(ROOT, pendingPath) : null,
      priceA: A.label, priceB: B.label,
      recordRow: row ? { seq: row.seq, hash: row.hash } : null,
      rulebook: { path: rulebookPath, sha256: rulebookSha },
      mocks: o.mocks ?? null,
      decisions: path.relative(ROOT, o.decisions),
    },
    vaultState: {
      owner: v.owner, keeper: v.keeper, assetCount: v.assetCount, totalSupply: v.totalSupply, navPerShare: v.navPerShare,
      pendingRegistryChange: v.pendingRegistryChange, pendingRegistryEta: v.pendingRegistryEta,
      maxRefAge: v.maxRefAge, maxFillLossBps: v.maxFillLossBps, dailyLossBudgetBps: v.dailyLossBudgetBps,
      biddingOpen: v.biddingOpen, auctionCount: v.auctionCount, premiumBps: v.premiumBps, registryDelay: v.registryDelay,
    },
    registry: registry.map((r) => ({
      i: r.i, symbol: r.symbol, symbolSource: r.symbolSource, address: r.address, decimals: r.decimals, balance: r.balance,
      refPrice: r.refPrice, refPriceUpdatedAt: r.refPriceUpdatedAt, inRemoval: r.inRemoval,
      // the day's market price as a reference — what the executor's 5% guard compares the chain with
      planRefPrice: marketRef[r.symbol] ?? null,
      // the reference every amount of this plan is sized at; the executor
      // refuses to trade if the chain no longer shows it
      chainRefAtPlan: rows.find((x) => x.symbol === r.symbol)?.chainRef ?? null,
      priceA: priceA(r.symbol), priceB: priceB(r.symbol), disagreementBps: bpsDiff(priceA(r.symbol), priceB(r.symbol)),
    })),
    adds, removes,
    decisionSha256, decisionId,
    decisionFile,
    announceTuple,
    carried,
    policy,
    targets: plan0.targets,
    trades: plan0.trades,
    expectedPostTradeWeights: plan0.expectedPostTradeWeights,
    notes: [
      ...book.notes,
      ...(o.reweightBlock ? ['--reweight-block: every block traded to the book although no registry change is pending in this plan (a session resumed after its registry change was executed)'] : []),
      ...plan0.notes,
      ...(gapNote ? [gapNote] : []),
      ...(guardNote ? [guardNote] : []),
      'The vault lags the index by REGISTRY_DELAY (7 days) at every registry change; the record does not wait. Publish the tracking difference.',
      ...(weightOnly ? ['nothing to announce (weight-only change): the registry is unchanged, so no announcement is made — auctions only'] : []),
      ...(announceTuple || weightOnly ? [] : [`announce tuple incomplete: ${adds.filter((a) => !a.address).map((a) => a.symbol).join(',') || 'addresses ok'}${decisionSha256 ? '' : '; decisionSha256 null (anchor the decision document first)'}`]),
    ],
    announce: carried?.announce ?? null,
    execute: null,
    firstPrices: [],
    fills: [],
    finalize: [],
    verify: null,
  };
  const out = o.out ?? planPath(index, date);
  savePlan(out, plan);
  log(`wrote ${path.relative(ROOT, out)} — ${adds.length} add(s), ${removes.length} remove(s), ${plan0.trades.length} auction(s), decisionSha256 ${decisionSha256 ? decisionSha256.slice(0, 12) + '…' : 'null'}`);
  return { plan, path: out };
}

async function main() {
  const { flag, opt } = argParse(process.argv.slice(2));
  const index = opt('--index', null);
  if (!INDEXES.includes(index)) {
    console.error(`usage: node keeper/basket-plan.mjs --index ${INDEXES.join('|')} [--date YYYY-MM-DD] [--rpc URL] [--pending p] [--book p] [--mocks p] [--prices-b p] [--decisions p] [--decision id] [--duration s] [--out p] [--no-fetch] [--reweight-block]`);
    process.exit(2);
  }
  await buildPlan({
    index,
    date: opt('--date', new Date().toISOString().slice(0, 10)),
    rpc: opt('--rpc', GIWA_RPC),
    chainId: Number(opt('--chain-id', GIWA_CHAIN_ID)),
    pending: opt('--pending', null),
    book: opt('--book', null),
    mocks: opt('--mocks', null),
    pricesB: opt('--prices-b', null),
    decisions: opt('--decisions', DECISIONS_LEDGER),
    decision: opt('--decision', null),
    duration: Number(opt('--duration', 900)),
    out: opt('--out', null),
    noFetch: flag('--no-fetch'),
    reweightBlock: flag('--reweight-block'),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
}
