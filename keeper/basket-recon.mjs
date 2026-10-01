/**
 * Basket reconstitution executor — runs one plan (keeper/basket-plan.mjs)
 * against a QuadrixBasketVault v3.1, one stage at a time.
 *
 *   announce      owner: announceRegistryChange(adds, removes, decisionSha256)
 *   execute       anyone: executeRegistryChange(same tuple) once the 7 days ran
 *   first-prices  keeper: the first setRefPrice for every added asset
 *   auctions      keeper opens, the bidder fills, until every traded name is
 *                 within the bound fair fills allow of its trade target
 *                 (residualBound) and every removal is drained — and
 *                 finalized at once (below)
 *   finalize      anyone: finalizeRemoval for each drained removal still in
 *                 the registry; a remnant under $1 is reported PENDING
 *   verify        read-only: registry, order, prices, weights, a redeem simulation
 *   day7          execute → first-prices → auctions → finalize → verify in one run
 *
 * DRY RUN IS THE DEFAULT. Without --live nothing is sent: every call is
 * simulated from the role that would sign it and printed with decoded
 * arguments. --live sends, signing with KEEPER_PK from the environment, or
 * — for a rehearsal on `anvil --auto-impersonate` only — from an unlocked
 * account given as --from. Fills sign as the bidder: BIDDER_PK (live) or
 * --bidder (rehearsal); the default bidder is the keeper signer, which is
 * the deployed testnet shape (owner = keeper = bidder) and not the mainnet
 * one.
 *
 * The contract bounds what the keeper role can lose per fill and per day,
 * but three things it cannot bound are guarded HERE, and each refuses with a
 * non-zero exit rather than proceeding:
 *   - a re-announce (only one change may be pending; re-announcing restarts
 *     the clock): announce refuses while pendingRegistryChange != 0, refuses
 *     a decisionSha256 that is not in trackrecord/decisions.jsonl or that
 *     belongs to another basket's decision, and refuses an EMPTY change (a
 *     weight-only plan needs no announcement; announcing one would block the
 *     vault's auctions for the 7 days);
 *   - the first reference price of a new asset (band-free by design):
 *     first-prices refuses unless the plan's two independent sources agree
 *     within --first-price-tol (2%) and the mock's decimals on chain equal
 *     the plan's — a one-decimal slip is a 10× price;
 *   - a reference walked during a session: this script re-posts only the
 *     value already on chain (a same-value post refreshes the v3.1
 *     staleness clock, nothing else) and re-reads both legs right before
 *     each re-post, stopping if another run moved one in between; refuses
 *     any post that would step outside the ±15% band; refuses to trade
 *     while a chain reference is more than --ref-drift-tol (5%) away from
 *     the day's market price — re-mark with the daily keeper first; and
 *     refuses to trade when a chain reference is no longer the one the plan
 *     sized its amounts at (chainRefAtPlan) — regenerate the plan.
 * Fills are taken at the curve's fair point by default (--fill fair: factor
 * 10,000 ≤ f ≤ 10,010, so lossAtRef is 0 and share value is unchanged);
 * --fill open takes the +2% start (a gift to holders); --fill natural fills
 * at whatever point the script reaches, bounded only by the contract. The
 * fair window is duration/30 seconds wide (30 s at 900 s); a missed window
 * cancels and reopens at most twice, then stops with a message to widen the
 * planner's --duration (1800 s gives 60 s on the public chain).
 * Removals (red-team RT17, option K): finalizeRemoval needs the vault's
 * balance to be exactly zero, and anyone can send one base unit, or create
 * shares (which pays in a pro-rata slice of a leaving asset), between the
 * drain fill and the finalize. So a drain is finalized right after its fill,
 * not after every other auction: the balance is re-read, zero → finalize at
 * once; not zero → re-drain from the live balance at once (a remnant under
 * the plan's $1 trade minimum is filled at the curve's open without waiting
 * — the bidder pays at most 2% over reference on less than $1, lossAtRef 0;
 * $1 or more follows the fill policy), then check again — at most five
 * re-drains. Still not zero → the asset is written to plan.finalizePending
 * and the run goes on: the auctions stage, finalize and verify report it as
 * PENDING, not as a failure (redemptions and the record are unaffected; the
 * leg keeps paying out its remnant until a later drain). Each fill also
 * takes min(auction amount, the vault's live balance), so a redemption in
 * the window shrinks the fill instead of reverting it, and the unfilled rest
 * of the auction is cancelled.
 * Every transaction is simulated first, sent with fixed gas, retried on a
 * nonce error (the keeper key is shared by the crons and the desk) and
 * required to be mined WITHOUT revert before the next one (a reverted
 * receipt does not throw in viem — basket-mark.mjs, 2026-09-21). Reads go
 * through Multicall3 in paced batches. Secrets are never printed.
 *
 * Usage:
 *   node keeper/basket-recon.mjs --index qrev --stage announce                 # dry run against GIWA
 *   KEEPER_PK=0x… node keeper/basket-recon.mjs --index qrev --stage announce --live
 *   node keeper/basket-recon.mjs --index qrev --stage day7 --live --rpc http://127.0.0.1:8545 \
 *        --from 0x<owner> --bidder 0x<bidder> --warp                              # anvil rehearsal
 *
 * Options:
 *   --plan p              plan file (default: the latest keeper/plans/{index}/*.json)
 *   --rpc URL             default GIWA Sepolia public RPC; --chain-id for a fresh anvil
 *   --live                send transactions (default: dry run)
 *   --from 0x…            unlocked sender (anvil/hardhat only; requires --live and a local --rpc)
 *   --bidder 0x…          unlocked bidder (rehearsal); live fills use BIDDER_PK when set
 *   --fill fair|open|natural   fill policy (default fair)
 *   --fair-window-bps n   width of the fair window above 10,000 (default 10)
 *   --first-price-tol x   max relative disagreement between the two sources (default 0.02)
 *   --ref-drift-tol x     max chain-reference vs plan-price drift before trading (default 0.05)
 *   --decisions p         decisions ledger (default trackrecord/decisions.jsonl)
 *   --warp                on anvil, jump the clock to the fair point instead of waiting
 *   --max-rounds n        residual rebalance rounds after the plan's trades (default 3)
 *   --no-faucet           never top the bidder up from a mock's open faucet
 *   --max-faucet-calls n  cap on faucet() calls per asset (default 60)
 *   --allow-plan-date     accept a plan not generated today (first-prices, auctions)
 *   --hook file           REHEARSAL ONLY (--live --from on a local anvil): a module whose
 *                         default export is awaited at 'before-fill' (after the wait, before
 *                         the live balance is re-read) and 'after-fill' (between a drain fill
 *                         and the finalize check) — how the anvil rehearsal lands a donation,
 *                         a creation or a redemption inside those windows
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWalletClient, http, getAddress, isAddress, keccak256, encodeAbiParameters, parseEventLogs, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  INDEXES, GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, ERC20_ABI, DECISIONS_LEDGER,
  chainFor, isLocalRpc, sleep, makeReader, readVault, toRefPrice, bpsDiff, sha256,
  loadDecisions, loadPlan, savePlan, latestPlan, computeTrades,
} from './basket-plan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO32 = `0x${'0'.repeat(64)}`;
const STAGES = ['announce', 'execute', 'first-prices', 'auctions', 'finalize', 'verify', 'day7'];
/** Option K: re-drains of a removal remnant before it is left PENDING. */
export const MAX_DRAIN_ATTEMPTS = 5;

/** Fixed gas per call, scaled by the registry size where the contract loops
 *  over it. Same reason as basket-mark.mjs POST_GAS: a node estimate that is
 *  exactly right for the previous state ran a band step out of gas on
 *  2026-09-21 and the reverted receipt was logged as posted. Measured on the
 *  fork: announce 72,748 (one add), execute 52,823 (one add), fill 117,557
 *  (11 assets). */
const GAS = {
  post: 120_000n,
  announce: (k) => 150_000n + 45_000n * BigInt(k),
  execute: (k) => 120_000n + 60_000n * BigInt(k),
  openAuction: 220_000n,
  fill: (n) => 260_000n + 12_000n * BigInt(n),
  finalize: (n) => 120_000n + 8_000n * BigInt(n),
  approve: 80_000n,
  faucet: 100_000n,
};

/** A guard refusal: printed as REFUSED and exits 1; never a stack trace. */
class Refused extends Error {}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const iso = (ts) => new Date(Number(ts) * 1000).toISOString();
const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const pct = (x) => `${(x * 100).toFixed(2)}%`;

// ------------------------------------------------------------- CLI parsing
function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const o = {
    index: opt('--index', null),
    stage: opt('--stage', null),
    plan: opt('--plan', null),
    rpc: opt('--rpc', GIWA_RPC),
    chainId: Number(opt('--chain-id', GIWA_CHAIN_ID)),
    live: flag('--live'),
    from: opt('--from', null),
    bidder: opt('--bidder', null),
    fill: opt('--fill', 'fair'),
    fairWindowBps: Number(opt('--fair-window-bps', 10)),
    firstPriceTol: Number(opt('--first-price-tol', 0.02)),
    refDriftTol: Number(opt('--ref-drift-tol', 0.05)),
    decisions: opt('--decisions', DECISIONS_LEDGER),
    warp: flag('--warp'),
    maxRounds: Number(opt('--max-rounds', 3)),
    faucet: !flag('--no-faucet'),
    maxFaucetCalls: Number(opt('--max-faucet-calls', 60)),
    allowPlanDate: flag('--allow-plan-date'),
    paceMs: opt('--pace-ms', null) == null ? undefined : Number(opt('--pace-ms')),
    hook: opt('--hook', null),
  };
  if (!INDEXES.includes(o.index) || !STAGES.includes(o.stage) || !['fair', 'open', 'natural'].includes(o.fill)) {
    console.error(`usage: node keeper/basket-recon.mjs --index ${INDEXES.join('|')} --stage ${STAGES.join('|')} [--plan p] [--rpc URL] [--live] [--from 0x…] [--bidder 0x…] [--fill fair|open|natural] [--warp] …`);
    process.exit(2);
  }
  return o;
}

// ----------------------------------------------------------- error decoding
function fmtErr(e) {
  let name = null;
  let cur = e;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.data?.errorName) { name = cur.data.errorName; break; }
    if (cur.name === 'ContractFunctionRevertedError' && cur.reason) { name = cur.reason; break; }
    cur = cur.cause;
  }
  const short = e?.shortMessage ?? e?.message ?? String(e);
  return name ? `${name} (${short.split('\n')[0]})` : short.split('\n')[0];
}

// ------------------------------------------------------------ the context
async function makeCtx(o) {
  const log = (m) => console.log(`[recon:${o.index}:${o.stage}] ${m}`);
  const planFile = o.plan ?? latestPlan(o.index);
  if (!planFile) throw new Refused(`no plan for ${o.index} — run keeper/basket-plan.mjs first`);
  const plan = loadPlan(planFile);
  if (plan.index !== o.index) throw new Refused(`${planFile} is a plan for ${plan.index}, not ${o.index}`);

  const reader = await makeReader(o.rpc, { chainId: o.chainId, paceMs: o.paceMs });
  if (plan.chainId !== reader.chainId) throw new Refused(`plan is for chain ${plan.chainId}, RPC is chain ${reader.chainId}`);
  const clientVersion = await reader.publicClient.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');
  const devNode = /anvil|hardhat|ganache/i.test(String(clientVersion));
  const chain = chainFor(o.rpc, reader.chainId);

  // Signers. Addresses are printed; keys never are.
  let keeperAddr;
  let keeperWallet = null;
  let bidderAddr;
  let bidderWallet = null;
  let mode;
  if (o.live && o.from) {
    if (!devNode || !isLocalRpc(o.rpc)) throw new Refused(`--from is for an unlocked account on a local anvil/hardhat node; ${o.rpc} reports "${clientVersion}"`);
    if (!isAddress(o.from)) throw new Refused(`--from ${o.from} is not an address`);
    keeperAddr = getAddress(o.from);
    keeperWallet = createWalletClient({ account: keeperAddr, chain, transport: http(o.rpc) });
    bidderAddr = o.bidder ? getAddress(o.bidder) : keeperAddr;
    bidderWallet = bidderAddr === keeperAddr ? keeperWallet : createWalletClient({ account: bidderAddr, chain, transport: http(o.rpc) });
    mode = `LIVE, unlocked --from (${clientVersion})`;
  } else if (o.live) {
    const pk = process.env.KEEPER_PK;
    if (!pk) throw new Refused('--live needs KEEPER_PK in the environment (or --from on a local anvil)');
    const acct = privateKeyToAccount(pk);
    keeperAddr = acct.address;
    keeperWallet = createWalletClient({ account: acct, chain, transport: http(o.rpc) });
    if (process.env.BIDDER_PK) {
      const b = privateKeyToAccount(process.env.BIDDER_PK);
      bidderAddr = b.address;
      bidderWallet = createWalletClient({ account: b, chain, transport: http(o.rpc) });
    } else {
      bidderAddr = keeperAddr;
      bidderWallet = keeperWallet;
    }
    mode = `LIVE, KEEPER_PK${process.env.BIDDER_PK ? ' + BIDDER_PK' : ''} (${clientVersion})`;
  } else {
    // Dry run: simulate from the vault's real roles, so a call that the role
    // could not make shows up as a revert here too.
    const v0 = await readVault(reader, plan.vault);
    keeperAddr = o.from && isAddress(o.from) ? getAddress(o.from) : v0.keeper;
    bidderAddr = o.bidder && isAddress(o.bidder) ? getAddress(o.bidder) : process.env.BIDDER_PK ? privateKeyToAccount(process.env.BIDDER_PK).address : keeperAddr;
    mode = `DRY RUN (${clientVersion}) — nothing is sent`;
  }
  if (o.warp && !devNode) throw new Refused('--warp needs an anvil/hardhat node');
  let hook = null;
  if (o.hook) {
    if (!(o.live && o.from && devNode && isLocalRpc(o.rpc))) throw new Refused('--hook is for the anvil rehearsal only (--live --from on a local anvil)');
    hook = (await import(pathToFileURL(path.resolve(o.hook)).href)).default;
  }
  log(`${mode}; rpc ${o.rpc}; plan ${path.relative(ROOT, planFile)} (${plan.date}, ${plan.adds.length} add, ${plan.removes.length} remove, ${plan.trades.length} auction); keeper/owner signer ${keeperAddr}; bidder ${bidderAddr}; fill ${o.fill}`);
  return { o, log, plan, planFile, reader, pc: reader.publicClient, devNode, keeperAddr, keeperWallet, bidderAddr, bidderWallet, live: o.live, hook, pendingThisRun: new Set() };
}

// -------------------------------------------------------------- sending
/** basket-mark.mjs sendNonceSafe: the key is shared by the crons and the desk. */
async function sendNonceSafe(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!/nonce/i.test(String(e && e.message))) throw e;
      await sleep(4000 * (i + 1));
    }
  }
  throw last;
}

/** basket-mark.mjs requireMined: a reverted receipt must stop the run. */
async function requireMined(pc, hash, what) {
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${what} reverted on chain (tx ${hash}, block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})`);
  return receipt;
}

/**
 * Simulate, print, and (live) send one call as `who` ('keeper' | 'bidder').
 * `dependsOnUnsent` marks a dry-run step whose simulation cannot succeed
 * because an earlier step was not sent; it is printed, not simulated.
 */
async function call(ctx, { who, to, abi = VAULT_ABI, functionName, args = [], gas, what, dependsOnUnsent = false }) {
  const from = who === 'bidder' ? ctx.bidderAddr : ctx.keeperAddr;
  const wallet = who === 'bidder' ? ctx.bidderWallet : ctx.keeperWallet;
  const shown = `${functionName}(${args.map((a) => (typeof a === 'bigint' ? a.toString() : Array.isArray(a) ? `[${a.join(', ')}]` : String(a))).join(', ')})`;
  let request = null;
  let result;
  if (!(dependsOnUnsent && !ctx.live)) {
    try {
      ({ request, result } = await ctx.pc.simulateContract({ address: to, abi, functionName, args, account: from }));
    } catch (e) {
      throw new Refused(`${what}: ${shown} would revert as ${from} — ${fmtErr(e)}`);
    }
  }
  if (!ctx.live) {
    ctx.log(`  would ${what}: ${shown} as ${from}${dependsOnUnsent ? ' (not simulated — depends on an unsent call)' : ' (simulated ok)'}`);
    return { dry: true, result };
  }
  const hash = await sendNonceSafe(() => wallet.writeContract({ ...request, gas }));
  const receipt = await requireMined(ctx.pc, hash, `${what}: ${shown}`);
  const block = await ctx.pc.getBlock({ blockNumber: receipt.blockNumber });
  ctx.log(`  ${what}: ${shown} tx=${hash} block=${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return { hash, receipt, result, blockTimestamp: block.timestamp };
}

function tuple(plan) {
  const t = plan.announceTuple ?? plan.announce?.tuple;
  if (!t) {
    const why = plan.notes.find((n) => /^(announce tuple|nothing to announce)/.test(n)) ?? "adds' addresses or decisionSha256 missing";
    throw new Refused(`the plan has no complete announce tuple — ${why}`);
  }
  return { adds: t.adds.map((a) => getAddress(a)), removes: t.removes.map((a) => getAddress(a)), sha: t.decisionSha256 };
}

/** The ledger entry for the plan's sha, which must be THIS basket's decision:
 *  files are named `{date}-{index}-…` (or the plan's own decisionFile). A sha
 *  of another basket's document pinned into an announcement is permanent. */
function decisionEntry(ctx, sha) {
  const { plan } = ctx;
  const entry = loadDecisions(ctx.o.decisions).find((e) => e.sha256 === sha);
  if (!entry) throw new Refused(`decisionSha256 ${sha.slice(0, 12)}… is not in ${path.relative(ROOT, ctx.o.decisions)} — anchor the decision document first (anchor-decision workflow)`);
  if (!entry.file.includes(`-${plan.index}-`) && `trackrecord/${entry.file}` !== plan.decisionFile) throw new Refused(`decision ${entry.id} (${entry.file}) is not a ${plan.index} decision — its sha would be pinned into this vault's announcement for good`);
  return entry;
}

/** Review §6-1: the contract accepts a duplicate address at announce and
 *  refuses the same tuple at execute forever (the second push of an add, or
 *  a remove already in removal, reverts) — the announcement would then block
 *  every change on the vault until a re-announce restarts the seven days. */
export function tupleProblems({ adds, removes }) {
  const low = (xs) => xs.map((x) => String(x).toLowerCase());
  const dups = (xs) => [...new Set(low(xs).filter((x, i, a) => a.indexOf(x) !== i))];
  const out = [];
  const da = dups(adds);
  const dr = dups(removes);
  const both = low(adds).filter((x) => low(removes).includes(x));
  if (da.length) out.push(`duplicate address in adds: ${da.join(', ')}`);
  if (dr.length) out.push(`duplicate address in removes: ${dr.join(', ')}`);
  if (both.length) out.push(`address in both adds and removes: ${[...new Set(both)].join(', ')}`);
  return out;
}

/** The deployed convention: mock symbol = "m" + the plan's symbol. */
export const mockSymbolMismatch = (planSymbol, onchainSymbol) => onchainSymbol !== `m${planSymbol}`;

const tupleHash = ({ adds, removes, sha }) =>
  keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'address[]' }, { type: 'bytes32' }], [adds, removes, sha]));

function requirePlanFresh(ctx) {
  if (ctx.plan.date === todayUTC() || ctx.o.allowPlanDate) return;
  throw new Refused(`plan ${ctx.plan.date} was not generated today (${todayUTC()}) — prices and balances have moved; regenerate it (or pass --allow-plan-date for a rehearsal)`);
}

async function assetIndex(ctx, v) {
  const bySym = {};
  for (const a of v.assets) {
    const planRow = ctx.plan.registry.find((r) => r.address === a.address) ?? ctx.plan.adds.find((r) => r.address === a.address);
    bySym[planRow?.symbol ?? a.onchainSymbol] = { ...a, symbol: planRow?.symbol ?? a.onchainSymbol };
  }
  return bySym;
}

// ================================================================ announce
async function stageAnnounce(ctx) {
  const { plan, log } = ctx;
  const t = tuple(plan);
  // An empty tuple is a valid call for the contract, and it would lock this
  // vault's auctions for REGISTRY_DELAY. A weight-only plan trades, it does
  // not announce.
  if (t.adds.length + t.removes.length === 0) throw new Refused("empty change — a weight-only plan needs no announcement; announcing it would block this vault's auctions for 7 days (run the auctions stage instead)");
  const problems = tupleProblems(t);
  if (problems.length) throw new Refused(`${problems.join('; ')} — the contract would accept this announcement and refuse it at execute forever`);
  for (const a of t.adds) if (!plan.adds.some((x) => x.address && getAddress(x.address) === a)) throw new Refused(`tuple add ${a} is not one of the plan's adds`);
  for (const a of t.removes) if (!plan.removes.some((x) => getAddress(x.address) === a)) throw new Refused(`tuple remove ${a} is not one of the plan's removes`);
  // The decision hash must be an anchored one, of THIS basket. The ledger is
  // the truth; a file on disk that no longer hashes to it is a second signal
  // something moved.
  const sha = t.sha.replace(/^0x/, '');
  const entry = decisionEntry(ctx, sha);
  const onDisk = path.join(ROOT, 'trackrecord', entry.file);
  if (fs.existsSync(onDisk) && sha256(fs.readFileSync(onDisk)) !== sha) throw new Refused(`${entry.file} on disk does not hash to the anchored ${sha.slice(0, 12)}… — the document was edited after anchoring`);
  log(`decision ${entry.id} anchored in ${entry.txHash} (${entry.anchoredAt})`);

  const v = await readVault(ctx.reader, plan.vault);
  if (v.pendingRegistryChange !== ZERO32) throw new Refused(`a registry change is already pending (${v.pendingRegistryChange}, eta ${iso(v.pendingRegistryEta)}) — re-announcing would restart the 7 days; execute or wait`);
  if (ctx.keeperAddr !== v.owner) throw new Refused(`announce is onlyOwner; owner is ${v.owner}, signer is ${ctx.keeperAddr}`);
  const reads = await ctx.reader.batch([
    ...t.adds.flatMap((a) => [
      { address: plan.vault, abi: VAULT_ABI, functionName: 'isRegistryAsset', args: [a] },
      { address: a, abi: ERC20_ABI, functionName: 'decimals' },
      { address: a, abi: ERC20_ABI, functionName: 'symbol' },
    ]),
    ...t.removes.flatMap((a) => [
      { address: plan.vault, abi: VAULT_ABI, functionName: 'isRegistryAsset', args: [a] },
      { address: plan.vault, abi: VAULT_ABI, functionName: 'inRemoval', args: [a] },
      { address: a, abi: ERC20_ABI, functionName: 'symbol' },
    ]),
  ]);
  t.adds.forEach((a, i) => {
    const add = plan.adds.find((x) => x.address && getAddress(x.address) === a);
    const [isReg, dec, sym] = reads.slice(i * 3, i * 3 + 3);
    if (isReg) throw new Refused(`${add?.symbol ?? a} is already a registry asset`);
    if (Number(dec) !== add.decimals) throw new Refused(`${add.symbol}: ${a} has ${dec} decimals on chain, the plan says ${add.decimals} — a first price sized to the wrong decimals is off by 10× per decimal`);
    if (mockSymbolMismatch(add.symbol, sym)) throw new Refused(`${add.symbol}: ${a} is ${sym} on chain, not m${add.symbol} — wrong mock address in the plan`);
    log(`  add ${add.symbol.padEnd(7)} ${a} ${sym} ${dec} dec — first ref ${add.firstRefPrice} (A ${add.priceA} / B ${add.priceB ?? '—'}, ${add.disagreementBps ?? '—'} bp apart)`);
  });
  t.removes.forEach((a, i) => {
    const rem = plan.removes.find((x) => getAddress(x.address) === a);
    const [isReg, inRem, sym] = reads.slice(t.adds.length * 3 + i * 3, t.adds.length * 3 + i * 3 + 3);
    if (!isReg) throw new Refused(`${rem?.symbol ?? a} is not a registry asset`);
    if (inRem) throw new Refused(`${rem?.symbol ?? a} is already in removal`);
    if (mockSymbolMismatch(rem.symbol, sym)) throw new Refused(`${rem.symbol}: ${a} is ${sym} on chain, not m${rem.symbol} — wrong removal address in the plan`);
    log(`  remove ${rem.symbol.padEnd(7)} ${a} ${sym} (balance ${rem.balance})`);
  });
  log(`checks: no duplicate address in adds or removes, none in both; every chain symbol is m{SYMBOL} (${t.adds.length} add, ${t.removes.length} remove)`);
  const expectedHash = tupleHash(t);
  log(`tuple keccak ${expectedHash}; eta would be now + ${Number(v.registryDelay) / 86400} days`);
  const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'announceRegistryChange', args: [t.adds, t.removes, t.sha], gas: GAS.announce(t.adds.length + t.removes.length), what: 'announce' });
  if (r.dry) return;
  const [pending, eta] = await ctx.reader.batch([
    { address: plan.vault, abi: VAULT_ABI, functionName: 'pendingRegistryChange' },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'pendingRegistryEta' },
  ]);
  if (pending.toLowerCase() !== expectedHash.toLowerCase()) throw new Error(`announced hash ${pending} != expected ${expectedHash}`);
  plan.announce = { txHash: r.hash, block: r.receipt.blockNumber, at: iso(r.blockTimestamp), eta: eta.toString(), etaIso: iso(eta), pendingHash: pending, tuple: { adds: t.adds, removes: t.removes, decisionSha256: t.sha }, decisionId: entry.id, signer: ctx.keeperAddr };
  plan.announceTuple = plan.announce.tuple;
  savePlan(ctx.planFile, plan);
  log(`announced; execute on or after ${iso(eta)}; plan updated`);
}

// ================================================================= execute
/** K-6: executeRegistryChange is permissionless. With nothing pending, the
 *  change was executed when every add of the tuple is in the registry and
 *  every remove is in removal (or already finalized). */
function executedAlready(v, t) {
  if (t.adds.length + t.removes.length === 0) return false;
  const on = (a) => v.assets.find((x) => x.address === a);
  return t.adds.every((a) => !!on(a)) && t.removes.every((a) => !on(a) || on(a).inRemoval);
}

const EXECUTED_EVENT = VAULT_ABI.find((x) => x.type === 'event' && x.name === 'RegistryChangeExecuted');

async function findExecution(ctx, t) {
  const latest = await ctx.pc.getBlockNumber();
  const floor = latest > 100_000n ? latest - 100_000n : 0n; // ≈ 28 h of 1-s blocks, 10 reads at most
  const lo = ctx.plan.announce?.block && BigInt(ctx.plan.announce.block) > floor ? BigInt(ctx.plan.announce.block) : floor;
  for (let to = latest; to >= lo; to -= 10_000n) {
    const from = to - 9_999n > lo ? to - 9_999n : lo;
    const logs = await ctx.pc.getLogs({ address: ctx.plan.vault, event: EXECUTED_EVENT, fromBlock: from, toBlock: to });
    const hit = logs.reverse().find((l) => tupleHash({ adds: l.args.adds.map((a) => getAddress(a)), removes: l.args.removes.map((a) => getAddress(a)), sha: l.args.decisionSha256 }).toLowerCase() === tupleHash(t).toLowerCase());
    if (hit) return hit;
    if (from === lo) break;
  }
  return null;
}

async function stageExecute(ctx) {
  const { plan, log } = ctx;
  const t = tuple(plan);
  const v = await readVault(ctx.reader, plan.vault);
  if (v.pendingRegistryChange === ZERO32) {
    if (!executedAlready(v, t)) throw new Refused('nothing is pending on chain — announce first');
    if (plan.execute?.txHash) { log(`already executed (tx ${plan.execute.txHash}); continuing`); return; }
    let ev = null;
    try { ev = await findExecution(ctx, t); } catch (e) { log(`  could not search for the RegistryChangeExecuted log (${fmtErr(e)})`); }
    const tx = ev ? await ctx.pc.getTransaction({ hash: ev.transactionHash }).catch(() => null) : null;
    const blk = ev ? await ctx.pc.getBlock({ blockNumber: ev.blockNumber }) : null;
    const by = tx?.from ? getAddress(tx.from) : null;
    log(`nothing pending, and the registry already holds this change — executeRegistryChange is permissionless and was called ${by ? `by ${by} in tx ${ev.transactionHash} (block ${ev.blockNumber})` : 'by someone else (tx not found in the last 100,000 blocks)'}; continuing with first-prices`);
    if (!ctx.live) return;
    plan.execute = { txHash: ev?.transactionHash ?? null, block: ev?.blockNumber ?? null, at: blk ? iso(blk.timestamp) : null, assetCount: v.assetCount, order: v.assets.map((x) => x.address), signer: by, byThirdParty: by ? by !== ctx.keeperAddr : true };
    savePlan(ctx.planFile, plan);
    return;
  }
  const h = tupleHash(t);
  if (h.toLowerCase() !== v.pendingRegistryChange.toLowerCase()) throw new Refused(`the plan's tuple hashes to ${h} but the pending change is ${v.pendingRegistryChange} — this plan is not what was announced`);
  if (v.block.timestamp < v.pendingRegistryEta) throw new Refused(`timelock not elapsed: eta ${iso(v.pendingRegistryEta)}, chain time ${iso(v.block.timestamp)} (${Number(v.pendingRegistryEta - v.block.timestamp)} s to go)`);
  log(`pending ${v.pendingRegistryChange} matches the plan; eta ${iso(v.pendingRegistryEta)} passed; assetCount ${v.assetCount} → ${v.assetCount + t.adds.length}`);
  const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'executeRegistryChange', args: [t.adds, t.removes, t.sha], gas: GAS.execute(t.adds.length + t.removes.length), what: 'execute' });
  if (r.dry) return;
  const after = await readVault(ctx.reader, plan.vault);
  if (after.assetCount !== v.assetCount + t.adds.length) throw new Error(`assetCount ${after.assetCount} after execute, expected ${v.assetCount + t.adds.length}`);
  for (const a of t.removes) if (!after.assets.find((x) => x.address === a)?.inRemoval) throw new Error(`${a} not flagged inRemoval after execute`);
  plan.execute = { txHash: r.hash, block: r.receipt.blockNumber, at: iso(r.blockTimestamp), assetCount: after.assetCount, order: after.assets.map((x) => x.address), signer: ctx.keeperAddr };
  savePlan(ctx.planFile, plan);
  log(`executed; ${after.assetCount} assets; every fill on this vault is closed until first-prices runs (portfolioValueAtRef reverts PriceUnset)`);
}

// ============================================================ first-prices
async function stageFirstPrices(ctx) {
  const { plan, log, o } = ctx;
  requirePlanFresh(ctx);
  const v = await readVault(ctx.reader, plan.vault);
  if (v.pendingRegistryChange !== ZERO32) throw new Refused('a registry change is still pending — execute first');
  if (ctx.keeperAddr !== v.keeper) throw new Refused(`setRefPrice is keeper-only; keeper is ${v.keeper}, signer is ${ctx.keeperAddr}`);
  if (plan.adds.length === 0) { log('no adds in the plan — nothing to post'); return; }
  const bandBps = 1_500n;
  for (const add of plan.adds) {
    if (!add.address) throw new Refused(`${add.symbol}: no mock address in the plan`);
    const on = v.assets.find((x) => x.address === add.address);
    if (!on) throw new Refused(`${add.symbol} ${add.address} is not in the registry — execute first`);
    if (on.decimals !== add.decimals) throw new Refused(`${add.symbol}: ${on.decimals} decimals on chain, plan says ${add.decimals}`);
    if (!(add.priceB > 0)) throw new Refused(`${add.symbol}: no second-source price — a band-free first post needs two independent sources`);
    const diff = Math.abs(add.priceA - add.priceB) / add.priceA;
    if (diff > o.firstPriceTol) throw new Refused(`${add.symbol}: sources disagree by ${pct(diff)} (A ${add.priceA}, B ${add.priceB}) > ${pct(o.firstPriceTol)}`);
    const target = toRefPrice(add.priceA, add.decimals);
    if (target !== big(add.firstRefPrice)) throw new Refused(`${add.symbol}: plan firstRefPrice ${add.firstRefPrice} != toRefPrice(${add.priceA}, ${add.decimals}) = ${target}`);
    if (on.refPrice === target) { log(`  ${add.symbol}: reference already ${target} — skipped`); continue; }
    if (on.refPrice !== 0n) {
      const span = (on.refPrice * bandBps) / 10_000n;
      if (target > on.refPrice + span || target < on.refPrice - span) throw new Refused(`${add.symbol}: reference is already set (${on.refPrice}) and ${target} is outside the ±15% band — the daily mark steps references, this stage does not`);
      log(`  ${add.symbol}: reference already set (${on.refPrice}); ${target} is inside the band — posting`);
    }
    log(`  ${add.symbol}: first post ${target} = $${add.priceA} at ${add.decimals} dec (B $${add.priceB}, ${add.disagreementBps} bp apart); ${on.refPrice === 0n ? 'BAND-FREE first post' : 'in-band post'}`);
    const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [add.address, target], gas: GAS.post, what: `first price ${add.symbol}` });
    if (r.dry) continue;
    const back = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [add.address] });
    if (back !== target) throw new Error(`${add.symbol}: refPrice reads ${back} after posting ${target}`);
    plan.firstPrices.push({ symbol: add.symbol, address: add.address, price: target.toString(), priceA: add.priceA, priceB: add.priceB, txHash: r.hash, at: iso(r.blockTimestamp) });
    savePlan(ctx.planFile, plan);
  }
}

// ================================================================ auctions
/** The fair window in seconds after startTime: factor(e) = start − ⌊range·e/dur⌋
 *  (curveFactorBps), fair when ⌊range·e/dur⌋ = premium. */
function fairWindow(duration, premiumBps, maxFillLossBps, windowBps) {
  const range = premiumBps + maxFillLossBps;
  const eMin = Math.ceil(((premiumBps - windowBps) * duration) / range);
  const eMax = Math.ceil(((premiumBps + 1) * duration) / range) - 1;
  return { eMin, eMax, aim: eMin + Math.floor((eMax - eMin) * 0.4), range };
}

async function chainTime(ctx) {
  return (await ctx.pc.getBlock()).timestamp;
}

async function waitUntil(ctx, targetTs, why) {
  let now = await chainTime(ctx);
  if (now >= targetTs) return;
  if (ctx.o.warp) {
    await ctx.pc.request({ method: 'evm_increaseTime', params: [Number(targetTs - now)] });
    await ctx.pc.request({ method: 'evm_mine', params: [] });
    ctx.log(`  warped ${Number(targetTs - now)} s (${why})`);
    return;
  }
  ctx.log(`  waiting ${Number(targetTs - now)} s (${why})`);
  while (now < targetTs) {
    await sleep(Math.min(15_000, Math.max(2_000, Number(targetTs - now) * 1000)));
    now = await chainTime(ctx);
  }
}

async function ensureInventory(ctx, token, symbol, need) {
  const [bal, allowance] = await ctx.reader.batch([
    { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [ctx.bidderAddr] },
    { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.bidderAddr, ctx.plan.vault] },
  ]);
  if (bal < need) {
    if (!ctx.o.faucet) throw new Refused(`bidder ${ctx.bidderAddr} holds ${bal} ${symbol}, needs ${need}, and --no-faucet is set`);
    let faucetAmount;
    try { faucetAmount = await ctx.pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'faucetAmount' }); } catch {
      throw new Refused(`bidder holds ${bal} ${symbol}, needs ${need}, and ${token} has no faucet — fund the bidder`);
    }
    const calls = Number((need - bal + faucetAmount - 1n) / faucetAmount);
    if (calls > ctx.o.maxFaucetCalls) throw new Refused(`bidder needs ${calls} faucet() calls of ${symbol} (${faucetAmount} each) > --max-faucet-calls ${ctx.o.maxFaucetCalls}`);
    ctx.log(`  bidder holds ${bal} ${symbol}, needs ${need}: ${calls} × faucet() (${faucetAmount} each)`);
    for (let i = 0; i < calls; i++) {
      await call(ctx, { who: 'bidder', to: token, abi: ERC20_ABI, functionName: 'faucet', gas: GAS.faucet, what: `faucet ${symbol} ${i + 1}/${calls}` });
      if (!ctx.live) break; // one printed line stands for the loop in a dry run
    }
  }
  if (allowance < need) {
    await call(ctx, { who: 'bidder', to: token, abi: ERC20_ABI, functionName: 'approve', args: [ctx.plan.vault, maxUint256], gas: GAS.approve, what: `approve ${symbol}` });
  }
}

/** A same-value re-post must re-post the value on chain NOW, not the one read
 *  at the start of the trade: if any other keeper run (the daily mark, the
 *  6-hourly NAV keeper, a manual run) moved a reference in between, posting
 *  the old value would step it BACK — this script never moves a reference. */
async function requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t) {
  const [curS, curB] = await ctx.reader.batch([
    { address: ctx.plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [sell] },
    { address: ctx.plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [buy] },
  ]);
  if (curS !== pSell || curB !== pBuy) throw new Refused(`reference moved during the session (${t.sell} ${pSell}→${curS}, ${t.buy} ${pBuy}→${curB}) — another keeper run is active; stopping before any re-post`);
}

/** Missed fair windows cancel and reopen; each miss costs four keeper
 *  transactions, so the retries are bounded. */
const MAX_WINDOW_ATTEMPTS = 3;

async function runHook(ctx, point, info) {
  if (ctx.hook) await ctx.hook(point, info, { rpc: ctx.o.rpc, vault: ctx.plan.vault, chainId: ctx.reader.chainId });
}

async function runTrade(ctx, v, t, round, attemptNo = 1) {
  const { plan, log, o } = ctx;
  // A residual drain under $1 (option K) fills at the open: waiting ~10
  // minutes for the fair point is the window a donation needs, and the most
  // the bidder overpays at the open is 2% of less than $1.
  const policy = t.immediate ? 'open' : o.fill;
  const sell = getAddress(t.sellAddress);
  const buy = getAddress(t.buyAddress);
  const [sellBal, pSell, pBuy, tsSell, tsBuy] = await ctx.reader.batch([
    { address: sell, abi: ERC20_ABI, functionName: 'balanceOf', args: [plan.vault] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [sell] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [buy] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPriceUpdatedAt', args: [sell] },
    { address: plan.vault, abi: VAULT_ABI, functionName: 'refPriceUpdatedAt', args: [buy] },
  ]);
  let amount = t.drain ? sellBal : (big(t.sellAmount) < sellBal ? big(t.sellAmount) : sellBal);
  if (amount === 0n) { log(`  #${t.seq} ${t.sell}→${t.buy}: nothing left to sell — skipped`); return null; }
  if (pSell === 0n || pBuy === 0n) throw new Refused(`#${t.seq}: a leg has no reference (${t.sell} ${pSell}, ${t.buy} ${pBuy})`);
  const now = await chainTime(ctx);
  log(`  #${t.seq} round ${round}${attemptNo > 1 ? ` attempt ${attemptNo}/${MAX_WINDOW_ATTEMPTS}` : ''}: sell ${amount} ${t.sell} for ${t.buy}${t.drain ? ' [drain to zero]' : ''}${t.immediate ? ' [remnant under $1: fill at the open]' : ''}; refs ${pSell} / ${pBuy} aged ${now - tsSell}s / ${now - tsBuy}s (maxRefAge ${v.maxRefAge}s)`);
  // An immediate fill skips the same-value re-posts while both references
  // are comfortably fresh (they were re-posted by the fill a moment ago):
  // fewer transactions, a narrower window.
  const repost = !(t.immediate && now - tsSell < v.maxRefAge - 120n && now - tsBuy < v.maxRefAge - 120n);

  // Inventory for the worst case (+2% at the open), then the auction itself.
  const buyWorst = (amount * pSell * (10_000n + v.premiumBps) + pBuy * 10_000n - 1n) / (pBuy * 10_000n);
  await ensureInventory(ctx, buy, t.buy, buyWorst);
  const idBefore = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'auctionCount' });
  const opened = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'openAuction', args: [sell, buy, amount, BigInt(t.duration)], gas: GAS.openAuction, what: `open auction #${t.seq}` });
  const id = idBefore;
  const win = fairWindow(t.duration, Number(v.premiumBps), Number(v.maxFillLossBps), o.fairWindowBps);
  const aimElapsed = policy === 'fair' ? win.aim : 0;
  if (opened.dry) {
    log(`  would wait ${aimElapsed} s to the ${policy === 'fair' ? `fair window [${win.eMin}, ${win.eMax}] s` : 'open'}, re-read and re-post both references at their current values, then fill(${id}, min(${amount}, live balance)) as bidder ${ctx.bidderAddr}${t.drain ? `; then read ${t.sell}'s balance: zero → finalizeRemoval at once, else re-drain at once (≤ ${MAX_DRAIN_ATTEMPTS}×), else left waiting (finalizePending)` : ''}`);
    await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} (same value)` });
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} (same value)` });
    await call(ctx, { who: 'bidder', to: plan.vault, functionName: 'fill', args: [id, amount], gas: GAS.fill(v.assetCount), what: `fill #${t.seq}`, dependsOnUnsent: true });
    return { dry: true };
  }
  const a = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
  const startTime = BigInt(a[3]);
  if (getAddress(a[0]) !== sell || getAddress(a[1]) !== buy) throw new Error(`auction ${id} is not ours (${a[0]} → ${a[1]})`);

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitUntil(ctx, startTime + BigInt(aimElapsed), policy === 'fair' ? `to the fair point of auction ${id}` : `auction ${id} open`);
    // Same-value re-posts: refresh the staleness clock, move nothing — so the
    // values on chain must still be the ones read at the start of this trade.
    if (repost) {
      await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} (same value)` });
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} (same value)` });
    }
    // K-3: the fill takes what the vault holds NOW, at most the auction's
    // amount — a redemption since the balance was read would otherwise make
    // the fill revert; anything that arrived since stays and is re-drained.
    // Read before the factor, so that the factor check stays the last read
    // before the fill.
    await runHook(ctx, 'before-fill', { seq: t.seq, symbol: t.sell, asset: sell, auctionId: id, amount, drain: !!t.drain, residual: !!t.residual });
    const liveBal = await ctx.pc.readContract({ address: sell, abi: ERC20_ABI, functionName: 'balanceOf', args: [plan.vault] });
    const take = liveBal < amount ? liveBal : amount;
    if (take === 0n) {
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id} (nothing left to sell)` });
      return null;
    }
    const factorNow = Number(await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'curveFactorBps', args: [id] }));
    const late = policy !== 'natural' && factorNow < 10_000;
    const early = policy === 'fair' && factorNow > 10_000 + o.fairWindowBps;
    if (early) {
      log(`  factor ${factorNow} still above the window — waiting`);
      await waitUntil(ctx, (await chainTime(ctx)) + 5n, 'window');
      attempt--; // not a retry, just a wait
      continue;
    }
    if (late) {
      log(`  factor ${factorNow} is below fair — too late for a ${policy} fill; cancelling auction ${id}${attemptNo < MAX_WINDOW_ATTEMPTS ? ' and reopening' : ''}`);
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id}` });
      if (attemptNo >= MAX_WINDOW_ATTEMPTS) throw new Error(`#${t.seq}: missed the fair window ${attemptNo} times (window [${win.eMin}, ${win.eMax}] s of a ${t.duration} s auction = duration/30 wide; three mined transactions must land inside it) — widen the planner's --duration (1800 s gives a 60 s window on the public chain) or run when blocks are quick`);
      return runTrade(ctx, v, t, round, attemptNo + 1);
    }
    if (take !== amount) log(`  live balance ${liveBal} ${t.sell} is below the auction's ${amount} (a redemption in the window) — filling ${take}`);
    const filled = await call(ctx, { who: 'bidder', to: plan.vault, functionName: 'fill', args: [id, take], gas: GAS.fill(v.assetCount), what: `fill #${t.seq} (auction ${id})` });
    const ev = parseEventLogs({ abi: VAULT_ABI, logs: filled.receipt.logs, eventName: 'AuctionFilled' })[0]?.args;
    if (!ev) throw new Error(`no AuctionFilled event in ${filled.hash}`);
    const elapsed = Number(filled.blockTimestamp - startTime);
    const factor = 10_000 + Number(v.premiumBps) - Math.floor((win.range * elapsed) / t.duration);
    const rec = {
      seq: t.seq, round, auctionId: id.toString(), sell: t.sell, buy: t.buy, sellTaken: ev.sellTaken.toString(), buyPaid: ev.buyPaid.toString(),
      lossAtRef: ev.lossAtRef.toString(), factorBps: factor, elapsed, policy, bidder: ctx.bidderAddr,
      openTx: opened.hash, fillTx: filled.hash, at: iso(filled.blockTimestamp),
      ...(take !== amount ? { auctionAmount: amount.toString() } : {}),
      ...(t.residual ? { residualOf: t.parentSeq ?? null } : {}),
    };
    plan.fills.push(rec);
    savePlan(ctx.planFile, plan);
    log(`  filled auction ${id}: took ${ev.sellTaken} ${t.sell}, paid ${ev.buyPaid} ${t.buy}, factor ${factor} bp (${elapsed} s in), lossAtRef ${ev.lossAtRef}`);
    if (policy !== 'natural') {
      if (ev.lossAtRef !== 0n) throw new Error(`HALT: fill ${filled.hash} booked lossAtRef ${ev.lossAtRef} under the ${policy} policy`);
      if (policy === 'fair' && (factor < 10_000 || factor > 10_000 + o.fairWindowBps)) throw new Error(`HALT: fill ${filled.hash} landed at factor ${factor}, outside [10000, ${10_000 + o.fairWindowBps}]`);
    }
    // K-1: a drain is finalized right here, not after the other auctions.
    if (t.drain && !t.residual) await settleRemoval(ctx, v, t, round);
    if (take !== amount) {
      const a2 = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'auctions', args: [id] });
      if (a2[5]) await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel the unfilled rest of auction ${id} (${a2[2]} ${t.sell})` });
    }
    return rec;
  }
  throw new Error(`auction for #${t.seq} could not be filled in the window`);
}

// ------------------------------------------------- removals (option K)
const minTradeValue = (plan) => BigInt(Math.round((plan.policy.minTradeUsd ?? 1) * 1e18)); // USD × 1e18
const usd = (x) => (Number(x) / 1e18).toFixed(Number(x) < 1e18 ? 6 : 2);

/** finalizeRemoval for one drained asset; records it and clears any PENDING.
 *  `assetCount` sizes the gas only — passed in, so that nothing paced (the
 *  public endpoint's batches wait a second each) sits between a drain fill
 *  and its finalize. */
async function finalizeOne(ctx, asset, sym, assetCount) {
  const { plan, log } = ctx;
  const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'finalizeRemoval', args: [asset], gas: GAS.finalize(assetCount + 2), what: `finalize ${sym}` });
  if (r.dry) return;
  const after = await readVault(ctx.reader, plan.vault);
  if (after.assets.some((x) => x.address === asset)) throw new Error(`${sym} still in the registry after finalizeRemoval`);
  plan.finalize.push({ symbol: sym, address: asset, txHash: r.hash, at: iso(r.blockTimestamp), assetCount: after.assetCount, order: after.assets.map((x) => x.address) });
  if (plan.finalizePending) plan.finalizePending = plan.finalizePending.filter((x) => x.address !== asset);
  savePlan(ctx.planFile, plan);
  log(`  ${sym} removed; registry order is now (swap-and-pop) ${after.assets.map((x) => plan.registry.find((p) => p.address === x.address)?.symbol ?? plan.adds.find((p) => p.address === x.address)?.symbol ?? x.address).join(' ')}`);
}

/** K-4: the remnant stays; the run goes on and says so. */
function recordPending(ctx, entry) {
  const { plan, log } = ctx;
  ctx.pendingThisRun.add(entry.address);
  log(`  PENDING ${entry.symbol} ${entry.address}: ${entry.balance} base units (≈ $${entry.valueUsd}) still in the vault after ${entry.attempts} re-drain(s) — finalizeRemoval waits for a later drain (re-run the auctions stage). Redemptions pay the remnant pro rata meanwhile; the record is unaffected.`);
  if (!ctx.live) return;
  plan.finalizePending = [...(plan.finalizePending ?? []).filter((x) => x.address !== entry.address), entry];
  savePlan(ctx.planFile, plan);
}

/**
 * K-1/K-2/K-4 after a drain fill (or for a remnant found later): read the
 * balance; zero → finalize at once; otherwise re-drain from the live balance
 * at once and look again, at most MAX_DRAIN_ATTEMPTS times; then PENDING.
 */
async function settleRemoval(ctx, v, t, round) {
  const { plan, log, o } = ctx;
  const asset = getAddress(t.sellAddress);
  let lastTx = null;
  for (let k = 0; ; k++) {
    await runHook(ctx, 'after-fill', { seq: t.seq, symbol: t.sell, asset, attempt: k });
    // Two direct reads, not a paced batch: this is the window K closes.
    const [bal, ref] = await Promise.all([
      ctx.pc.readContract({ address: asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [plan.vault] }),
      ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'refPrice', args: [asset] }),
    ]);
    if (bal === 0n) {
      log(`  ${t.sell}: balance 0 — finalizing now${k ? ` (after ${k} re-drain(s))` : ''}`);
      await finalizeOne(ctx, asset, t.sell, v.assetCount);
      return 'finalized';
    }
    const value = bal * ref;
    if (k >= MAX_DRAIN_ATTEMPTS) {
      recordPending(ctx, { symbol: t.sell, address: asset, balance: bal.toString(), valueUsd: usd(value), attempts: k, lastTx, at: iso(await chainTime(ctx)), stage: o.stage });
      return 'pending';
    }
    const dust = value < minTradeValue(plan);
    log(`  ${t.sell}: ${bal} base units (≈ $${usd(value)}) in the vault after the drain — re-drain ${k + 1}/${MAX_DRAIN_ATTEMPTS} now${dust ? ', filled at the open (under the $1 trade minimum)' : `, ${o.fill} fill`}`);
    const rec = await runTrade(ctx, v, { ...t, seq: `${t.seq}.r${k + 1}`, parentSeq: t.seq, sellAmount: bal, drain: true, residual: true, immediate: dust }, round);
    if (rec?.fillTx) lastTx = rec.fillTx;
  }
}

/** A buy leg for a remnant: the plan's own drain buy, else the largest holding. */
function remnantBuy(ctx, v, sym) {
  const t = ctx.plan.trades.find((x) => x.sell === sym && x.drain);
  if (t && v.assets.some((a) => a.address === getAddress(t.buyAddress) && !a.inRemoval)) return { buy: t.buy, buyAddress: getAddress(t.buyAddress), duration: t.duration };
  const best = v.assets.filter((a) => !a.inRemoval && a.refPrice > 0n).sort((a, b) => (b.balance * b.refPrice > a.balance * a.refPrice ? 1 : -1))[0];
  const bySym = ctx.plan.registry.find((r) => r.address === best.address)?.symbol ?? ctx.plan.adds.find((r) => r.address === best.address)?.symbol ?? best.onchainSymbol;
  return { buy: bySym, buyAddress: best.address, duration: ctx.plan.policy.duration };
}

/** After each round: every asset in removal is finalized when drained, or
 *  re-drained (K-2) — this covers a re-run and a remnant that reached the
 *  vault in another trade's window. One PENDING per asset per run. */
async function sweepRemovals(ctx, round) {
  const v = await readVault(ctx.reader, ctx.plan.vault);
  for (const a of v.assets.filter((x) => x.inRemoval)) {
    if (ctx.pendingThisRun.has(a.address)) continue;
    const sym = ctx.plan.removes.find((r) => r.address === a.address)?.symbol ?? a.onchainSymbol;
    if (a.balance === 0n) { await finalizeOne(ctx, a.address, sym, v.assetCount); continue; }
    const b = remnantBuy(ctx, v, sym);
    ctx.log(`  ${sym} is in removal with ${a.balance} base units left — draining it now`);
    await settleRemoval(ctx, v, { seq: `sweep-${sym}`, sell: sym, sellAddress: a.address, ...b, drain: true }, round);
  }
}

/** Live rows for computeTrades: chain balances, chain references, plan targets. */
async function liveRows(ctx, v) {
  const removes = new Set(ctx.plan.removes.map((r) => r.symbol));
  const bySym = await assetIndex(ctx, v);
  return Object.values(bySym).map((a) => {
    const tgt = ctx.plan.targets.find((t) => t.symbol === a.symbol);
    // The target the auctions can reach (plan tradeTargetWeight): held names
    // keep their weight, the traded set shares its own value.
    return { symbol: a.symbol, address: a.address, decimals: a.decimals, balance: a.balance, ref: a.refPrice, targetWeight: tgt?.tradeTargetWeight ?? tgt?.targetWeight ?? 0, isAdd: false, isRemove: removes.has(a.symbol) || a.inRemoval, sleeve: tgt?.sleeve };
  });
}

/**
 * Owner choice 4 of the planner spec of 2026-10-01 (§5, still open): what a
 * traded name may differ from its trade target after the session. null —
 * option ①, the spec's §4 rule: the bound the fills themselves allow
 * (residualBound below, computed from settings that exist already: the fair
 * window and the $1 trade minimum). A number — option ②: a fixed width in
 * points, whose value is the owner's to set. Before this change the width
 * was the rulebook's 5-point tolerance, which hid a whole entering name.
 */
export const VERIFY_FIXED_POINTS = null;

/**
 * How far a traded name can sit from its trade target after fills inside
 * the fair window, as a weight (planner spec §4):
 *   window × (bought_i + aim_i × bought) / V  +  (n × $1 + k × maxRef) / V
 * window — the fill policy's fair window (--fair-window-bps, 10 bp): a fill
 * at factor f pays (f − 10,000)/10,000 more of the buy asset than fair, so
 * the name bought gains and every name's share of the larger vault shrinks;
 * bought_i / bought — value the plan's fills put into the name / into all
 * names, at today's references; n — traded names (each matching step of the
 * planner leaves at most the $1 trade minimum unmatched on a name, and there
 * are fewer steps than traded names); k × maxRef — one base unit per fill
 * from rounding; V — the vault's value now.
 */
export function residualBound(ctx, rows) {
  const total = rows.reduce((t, r) => t + Number(r.balance * r.ref), 0);
  const traded = new Set(ctx.plan.targets.filter((t) => t.traded).map((t) => t.symbol));
  const windowFrac = (ctx.o?.fairWindowBps ?? 10) / 10_000;
  const refOf = Object.fromEntries(rows.map((r) => [r.symbol, r.ref]));
  const bought = {};
  let boughtAll = 0;
  const fills = ctx.plan.fills ?? [];
  for (const f of fills) {
    const ref = refOf[f.buy];
    if (ref == null) continue;
    const v = Number(big(f.buyPaid) * ref);
    bought[f.buy] = (bought[f.buy] ?? 0) + v;
    boughtAll += v;
  }
  const n = rows.filter((r) => traded.has(r.symbol) || r.isRemove).length;
  const maxRef = rows.reduce((m, r) => (r.ref > m ? r.ref : m), 0n);
  const slack = total > 0 ? (n * Number(minTradeValue(ctx.plan)) + fills.length * Number(maxRef)) / total : 0;
  return (r) => (total > 0 ? (windowFrac * ((bought[r.symbol] ?? 0) + Math.max(0, r.targetWeight) * boughtAll)) / total : 0) + slack;
}

export function residual(ctx, rows) {
  const total = rows.reduce((t, r) => t + Number(r.balance * r.ref), 0);
  const traded = new Set(ctx.plan.targets.filter((t) => t.traded).map((t) => t.symbol));
  const minValue = minTradeValue(ctx.plan);
  const boundOf = VERIFY_FIXED_POINTS != null ? () => VERIFY_FIXED_POINTS / 100 : residualBound(ctx, rows);
  const out = [];
  for (const r of rows) {
    const w = total > 0 ? Number(r.balance * r.ref) / total : 0;
    const drift = w - r.targetWeight;
    const bound = boundOf(r);
    // K-4: a removal remnant under the trade minimum is PENDING, not a failure.
    const pending = r.isRemove && r.balance > 0n && r.balance * r.ref < minValue;
    out.push({ symbol: r.symbol, weight: w, targetWeight: r.targetWeight, drift, bound, ok: r.isRemove ? r.balance === 0n : !traded.has(r.symbol) || Math.abs(drift) <= bound, pending });
  }
  return out;
}

async function stageAuctions(ctx) {
  const { plan, log, o } = ctx;
  requirePlanFresh(ctx);
  let v = await readVault(ctx.reader, plan.vault);
  if (v.pendingRegistryChange !== ZERO32) throw new Refused('a registry change is pending — execute it before trading');
  if (ctx.keeperAddr !== v.keeper) throw new Refused(`openAuction/setRefPrice are keeper-only; keeper is ${v.keeper}, signer is ${ctx.keeperAddr}`);
  const unpriced = v.assets.filter((a) => a.refPrice === 0n);
  if (unpriced.length) throw new Refused(`unpriced registry assets ${unpriced.map((a) => a.address).join(', ')} — every fill reverts PriceUnset until first-prices runs`);
  if (!v.biddingOpen) {
    const isB = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'isBidder', args: [ctx.bidderAddr] });
    if (!isB) throw new Refused(`bidder ${ctx.bidderAddr} is not whitelisted (isBidder false, biddingOpen false) — owner setBidder first`);
  }
  // References must be today's marks: this script never moves one.
  const bySym = await assetIndex(ctx, v);
  for (const [sym, a] of Object.entries(bySym)) {
    const planRef = plan.registry.find((r) => r.symbol === sym)?.planRefPrice ?? plan.adds.find((r) => r.symbol === sym)?.firstRefPrice;
    if (planRef == null) continue;
    const d = Math.abs(Number(a.refPrice) - Number(planRef)) / Number(planRef);
    if (d > o.refDriftTol) throw new Refused(`${sym}: chain reference ${a.refPrice} is ${pct(d)} from the plan's ${planRef} (> ${pct(o.refDriftTol)}) — re-mark with the daily keeper (paper-index.mjs) first; this script does not move references`);
  }
  // The plan sized every amount at the references it read on chain (planner
  // spec 2026-10-01 §1.3) — the prices the contract fills at. A reference
  // that moved since (a daily or NAV mark between the plan and this run)
  // makes the planned amounts miss the book by that move: regenerate.
  if (plan.trades.length > 0) {
    const moved = [];
    for (const r of plan.registry) {
      if (r.chainRefAtPlan == null) continue;
      const on = v.assets.find((a) => a.address === getAddress(r.address));
      if (on && on.refPrice !== big(r.chainRefAtPlan)) moved.push(`${r.symbol} ${r.chainRefAtPlan}→${on.refPrice}`);
    }
    if (moved.length) throw new Refused(`reference(s) moved since the plan sized its auctions (${moved.join(', ')}) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage`);
  }
  log(`${plan.trades.length} planned auction(s); ${plan.fills.length} already filled; fill policy ${o.fill}; every reference within ${pct(o.refDriftTol)} of the plan${plan.trades.length ? ' and equal to the one the plan sized at' : ''}`);
  if (plan.trades.length === 0) {
    // A plan made on a later day has no auction for a remnant under the
    // trade minimum (computeTrades skips it), and none for a removal when
    // nothing else trades. An asset still in removal is drained and
    // finalized all the same — otherwise a PENDING left by an earlier
    // session could never be cleared by re-running this stage.
    const left = v.assets.filter((a) => a.inRemoval);
    if (left.length === 0) { log('nothing to trade'); return; }
    const names = left.map((a) => `${plan.removes.find((r) => r.address === a.address)?.symbol ?? a.onchainSymbol} (${a.balance} base units)`).join(', ');
    if (!ctx.live) { log(`no planned auction; still in removal: ${names} — a live run drains and finalizes (option K)`); return; }
    log(`no planned auction; still in removal: ${names} — draining and finalizing`);
    await sweepRemovals(ctx, 1);
    return;
  }

  for (let round = 1; round <= o.maxRounds; round++) {
    let trades;
    if (round === 1) {
      const done = new Set(plan.fills.filter((f) => f.round === 1).map((f) => f.seq));
      trades = plan.trades.filter((t) => !done.has(t.seq));
    } else {
      const rows = await liveRows(ctx, v);
      const traded = plan.targets.filter((t) => t.traded).map((t) => t.symbol);
      trades = computeTrades(rows, plan.policy, { forceTraded: traded, onlyForced: true }).trades;
      log(`round ${round}: ${trades.length} residual auction(s) from live balances`);
    }
    for (const t of trades) await runTrade(ctx, v, t, round);
    if (!ctx.live) { log('dry run: residual rounds need the fills above to have happened — stopping after round 1'); return; }
    await sweepRemovals(ctx, round);
    v = await readVault(ctx.reader, plan.vault);
    const res = residual(ctx, await liveRows(ctx, v));
    for (const r of res) log(`  ${r.symbol.padEnd(7)} ${pct(r.weight).padStart(7)} vs trade target ${pct(r.targetWeight).padStart(7)} (${(r.drift * 100).toFixed(4)} pt, bound ${(r.bound * 100).toFixed(4)} pt) ${r.ok ? 'ok' : r.pending ? 'PENDING (remnant under $1, finalize waiting)' : 'OUTSIDE'}`);
    if (res.every((r) => r.ok || r.pending)) { log(`inside the bound after round ${round}${res.some((r) => r.pending) ? `; PENDING: ${res.filter((r) => r.pending).map((r) => r.symbol).join(', ')}` : ''}`); return; }
  }
  throw new Error(`still outside the bound after ${o.maxRounds} round(s)`);
}

// ================================================================ finalize
async function stageFinalize(ctx) {
  const { plan, log } = ctx;
  const v = await readVault(ctx.reader, plan.vault);
  const inRem = v.assets.filter((a) => a.inRemoval);
  if (inRem.length === 0) { log('no asset is in removal — nothing to finalize'); return; }
  let blocked = 0;
  for (const a of inRem) {
    const sym = plan.removes.find((r) => r.address === a.address)?.symbol ?? a.onchainSymbol;
    if (a.balance !== 0n) {
      const value = a.balance * a.refPrice;
      if (value < minTradeValue(plan)) {
        // K-4: what the auctions stage could not drain in five tries, or a
        // remnant that arrived since — PENDING, not a failure.
        const prev = plan.finalizePending?.find((x) => x.address === a.address);
        recordPending(ctx, { symbol: sym, address: a.address, balance: a.balance.toString(), valueUsd: usd(value), attempts: prev?.attempts ?? 0, lastTx: prev?.lastTx ?? null, at: iso(v.block.timestamp), stage: 'finalize' });
        continue;
      }
      log(`  ${sym} ${a.address}: balance ${a.balance} (≈ $${usd(value)}) is not zero — cannot finalize; drain it with the auctions stage (it finalizes right after the drain)`);
      blocked++;
      continue;
    }
    await finalizeOne(ctx, a.address, sym, v.assetCount);
  }
  if (blocked) throw new Error(`${blocked} removal(s) not drained`);
}

// ================================================================== verify
async function stageVerify(ctx) {
  const { plan, log } = ctx;
  const v = await readVault(ctx.reader, plan.vault);
  const fails = [];
  const check = (ok, msg) => { log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
  check(v.pendingRegistryChange === ZERO32, `no pending registry change (${v.pendingRegistryChange === ZERO32 ? 'none' : v.pendingRegistryChange})`);
  const bySym = await assetIndex(ctx, v);
  for (const a of plan.adds) {
    const on = a.address ? v.assets.find((x) => x.address === a.address) : null;
    check(!!on, `${a.symbol} is in the registry`);
    if (on) check(on.refPrice !== 0n, `${a.symbol} has a reference (${on.refPrice}, age ${Number(v.block.timestamp - on.refPriceUpdatedAt)} s)`);
    if (on) check(on.decimals === a.decimals, `${a.symbol} decimals ${on.decimals} == plan ${a.decimals}`);
  }
  for (const r of plan.removes) {
    const on = v.assets.find((x) => x.address === r.address);
    if (on) check(on.inRemoval, `${r.symbol} still held: inRemoval=${on.inRemoval}, balance ${on.balance} (finalize pending)`);
    else check(true, `${r.symbol} is out of the registry`);
  }
  const expectedCount = plan.registry.length + plan.adds.length - plan.finalize.length;
  check(v.assetCount === expectedCount, `assetCount ${v.assetCount} == ${expectedCount} (registry ${plan.registry.length} + adds ${plan.adds.length} − finalized ${plan.finalize.length})`);
  const order = v.assets.map((x) => bySym[Object.keys(bySym).find((s) => bySym[s].address === x.address)]?.symbol ?? x.address);
  log(`  registry order (assets(i), what the site's amount vector must follow): ${order.join(' ')}`);
  const stale = v.assets.filter((a) => v.block.timestamp - a.refPriceUpdatedAt > v.maxRefAge);
  log(`  ${stale.length} reference(s) older than maxRefAge ${v.maxRefAge} s${stale.length ? ' (fills would revert RefPriceStale until the daily mark; not a failure)' : ''}`);
  const res = residual(ctx, await liveRows(ctx, v));
  for (const r of res) {
    const book = plan.targets.find((t) => t.symbol === r.symbol)?.targetWeight;
    const line = `${r.symbol.padEnd(7)} weight ${pct(r.weight).padStart(7)} trade target ${pct(r.targetWeight).padStart(7)} (book ${book != null ? pct(book) : '—'}) drift ${(r.drift * 100).toFixed(4)} pt (bound ${(r.bound * 100).toFixed(4)} pt)`;
    if (!r.ok && r.pending) log(`  PEND ${line} — PENDING: in removal, remnant under $1, finalize waiting (not a failure)`);
    else check(r.ok, line);
  }
  for (const p of plan.finalizePending ?? []) log(`  PENDING ${p.symbol} ${p.address}: ${p.balance} base units (≈ $${p.valueUsd}) after ${p.attempts} re-drain(s), since ${p.at}`);
  // A redeem simulation from the owner (the genesis holder): the payout must
  // have one slice per registry asset. Reads no price, so it works in any state.
  const ownerShares = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'balanceOf', args: [v.owner] });
  if (ownerShares >= 10n ** 18n) {
    try {
      const { result } = await ctx.pc.simulateContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'redeem', args: [10n ** 18n, v.owner], account: v.owner });
      check(result.length === v.assetCount, `redeem(1 share) simulated from ${v.owner}: ${result.length} amounts, ${result.filter((x) => x > 0n).length} nonzero`);
    } catch (e) {
      check(false, `redeem simulation reverted: ${fmtErr(e)}`);
    }
  } else log(`  (owner holds ${ownerShares} share-wei — redeem simulation skipped)`);
  plan.verify = { at: new Date().toISOString(), block: v.block.number.toString(), assetCount: v.assetCount, order: v.assets.map((x) => x.address), fails, pending: res.filter((r) => !r.ok && r.pending).map((r) => r.symbol), weights: res.map((r) => ({ symbol: r.symbol, weight: r.weight, targetWeight: r.targetWeight })) };
  savePlan(ctx.planFile, plan);
  if (fails.length) throw new Error(`verify: ${fails.length} check(s) failed`);
  log(`verify: all checks passed${plan.verify.pending.length ? ` (PENDING: ${plan.verify.pending.join(', ')})` : ''}`);
}

// ---------------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const ctx = await makeCtx(o);
  const run = async (stage, fn) => { ctx.o.stage = stage; ctx.log(`— ${stage} —`); await fn(ctx); };
  switch (o.stage) {
    case 'announce': return stageAnnounce(ctx);
    case 'execute': return stageExecute(ctx);
    case 'first-prices': return stageFirstPrices(ctx);
    case 'auctions': return stageAuctions(ctx);
    case 'finalize': return stageFinalize(ctx);
    case 'verify': return stageVerify(ctx);
    case 'day7':
      // first-prices and auctions refuse a plan not generated today; check it
      // BEFORE execute is sent, or a stale plan executes and then stops.
      requirePlanFresh(ctx);
      await run('execute', stageExecute);
      await run('first-prices', stageFirstPrices);
      await run('auctions', stageAuctions);
      await run('finalize', stageFinalize);
      await run('verify', stageVerify);
      return;
    default: throw new Error(`unknown stage ${o.stage}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    if (e instanceof Refused) {
      console.error(`REFUSED: ${e.message}`);
      process.exit(1);
    }
    console.error(e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
}
