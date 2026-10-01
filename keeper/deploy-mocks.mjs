/**
 * Deploys the mock constituents a basket reconstitution adds (GIWA Sepolia
 * testnet), one MockConstituent per entering name and basket, and writes
 * their addresses to keeper/mocks/{date}.json — the file the planner's
 * --mocks (and the basket-reconstitution workflow's `mocks` input) reads.
 *
 * Convention, measured on chain 2026-10-01 (block 37,498,048): every basket
 * holds its OWN mock of a name. Fourteen symbols are held by more than one of
 * the six vaults (HYPE and UNI by four) and no two vaults share an address.
 * So a name entering three baskets (NEAR: qREV, qAI, qX20) gets three mocks,
 * and the output is keyed by index: {qrev: {NEAR: {address, decimals, …}}, …}.
 *
 * Each mock is the deployed contract (keeper/artifacts/MockConstituent.json;
 * before deploying, its runtime code is compared with a mock already in the
 * target vault — equal except the two immutables and the build metadata), with
 * the conventions of the site repository's DeployIndexBasket script and
 * gen-manifest.py:
 *   name "Mock {Name}", symbol m{SYMBOL};
 *   decimals = clamp(floor(log10 price) + 9, 0, 18) — nine to ten significant
 *     digits of reference price; the planner and the executor read the chain's
 *     decimals back, so a deployed mock is the truth from here on;
 *   faucetAmount = amountPerShare × 1,000 (one faucet call = one 1,000-share
 *     creation basket), amountPerShare = floor(weight × 10^decimals / price)
 *     for a $1 share — the faucet stays open to anyone;
 *   genesis allotment to the BIDDER, not the deployer: the vault already has
 *     its shares, and the entering name reaches the vault only by auction, so
 *     the bidder must hold it — `--inventory-x` (2) times the vault's target
 *     holding at today's price (the buy-in at the +2% open plus the residual
 *     rounds, with no faucet calls);
 *   desk inventory (100,000 shares' worth) only when --desk is given; without
 *     it the desk tops itself up from the open faucet (functions/api/desk.js).
 * Price and weight are the day's record row (qREV, qDEFI, qAI, Triens) or, for
 * qX20, which has no record series, the book (keeper/state.json) at source A
 * (CoinGecko) with source B (CoinPaprika) as fallback — the planner's sources.
 *
 * Work order: keeper/pending-registry-{index}.json of --date, its adds whose
 * address is null. A name already in the output file with code on chain is
 * skipped, so a re-run after a partial failure deploys only what is missing;
 * the file is written after every deployment.
 *
 * DRY RUN IS THE DEFAULT: each deployment is simulated (eth_call of the init
 * code from the signer) and printed. --live sends with KEEPER_PK (the deployer
 * key of every basket), or — rehearsal on a local anvil only — from an
 * unlocked --from. Every receipt must be mined without revert and every new
 * mock is read back (code, name, symbol, decimals, faucetAmount, genesis
 * balance) before the next one. Keys are never printed.
 *
 * Usage:
 *   node keeper/deploy-mocks.mjs --date 2026-10-01                     # dry run, every index with adds that day
 *   KEEPER_PK=0x… BIDDER_PK=0x… node keeper/deploy-mocks.mjs --date 2026-10-01 --live
 *   node keeper/deploy-mocks.mjs --date 2026-10-01 --index qrev --live --rpc http://127.0.0.1:8545 \
 *        --from 0x<owner> --genesis-to 0x<bidder>                       # anvil rehearsal
 *
 * Options:
 *   --date YYYY-MM-DD    the pending-registry date (default today, UTC); names the output
 *   --index a,b          subset (default: every index with a pending-registry file of --date)
 *   --rpc URL            default GIWA Sepolia public RPC; --chain-id n for a fresh anvil
 *   --live               send (default: dry run)
 *   --from 0x…           unlocked sender (anvil only; requires --live and a local --rpc)
 *   --genesis-to 0x…     bidder inventory recipient (default: BIDDER_PK's address, else the signer)
 *   --desk 0x…           also seed this desk address with 100,000 shares' worth
 *   --inventory-x n      bidder inventory, multiple of the vault's target holding (default 2)
 *   --out p              default keeper/mocks/{date}.json
 *   --pending-dir d      default keeper/
 *   --no-fetch           never call CoinGecko / CoinPaprika (qX20 then needs keeper/cache)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, getAddress, isAddress, encodeDeployData, zeroAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  INDEXES, TICKER, GIWA_RPC, GIWA_CHAIN_ID, ERC20_ABI, chainFor, isLocalRpc, sleep, makeReader, readVault,
  toRefPrice, decimalsByPrice, loadRulebook, readBook, recordRow, loadSourceA, loadSourceB,
} from './basket-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ARTIFACT = JSON.parse(fs.readFileSync(path.join(HERE, 'artifacts', 'MockConstituent.json'), 'utf8'));
const MOCK_ABI = parseAbi(['function name() view returns (string)', 'function totalSupply() view returns (uint256)']).concat(ERC20_ABI);

/** DeployIndexBasket's sizes, in shares of $1 at the manifest's prices. */
const FAUCET_SHARES = 1_000n;
const DESK_SHARES = 100_000n;
/** Measured on the fork: one MockConstituent deployment ≈ 1.0M gas. */
const DEPLOY_GAS = 2_500_000n;

/** gen-manifest.py NAMES, plus the names entering on 2026-10-01. */
const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ether', BNB: 'BNB', XRP: 'XRP', SOL: 'Solana', TRX: 'TRON', HYPE: 'Hyperliquid', DOGE: 'Dogecoin',
  RAIN: 'Rain', LINK: 'Chainlink', ADA: 'Cardano', XLM: 'Stellar', BCH: 'Bitcoin Cash', UNI: 'Uniswap', GRAM: 'Gram',
  CC: 'Canton', HBAR: 'Hedera', AVAX: 'Avalanche', SHIB: 'Shiba Inu', SUI: 'Sui', AERO: 'Aerodrome', CAKE: 'PancakeSwap',
  CRV: 'Curve', JUP: 'Jupiter', RAY: 'Raydium', SKY: 'Sky', PENDLE: 'Pendle', ZRO: 'LayerZero', AAVE: 'Aave', ONDO: 'Ondo',
  MORPHO: 'Morpho', ENA: 'Ethena', JST: 'JUST', ETHFI: 'ether.fi', PYTH: 'Pyth', WC: 'Working Capital', TAO: 'Bittensor',
  RENDER: 'Render', FET: 'Fetch.ai', GRT: 'The Graph', AKT: 'Akash', VIRTUAL: 'Virtuals Protocol', GRASS: 'Grass', VVV: 'Venice',
  SYRUP: 'Syrup', NEAR: 'NEAR', ZEC: 'Zcash', XMR: 'Monero', ICP: 'Internet Computer', ASTER: 'Aster',
};

class Refused extends Error {}

// ------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const date = opt('--date', new Date().toISOString().slice(0, 10));
  const o = {
    date,
    index: opt('--index', null),
    rpc: opt('--rpc', GIWA_RPC),
    chainId: Number(opt('--chain-id', GIWA_CHAIN_ID)),
    live: flag('--live'),
    from: opt('--from', null),
    genesisTo: opt('--genesis-to', null),
    desk: opt('--desk', null),
    inventoryX: Number(opt('--inventory-x', 2)),
    out: opt('--out', path.join(HERE, 'mocks', `${date}.json`)),
    pendingDir: opt('--pending-dir', HERE),
    noFetch: flag('--no-fetch'),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !(o.inventoryX >= 1)) {
    console.error('usage: node keeper/deploy-mocks.mjs --date YYYY-MM-DD [--index a,b] [--rpc URL] [--live] [--from 0x…] [--genesis-to 0x…] [--desk 0x…] [--inventory-x n] [--out p]');
    process.exit(2);
  }
  return o;
}

// ------------------------------------------------------------- helpers
/** Runtime code, the two immutables (decimals, faucetAmount) zeroed and the
 *  CBOR metadata tail cut — what must equal between the artifact and a mock
 *  already deployed. */
function codeShape(hex) {
  const h = hex.replace(/^0x/, '').toLowerCase();
  const b = h.split('');
  for (const r of Object.values(ARTIFACT.immutableReferences).flat()) for (let i = r.start * 2; i < (r.start + r.length) * 2; i++) b[i] = '0';
  return b.join('').slice(0, h.length - ARTIFACT.metadataBytes * 2);
}
const ARTIFACT_SHAPE = codeShape(ARTIFACT.deployedBytecode);

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

/** The public endpoint rate-limits bursts ("RPC Request failed", 429): a
 *  read is retried with a back-off; a send never is (sendNonceSafe above). */
async function retryRead(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i + 1 >= tries || !/RPC Request failed|429|rate|timeout|fetch failed/i.test(String(e?.shortMessage ?? e?.message))) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

function readOut(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeOut(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

/** The work list: every index whose pending-registry file is of `date` and
 *  names an add without an address. */
function workOrders(o) {
  const want = o.index ? o.index.split(',').map((s) => s.trim()).filter(Boolean) : INDEXES;
  for (const i of want) if (!INDEXES.includes(i)) throw new Refused(`unknown index ${i} (${INDEXES.join(', ')})`);
  const orders = [];
  for (const index of want) {
    const p = path.join(o.pendingDir, `pending-registry-${index}.json`);
    if (!fs.existsSync(p)) {
      if (o.index) throw new Refused(`${path.relative(ROOT, p)} does not exist — no reconstitution work order for ${index}`);
      continue;
    }
    const pending = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (pending.date !== o.date) {
      if (o.index) throw new Refused(`${path.relative(ROOT, p)} is of ${pending.date}, not ${o.date}`);
      continue;
    }
    orders.push({ index, pending, pendingPath: p, adds: (pending.adds ?? []).filter((a) => !a.address).map((a) => a.symbol) });
  }
  return orders;
}

// ---------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[mocks] ${m}`);
  const reader = await makeReader(o.rpc, { chainId: o.chainId });
  const pc = reader.publicClient;
  const clientVersion = await pc.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');
  const devNode = /anvil|hardhat|ganache/i.test(String(clientVersion));
  const chain = chainFor(o.rpc, reader.chainId);

  // Signer. Addresses are printed; keys never are.
  let signer;
  let wallet = null;
  let mode;
  if (o.live && o.from) {
    if (!devNode || !isLocalRpc(o.rpc)) throw new Refused(`--from is for an unlocked account on a local anvil/hardhat node; ${o.rpc} reports "${clientVersion}"`);
    if (!isAddress(o.from)) throw new Refused(`--from ${o.from} is not an address`);
    signer = getAddress(o.from);
    wallet = createWalletClient({ account: signer, chain, transport: http(o.rpc) });
    mode = `LIVE, unlocked --from (${clientVersion})`;
  } else if (o.live) {
    if (!process.env.KEEPER_PK) throw new Refused('--live needs KEEPER_PK in the environment (or --from on a local anvil)');
    const acct = privateKeyToAccount(process.env.KEEPER_PK);
    signer = acct.address;
    wallet = createWalletClient({ account: acct, chain, transport: http(o.rpc) });
    mode = `LIVE, KEEPER_PK (${clientVersion})`;
  } else {
    signer = o.from && isAddress(o.from) ? getAddress(o.from) : process.env.KEEPER_PK ? privateKeyToAccount(process.env.KEEPER_PK).address : null;
    mode = `DRY RUN (${clientVersion}) — nothing is sent`;
  }
  let genesisTo;
  let genesisWhy;
  if (o.genesisTo) {
    if (!isAddress(o.genesisTo)) throw new Refused(`--genesis-to ${o.genesisTo} is not an address`);
    genesisTo = getAddress(o.genesisTo);
    genesisWhy = '--genesis-to';
  } else if (process.env.BIDDER_PK) {
    genesisTo = privateKeyToAccount(process.env.BIDDER_PK).address;
    genesisWhy = "BIDDER_PK's address";
  } else {
    genesisTo = null; // the signer, once known (dry run: the vault owner)
    genesisWhy = 'the signer (no BIDDER_PK: the keeper key is the bidder)';
  }
  const desk = o.desk ? (isAddress(o.desk) ? getAddress(o.desk) : (() => { throw new Refused(`--desk ${o.desk} is not an address`); })()) : null;

  const orders = workOrders(o);
  if (orders.length === 0) { log(`no pending-registry file of ${o.date} — nothing to deploy`); return; }
  const out = readOut(o.out) ?? { _doc: 'Mock constituents deployed for a basket reconstitution, by keeper/deploy-mocks.mjs: {index: {SYMBOL: {address, decimals, …}}}. One mock per basket and name (the deployed convention). Read by keeper/basket-plan.mjs --mocks.', date: o.date, chainId: reader.chainId };
  if (out.date !== o.date || out.chainId !== reader.chainId) throw new Refused(`${path.relative(ROOT, o.out)} is for ${out.date} on chain ${out.chainId}, not ${o.date} on chain ${reader.chainId}`);
  log(`${mode}; rpc ${o.rpc}; ${orders.map((x) => `${TICKER[x.index]} [${x.adds.join(',') || '—'}]`).join(' · ')}; out ${path.relative(ROOT, o.out)}`);

  let A = null;
  let B = null;
  let deployed = 0;
  let planned = 0;
  for (const { index, pending, adds } of orders) {
    const T = TICKER[index];
    if (adds.length === 0) { log(`${T}: every add in the work order already has an address — nothing to deploy`); continue; }
    const { rulebook } = loadRulebook(index);
    const vault = getAddress(rulebook.basket?.vault ?? zeroAddress);
    if (vault === zeroAddress) throw new Refused(`${T}: rulebook basket.vault is null`);
    if (pending.vault && getAddress(pending.vault) !== vault) throw new Refused(`${T}: work order vault ${pending.vault} != rulebook ${vault}`);
    const v = await retryRead(() => readVault(reader, vault));
    const from = signer ?? v.owner;
    const inventoryTo = genesisTo ?? from;
    if (v.pendingRegistryChange !== `0x${'0'.repeat(64)}`) log(`  ${T}: note — a registry change is already pending on this vault (${v.pendingRegistryChange})`);

    // Convention checks against the vault's own registry: symbols m{SYMBOL},
    // and the artifact's code is the code of the mocks already held.
    const symOf = Object.fromEntries(Object.entries(rulebook.basket.assets).map(([s, e]) => [getAddress(typeof e === 'string' ? e : e.address), s]));
    const off = v.assets.filter((a) => symOf[a.address] && a.onchainSymbol !== `m${symOf[a.address]}`);
    if (off.length) throw new Refused(`${T}: registry mocks not named m{SYMBOL}: ${off.map((a) => `${symOf[a.address]}=${a.onchainSymbol}`).join(', ')} — the convention this tool follows does not hold here`);
    const refAsset = v.assets[0];
    const refCode = await retryRead(() => pc.getCode({ address: refAsset.address }));
    if (!refCode || codeShape(refCode) !== ARTIFACT_SHAPE) throw new Refused(`${T}: keeper/artifacts/MockConstituent.json is not the contract deployed at ${refAsset.address} (${refAsset.onchainSymbol}) — rebuild the artifact from the site repository's contracts/src/MockConstituent.sol`);
    const heldSyms = new Set(v.assets.map((a) => a.onchainSymbol));
    for (const s of adds) if (heldSyms.has(`m${s}`)) throw new Refused(`${T}: the vault already holds an m${s} — not deploying a second`);

    // Price and weight of each add: the record row of the day, else the book
    // at source A (B as fallback).
    const row = recordRow(index, o.date);
    const rowOf = (s) => row?.members?.find((m) => m.symbol === s) ?? null;
    let bookW = null;
    if (!row) {
      A ??= await loadSourceA(o.date, !o.noFetch);
      B ??= await loadSourceB(o.date, null, !o.noFetch);
      const bookPath = index === 'qx20' ? path.join(HERE, 'state.json') : path.join(HERE, `state-${index}.json`);
      const book = readBook(index, bookPath, rulebook);
      const px = (s) => (s === 'WC' ? book.wcUnitValue : A.prices[s] > 0 ? A.prices[s] : B.prices[s] > 0 ? B.prices[s] : null);
      const val = {};
      for (const [s, u] of Object.entries(book.units)) {
        const p = px(s);
        if (!(p > 0)) throw new Refused(`${T}: no price for book member ${s} from ${A.label} or ${B.label}`);
        val[s] = u * p;
      }
      const tot = Object.values(val).reduce((a, b) => a + b, 0);
      bookW = (s) => (val[s] != null ? { weight: val[s] / tot, price: px(s), source: `book ${path.relative(ROOT, bookPath)} at ${A.prices[s] > 0 ? A.label : B.label}` } : null);
    }
    const vaultValue = v.assets.reduce((t, a) => t + a.balance * a.refPrice, 0n); // USD × 1e18
    log(`${T} ${vault}: ${v.assetCount} assets, value at references $${(Number(vaultValue) / 1e18).toFixed(0)}; signer ${from}; bidder inventory to ${inventoryTo} (${genesisWhy}); desk ${desk ?? 'none (tops up from the open faucet)'}`);

    out[index] ??= {};
    for (const sym of adds) {
      const have = out[index][sym];
      if (have?.address) {
        const code = await retryRead(() => pc.getCode({ address: have.address })).catch(() => undefined);
        if (code && code !== '0x') { log(`  ${sym}: already deployed at ${have.address} (${path.relative(ROOT, o.out)}) — skipped`); continue; }
        throw new Refused(`${T} ${sym}: ${path.relative(ROOT, o.out)} names ${have.address}, which has no code on this chain`);
      }
      const r = rowOf(sym);
      const pw = r ? { weight: r.weight, price: r.price, source: `record-${index} ${o.date} seq ${row.seq}` } : bookW?.(sym);
      if (!pw || !(pw.price > 0) || !(pw.weight > 0)) throw new Refused(`${T} ${sym}: no price/weight for the entering name (record row ${row ? `seq ${row.seq}` : 'absent'})`);
      const decimals = decimalsByPrice(pw.price);
      const ref = toRefPrice(pw.price, decimals); // USD × 1e18 per base unit
      const wScaled = BigInt(Math.round(pw.weight * 1e9));
      const amountPerShare = (10n ** 18n * wScaled) / 10n ** 9n / ref; // floor(weight × 10^d / price) for a $1 share
      if (amountPerShare === 0n) throw new Refused(`${T} ${sym}: amountPerShare rounds to zero (weight ${pw.weight}, price ${pw.price}, ${decimals} dec)`);
      const faucetAmount = amountPerShare * FAUCET_SHARES;
      const xScaled = BigInt(Math.round(o.inventoryX * 1000));
      const genesisAmount = (vaultValue * wScaled * xScaled / (10n ** 9n * 1000n) + ref - 1n) / ref;
      const deskAmount = desk ? amountPerShare * DESK_SHARES : 0n;
      const name = `Mock ${NAMES[sym] ?? sym}`;
      const mockSymbol = `m${sym}`;
      const args = [name, mockSymbol, decimals, faucetAmount, inventoryTo, genesisAmount, desk ?? zeroAddress, deskAmount];
      const data = encodeDeployData({ abi: ARTIFACT.abi, bytecode: ARTIFACT.bytecode, args });
      const shown = `${mockSymbol} "${name}" ${decimals} dec, faucet ${faucetAmount} (1,000 shares × ${(pw.weight * 100).toFixed(2)}% at $${pw.price}), bidder inventory ${genesisAmount} (≈ $${((Number(genesisAmount) * Number(ref)) / 1e18).toFixed(0)} = ${o.inventoryX}× the vault's target holding), desk ${deskAmount}; price/weight from ${pw.source}`;
      // Simulate the constructor from the signer.
      try {
        await retryRead(() => pc.call({ account: from, data, gas: DEPLOY_GAS }));
      } catch (e) {
        throw new Refused(`${T} ${sym}: deployment would revert from ${from} — ${e.shortMessage ?? e.message}`);
      }
      planned++;
      if (!o.live) { log(`  would deploy ${shown} — simulated ok`); continue; }
      const hash = await sendNonceSafe(() => wallet.sendTransaction({ data, gas: DEPLOY_GAS }));
      const rc = await pc.waitForTransactionReceipt({ hash });
      if (rc.status !== 'success' || !rc.contractAddress) throw new Error(`${T} ${sym}: deployment reverted or created nothing (tx ${hash}, block ${rc.blockNumber})`);
      const address = getAddress(rc.contractAddress);
      const code = await pc.getCode({ address });
      const [nm, sy, dec, fa, gb] = await reader.batch([
        { address, abi: MOCK_ABI, functionName: 'name' },
        { address, abi: MOCK_ABI, functionName: 'symbol' },
        { address, abi: MOCK_ABI, functionName: 'decimals' },
        { address, abi: MOCK_ABI, functionName: 'faucetAmount' },
        { address, abi: MOCK_ABI, functionName: 'balanceOf', args: [inventoryTo] },
      ]);
      const bad = [];
      if (!code || codeShape(code) !== ARTIFACT_SHAPE) bad.push('runtime code differs from the artifact');
      if (nm !== name) bad.push(`name ${nm}`);
      if (sy !== mockSymbol) bad.push(`symbol ${sy}`);
      if (Number(dec) !== decimals) bad.push(`decimals ${dec}`);
      if (fa !== faucetAmount) bad.push(`faucetAmount ${fa}`);
      if (gb < genesisAmount) bad.push(`bidder balance ${gb} < ${genesisAmount}`);
      out[index][sym] = {
        address, decimals, mockSymbol, name, faucetAmount, genesisTo: inventoryTo, genesisAmount, deskTo: desk, deskAmount,
        priceUsd: pw.price, weight: pw.weight, priceSource: pw.source, vault, txHash: hash, block: rc.blockNumber, gasUsed: rc.gasUsed, deployer: from,
      };
      writeOut(o.out, out);
      deployed++;
      if (bad.length) throw new Error(`${T} ${sym}: deployed at ${address} but the read-back disagrees: ${bad.join('; ')}`);
      log(`  deployed ${shown} at ${address} tx=${hash} block=${rc.blockNumber} gas=${rc.gasUsed}; read back ok`);
    }
  }
  if (o.live) log(`${deployed} mock(s) deployed; ${path.relative(ROOT, o.out)} written — pass it as the planner's --mocks (workflow input mocks=${path.relative(ROOT, o.out)})`);
  else log(`dry run: ${planned} deployment(s) simulated; nothing sent, nothing written`);
}

main().catch((e) => {
  if (e instanceof Refused) { console.error(`REFUSED: ${e.message}`); process.exit(1); }
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
