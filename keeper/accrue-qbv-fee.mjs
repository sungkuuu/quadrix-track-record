/**
 * QuadrixBasketVault v3 management-fee accrual poke.
 *
 * The streaming fee is lazy: value accrues by formula regardless of when this
 * runs, and any missed run is settled exactly by the next one — so this job is
 * about keeping the on-chain supply/NAV picture current, not about collecting.
 * It is therefore NON-FATAL in the keeper workflow: a failure here must never
 * block the NAV mark.
 *
 * Skips (exit 0, with a log line) when nothing meaningful would mint:
 * zero supply, zero rate, or less than MIN_ACCRUE_INTERVAL since last accrual.
 *
 * Usage: KEEPER_PK=0x... node keeper/accrue-qbv-fee.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const VAULT = '0xa908c180be8d58f223a220da98dd71db0f0be45d'; // QBV v3, GIWA Sepolia
const MIN_ACCRUE_INTERVAL = 6n * 3600n - 300n; // just under the cron period

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

const ABI = parseAbi([
  'function accrueManagementFee() external returns (uint256)',
  'function lastFeeAccrual() view returns (uint256)',
  'function mgmtFeeBps() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);

const pub = createPublicClient({ chain: giwaSepolia, transport: http() });

const [last, rate, supply] = await Promise.all([
  pub.readContract({ address: VAULT, abi: ABI, functionName: 'lastFeeAccrual' }),
  pub.readContract({ address: VAULT, abi: ABI, functionName: 'mgmtFeeBps' }),
  pub.readContract({ address: VAULT, abi: ABI, functionName: 'totalSupply' }),
]);

const now = BigInt(Math.floor(Date.now() / 1000));
if (supply === 0n || rate === 0n) {
  console.log(`accrue-qbv-fee: skip (supply=${supply}, rate=${rate}bps)`);
  process.exit(0);
}
if (now - last < MIN_ACCRUE_INTERVAL) {
  console.log(`accrue-qbv-fee: skip (accrued ${now - last}s ago)`);
  process.exit(0);
}

const account = privateKeyToAccount(process.env.KEEPER_PK);
const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract({
  address: VAULT,
  abi: ABI,
  functionName: 'accrueManagementFee',
});
await pub.waitForTransactionReceipt({ hash });
console.log(`accrue-qbv-fee: accrued (dt=${now - last}s) tx=${hash}`);
