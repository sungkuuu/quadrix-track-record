/**
 * Basket reconstitution executor — runs one plan (keeper/basket-plan.mjs)
 * against a QuadrixBasketVault v3.1, one stage at a time.
 *
 *   announce      owner: announceRegistryChange(adds, removes, decisionSha256)
 *   execute       anyone: executeRegistryChange(same tuple) once the 7 days ran
 *   first-prices  keeper: the first setRefPrice for every added asset
 *   auctions      keeper opens, the bidder fills, until every traded name is
 *                 inside the rulebook tolerance and every removal is drained
 *   finalize      anyone: finalizeRemoval for each drained removal
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
 *     any post that would step outside the ±15% band; and refuses to trade
 *     while a chain reference is more than --ref-drift-tol (5%) away from
 *     the plan's price — re-mark with the daily keeper first.
 * Fills are taken at the curve's fair point by default (--fill fair: factor
 * 10,000 ≤ f ≤ 10,010, so lossAtRef is 0 and share value is unchanged);
 * --fill open takes the +2% start (a gift to holders); --fill natural fills
 * at whatever point the script reaches, bounded only by the contract. The
 * fair window is duration/30 seconds wide (30 s at 900 s); a missed window
 * cancels and reopens at most twice, then stops with a message to widen the
 * planner's --duration (1800 s gives 60 s on the public chain).
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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  log(`${mode}; rpc ${o.rpc}; plan ${path.relative(ROOT, planFile)} (${plan.date}, ${plan.adds.length} add, ${plan.removes.length} remove, ${plan.trades.length} auction); keeper/owner signer ${keeperAddr}; bidder ${bidderAddr}; fill ${o.fill}`);
  return { o, log, plan, planFile, reader, pc: reader.publicClient, devNode, keeperAddr, keeperWallet, bidderAddr, bidderWallet, live: o.live };
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
    ]),
  ]);
  t.adds.forEach((a, i) => {
    const add = plan.adds.find((x) => x.address === a);
    const [isReg, dec, sym] = reads.slice(i * 3, i * 3 + 3);
    if (isReg) throw new Refused(`${add?.symbol ?? a} is already a registry asset`);
    if (Number(dec) !== add.decimals) throw new Refused(`${add.symbol}: ${a} has ${dec} decimals on chain, the plan says ${add.decimals} — a first price sized to the wrong decimals is off by 10× per decimal`);
    log(`  add ${add.symbol.padEnd(7)} ${a} ${sym} ${dec} dec — first ref ${add.firstRefPrice} (A ${add.priceA} / B ${add.priceB ?? '—'}, ${add.disagreementBps ?? '—'} bp apart)`);
  });
  t.removes.forEach((a, i) => {
    const rem = plan.removes.find((x) => x.address === a);
    const [isReg, inRem] = reads.slice(t.adds.length * 3 + i * 2, t.adds.length * 3 + i * 2 + 2);
    if (!isReg) throw new Refused(`${rem?.symbol ?? a} is not a registry asset`);
    if (inRem) throw new Refused(`${rem?.symbol ?? a} is already in removal`);
    log(`  remove ${rem?.symbol ?? '?'} ${a} (balance ${rem?.balance})`);
  });
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
async function stageExecute(ctx) {
  const { plan, log } = ctx;
  const t = tuple(plan);
  const v = await readVault(ctx.reader, plan.vault);
  if (v.pendingRegistryChange === ZERO32) throw new Refused('nothing is pending on chain — announce first');
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

async function runTrade(ctx, v, t, round, attemptNo = 1) {
  const { plan, log, o } = ctx;
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
  log(`  #${t.seq} round ${round}${attemptNo > 1 ? ` attempt ${attemptNo}/${MAX_WINDOW_ATTEMPTS}` : ''}: sell ${amount} ${t.sell} for ${t.buy}${t.drain ? ' [drain to zero]' : ''}; refs ${pSell} / ${pBuy} aged ${now - tsSell}s / ${now - tsBuy}s (maxRefAge ${v.maxRefAge}s)`);

  // Inventory for the worst case (+2% at the open), then the auction itself.
  const buyWorst = (amount * pSell * (10_000n + v.premiumBps) + pBuy * 10_000n - 1n) / (pBuy * 10_000n);
  await ensureInventory(ctx, buy, t.buy, buyWorst);
  const idBefore = await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'auctionCount' });
  const opened = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'openAuction', args: [sell, buy, amount, BigInt(t.duration)], gas: GAS.openAuction, what: `open auction #${t.seq}` });
  const id = idBefore;
  const win = fairWindow(t.duration, Number(v.premiumBps), Number(v.maxFillLossBps), o.fairWindowBps);
  const aimElapsed = o.fill === 'fair' ? win.aim : 0;
  if (opened.dry) {
    log(`  would wait ${aimElapsed} s to the ${o.fill === 'fair' ? `fair window [${win.eMin}, ${win.eMax}] s` : 'open'}, re-read and re-post both references at their current values, then fill(${id}, ${amount}) as bidder ${ctx.bidderAddr}`);
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
    await waitUntil(ctx, startTime + BigInt(aimElapsed), o.fill === 'fair' ? `to the fair point of auction ${id}` : `auction ${id} open`);
    // Same-value re-posts: refresh the staleness clock, move nothing — so the
    // values on chain must still be the ones read at the start of this trade.
    await requireRefsUnmoved(ctx, sell, buy, pSell, pBuy, t);
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [sell, pSell], gas: GAS.post, what: `re-post ${t.sell} (same value)` });
    await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'setRefPrice', args: [buy, pBuy], gas: GAS.post, what: `re-post ${t.buy} (same value)` });
    const factorNow = Number(await ctx.pc.readContract({ address: plan.vault, abi: VAULT_ABI, functionName: 'curveFactorBps', args: [id] }));
    const late = o.fill !== 'natural' && factorNow < 10_000;
    const early = o.fill === 'fair' && factorNow > 10_000 + o.fairWindowBps;
    if (early) {
      log(`  factor ${factorNow} still above the window — waiting`);
      await waitUntil(ctx, (await chainTime(ctx)) + 5n, 'window');
      attempt--; // not a retry, just a wait
      continue;
    }
    if (late) {
      log(`  factor ${factorNow} is below fair — too late for a ${o.fill} fill; cancelling auction ${id}${attemptNo < MAX_WINDOW_ATTEMPTS ? ' and reopening' : ''}`);
      await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'cancelAuction', args: [id], gas: GAS.openAuction, what: `cancel auction ${id}` });
      if (attemptNo >= MAX_WINDOW_ATTEMPTS) throw new Error(`#${t.seq}: missed the fair window ${attemptNo} times (window [${win.eMin}, ${win.eMax}] s of a ${t.duration} s auction = duration/30 wide; three mined transactions must land inside it) — widen the planner's --duration (1800 s gives a 60 s window on the public chain) or run when blocks are quick`);
      return runTrade(ctx, v, t, round, attemptNo + 1);
    }
    const filled = await call(ctx, { who: 'bidder', to: plan.vault, functionName: 'fill', args: [id, amount], gas: GAS.fill(v.assetCount), what: `fill #${t.seq} (auction ${id})` });
    const ev = parseEventLogs({ abi: VAULT_ABI, logs: filled.receipt.logs, eventName: 'AuctionFilled' })[0]?.args;
    if (!ev) throw new Error(`no AuctionFilled event in ${filled.hash}`);
    const elapsed = Number(filled.blockTimestamp - startTime);
    const factor = 10_000 + Number(v.premiumBps) - Math.floor((win.range * elapsed) / t.duration);
    const rec = {
      seq: t.seq, round, auctionId: id.toString(), sell: t.sell, buy: t.buy, sellTaken: ev.sellTaken.toString(), buyPaid: ev.buyPaid.toString(),
      lossAtRef: ev.lossAtRef.toString(), factorBps: factor, elapsed, policy: o.fill, bidder: ctx.bidderAddr,
      openTx: opened.hash, fillTx: filled.hash, at: iso(filled.blockTimestamp),
    };
    plan.fills.push(rec);
    savePlan(ctx.planFile, plan);
    log(`  filled auction ${id}: took ${ev.sellTaken} ${t.sell}, paid ${ev.buyPaid} ${t.buy}, factor ${factor} bp (${elapsed} s in), lossAtRef ${ev.lossAtRef}`);
    if (o.fill !== 'natural') {
      if (ev.lossAtRef !== 0n) throw new Error(`HALT: fill ${filled.hash} booked lossAtRef ${ev.lossAtRef} under the ${o.fill} policy`);
      if (o.fill === 'fair' && (factor < 10_000 || factor > 10_000 + o.fairWindowBps)) throw new Error(`HALT: fill ${filled.hash} landed at factor ${factor}, outside [10000, ${10_000 + o.fairWindowBps}]`);
    }
    return rec;
  }
  throw new Error(`auction for #${t.seq} could not be filled in the window`);
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

function residual(ctx, rows) {
  const tol = ctx.plan.policy.tolerancePoints / 100;
  const total = rows.reduce((t, r) => t + Number(r.balance * r.ref), 0);
  const traded = new Set(ctx.plan.targets.filter((t) => t.traded).map((t) => t.symbol));
  const out = [];
  for (const r of rows) {
    const w = total > 0 ? Number(r.balance * r.ref) / total : 0;
    const drift = w - r.targetWeight;
    out.push({ symbol: r.symbol, weight: w, targetWeight: r.targetWeight, drift, ok: r.isRemove ? r.balance === 0n : !traded.has(r.symbol) || Math.abs(drift) < tol });
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
  log(`${plan.trades.length} planned auction(s); ${plan.fills.length} already filled; fill policy ${o.fill}; every reference within ${pct(o.refDriftTol)} of the plan`);
  if (plan.trades.length === 0) { log('nothing to trade'); return; }

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
    v = await readVault(ctx.reader, plan.vault);
    const res = residual(ctx, await liveRows(ctx, v));
    for (const r of res) log(`  ${r.symbol.padEnd(7)} ${pct(r.weight).padStart(7)} vs trade target ${pct(r.targetWeight).padStart(7)} (${(r.drift * 100).toFixed(2)} pt) ${r.ok ? 'ok' : 'OUTSIDE'}`);
    if (res.every((r) => r.ok)) { log(`inside tolerance after round ${round}`); return; }
  }
  throw new Error(`still outside tolerance after ${o.maxRounds} round(s)`);
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
      log(`  ${sym} ${a.address}: balance ${a.balance} is not zero — cannot finalize (drain by auction; a 1-unit donation from anyone blocks this, and the leg keeps paying out in every redemption meanwhile)`);
      blocked++;
      continue;
    }
    const r = await call(ctx, { who: 'keeper', to: plan.vault, functionName: 'finalizeRemoval', args: [a.address], gas: GAS.finalize(v.assetCount), what: `finalize ${sym}` });
    if (r.dry) continue;
    const after = await readVault(ctx.reader, plan.vault);
    if (after.assets.some((x) => x.address === a.address)) throw new Error(`${sym} still in the registry after finalizeRemoval`);
    plan.finalize.push({ symbol: sym, address: a.address, txHash: r.hash, at: iso(r.blockTimestamp), assetCount: after.assetCount, order: after.assets.map((x) => x.address) });
    savePlan(ctx.planFile, plan);
    log(`  ${sym} removed; registry order is now (swap-and-pop) ${after.assets.map((x) => plan.registry.find((p) => p.address === x.address)?.symbol ?? plan.adds.find((p) => p.address === x.address)?.symbol ?? x.address).join(' ')}`);
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
    check(r.ok, `${r.symbol.padEnd(7)} weight ${pct(r.weight).padStart(7)} trade target ${pct(r.targetWeight).padStart(7)} (book ${book != null ? pct(book) : '—'}) drift ${(r.drift * 100).toFixed(2)} pt`);
  }
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
  plan.verify = { at: new Date().toISOString(), block: v.block.number.toString(), assetCount: v.assetCount, order: v.assets.map((x) => x.address), fails, weights: res.map((r) => ({ symbol: r.symbol, weight: r.weight, targetWeight: r.targetWeight })) };
  savePlan(ctx.planFile, plan);
  if (fails.length) throw new Error(`verify: ${fails.length} check(s) failed`);
  log('verify: all checks passed');
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

main().catch((e) => {
  if (e instanceof Refused) {
    console.error(`REFUSED: ${e.message}`);
    process.exit(1);
  }
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
