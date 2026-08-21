/**
 * Anchors a decision document on GIWA Sepolia.
 *
 * A decision (an allocation revision, a mode change, anything the manager
 * decided rather than the market did) is a file under trackrecord/decisions/.
 * This script commits its SHA-256 to the chain as calldata `qxdec:<hash>` and
 * appends the result to trackrecord/decisions.jsonl. From its effective date
 * onward the daily record carries the same hash, so the decision is pinned
 * twice: once at the moment it was made, and once inside the hash chain.
 *
 * The point is narrow and worth stating plainly: it proves WHEN the document
 * existed and that it has not been edited since. It cannot prove the reasoning
 * was sincere — nothing can. It removes exactly one move: writing the decision
 * afterwards, or rewriting it, and presenting it as contemporaneous.
 *
 * Usage:
 *   KEEPER_PK=0x... node scripts/anchor-decision.mjs trackrecord/decisions/<file>.md
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'trackrecord', 'decisions.jsonl');

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

const target = process.argv[2];
if (!target) throw new Error('usage: node scripts/anchor-decision.mjs <path to decision .md>');

const abs = path.resolve(target);
const rel = path.relative(path.join(ROOT, 'trackrecord'), abs);
const body = fs.readFileSync(abs);
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const id = path.basename(abs, '.md');

const existing = fs.existsSync(LEDGER)
  ? fs
      .readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];

const prior = existing.find((e) => e.id === id);
if (prior) {
  // Anchors are append-only: a changed document is a NEW decision with its own
  // id, never a re-anchor that quietly replaces the old hash.
  if (prior.sha256 === sha256) {
    console.log(`${id} already anchored in ${prior.txHash} — nothing to do`);
    process.exit(0);
  }
  throw new Error(
    `${id} is already anchored with a different hash (${prior.sha256.slice(0, 12)}…). ` +
      'Publish a new dated decision instead of editing an anchored one.'
  );
}

const pk = process.env.KEEPER_PK;
if (!pk) throw new Error('KEEPER_PK not set');
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });

const txHash = await wallet.sendTransaction({
  to: account.address,
  value: 0n,
  data: toHex(`qxdec:${sha256}`),
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') throw new Error(`anchor tx reverted: ${txHash}`);

// effectiveFrom drives which daily records must carry this hash; it is the date
// in the filename, which is also the date the document states.
const effectiveFrom = id.slice(0, 10);
fs.appendFileSync(
  LEDGER,
  JSON.stringify({
    id,
    file: rel,
    effectiveFrom,
    sha256,
    txHash,
    anchoredAt: new Date().toISOString(),
  }) + '\n'
);
console.log(`anchored ${id}\n  sha256 ${sha256}\n  tx     ${txHash} (block ${receipt.blockNumber})`);
