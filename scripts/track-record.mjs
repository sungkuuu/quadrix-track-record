/**
 * Track-record pipeline — implements docs/track-record-spec.md.
 *
 * Appends one point-in-time daily record to trackrecord/record.jsonl and
 * anchors the hash-chain head on GIWA Sepolia. Append-only: corrections are
 * new records, never edits. Each record embeds the previous record's hash,
 * so a retroactive fork breaks the chain (spec §1); the anchored head makes
 * the break third-party-detectable without our cooperation.
 *
 * DRY RUN (current mode): the book is empty. What accrues is proof that the
 * recording infrastructure predates the record — capital may only enter
 * after ≥7 anchored dry-run days (spec §6).
 *
 * Benchmark prices are recorded from day one so the source is locked before
 * inception (spec §3): Binance daily closes for BTC/ETH, the same source the
 * published qX20 series uses.
 *
 * Usage:
 *   node scripts/track-record.mjs            # append today's record
 *   KEEPER_PK=0x... node scripts/track-record.mjs --anchor   # + anchor head
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Two series, never concatenated (spec §8). DRY_RUN is the default and writes
// the original files; LIVE is opt-in via TRACK_MODE=LIVE, writes its own files
// with its own genesis, and refuses to run until a book source is configured —
// an accidental env flip must fail loudly, not silently start a live series.
const MODE = process.env.TRACK_MODE === 'LIVE' ? 'LIVE' : 'DRY_RUN';
const SUFFIX = MODE === 'LIVE' ? '-live' : '';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'trackrecord');
const RECORDS = path.join(DIR, `record${SUFFIX}.jsonl`);
const ANCHORS = path.join(DIR, `anchors${SUFFIX}.jsonl`);

if (MODE === 'LIVE' && !process.env.ENZYME_VAULT_ADDRESS) {
  throw new Error(
    'TRACK_MODE=LIVE requires ENZYME_VAULT_ADDRESS (the N1DV vault on Arbitrum) — refusing to start a live series with an empty book source'
  );
}

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Yesterday's completed UTC day — records always describe a closed day. */
function recordDate() {
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Binance daily close for the record date (00:00 UTC open of that day's kline).
 *  data-api.binance.vision first: Binance's official public market-data mirror
 *  serves the same klines but is not geo-blocked — api.binance.com returns 451
 *  from GitHub-hosted runners (cause of the seq 1–5 benchmark gap). */
const BINANCE_HOSTS = ['data-api.binance.vision', 'api.binance.com'];
async function binanceClose(symbol, date) {
  const start = Date.parse(date + 'T00:00:00Z');
  for (const host of BINANCE_HOSTS) {
    try {
      const url = `https://${host}/api/v3/klines?symbol=${symbol}USDT&interval=1d&startTime=${start}&endTime=${start + 1}&limit=1`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const k = await r.json();
      if (Array.isArray(k) && k.length > 0) return parseFloat(k[0][4]);
    } catch {
      // unreachable host — try the next one
    }
  }
  return null; // spec §2: no silent fill
}

function lastLine(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

const prev = lastLine(RECORDS);
const date = recordDate();

if (prev && prev.date >= date) {
  console.log(`record for ${date} already exists (append-only — not rewritten)`);
  process.exit(0);
}

const [btc, eth] = await Promise.all([binanceClose('BTC', date), binanceClose('ETH', date)]);

/** Decisions in force on the record date, oldest first — each is a document
 *  hash already anchored on its own. Carrying them inside the chain means the
 *  set of decisions in force on a given day cannot be revised later either. */
function decisionsInForce(onDate) {
  const ledger = path.join(DIR, 'decisions.jsonl');
  if (!fs.existsSync(ledger)) return [];
  return fs
    .readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((d) => d.effectiveFrom <= onDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .map((d) => ({ id: d.id, sha256: d.sha256 }));
}

const decisions = decisionsInForce(date);

// ---------------------------------------------------------------- LIVE book
// Book reader, decision of 2026-09-01 (owner): ONCHAIN SUM — balances are read
// from the chain and priced from the same public source the benchmarks use, so
// anyone can recompute the book without trusting a number we typed. The posted
// admin NAV is NOT read (it is the March-incident surface). Chains are a config
// list; today the whole book lives on Arbitrum, and a later bridge execution
// adds a chain entry here rather than changing the reader.
//
// Cash rule: only USDC held BY THE VAULT CONTRACT counts as cash. USDC or
// native ETH on the management wallet is the owner's own (gas float, residue),
// not vault property — the whitelist below is the exhaustive set of vault
// positions outside the contract.
const LIVE_INCEPTION = '2026-09-01'; // anchored decision 2026-09-01-n1q-live-inception
const MGMT_WALLET = '0x2b5b5177f4aaece5a311134023ac11dd9ca9e321';
const CHAINS = {
  arbitrum: {
    rpc: 'https://arb1.arbitrum.io/rpc',
    cash: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, holder: 'vault' },
    positions: [
      // symbol used for Binance pricing: WBTC marks to BTC, WETH to ETH — the
      // wrapper premium/discount on Arbitrum is far inside our tolerance.
      { symbol: 'WBTC', priceSymbol: 'BTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
      { symbol: 'WETH', priceSymbol: 'ETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
      { symbol: 'PENDLE', priceSymbol: 'PENDLE', address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', decimals: 18 },
    ],
  },
};

async function erc20Balance(rpc, token, holder) {
  const data = '0x70a08231' + holder.slice(2).toLowerCase().padStart(64, '0');
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
  });
  const j = await r.json();
  if (j.error || !j.result) throw new Error(`balanceOf failed for ${token}: ${JSON.stringify(j.error)}`);
  return BigInt(j.result);
}

async function buildLiveBook(recordDate) {
  const vault = process.env.ENZYME_VAULT_ADDRESS;
  const positions = [];
  let cash = 0;
  for (const [chain, cfg] of Object.entries(CHAINS)) {
    const cashHolder = cfg.cash.holder === 'vault' ? vault : MGMT_WALLET;
    cash += Number(await erc20Balance(cfg.rpc, cfg.cash.address, cashHolder)) / 10 ** cfg.cash.decimals;
    for (const t of cfg.positions) {
      const qty = Number(await erc20Balance(cfg.rpc, t.address, MGMT_WALLET)) / 10 ** t.decimals;
      if (qty === 0) continue; // empty sleeves stay out of the record, not in it as zeros
      const price = await binanceClose(t.priceSymbol, recordDate);
      if (price == null) throw new Error(`no price for ${t.priceSymbol} on ${recordDate} — refusing to write a mispriced book`);
      positions.push({ chain, symbol: t.symbol, address: t.address, qty, priceUSDT: price, valueUSDT: qty * price });
    }
  }
  return { positions, cashUSDT: cash };
}

if (MODE === 'LIVE' && date < LIVE_INCEPTION) {
  console.log(`LIVE series starts ${LIVE_INCEPTION}; ${date} predates it — nothing to record`);
  process.exit(0);
}
const book = MODE === 'LIVE' ? await buildLiveBook(date) : { positions: [], cashUSDT: 0 };
const aum = book.cashUSDT + book.positions.reduce((s, p) => s + p.valueUSDT, 0);

const record = {
  seq: prev ? prev.seq + 1 : 0,
  date,
  observedAt: new Date().toISOString(),
  mode: MODE, // series selected once at the top; never concatenate (spec §8)
  book,
  aumUSDT: Math.round(aum * 1e6) / 1e6,
  benchmarks:
    btc != null && eth != null
      ? { source: 'binance-daily-close', BTC: btc, ETH: eth }
      : { source: 'binance-daily-close', missing: true }, // flagged, never backfilled
  prevHash: prev ? prev.hash : null,
};
// Omitted entirely when there are none, so records predating the first
// decision keep the exact shape they were hashed with.
if (decisions.length) record.decisions = decisions;
record.hash = sha256(JSON.stringify(record));

fs.mkdirSync(DIR, { recursive: true });
fs.appendFileSync(RECORDS, JSON.stringify(record) + '\n');
console.log(`record #${record.seq} ${date} appended — head ${record.hash.slice(0, 16)}…`);
if (record.benchmarks.missing) {
  // The record itself must still be written (spec §2), so this cannot fail the
  // job — the workflow greps for this marker to raise a visible alert instead.
  console.log(`BENCHMARKS_MISSING ${date}`);
}

if (process.argv.includes('--anchor')) {
  const pk = process.env.KEEPER_PK;
  if (!pk) throw new Error('KEEPER_PK not set');
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
  const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
  // Zero-value self-send carrying the head hash as calldata: a timestamped,
  // immutable, third-party-verifiable commitment to the chain head.
  const hash = await wallet.sendTransaction({
    to: account.address,
    value: 0n,
    data: toHex('qxtr:' + record.hash),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  fs.appendFileSync(
    ANCHORS,
    JSON.stringify({ date, seq: record.seq, headHash: record.hash, txHash: hash }) + '\n'
  );
  console.log(`anchored on GIWA Sepolia: ${hash}`);
}
