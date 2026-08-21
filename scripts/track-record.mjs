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

const record = {
  seq: prev ? prev.seq + 1 : 0,
  date,
  observedAt: new Date().toISOString(),
  mode: MODE, // series selected once at the top; never concatenate (spec §8)
  // LIVE book construction lands with the Enzyme reader (blocked on the real
  // vault address); until then LIVE mode cannot start — guarded above.
  book: { positions: [], cashUSDT: 0 },
  aumUSDT: 0,
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
