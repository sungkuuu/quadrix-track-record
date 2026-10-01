/**
 * Whitelists (or removes) one auction bidder on the basket vaults — the
 * owner's `setBidder(bidder, allowed)` — and appends every transaction to
 * keeper/bidder-log.jsonl.
 *
 * Why a log file: QuadrixBasketVault v3.1's owner setters emit no event
 * (red-team RT24), so a whitelisting is visible on chain only as a
 * transaction and in the `isBidder` mapping. The tx hash, the block and the
 * read-back are committed here so the record shows when each bidder was
 * allowed and by whom.
 *
 * The vaults are the rulebooks' `basket.vault` (keeper/rulebooks/*.json) —
 * the same list every other keeper tool uses — never a second hard-coded
 * list. A vault where `isBidder(bidder)` already equals `allowed` is skipped
 * and nothing is sent.
 *
 * DRY RUN IS THE DEFAULT: each call is simulated from the vault's owner and
 * printed. --live sends with KEEPER_PK (owner of the six testnet vaults), or —
 * rehearsal on a local anvil only — from an unlocked --from. Every receipt
 * must be mined without revert and `isBidder` is read back before the next
 * vault. Keys are never printed.
 *
 * Usage:
 *   BIDDER_PK=0x… node keeper/set-bidder.mjs                          # dry run, all six vaults
 *   KEEPER_PK=0x… BIDDER_PK=0x… node keeper/set-bidder.mjs --live
 *   node keeper/set-bidder.mjs --bidder 0x… --live --rpc http://127.0.0.1:8545 --from 0x<owner>   # anvil
 *
 * Options:
 *   --bidder 0x…      the bidder (default: BIDDER_PK's address)
 *   --index a,b       subset of the rulebooks (default: every rulebook with a basket.vault)
 *   --allow false     remove instead of allow
 *   --rpc URL         default GIWA Sepolia public RPC; --chain-id n for a fresh anvil
 *   --live            send (default: dry run)
 *   --from 0x…        unlocked owner (anvil only; requires --live and a local --rpc)
 *   --log p           default keeper/bidder-log.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, getAddress, isAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { INDEXES, TICKER, GIWA_RPC, GIWA_CHAIN_ID, VAULT_ABI, chainFor, isLocalRpc, sleep, makeReader, loadRulebook } from './basket-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SET_BIDDER_ABI = parseAbi(['function setBidder(address bidder, bool allowed)']).concat(VAULT_ABI);
const GAS = 80_000n;

class Refused extends Error {}

function parseArgs(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const allow = opt('--allow', 'true');
  if (!['true', 'false'].includes(allow)) { console.error('--allow takes true or false'); process.exit(2); }
  return {
    bidder: opt('--bidder', null),
    index: opt('--index', null),
    allowed: allow === 'true',
    rpc: opt('--rpc', GIWA_RPC),
    chainId: Number(opt('--chain-id', GIWA_CHAIN_ID)),
    live: flag('--live'),
    from: opt('--from', null),
    log: opt('--log', path.join(HERE, 'bidder-log.jsonl')),
  };
}

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

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[set-bidder] ${m}`);
  let bidder;
  if (o.bidder) {
    if (!isAddress(o.bidder)) throw new Refused(`--bidder ${o.bidder} is not an address`);
    bidder = getAddress(o.bidder);
  } else if (process.env.BIDDER_PK) {
    bidder = privateKeyToAccount(process.env.BIDDER_PK).address;
  } else {
    throw new Refused('no bidder: pass --bidder 0x… or set BIDDER_PK (repository secret) — without a separate bidder the keeper key bids, and it is whitelisted already on every vault');
  }

  const reader = await makeReader(o.rpc, { chainId: o.chainId });
  const pc = reader.publicClient;
  const clientVersion = await pc.request({ method: 'web3_clientVersion' }).catch(() => 'unknown');
  const devNode = /anvil|hardhat|ganache/i.test(String(clientVersion));
  const chain = chainFor(o.rpc, reader.chainId);
  let signer = null;
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
    signer = process.env.KEEPER_PK ? privateKeyToAccount(process.env.KEEPER_PK).address : null;
    mode = `DRY RUN (${clientVersion}) — nothing is sent`;
  }

  const want = o.index ? o.index.split(',').map((s) => s.trim()).filter(Boolean) : INDEXES;
  for (const i of want) if (!INDEXES.includes(i)) throw new Refused(`unknown index ${i} (${INDEXES.join(', ')})`);
  const vaults = want.map((index) => ({ index, vault: loadRulebook(index).rulebook.basket?.vault ?? null })).filter((x) => x.vault).map((x) => ({ ...x, vault: getAddress(x.vault) }));
  if (vaults.length === 0) throw new Refused('no rulebook names a basket vault');
  log(`${mode}; rpc ${o.rpc}; bidder ${bidder} → ${o.allowed}; vaults (from keeper/rulebooks): ${vaults.map((x) => `${TICKER[x.index]} ${x.vault}`).join(' · ')}`);

  let sent = 0;
  for (const { index, vault } of vaults) {
    const T = TICKER[index];
    const [owner, isB, open] = await reader.batch([
      { address: vault, abi: VAULT_ABI, functionName: 'owner' },
      { address: vault, abi: VAULT_ABI, functionName: 'isBidder', args: [bidder] },
      { address: vault, abi: VAULT_ABI, functionName: 'biddingOpen' },
    ]);
    const from = signer ?? owner;
    if (isB === o.allowed) { log(`  ${T}: isBidder(${bidder}) is already ${isB} — nothing to send`); continue; }
    if (getAddress(from) !== getAddress(owner)) throw new Refused(`${T}: setBidder is onlyOwner; owner is ${owner}, signer is ${from}`);
    let request;
    try {
      ({ request } = await pc.simulateContract({ address: vault, abi: SET_BIDDER_ABI, functionName: 'setBidder', args: [bidder, o.allowed], account: from }));
    } catch (e) {
      throw new Refused(`${T}: setBidder(${bidder}, ${o.allowed}) would revert as ${from} — ${e.shortMessage ?? e.message}`);
    }
    if (!o.live) { log(`  ${T}: would setBidder(${bidder}, ${o.allowed}) as ${from} (simulated ok; biddingOpen ${open})`); continue; }
    const hash = await sendNonceSafe(() => wallet.writeContract({ ...request, gas: GAS }));
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${T}: setBidder reverted on chain (tx ${hash}, block ${rc.blockNumber})`);
    const back = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: 'isBidder', args: [bidder] });
    const blk = await pc.getBlock({ blockNumber: rc.blockNumber });
    const line = { at: new Date(Number(blk.timestamp) * 1000).toISOString(), index, ticker: T, vault, chainId: reader.chainId, bidder, allowed: o.allowed, txHash: hash, block: rc.blockNumber.toString(), signer: from, isBidderAfter: back };
    fs.appendFileSync(o.log, JSON.stringify(line) + '\n');
    sent++;
    if (back !== o.allowed) throw new Error(`${T}: isBidder(${bidder}) reads ${back} after setBidder(${o.allowed}) tx ${hash}`);
    log(`  ${T}: setBidder(${bidder}, ${o.allowed}) tx=${hash} block=${rc.blockNumber}; isBidder now ${back}; logged`);
  }
  log(o.live ? `${sent} transaction(s); ${path.relative(ROOT, o.log)} appended` : 'dry run: nothing sent, nothing logged');
}

main().catch((e) => {
  if (e instanceof Refused) { console.error(`REFUSED: ${e.message}`); process.exit(1); }
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
