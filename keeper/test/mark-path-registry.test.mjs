/**
 * Attacks on the mark path of keeper/leverage-index.mjs (markVault and the registry
 * checks before it) against keeper/leverage-vaults.json swapped under it. Offline: the fake node
 * and the throwaway series of leverage-index.test.mjs (the anchor transactions are signed with a
 * key generated for the run and never leave the fake node).
 *
 *   node --test keeper/test/mark-path-registry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { run } from '../leverage-index.mjs';
import { THROWAWAY_CHECK, THROWAWAY_LEVEL, synthMinutes, fakeBinance, fakeNode, tempRoot, readJsonl, dayMs } from './leverage-helpers.mjs';

const FILL = { check: THROWAWAY_CHECK, primary: THROWAWAY_LEVEL };
const I = '2030-05-02';
const VAULT = getAddress('0x00000000000000000000000000000000000beef1');
function days(first, count, { seed = 11, vol = 0.002 } = {}) {
  const out = [];
  let p0 = 30_000;
  for (let k = 0; k < count; k++) {
    const d = new Date(dayMs(first) + k * 86_400_000).toISOString().slice(0, 10);
    const ms = synthMinutes(d, { seed: seed + k, p0, vol });
    out.push(...ms);
    p0 = ms.at(-1).c;
  }
  return out;
}
function deps(root, { minutes, now, key, node, logs = [] }) {
  const binance = fakeBinance({ BTCUSDT: minutes }, { serverTime: () => now() });
  return { root, now, binance, env: { KEEPER_PK: key }, log: (m) => logs.push(String(m)), wait: async () => {}, transport: () => node.transport, pollingInterval: 5, readTiming: { waitMs: 50, stepMs: 1 } };
}
const at = (iso) => () => Date.parse(iso);
const vaults = (gate, address = VAULT) => ({ qbtc2x: { chainId: 91342, address, gate, deployTx: null, block: null } });
async function capture(fn) {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try { return { code: await fn(), err: errs.join('\n') }; } finally { console.error = orig; }
}

test('H9: the gate shape — {halt, pct 0}, {halt, pct -1}, {halt, pct "abc"}, {STEP}, {halt} are refused after the anchor and before any mark; {halt, pct "15"} (a string) and {halt, pct true} pass the shape check and halt at 15% / 1%', async () => {
  const minutes = days('2030-05-01', 3);
  const cases = [
    [{ mode: 'halt', pct: 0 }, 2, /gate must be/],
    [{ mode: 'halt', pct: -1 }, 2, /gate must be/],
    [{ mode: 'halt', pct: 'abc' }, 2, /gate must be/],
    [{ mode: 'STEP' }, 2, /gate must be/],
    [{ mode: 'halt' }, 2, /gate must be/],
    [{ mode: 'halt', pct: '15' }, 0, null], // a string — JS coercion; a small day move passes the 15% gate
    [{ mode: 'halt', pct: true }, 0, null], // true > 0 — a 1% gate; the throwaway day below moves less than that or halts
  ];
  for (const [gate, code, re] of cases) {
    const key = generatePrivateKey();
    const node = fakeNode({ vault: VAULT, keeper: privateKeyToAccount(key).address });
    const root = tempRoot({ fill: FILL, inception: I, vaults: vaults(gate) });
    const logs = [];
    const out = await capture(() => run(['--index', 'qbtc2x', '--anchor'], deps(root, { minutes, now: at('2030-05-03T00:25:00Z'), key, node, logs })));
    const marks = node.txs.filter((t) => t.to !== t.from).length;
    if (code === 2) {
      assert.equal(out.code, 2, `${JSON.stringify(gate)}: ${out.err}`);
      assert.match(out.err, re);
      assert.equal(marks, 0, `${JSON.stringify(gate)}: nothing marked`);
      assert.equal(readJsonl(path.join(root, 'trackrecord', 'anchors-qbtc2x.jsonl')).length, 2, 'the lines are anchored first');
    } else {
      assert.ok(out.code === 0 || /MARK HALTED/.test(out.err), `${JSON.stringify(gate)}: ${out.code} ${out.err}`);
    }
  }
});

test('H9 blocked: a registry line naming a vault with the right symbol but another keeper, or another symbol with the right keeper, is refused before any mark; a counterfeit with BOTH right (anyone can deploy one with manager = the keeper address) is marked', async () => {
  const minutes = days('2030-05-01', 3);
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const cases = [
    ['right symbol, other keeper', { keeper: stranger, symbol: 'qBTC2X' }, 1, /keeper is .*, not the signer .* — no mark sent/],
    ['other symbol, right keeper', { keeper: me, symbol: 'qETH1.5X' }, 1, /is "qETH1\.5X", not qBTC2X — keeper\/leverage-vaults\.json names the wrong vault; no mark sent/],
    ['counterfeit: right symbol and keeper, owner a stranger', { keeper: me, owner: stranger, symbol: 'qBTC2X' }, 0, null],
  ];
  for (const [label, opts, code, re] of cases) {
    const node = fakeNode({ vault: VAULT, ...opts });
    const root = tempRoot({ fill: FILL, inception: I, vaults: vaults({ mode: 'step' }) });
    const out = await capture(() => run(['--index', 'qbtc2x', '--anchor'], deps(root, { minutes, now: at('2030-05-03T00:25:00Z'), key, node })));
    const marks = node.txs.filter((t) => t.to !== t.from).length;
    assert.equal(out.code, code, `${label}: ${out.err}`);
    if (re) { assert.match(out.err, re, label); assert.equal(marks, 0, label); } else assert.ok(marks >= 1, `${label}: the keeper marked a vault it did not deploy and does not own`);
  }
});
