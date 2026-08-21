/**
 * qX20 index NAV keeper.
 *
 * Runs the public engine methodology (top-20 by market cap after exclusions,
 * 60% single-asset cap) against live market data, marks the portfolio to
 * market, and posts the resulting NAV to the QuadrixIndexVault on GIWA
 * Sepolia. Band rebalancing: the model book is only re-weighted when a
 * constituent drifts more than REBALANCE_BAND from target (or the membership
 * changes), so turnover — and the friction cost it would carry on mainnet —
 * stays minimal. Model units persist in state.json so the index level is
 * continuous across runs.
 *
 * Usage: KEEPER_PK=0x... node contracts/keeper/update-nav.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const VAULT = '0x1d1115b961832dd921be78cf1362a531b69bcaa0';
const KEEPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(KEEPER_DIR, 'state.json');
// state.json is a working file — it is overwritten every run so the model book
// stays continuous. The record of what was actually posted is the append-only
// ledger below, which is never rewritten. Keeping the two apart is what lets
// this repository keep saying "nothing here is edited after the fact".
const MARKS_PATH = path.join(KEEPER_DIR, 'nav-marks.jsonl');

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

const ABI = parseAbi([
  'function setNav(uint256 newNavPerShare, uint256 indexLevel) external',
  'function navPerShare() view returns (uint256)',
]);

// Same universe rules as the site's engine demo (indexEngine DEFAULT_EXCLUSIONS
// + the 2026 additions from the Engine page).
const EXCLUDE = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'FEI', 'TUSD', 'USDP', 'WBTC', 'LEO', 'TON',
  'OKB', 'OMG', 'LTC', 'XMR', 'DASH', 'ZEC', 'PIVX', 'XVG', 'KMD',
  'USDS', 'USDE', 'USD1', 'PYUSD', 'FDUSD', 'USDD', 'USDF', 'RLUSD', 'USDT0', 'USDG',
  'WETH', 'STETH', 'WSTETH', 'WEETH', 'WBETH', 'CBBTC', 'BSC-USD', 'JITOSOL',
  'SUSDE', 'SUSDS', 'BTCB', 'KHYPE', 'USDTB', 'BFUSD', 'SYRUPUSDC', 'PAXG',
  'WBT', 'BGB', 'GT', 'KCS', 'FIGR_HELOC', 'USYC', 'BUIDL',
]);
const TOP_N = 20;
const MAX_WEIGHT = 0.6;
/** Abort rather than post a NAV that moves more than this in one run. The
 *  contract enforces ±25%; this stops well short so a bad feed surfaces as a
 *  failed run instead of a silently clamped, wrong NAV. */
const SANITY_MOVE_PCT = 15;
/** Re-weight only when a constituent drifts this far from target (5%p). */
const REBALANCE_BAND = 0.05;
/** Membership rank buffers: incumbents stay until they fall below EXIT_RANK,
 *  outsiders force their way in only above ENTRY_RANK — so a coin oscillating
 *  around rank 20 doesn't churn in and out every run. */
const ENTRY_RANK = 17;
const EXIT_RANK = 23;

/** Which upstream actually supplied the prices — reported in failure output so
 *  an operator can tell a real market move from one source disagreeing. */
let priceSource = 'none';

async function fetchMarkets() {
  // CoinGecko first, CoinPaprika fallback (CG throttles datacenter IPs).
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets' +
        '?vs_currency=usd&order=market_cap_desc&per_page=60&page=1'
    );
    const raw = await res.json();
    if (Array.isArray(raw)) {
      priceSource = 'coingecko';
      return raw.map((c) => ({
        symbol: String(c.symbol).toUpperCase(),
        price: c.current_price,
        marketCap: c.market_cap,
      }));
    }
  } catch { /* fall through */ }
  const res = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=80');
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('all market sources failed');
  priceSource = 'coinpaprika';
  return raw.map((c) => ({
    symbol: String(c.symbol).toUpperCase(),
    price: c.quotes?.USD?.price,
    marketCap: c.quotes?.USD?.market_cap,
  }));
}

function applyCap(weights, cap) {
  const w = new Map(weights.map((x) => [x.symbol, x.weight]));
  const capped = new Set();
  for (let i = 0; i < weights.length; i++) {
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

/** Buffered membership: keep incumbents while rank ≤ EXIT_RANK, force in
 *  outsiders at rank ≤ ENTRY_RANK, fill remaining seats by best rank. */
function targetMembership(ranked, incumbents) {
  const rank = new Map(ranked.map((m, i) => [m.symbol, i + 1]));
  let members = incumbents.filter((s) => (rank.get(s) ?? Infinity) <= EXIT_RANK);
  for (const m of ranked.slice(0, ENTRY_RANK)) {
    if (!members.includes(m.symbol)) members.push(m.symbol);
  }
  if (members.length > TOP_N) {
    members = members.sort((a, b) => rank.get(a) - rank.get(b)).slice(0, TOP_N);
  }
  for (const m of ranked) {
    if (members.length >= TOP_N) break;
    if (!members.includes(m.symbol)) members.push(m.symbol);
  }
  return new Set(members);
}

function targetWeights(markets, incumbents) {
  const ranked = markets
    .filter((m) => !EXCLUDE.has(m.symbol) && m.marketCap > 0 && m.price > 0)
    .sort((a, b) => b.marketCap - a.marketCap);
  const members = targetMembership(ranked, incumbents);
  const eligible = ranked.filter((m) => members.has(m.symbol));
  const total = eligible.reduce((s, m) => s + m.marketCap, 0);
  const raw = eligible.map((m) => ({ symbol: m.symbol, weight: m.marketCap / total }));
  return applyCap(raw, MAX_WEIGHT);
}

async function main() {
  const pk = process.env.KEEPER_PK;
  if (!pk) throw new Error('KEEPER_PK not set');

  const markets = await fetchMarkets();
  const prices = Object.fromEntries(markets.map((m) => [m.symbol, m.price]));

  // Mark the existing model book to market.
  let level = 1.0;
  let units = null;
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null;
  const weights = targetWeights(markets, state?.units ? Object.keys(state.units) : []);
  if (state?.units) {
    let value = 0;
    let missing = [];
    for (const [sym, u] of Object.entries(state.units)) {
      if (prices[sym] > 0) value += u * prices[sym];
      else missing.push(sym);
    }
    if (missing.length) console.warn('constituents without a live price (dropped):', missing);
    level = value;
    units = state.units;
  }

  // Reconstitution is MONTHLY — the published rule, and until 2026-08-21 not
  // the implemented one. This job runs every six hours so the on-chain NAV
  // stays fresh, but re-examining membership on every run is a different index:
  // it swapped constituents 117 times over the 2017-2026 sample against 53 for
  // the monthly rule, returned less (+1,082% vs +1,104%) and traded more (32%
  // vs 28% annual turnover). Between reconstitutions the book is marked to
  // market and only the drift band can move it.
  const month = new Date().toISOString().slice(0, 7);
  const isReconstitution = state?.reconstitutedIn !== month;
  const heldSymbols = units ? Object.keys(units) : [];

  const activeWeights = isReconstitution || !units
    ? weights
    : applyCap(
        // Between reconstitutions the membership is frozen; only the cap-weights
        // among the incumbents are refreshed.
        markets
          .filter((m) => heldSymbols.includes(m.symbol) && m.marketCap > 0 && m.price > 0)
          .map((m, _i, arr) => ({
            symbol: m.symbol,
            weight: m.marketCap / arr.reduce((t, x) => t + x.marketCap, 0),
          })),
        MAX_WEIGHT
      );

  const targets = Object.fromEntries(activeWeights.map((w) => [w.symbol, w.weight]));
  let rebalance = units === null;
  if (units !== null) {
    const wanted = Object.keys(targets);
    if (isReconstitution && (heldSymbols.length !== wanted.length || wanted.some((s) => !(s in units)))) {
      rebalance = true; // membership change, at a reconstitution
    } else {
      for (const [sym, u] of Object.entries(units)) {
        const drifted = (u * prices[sym]) / level;
        if (Math.abs(drifted - targets[sym]) > REBALANCE_BAND) {
          rebalance = true;
          break;
        }
      }
    }
  }
  if (rebalance) {
    units = Object.fromEntries(
      activeWeights.map((w) => [w.symbol, (level * w.weight) / prices[w.symbol]])
    );
  }
  console.log(
    rebalance
      ? `rebalanced to target weights (${isReconstitution ? 'monthly reconstitution' : 'drift band'})`
      : `within band — book held, zero turnover${isReconstitution ? ' (reconstitution: membership unchanged)' : ''}`
  );

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
  const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });

  const current = await publicClient.readContract({
    address: VAULT, abi: ABI, functionName: 'navPerShare',
  });
  let nav = BigInt(Math.round(level * 1e6));
  let override = null;

  // A move this large is either a genuine market event or — far more likely —
  // a bad price feed. Silently clamping to the contract's bound would post a
  // wrong NAV and hide the cause, so stop and let the run go red instead.
  const movePct = (Number(nav) / Number(current) - 1) * 100;
  if (Math.abs(movePct) > SANITY_MOVE_PCT) {
    // The threshold cannot tell a bad feed from a genuine crash, so it does not
    // try — it stops and hands the operator everything needed to decide.
    const movers = Object.entries(units)
      .map(([c, u]) => [c, (u * prices[c]) / level])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([c, w]) => `${c} ${(w * 100).toFixed(1)}% @ ${prices[c]}`)
      .join(', ');
    console.error(
      [
        '',
        '=== KEEPER HALTED — NAV not posted ===',
        `  timestamp     ${new Date().toISOString()}`,
        `  price source  ${priceSource}`,
        `  onchain NAV   ${Number(current) / 1e6}`,
        `  computed NAV  ${Number(nav) / 1e6}`,
        `  move          ${movePct.toFixed(2)}%  (threshold ±${SANITY_MOVE_PCT}%)`,
        `  book          ${movers}`,
        `  rebalanced    ${rebalance}`,
        '',
        '  Operator: see contracts/keeper/RUNBOOK.md before overriding.',
        '',
      ].join('\n')
    );
    // The only way past this gate is a human re-running the workflow with the
    // override input set — a deliberate, attributable act recorded in the run
    // log and in state.json, not a silent retry.
    if (process.env.KEEPER_ACK_MOVE !== 'true') {
      throw new Error(
        `refusing to post NAV: ${movePct.toFixed(2)}% move exceeds the ±${SANITY_MOVE_PCT}% threshold`
      );
    }
    console.warn(`OPERATOR OVERRIDE: posting the ${movePct.toFixed(2)}% move anyway.`);
    override = { movePct, priceSource, previousNav: Number(current) / 1e6 };
  }

  // Respect the contract's ±25% per-update bound; repeated runs converge.
  const hi = (current * 124n) / 100n;
  const lo = (current * 76n) / 100n;
  if (nav > hi) nav = hi;
  if (nav < lo) nav = lo;

  const hash = await wallet.writeContract({
    address: VAULT, abi: ABI, functionName: 'setNav', args: [nav, nav],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const postedAt = new Date().toISOString();

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ updatedAt: postedAt, level, units, priceSource, override,
      reconstitutedIn: isReconstitution ? month : (state?.reconstitutedIn ?? month) }, null, 2) + '\n'
  );

  // Append-only ledger of every mark this keeper has posted. One line, one
  // on-chain transaction — so the index level can be checked against the chain
  // for any past date without trusting state.json's current contents.
  fs.appendFileSync(
    MARKS_PATH,
    JSON.stringify({
      postedAt,
      vault: VAULT,
      chainId: 91342,
      navFrom: Number(current) / 1e6,
      navTo: Number(nav) / 1e6,
      level: Number(level.toFixed(6)),
      priceSource,
      override,
      txHash: hash,
    }) + '\n'
  );
  console.log(`nav ${Number(current) / 1e6} -> ${Number(nav) / 1e6} (level ${level.toFixed(6)})`, hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
