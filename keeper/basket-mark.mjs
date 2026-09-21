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
 *       lets auction fills execute (the v3.1 stale-reference guard);
 *   (c) on a reconstitution day whose membership differs from the vault's
 *       registry, writes keeper/pending-registry-{index}.json (adds /
 *       removes / a decision-hash placeholder) and logs the
 *       announceRegistryChange / executeRegistryChange calls it WOULD make.
 *       Nothing is announced on chain here: a registry change needs an
 *       anchored decision document first (RUNBOOK, "during a rebalance").
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
 */
/** The keeper key is shared by three crons and the site's desk, so two
 *  senders can race for the same nonce. viem fetches the nonce per call, so
 *  a short wait and a resend is the whole fix; anything else is rethrown. */
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
  const { index, basket, level, navBase, prices, members, reconstituted, dryRun, keeperDir, date } = args;
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
    const hash = await sendNonceSafe(() => wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: 'setNav', args: [step] }));
    await publicClient.waitForTransactionReceipt({ hash });
    posted.nav.push({ nav: step.toString(), txHash: hash });
    log(index, `  setNav(${step}) [${fmt6(step)}] tx=${hash}`);
  }

  // ----------------------------------------------------- (b) reference prices
  for (const a of assets) {
    const px = prices[a.symbol];
    if (!(px > 0)) {
      log(index, `ref ${a.symbol}: no price today — not posted (fill() fails closed on staleness, exits unaffected)`);
      continue;
    }
    let decimals = a.decimals;
    if (decimals == null) {
      decimals = Number(await publicClient.readContract({ address: a.address, abi: ERC20_ABI, functionName: 'decimals' }));
    }
    const target = toRefPrice(px, decimals);
    const current = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'refPrice', args: [a.address] });
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
        address: vault, abi: VAULT_ABI, functionName: 'setRefPrice', args: [a.address, step],
      }));
      await publicClient.waitForTransactionReceipt({ hash });
      posted.ref[a.symbol].push({ price: step.toString(), txHash: hash });
      log(index, `  setRefPrice(${a.symbol}, ${step}) tx=${hash}`);
    }
  }

  // -------------------------------------------- (c) registry diff on recon days
  const registrySymbols = new Set(assets.map((a) => a.symbol));
  const memberSet = new Set(members);
  const adds = members.filter((s) => !registrySymbols.has(s));
  const removes = assets.filter((a) => !memberSet.has(a.symbol)).map((a) => a.symbol);
  const pendingPath = path.join(keeperDir, `pending-registry-${index}.json`);
  if (adds.length === 0 && removes.length === 0) {
    log(index, `registry: vault holds exactly today's ${members.length} members — no change pending`);
    if (fs.existsSync(pendingPath)) {
      log(index, `  (${path.basename(pendingPath)} still exists from an earlier run — remove it once executed)`);
    }
  } else if (!reconstituted) {
    log(index, `registry: membership differs from the vault (adds ${adds.join(',') || '—'}; removes ${removes.join(',') || '—'}) but today is not a reconstitution — nothing written`);
  } else {
    const pending = {
      index,
      date,
      vault,
      chainId: 91342,
      adds: adds.map((s) => ({ symbol: s, address: null, note: 'deploy a MockConstituent for this name first (testnet) — address unknown until then' })),
      removes: removes.map((s) => ({ symbol: s, address: assets.find((a) => a.symbol === s).address })),
      decisionSha256: null,
      decisionFile: `trackrecord/decisions/${date}-${index}-reconstitution.md (to be written, then anchored with scripts/anchor-decision.mjs; its sha256 replaces this null)`,
      calls: [
        `announceRegistryChange(adds=[${adds.map(() => '<new mock address>').join(', ')}], removes=[${removes.map((s) => assets.find((a) => a.symbol === s).address).join(', ')}], decisionSha256=<sha256 of the anchored decision>)  — owner, day 0`,
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
