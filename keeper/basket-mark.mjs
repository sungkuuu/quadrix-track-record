/**
 * Basket marking — the on-chain leg of the paper-index keeper.
 *
 * When a rulebook carries a `basket` block with a deployed vault
 * (QuadrixBasketVault v3.1 on GIWA Sepolia), the daily run also:
 *
 *   (a) posts navPerShare = level / navBase × 1e6 (6 decimals), stepped in
 *       ≤ 14.9% increments when the move would exceed the contract's ±15%
 *       band — every step is one transaction and one log line;
 *   (b) posts refPrice for every registry asset from the day's prices, in
 *       the contract's unit (USD × 1e18 per BASE UNIT of the mock, so
 *       price × 1e18 / 10^decimals), with the same stepping; a re-post of
 *       an unchanged price still refreshes refPriceUpdatedAt, which is what
 *       lets auction fills execute (the v3.1 stale-reference guard).
 *       "Registry asset" is read from the vault (assetCount / assets(i),
 *       once per run), not taken from the rulebook: a basket.assets entry
 *       the vault does not hold yet — a new mock listed ahead of its
 *       executeRegistryChange — is skipped with a log line, because
 *       setRefPrice on it reverts NotRegistryAsset and a reverted post
 *       stops the run. The FIRST post on an unset reference (a newly
 *       registered asset) is band-free — the one number nothing on chain
 *       bounds — so it is made only through the same gate the
 *       reconstitution sender applies (keeper/basket-recon.mjs
 *       first-prices): decimals() re-read from the mock and equal to the
 *       rulebook's, and a second independent source (CoinPaprika, or
 *       `pricesB`) within FIRST_PRICE_TOL of the day's price; otherwise
 *       that one post is skipped with a loud line and the reconstitution
 *       run makes it;
 *   (c) on a reconstitution day whose membership differs from the vault's
 *       registry, writes keeper/pending-registry-{index}.json (adds /
 *       removes / a decision-hash placeholder) and logs the
 *       announceRegistryChange / executeRegistryChange calls it WOULD make.
 *       Nothing is announced on chain here: a registry change needs an
 *       anchored decision document first (RUNBOOK, "during a rebalance").
 *       An existing file that already lists the same adds and removes is
 *       kept as it is — it is the work order, and a person fills its
 *       decisionSha256 (the qX20 leg reaches this branch on every run). A
 *       file whose decisionSha256 is filled is NEVER rewritten, whatever
 *       today's diff says (the tuple may already be announced on chain and
 *       the workflow commits this file to public main); a file that is not
 *       JSON is never overwritten either. Only a never-decided order for a
 *       different change is replaced.
 *
 * Every chain write is skipped — with a line saying so — when KEEPER_PK is
 * absent, when the run is a dry run, or when basket.vault is null.
 * Auctions and rebalance execution are not implemented here; see
 * docs/paper-index.md, "Basket marking" and "What is NOT implemented".
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWalletClient, createPublicClient, http, defineChain, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Strictly inside the contract's NAV_BAND_BPS (1,500): 14.9%. */
export const STEP_BPS = 1_490n;

/** A first post on an unset reference is band-free, so it needs what the
 *  reconstitution sender needs (keeper/basket-recon.mjs --first-price-tol
 *  default): a second independent source within this relative distance. */
export const FIRST_PRICE_TOL = 0.02;

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

const VAULT_ABI = parseAbi([
  'function navPerShare() view returns (uint256)',
  'function refPrice(address) view returns (uint256)',
  'function refPriceUpdatedAt(address) view returns (uint256)',
  'function assetCount() view returns (uint256)',
  'function assets(uint256) view returns (address)',
  'function inRemoval(address) view returns (bool)',
  'function keeper() view returns (address)',
  'function setNav(uint256 newNavPerShare)',
  'function setRefPrice(address asset, uint256 price)',
]);
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);

/**
 * The sequence of marks that walks `current` to `target` without any single
 * post moving more than STEP_BPS. The first post on an unset reference
 * (current = 0) is band-free and lands in one step. Pure; exported for tests.
 */
export function stepsTo(current, target) {
  current = BigInt(current);
  target = BigInt(target);
  if (target <= 0n) throw new Error('target must be positive');
  if (current === 0n || current === target) return current === target ? [] : [target];
  const out = [];
  let cur = current;
  // A 100× move is ~33 steps; 1,000 bounds any sane target and stops a loop
  // on a value too small to move inside the band (integer floors), which is
  // reported rather than posted.
  for (let guard = 0; guard < 1_000; guard++) {
    const hi = (cur * (10_000n + STEP_BPS)) / 10_000n;
    const lo = (cur * (10_000n - STEP_BPS) + 9_999n) / 10_000n; // ceil, stays inside the band
    let next;
    if (target > hi) next = hi;
    else if (target < lo) next = lo;
    else next = target;
    if (next === cur) throw new Error(`cannot step from ${cur} toward ${target} inside the band — value too small`);
    out.push(next);
    cur = next;
    if (cur === target) break;
  }
  if (cur !== target) throw new Error(`stepping did not converge from ${current} to ${target}`);
  return out;
}

/** price (USD, float) → the contract's refPrice unit for a mock with `decimals`. */
export function toRefPrice(priceUsd, decimals) {
  // 12 significant digits of the float, then integer arithmetic.
  const scaled = BigInt(Math.round(priceUsd * 1e12));
  return (scaled * 10n ** 18n) / (10n ** 12n * 10n ** BigInt(decimals));
}

/** level / navBase → navPerShare (6 decimals). */
export function toNav(level, navBase) {
  const v = Math.round((level / navBase) * 1e6);
  if (!(v > 0)) throw new Error(`nav computes to ${v}`);
  return BigInt(v);
}

function log(index, msg) {
  console.log(`[basket:${index}] ${msg}`);
}

/** The second price source for a first post: CoinPaprika (update-nav.mjs's
 *  fallback source), fetched at most once per process and only when a first
 *  post is actually due — today's marks never reach it. A caller-supplied
 *  `pricesB` ({symbol: USD price}) stands in for it (tests, offline runs).
 *  A fetch failure is not an error: the first post is then skipped. */
let secondSource = null;
async function loadSecondSource(pricesB) {
  if (pricesB) return { prices: pricesB, label: 'pricesB (caller-supplied)' };
  if (secondSource) return secondSource;
  try {
    const r = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=500');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    const prices = {};
    for (const c of Array.isArray(raw) ? raw : []) {
      const s = String(c.symbol || '').toUpperCase();
      const p = c.quotes?.USD?.price;
      if (s && prices[s] == null && p > 0) prices[s] = p; // first (largest) wins, as in paper-index.mjs
    }
    secondSource = { prices, label: `coinpaprika (${Object.keys(prices).length} tickers)` };
  } catch (e) {
    secondSource = { prices: {}, label: `coinpaprika unavailable (${String(e.message).split('\n')[0]})` };
  }
  return secondSource;
}

/**
 * @param {object} args
 * @param {string} args.index            qx20 | qrev | qdefi
 * @param {object|null} args.basket      the rulebook's basket block
 * @param {number} args.level            today's index level
 * @param {number} args.navBase          the level that maps to navPerShare 1.000000
 * @param {Record<string, number>} args.prices   symbol → USD price today
 * @param {string[]} args.members        today's membership (symbols)
 * @param {boolean} args.reconstituted   whether today was a reconstitution
 * @param {boolean} args.dryRun
 * @param {string} args.keeperDir        where pending-registry-{index}.json goes
 * @param {string} args.date             YYYY-MM-DD
 * @param {Record<string, number>} [args.pricesB]  optional second source for a
 *        FIRST post (symbol → USD price); CoinPaprika is fetched when absent
 */
/** The keeper key is shared by three crons and the site's desk, so two
 *  senders can race for the same nonce. viem fetches the nonce per call, so
 *  a short wait and a resend is the whole fix; anything else is rethrown. */
/** Fixed gas for every post. On 2026-09-21 the node's estimate for the second
 *  UNI band step (36,025) was exactly what the first step had used minus the
 *  slot-refresh cost, the transaction ran out of gas, waitForTransactionReceipt
 *  returned the reverted receipt without throwing, the keeper logged it as
 *  posted, and the next step then failed simulation with NavMoveTooLarge. A
 *  setNav/setRefPrice post costs under 40k; 120k leaves the estimate out of it. */
const POST_GAS = 120_000n;

/** waitForTransactionReceipt resolves on a reverted receipt too. A reverted
 *  post must stop the run — the next band step would be computed from a state
 *  the chain never reached. */
async function requireMined(publicClient, hash, what) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${what} reverted on chain (tx ${hash}, block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})`);
  }
  return receipt;
}

async function sendNonceSafe(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!/nonce/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
    }
  }
  throw last;
}

export async function markBasket(args) {
  const { index, basket, level, navBase, prices, members, reconstituted, dryRun, keeperDir, date, pricesB = null } = args;
  if (!basket || !basket.vault) {
    log(index, 'no basket vault in the rulebook (basket.vault is null) — chain writes skipped');
    return { skipped: 'no-vault' };
  }
  const vault = getAddress(basket.vault);
  const assets = Object.entries(basket.assets || {}).map(([symbol, v]) => ({
    symbol,
    address: getAddress(typeof v === 'string' ? v : v.address),
    decimals: typeof v === 'string' ? null : (v.decimals ?? null),
  }));
  const pk = process.env.KEEPER_PK;
  const canWrite = !!pk && !dryRun;
  if (!pk) log(index, 'KEEPER_PK not set — computing every mark, posting none');
  else if (dryRun) log(index, 'dry run — computing every mark, posting none');

  const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
  const wallet = canWrite
    ? createWalletClient({ account: privateKeyToAccount(pk), chain: giwaSepolia, transport: http() })
    : null;

  const posted = { nav: [], ref: {} };

  // ---------------------------------------------------------------- (a) NAV
  const targetNav = toNav(level, navBase);
  const currentNav = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'navPerShare' });
  const navSteps = stepsTo(currentNav, targetNav);
  log(index, `nav: onchain ${fmt6(currentNav)} → target ${fmt6(targetNav)} (level ${level} / navBase ${navBase}); ${navSteps.length} step(s)`);
  for (const step of navSteps) {
    if (!canWrite) {
      log(index, `  would setNav(${step}) [${fmt6(step)}]`);
      continue;
    }
    const hash = await sendNonceSafe(() => wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: 'setNav', args: [step], gas: POST_GAS }));
    await requireMined(publicClient, hash, `setNav(${step})`);
    posted.nav.push({ nav: step.toString(), txHash: hash });
    log(index, `  setNav(${step}) [${fmt6(step)}] tx=${hash}`);
  }

  // --------------------------------------------------- the vault's registry
  // basket.assets is what the keeper can PRICE (symbol → address); the
  // registry is what the vault HOLDS. They differ from the day a new mock is
  // listed in the rulebook until its executeRegistryChange, and from a
  // finalizeRemoval until the rulebook drops the name. Only the overlap is
  // marked; everything else gets a line. Read once, before any refPrice post.
  const registryCount = Number(await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'assetCount' }));
  const onChain = new Set();
  for (let i = 0; i < registryCount; i++) {
    onChain.add(getAddress(await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'assets', args: [BigInt(i)] })));
  }
  const registered = assets.filter((a) => onChain.has(a.address));
  const unregistered = assets.filter((a) => !onChain.has(a.address));
  for (const a of unregistered) {
    log(index, `ref ${a.symbol}: ${a.address} is in the rulebook but not a registry asset of the vault — not posted (setRefPrice would revert NotRegistryAsset)`);
  }
  for (const addr of onChain) {
    if (!assets.some((a) => a.address === addr)) {
      log(index, `registry asset ${addr} is not in the rulebook's basket.assets — not posted (no symbol to price it by; add it to the rulebook)`);
    }
  }

  // ----------------------------------------------------- (b) reference prices
  for (const a of registered) {
    const px = prices[a.symbol];
    if (!(px > 0)) {
      log(index, `ref ${a.symbol}: no price today — not posted (fill() fails closed on staleness, exits unaffected)`);
      continue;
    }
    let decimals = a.decimals;
    if (decimals == null) {
      decimals = Number(await publicClient.readContract({ address: a.address, abi: ERC20_ABI, functionName: 'decimals' }));
    }
    const current = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'refPrice', args: [a.address] });
    if (current === 0n) {
      // FIRST post on a newly registered asset: band-free, so nothing on chain
      // bounds it. Same gate as keeper/basket-recon.mjs first-prices — the
      // mock's decimals re-read from the chain (a one-decimal slip is a 10×
      // price the band then needs ~15 posts to walk back) and a second source
      // within FIRST_PRICE_TOL — or that one post is skipped, loudly. fill()
      // fails closed (PriceUnset) until it is posted; exits are unaffected.
      const onchainDecimals = a.decimals == null ? decimals : Number(await publicClient.readContract({ address: a.address, abi: ERC20_ABI, functionName: 'decimals' }));
      if (onchainDecimals !== decimals) {
        log(index, `ref ${a.symbol}: FIRST POST SKIPPED — reference unset on chain; the rulebook says ${decimals} decimals but ${a.address} reports ${onchainDecimals}; a first price sized to the wrong decimals is off by 10× per decimal. Fix basket.assets.${a.symbol}.decimals (or let keeper/basket-recon.mjs first-prices post it from the plan)`);
        continue;
      }
      const B = await loadSecondSource(pricesB);
      const pb = B.prices[a.symbol];
      if (!(pb > 0)) {
        log(index, `ref ${a.symbol}: FIRST POST SKIPPED — reference unset on chain and no second price source for it (${B.label}); a band-free first post needs two independent sources within ${FIRST_PRICE_TOL * 100}%. keeper/basket-recon.mjs first-prices posts it from the plan's two sources`);
        continue;
      }
      const apart = Math.abs(px - pb) / px;
      if (apart > FIRST_PRICE_TOL) {
        log(index, `ref ${a.symbol}: FIRST POST SKIPPED — the two sources disagree by ${(apart * 100).toFixed(2)}% (A ${px}, B ${pb} from ${B.label}) > ${FIRST_PRICE_TOL * 100}%; not posting a band-free price on one source`);
        continue;
      }
      log(index, `ref ${a.symbol}: first post (band-free) passes the gate — ${onchainDecimals} decimals read from the mock, B ${pb} (${B.label}) is ${Math.round(apart * 10_000)} bp from A ${px}`);
    }
    const target = toRefPrice(px, decimals);
    // An unchanged price is still re-posted: the post refreshes
    // refPriceUpdatedAt, which the v3.1 fill() guard reads.
    const steps = current === target ? [target] : stepsTo(current, target);
    log(index, `ref ${a.symbol}: onchain ${current} → ${target} (price ${px}, ${decimals} dec); ${steps.length} step(s)`);
    posted.ref[a.symbol] = [];
    for (const step of steps) {
      if (!canWrite) {
        log(index, `  would setRefPrice(${a.address}, ${step})`);
        continue;
      }
      const hash = await sendNonceSafe(() => wallet.writeContract({
        address: vault, abi: VAULT_ABI, functionName: 'setRefPrice', args: [a.address, step], gas: POST_GAS,
      }));
      await requireMined(publicClient, hash, `setRefPrice(${a.symbol}, ${step})`);
      posted.ref[a.symbol].push({ price: step.toString(), txHash: hash });
      log(index, `  setRefPrice(${a.symbol}, ${step}) tx=${hash}`);
    }
  }

  // -------------------------------------------- (c) registry diff on recon days
  // Against the registry, not the rulebook: a name listed in basket.assets
  // ahead of its executeRegistryChange is still an add (its address now
  // known), and a name whose removal is already executed (inRemoval — it
  // stays in the registry until auctions drain it) is no longer a remove.
  const registrySymbols = new Set(registered.map((a) => a.symbol));
  const memberSet = new Set(members);
  const adds = members.filter((s) => !registrySymbols.has(s));
  const removes = [];
  const draining = [];
  for (const a of registered) {
    if (memberSet.has(a.symbol)) continue;
    const executed = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'inRemoval', args: [a.address] });
    (executed ? draining : removes).push(a.symbol);
  }
  if (draining.length) {
    log(index, `registry: removal executed, draining until finalizeRemoval — ${draining.join(',')}`);
  }
  const listedAdd = (s) => unregistered.find((a) => a.symbol === s) ?? null;
  const pendingPath = path.join(keeperDir, `pending-registry-${index}.json`);
  const existing = readJson(pendingPath);
  const syms = (xs) => (xs ?? []).map((x) => x.symbol).join(',') || '—';
  const action = pendingAction(existing, fs.existsSync(pendingPath), vault, adds, removes);
  if (adds.length === 0 && removes.length === 0) {
    log(index, `registry: vault holds exactly today's ${members.length} members — no change pending`);
    if (fs.existsSync(pendingPath)) {
      log(index, `  (${path.basename(pendingPath)} still exists from an earlier run — remove it once executed)`);
    }
  } else if (!reconstituted) {
    log(index, `registry: membership differs from the vault (adds ${adds.join(',') || '—'}; removes ${removes.join(',') || '—'}) but today is not a reconstitution — nothing written`);
  } else if (action === 'same') {
    // The workflow commits this file, and a person fills its decisionSha256
    // before announcing. Rewriting it on every run (the qX20 leg passes
    // reconstituted=true daily) would reset that field and the date.
    log(index, `registry: RECONSTITUTION — adds ${adds.join(',') || '—'}; removes ${removes.join(',') || '—'} → ${path.basename(pendingPath)} (dated ${existing.date ?? 'undated'}) already lists this change — kept as it is`);
    for (const c of existing.calls ?? []) log(index, `  would call: ${c}`);
    for (const x of existing.adds ?? []) {
      if (!x.address && listedAdd(x.symbol)) log(index, `  (${x.symbol}: address now listed in the rulebook, ${listedAdd(x.symbol).address} — fill it into the file)`);
    }
  } else if (action === 'decided') {
    // A decided work order is frozen: a person filled its decisionSha256, the
    // tuple may already be announced on chain, and the workflow commits this
    // file to public main. Sha filled ⇒ never rewritten, whatever today's diff
    // says; only a never-decided order may be replaced (the branch below).
    log(index, `registry: RECONSTITUTION — ${path.basename(pendingPath)} is a DECIDED work order (decisionSha256 ${existing.decisionSha256}; adds ${syms(existing.adds)}; removes ${syms(existing.removes)}${existing.vault !== vault ? `; vault ${existing.vault}` : ''}) but today's diff is adds ${adds.join(',') || '—'}; removes ${removes.join(',') || '—'} — NOT rewritten; resolve by hand (rulebook not yet listing an executed add? membership moved again after the decision?)`);
  } else if (action === 'not-json') {
    log(index, `registry: RECONSTITUTION — ${path.basename(pendingPath)} exists but is not JSON — NOT overwritten; today's diff is adds ${adds.join(',') || '—'}; removes ${removes.join(',') || '—'}; fix or remove the file by hand`);
  } else {
    const pending = {
      index,
      date,
      vault,
      chainId: 91342,
      adds: adds.map((s) => (listedAdd(s)
        ? { symbol: s, address: listedAdd(s).address, note: 'listed in the rulebook, not yet a registry asset — announce, then execute on day 7' }
        : { symbol: s, address: null, note: 'deploy a MockConstituent for this name first (testnet) — address unknown until then' })),
      removes: removes.map((s) => ({ symbol: s, address: assets.find((a) => a.symbol === s).address })),
      decisionSha256: null,
      decisionFile: `trackrecord/decisions/${date}-${index}-reconstitution.md (to be written, then anchored with scripts/anchor-decision.mjs; its sha256 replaces this null)`,
      calls: [
        `announceRegistryChange(adds=[${adds.map((s) => listedAdd(s)?.address ?? '<new mock address>').join(', ')}], removes=[${removes.map((s) => assets.find((a) => a.symbol === s).address).join(', ')}], decisionSha256=<sha256 of the anchored decision>)  — owner, day 0`,
        'executeRegistryChange(same adds, removes, decisionSha256)  — anyone, day 7 or later',
        ...removes.map((s) => `openAuction(sell=${s}, buy=<a member>, amount=<balance>, duration=<short>) … until balance is 0, then finalizeRemoval(${s})  — keeper; not implemented in this keeper`),
        ...adds.map((s) => `openAuction(sell=<an overweight member>, buy=${s}, …) after execute and a first setRefPrice(${s})  — keeper; not implemented in this keeper`),
      ],
      note: 'The 7-day announcement delay means the vault lags the index by at least a week at every reconstitution; the paper record does not wait. See docs/paper-index.md "Basket marking".',
    };
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
    log(index, `registry: RECONSTITUTION — adds ${adds.join(',') || '—'}; removes ${removes.join(',') || '—'} → wrote ${path.basename(pendingPath)}`);
    for (const c of pending.calls) log(index, `  would call: ${c}`);
  }

  return { skipped: canWrite ? null : 'no-key-or-dry-run', posted, adds, removes };
}

function fmt6(v) {
  return (Number(BigInt(v)) / 1e6).toFixed(6);
}

/** The parsed file, or null when it is absent or not JSON. */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether a pending-registry file describes this exact change: same vault,
 *  same add symbols, same remove symbols (order ignored). Exported for tests. */
export function sameChange(pending, vault, adds, removes) {
  if (!pending || pending.vault !== vault) return false;
  const same = (xs, ys) => xs.length === ys.length && [...xs].sort().join() === [...ys].sort().join();
  return same((pending.adds ?? []).map((x) => x.symbol), adds) && same((pending.removes ?? []).map((x) => x.symbol), removes);
}

/** What part (c) does with the pending-registry file on a reconstitution day
 *  whose diff is (adds, removes), given the parsed file (`existing`, null when
 *  absent or not JSON) and whether a file is there at all:
 *    'same'     — it already lists this change: kept as it is;
 *    'decided'  — its decisionSha256 is filled: a person decided and the
 *                 tuple may be announced on chain — never rewritten;
 *    'not-json' — a file exists that does not parse — never overwritten;
 *    'write'    — no file, or a never-decided order for a different change,
 *                 which is replaced by today's.
 *  Exported for tests. */
export function pendingAction(existing, fileExists, vault, adds, removes) {
  if (sameChange(existing, vault, adds, removes)) return 'same';
  if (existing && existing.decisionSha256) return 'decided';
  if (fileExists && existing === null) return 'not-json';
  return 'write';
}
