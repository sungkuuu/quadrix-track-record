// node --test keeper/nonce-race.test.mjs
//
// The nonce-race test of every keeper sender (keeper/nonce-race.mjs) and the
// resend loop, with no network and no real key: a throwaway key generated
// here and a fake node (keeper/test/nonce-race-node.mjs) on which another
// sender of the same key takes nonces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient, parseAbi, getAddress, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { NONCE_RACE, isNonceRace, sendNonceSafe, RESEND_WAIT_MS } from './nonce-race.mjs';
import { nonceRaceNode, chain, UNDERPRICED } from './test/nonce-race-node.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

// The error texts of the failed sends, as the runner logged them (the
// addresses, calldata and raw bytes replaced; every other line as logged).
// 2026-11-16 qREV setRefPrice and 2026-11-13 qX20 setRefPrice: writeContract.
const CONTRACT_UNDERPRICED = [
  'Missing or invalid parameters.',
  'Double check you have provided the correct parameters.',
  '',
  'URL: https://sepolia-rpc.giwa.io',
  'Request body: {"method":"eth_sendRawTransaction","params":["0x02f8b3"]}',
  ' ',
  'Request Arguments:',
  `  from:  ${A}`,
  `  to:    ${B}`,
  '  data:  0x175fef88',
  '  gas:   120000',
  ' ',
  'Contract Call:',
  `  address:   ${B}`,
  '  function:  setRefPrice(address asset, uint256 price)',
  `  args:                 (${A}, 1034110000)`,
  `  sender:    ${A}`,
  '',
  'Docs: https://viem.sh/docs/contract/writeContract',
  'Details: replacement transaction underpriced',
  'Version: viem@2.55.19',
].join('\n');
// 2026-11-16 Triens anchor: sendTransaction.
const SEND_UNDERPRICED = [
  'Missing or invalid parameters.',
  'Double check you have provided the correct parameters.',
  '',
  'URL: https://sepolia-rpc.giwa.io',
  'Request body: {"method":"eth_sendRawTransaction","params":["0x02f8"]}',
  ' ',
  'Request Arguments:',
  `  from:   ${A}`,
  `  to:     ${A}`,
  '  value:  0 ETH',
  '  data:   0x717870692d747269656e733a',
  '',
  'Details: replacement transaction underpriced',
  'Version: viem@2.55.19',
].join('\n');

test('a nonce race: the 2026-11-16 and 2026-11-13 texts, and the "nonce" texts the old test already caught', () => {
  for (const msg of [
    CONTRACT_UNDERPRICED,
    SEND_UNDERPRICED,
    'replacement transaction underpriced',
    'Details: Replacement transaction underpriced',
    'nonce too low',
    'nonce too high',
    'Nonce provided for the transaction is lower than the current nonce of the account.\nDetails: nonce too low',
    'Nonce provided for the transaction is higher than the next one expected.',
  ]) {
    assert.equal(isNonceRace(new Error(msg)), true, msg.split('\n').at(-2) ?? msg);
  }
  // The same texts under the old condition: the two 2026-11 texts were missed.
  assert.equal(/nonce/i.test(CONTRACT_UNDERPRICED), false);
  assert.equal(/nonce/i.test(SEND_UNDERPRICED), false);
});

test('not a nonce race: a revert, insufficient funds, a rate limit, a timeout, a fee below the floor', () => {
  for (const msg of [
    'The contract function "setRefPrice" reverted with the following signature:\n0x3ee5aeb5\nDetails: execution reverted',
    'execution reverted: NavMoveTooLarge',
    'The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.\nDetails: insufficient funds for gas * price + value',
    'HTTP request failed.\nStatus: 429\nDetails: over rate limit',
    'RPC Request failed.\nDetails: over rate limit',
    'The request took too long to respond.',
    'Details: transaction underpriced',
  ]) {
    assert.equal(isNonceRace(new Error(msg)), false, msg);
  }
  assert.equal(isNonceRace(null), false);
  assert.equal(isNonceRace(undefined), false);
  assert.ok(NONCE_RACE instanceof RegExp);
});

test('the node answer "replacement transaction underpriced" through viem is a nonce race; a revert and insufficient funds through viem are not', async () => {
  const account = privateKeyToAccount(generatePrivateKey()); // throwaway
  const abi = parseAbi(['function setRefPrice(address asset, uint256 price)']);
  const send = (node) => createWalletClient({ account, chain, transport: node.transport });
  const caught = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('no error'); };
  const e1 = await caught(() => send(nonceRaceNode({ fail: UNDERPRICED })).writeContract({ address: getAddress(B), abi, functionName: 'setRefPrice', args: [getAddress(A), 1n], gas: 120_000n }));
  assert.match(e1.message, /Details: replacement transaction underpriced/);
  assert.equal(isNonceRace(e1), true);
  const e2 = await caught(() => send(nonceRaceNode({ fail: UNDERPRICED })).sendTransaction({ to: account.address, value: 0n, data: toHex('qxpi-triens:ab') }));
  assert.equal(isNonceRace(e2), true);
  for (const text of ['execution reverted', 'insufficient funds for gas * price + value']) {
    const e = await caught(() => send(nonceRaceNode({ fail: text })).sendTransaction({ to: account.address, value: 0n, data: '0x01' }));
    assert.equal(isNonceRace(e), false, text);
  }
});

test('"already known" through viem: reported as NonceTooLowError, so it was a nonce race under the old test and still is (documented, not changed)', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const node = nonceRaceNode({ fail: 'already known' });
  const wallet = createWalletClient({ account, chain, transport: node.transport });
  let e;
  try { await wallet.sendTransaction({ to: account.address, value: 0n, data: '0x01' }); } catch (err) { e = err; }
  assert.match(e.message, /Nonce provided for the transaction is lower/);
  assert.match(e.message, /Details: already known/);
  assert.equal(/nonce/i.test(String(e.message)), true, 'the old condition');
  assert.equal(isNonceRace(e), true, 'the new one: same answer');
});

test('sendNonceSafe: a send whose nonce another sender took is resent once, under the nonce read again (the next free one)', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const node = nonceRaceNode({ steal: 1, startNonce: 11609 });
  const wallet = createWalletClient({ account, chain, transport: node.transport });
  const waits = [];
  const hash = await sendNonceSafe(
    () => wallet.sendTransaction({ to: account.address, value: 0n, data: toHex('qxpi-triens:ab') }),
    { wait: async (ms) => { waits.push(ms); } }
  );
  assert.deepEqual(node.raws.map((r) => [r.nonce, r.accepted]), [[11609, false], [11610, true]]);
  assert.deepEqual(node.stolen, [11609]);
  assert.deepEqual(node.nonceReads, [11609, 11610], 'the nonce is read again before the resend');
  assert.equal(hash, node.raws[1].hash);
  assert.deepEqual(waits, [RESEND_WAIT_MS]);
  // the resend carries the same call
  assert.equal(node.raws.filter((r) => r.accepted).length, 1, 'the call lands once');
});

test('sendNonceSafe stops after its bound: five sends, four waits (4 + 8 + 12 + 16 s), then the last error', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const node = nonceRaceNode({ steal: 1_000 });
  const wallet = createWalletClient({ account, chain, transport: node.transport });
  const waits = [];
  await assert.rejects(
    sendNonceSafe(() => wallet.sendTransaction({ to: account.address, value: 0n, data: '0x01' }), { wait: async (ms) => { waits.push(ms); } }),
    (e) => /replacement transaction underpriced/.test(e.message)
  );
  assert.equal(node.raws.length, 5);
  assert.equal(node.raws.filter((r) => r.accepted).length, 0);
  assert.deepEqual(node.raws.map((r) => r.nonce), [11609, 11610, 11611, 11612, 11613]);
  assert.deepEqual(waits, [4000, 8000, 12000, 16000]);
});

test('sendNonceSafe: any other error is thrown at once, with no resend and no wait', async () => {
  for (const text of ['execution reverted', 'insufficient funds for gas * price + value']) {
    const account = privateKeyToAccount(generatePrivateKey());
    const node = nonceRaceNode({ fail: text });
    const wallet = createWalletClient({ account, chain, transport: node.transport });
    const waits = [];
    await assert.rejects(sendNonceSafe(() => wallet.sendTransaction({ to: account.address, value: 0n, data: '0x01' }), { wait: async (ms) => { waits.push(ms); } }));
    assert.equal(node.raws.length, 1, text);
    assert.deepEqual(waits, [], text);
  }
});
