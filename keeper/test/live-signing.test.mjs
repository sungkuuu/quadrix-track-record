/**
 * keeper/basket-recon.mjs call() with a LOCAL signer — the KEEPER_PK path the
 * live workflow takes (every rehearsal signs through an unlocked --from
 * account on anvil instead, so none of them can see this).
 *
 * call() simulates with `account: <address>`; viem then returns a request
 * whose `account` is a JSON-RPC account ({address, type: 'json-rpc'}).
 * Passed on to writeContract as is, it overrides the wallet's private-key
 * account and viem asks the NODE to sign: eth_sendTransaction. The public
 * GIWA endpoint holds no key (eth_accounts answers []), so every live send
 * would fail. The transaction must be signed here and sent raw.
 *
 * No network and no real key: a throwaway key generated in the test, and a
 * transport that answers the handful of methods viem needs.
 *
 *   node --test keeper/test/live-signing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicClient, createWalletClient, custom, getAddress, keccak256, parseTransaction, recoverTransactionAddress, decodeFunctionData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { VAULT_ABI, savePlan, loadPlan } from '../basket-plan.mjs';
import { call } from '../basket-recon.mjs';

const CHAIN_ID = 91342;
const chain = { id: CHAIN_ID, name: 'probe', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } };
const VAULT = getAddress('0x88d3b5f638fe0d331797c612a5496bd8f0491fd4');
const hex = (n) => `0x${BigInt(n).toString(16)}`;

function fakeNode() {
  const methods = [];
  const raws = [];
  let mined = null;
  const block = (n) => ({
    number: hex(n), hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: hex(1_790_000_000 + n), baseFeePerGas: '0x3b9aca00',
    gasLimit: '0x1c9c380', gasUsed: '0x0', miner: `0x${'0'.repeat(40)}`, transactions: [], logsBloom: `0x${'0'.repeat(512)}`,
    difficulty: '0x0', extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: `0x${'0'.repeat(64)}`, size: '0x0', stateRoot: `0x${'0'.repeat(64)}`,
    receiptsRoot: `0x${'0'.repeat(64)}`, transactionsRoot: `0x${'0'.repeat(64)}`, uncles: [], mixHash: `0x${'0'.repeat(64)}`, totalDifficulty: '0x0',
  });
  const transport = custom({
    async request({ method, params }) {
      methods.push(method);
      switch (method) {
        case 'eth_chainId': return hex(CHAIN_ID);
        case 'eth_call': return '0x'; // a void function (setRefPrice) simulates ok
        case 'eth_blockNumber': return hex(mined ? 101 : 100);
        case 'eth_getTransactionCount': return '0x7';
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_gasPrice': return '0x3b9aca01';
        case 'eth_getBlockByNumber': return block(params[0] === 'latest' ? (mined ? 101 : 100) : Number(BigInt(params[0])));
        case 'eth_sendRawTransaction': {
          raws.push(params[0]);
          mined = keccak256(params[0]);
          return mined;
        }
        case 'eth_getTransactionReceipt': {
          if (!mined || params[0] !== mined) return null;
          return {
            transactionHash: mined, blockNumber: hex(101), blockHash: `0x${'b'.repeat(64)}`, transactionIndex: '0x0', status: '0x1', gasUsed: '0x5208',
            cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca01', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: null, from: params[0], to: VAULT,
          };
        }
        case 'eth_sendTransaction':
        case 'wallet_sendTransaction':
          // What the public endpoint does: it holds no key.
          throw Object.assign(new Error('unknown account'), { code: -32000 });
        default: throw new Error(`fake node: unexpected ${method}`);
      }
    },
  });
  return { transport, methods, raws };
}

test('live call() with a private-key signer (KEEPER_PK) signs locally and sends the raw transaction, with the same target, calldata and gas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-sign-'));
  const planFile = path.join(dir, 'plan.json');
  savePlan(planFile, { index: 'qdefi', vault: VAULT, fills: [], sent: [] });
  const node = fakeNode();
  const pc = createPublicClient({ chain, transport: node.transport, pollingInterval: 5 });
  const acct = privateKeyToAccount(generatePrivateKey()); // throwaway, generated here
  const wallet = createWalletClient({ account: acct, chain, transport: node.transport });
  const ctx = {
    o: { stage: 'test' }, log: () => {}, plan: loadPlan(planFile), planFile, pc, reader: { publicClient: pc, pace: 0 },
    keeperAddr: acct.address, keeperWallet: wallet, bidderAddr: acct.address, bidderWallet: wallet, live: true,
    floor: 0n, receipts: new Map(), events: null,
  };
  const asset = getAddress('0x1111111111111111111111111111111111111111');
  const r = await call(ctx, { who: 'keeper', to: VAULT, functionName: 'setRefPrice', args: [asset, 123n], gas: 120_000n, what: 're-post X (same value)' });
  assert.ok(!node.methods.includes('eth_sendTransaction') && !node.methods.includes('wallet_sendTransaction'), `asked the node to sign: ${node.methods.join(', ')}`);
  assert.equal(node.raws.length, 1);
  const tx = parseTransaction(node.raws[0]);
  assert.equal(getAddress(tx.to), VAULT);
  assert.equal(tx.gas, 120_000n);
  assert.equal(tx.chainId, CHAIN_ID);
  assert.deepEqual(decodeFunctionData({ abi: VAULT_ABI, data: tx.data }), { functionName: 'setRefPrice', args: [asset, 123n] });
  assert.equal(await recoverTransactionAddress({ serializedTransaction: node.raws[0] }), acct.address);
  assert.equal(r.receipt.status, 'success');
  assert.equal(loadPlan(planFile).sent[0].hash, r.hash);
});
