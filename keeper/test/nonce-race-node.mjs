/**
 * Test helper (no network, no real key): a node for one account whose nonces
 * another sender of the same key can take, as on 2026-11-16 (a 0-value send
 * from the same key landed on the nonce the keeper had just signed with, at
 * the same fee, and the node answered the keeper "replacement transaction
 * underpriced").
 *
 *   steal: how many raw transactions in a row find their nonce taken — the
 *          other sender's transaction lands on it and ours is rejected with
 *          `reject` (default the node's text of 2026-11-16);
 *   fail:  a JSON-RPC error message every raw transaction gets instead
 *          (a revert, insufficient funds, "already known", ...).
 *
 * The pending nonce is answered from the node's state at the time of each
 * eth_getTransactionCount, so a resend that reads it again gets the next
 * free nonce. Every raw transaction is recorded with its decoded nonce.
 */
import { custom, keccak256, parseTransaction } from 'viem';

export const CHAIN_ID = 91342;
export const chain = { id: CHAIN_ID, name: 'probe', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } };
export const UNDERPRICED = 'replacement transaction underpriced';
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const Z32 = `0x${'0'.repeat(64)}`;

export function nonceRaceNode({ steal = 0, fail = null, reject = UNDERPRICED, startNonce = 11609 } = {}) {
  let next = startNonce;
  let height = 100;
  const raws = []; // { nonce, raw, accepted, error }
  const stolen = []; // nonces the other sender took
  const receipts = new Map();
  const nonceReads = [];
  const block = (n) => ({
    number: hex(n), hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: hex(1_790_000_000 + n), baseFeePerGas: '0x320',
    gasLimit: '0x1c9c380', gasUsed: '0x0', miner: `0x${'0'.repeat(40)}`, transactions: [], logsBloom: `0x${'0'.repeat(512)}`,
    difficulty: '0x0', extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: Z32, size: '0x0', stateRoot: Z32,
    receiptsRoot: Z32, transactionsRoot: Z32, uncles: [], mixHash: Z32, totalDifficulty: '0x0',
  });
  const rpcError = (message) => Object.assign(new Error(message), { code: -32000 });
  const transport = custom({
    async request({ method, params }) {
      switch (method) {
        case 'eth_chainId': return hex(CHAIN_ID);
        case 'eth_blockNumber': return hex(height);
        case 'eth_getTransactionCount': nonceReads.push(next); return hex(next);
        case 'eth_maxPriorityFeePerGas': return hex(1_000_000);
        case 'eth_gasPrice': return hex(1_000_320);
        case 'eth_estimateGas': return hex(24_378);
        case 'eth_call': return '0x';
        // viem tries this first; a node without it makes viem read the nonce,
        // fees and gas one by one (the path the nonce reads above record).
        case 'eth_fillTransaction': throw Object.assign(new Error('the method eth_fillTransaction does not exist/is not available'), { code: -32601 });
        case 'eth_getBlockByNumber': return block(params[0] === 'latest' ? height : Number(BigInt(params[0])));
        case 'eth_sendRawTransaction': {
          const raw = params[0];
          const { nonce } = parseTransaction(raw);
          if (fail) {
            raws.push({ nonce, raw, accepted: false, error: fail });
            throw rpcError(fail);
          }
          if (steal > 0 && nonce === next) {
            steal--;
            stolen.push(next);
            next++; // the other sender's transaction holds this nonce now
            raws.push({ nonce, raw, accepted: false, error: reject });
            throw rpcError(reject);
          }
          if (nonce !== next) {
            raws.push({ nonce, raw, accepted: false, error: 'nonce too low' });
            throw rpcError(nonce < next ? 'nonce too low' : 'nonce too high');
          }
          next++;
          height++;
          const hash = keccak256(raw);
          raws.push({ nonce, raw, accepted: true, hash });
          receipts.set(hash, height);
          return hash;
        }
        case 'eth_getTransactionReceipt': {
          const h = params[0];
          if (!receipts.has(h)) return null;
          return {
            transactionHash: h, blockNumber: hex(receipts.get(h)), blockHash: `0x${'b'.repeat(64)}`, transactionIndex: '0x0', status: '0x1', gasUsed: '0x5f3a',
            cumulativeGasUsed: '0x5f3a', effectiveGasPrice: hex(1_000_320), logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: null, from: `0x${'1'.repeat(40)}`, to: `0x${'1'.repeat(40)}`,
          };
        }
        default: throw new Error(`fake node: unexpected ${method}`);
      }
    },
  });
  return { transport, raws, stolen, nonceReads };
}
