/**
 * Test helpers for the leverage leg (no network, no real key):
 *   - fakeBinance: the two Binance endpoints the leg calls, from 1-minute bars held here;
 *   - synthMinutes / minutesFrom15: 1-minute bars (a seeded walk, or rebuilt from 15-minute bars so
 *     that aggregating them gives those 15-minute bars back exactly);
 *   - fakeNode: a JSON-RPC node for viem with one QuadrixIndexVault (navPerShare, keeper, owner,
 *     depositsPaused, the ±25% bound) and self-send anchors. It accepts only RAW signed
 *     transactions — eth_sendTransaction (asking the node to sign) is refused as the public GIWA
 *     endpoint refuses it — and records every method called;
 *   - tempRoot: a throwaway repository root (keeper/rulebooks, keeper/leverage-*.json, trackrecord/).
 *
 * THROWAWAY values: every check pair and cost convention used by the tests is labelled
 * THROWAWAY_* below. None is a tested value; the shipped rulebooks keep null.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  custom, keccak256, parseTransaction, recoverTransactionAddress, decodeFunctionData, encodeFunctionResult, getAddress, toHex, hexToString,
} from 'viem';
import { VAULT_ABI } from '../leverage-index.mjs';
import { sha256 } from '../leverage-step.mjs';

export const KEEPER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.join(KEEPER_DIR, '..');
/** Throwaway pairs, labelled as such — never a tested value. */
export const THROWAWAY_CHECK = { minutes: 120, trigger: 2.2 };
export const THROWAWAY_LEVEL = { costBp: 30, ratePct: 6 };

const DAY = 86_400_000;
const MIN = 60_000;
export const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

// ------------------------------------------------------------------ bars

/** Seeded walk of 1,440 one-minute bars for `day` starting at `p0`. `shock(k)` multiplies the k-th minute's move. */
export function synthMinutes(day, { seed = 1, p0 = 100, vol = 0.002, shock = null, skip = null } = {}) {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 2 ** 32;
  };
  const out = [];
  let p = p0;
  for (let k = 0; k < 1440; k++) {
    const o = p;
    let ret = (rnd() - 0.5) * 2 * vol;
    if (shock) ret = shock(k, ret);
    const c = Math.max(1e-6, o * (1 + ret));
    const h = Math.max(o, c) * (1 + rnd() * vol * 0.5);
    const l = Math.min(o, c) * (1 - rnd() * vol * 0.5);
    p = c;
    if (skip && skip(k)) continue;
    const r = (x) => Number(x.toFixed(2));
    const [oo, hh, ll, cc] = [r(o), r(h), r(l), r(c)];
    out.push({ openMs: dayMs(day) + k * MIN, o: oo, h: Math.max(hh, oo, cc), l: Math.min(ll, oo, cc), c: cc });
  }
  return out;
}

/** 1-minute bars whose 15-minute aggregation is exactly `bars` ([{openMs, o, h, l, c, n1m}]). */
export function minutesFrom15(bars) {
  const out = [];
  for (const b of bars) {
    out.push({ openMs: b.openMs, o: b.o, h: b.h, l: b.l, c: b.n1m === 1 ? b.c : b.c });
    for (let j = 1; j < b.n1m; j++) out.push({ openMs: b.openMs + j * MIN, o: b.c, h: b.c, l: b.c, c: b.c });
  }
  return out;
}

/** The sixth test's 15-minute file → [{openMs, o, h, l, c, n1m}] (null when the file is absent). */
export async function read15mFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const zlib = await import('node:zlib');
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n');
  text.shift();
  return text.map((l) => {
    const f = l.split(',');
    return { openMs: Date.parse(`${f[0]}:00Z`), o: +f[1], h: +f[2], l: +f[3], c: +f[4], n1m: +f[5] };
  });
}

/**
 * Binance /api/v3/time and /api/v3/klines from `minutes` (symbol → sorted 1-minute bars).
 * `serverTime` is a function or a number; `drop` lets a test hide rows on the n-th fetch.
 */
export function fakeBinance(minutesBySymbol, { serverTime, mutate = null } = {}) {
  const calls = [];
  const st = () => (typeof serverTime === 'function' ? serverTime() : serverTime);
  return {
    host: 'data-api.binance.vision',
    calls,
    async time() {
      calls.push(['time']);
      return st();
    },
    async klines(symbol, startMs, endMs, limit) {
      calls.push(['klines', symbol, startMs, endMs, limit]);
      const all = minutesBySymbol[symbol] ?? [];
      let rows = all.filter((m) => m.openMs >= startMs && (endMs == null || m.openMs <= endMs) && m.openMs <= st()).slice(0, limit);
      if (mutate) rows = mutate(rows, calls.filter((c) => c[0] === 'klines').length);
      return rows.map((m) => [m.openMs, String(m.o), String(m.h), String(m.l), String(m.c), '1.0', m.openMs + MIN - 1, '0', 1, '0', '0', '0']);
    },
  };
}

// ------------------------------------------------------------------ chain

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const lc = (a) => String(a).toLowerCase();

/**
 * A JSON-RPC node with one mark vault. Returns { transport, state, methods, raws, txs }.
 * `lagAfterWrite` = k: after each vault write, the next k eth_calls at `latest`
 * see the state before that write (GIWA's public endpoint is load-balanced; a
 * node behind the receipt answers from the old block). A call at an explicit
 * block answers from that block, or "header not found" past the head.
 */
export function fakeNode({ chainId = 91342, vault, keeper, owner = keeper, nav = 1_000_000n, failSetNavAtStep = null, lagAfterWrite = 0, symbol = 'qBTC2X' } = {}) {
  const methods = [];
  const raws = [];
  const txs = []; // { hash, from, to, data, status, block }
  const receipts = new Map();
  const st = { vault: getAddress(vault), keeper: getAddress(keeper), owner: getAddress(owner), nav, paused: false, cap: 0n, block: 100n, history: new Map() };
  st.history.set(st.block, { nav: st.nav, paused: st.paused });
  let setNavCount = 0;
  let stale = null; // { nav, paused, left }
  const block = (n) => ({
    number: hex(n), hash: `0x${n.toString(16).padStart(64, '0')}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: hex(1_790_000_000n + n), baseFeePerGas: '0x3b9aca00',
    gasLimit: '0x1c9c380', gasUsed: '0x0', miner: `0x${'0'.repeat(40)}`, transactions: [], logsBloom: `0x${'0'.repeat(512)}`,
    difficulty: '0x0', extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: `0x${'0'.repeat(64)}`, size: '0x0', stateRoot: `0x${'0'.repeat(64)}`,
    receiptsRoot: `0x${'0'.repeat(64)}`, transactionsRoot: `0x${'0'.repeat(64)}`, uncles: [], mixHash: `0x${'0'.repeat(64)}`, totalDifficulty: '0x0',
  });
  const revert = (reason) => Object.assign(new Error(`execution reverted: ${reason}`), { code: 3, data: '0x' });
  /** Applies (or, with dry = true, checks) a vault call from `from`; returns a revert reason or null. */
  function vaultCall(from, data, dry, seen = null) {
    const { functionName, args } = decodeFunctionData({ abi: VAULT_ABI, data });
    if (functionName === 'setNav') {
      if (getAddress(from) !== st.keeper) return 'not keeper';
      const [x] = args;
      if (x === 0n) return 'zero nav';
      const old = seen ? seen.nav : st.nav;
      const maxUp = old + (old * 2500n) / 10000n;
      const maxDown = old - (old * 2500n) / 10000n;
      if (!(x <= maxUp && x >= maxDown)) return 'nav move too large';
      if (!dry) {
        setNavCount++;
        if (failSetNavAtStep != null && setNavCount === failSetNavAtStep) return 'injected failure';
        st.nav = x;
      }
      return null;
    }
    if (functionName === 'setDepositsPaused') {
      if (getAddress(from) !== st.owner) return 'OwnableUnauthorizedAccount';
      if (!dry) st.paused = args[0];
      return null;
    }
    return `unexpected ${functionName}`;
  }
  function view(data, at, seen = null) {
    const { functionName } = decodeFunctionData({ abi: VAULT_ABI, data });
    const s = seen ?? (at != null ? st.history.get(at) ?? null : { nav: st.nav, paused: st.paused });
    if (!s) throw Object.assign(new Error('header not found'), { code: -32000 });
    const value = { navPerShare: s.nav, keeper: st.keeper, owner: st.owner, depositsPaused: s.paused, symbol }[functionName];
    if (value === undefined) return null;
    return encodeFunctionResult({ abi: VAULT_ABI, functionName, result: value });
  }
  const transport = custom({
    async request({ method, params }) {
      methods.push(method);
      switch (method) {
        case 'eth_chainId': return hex(chainId);
        case 'eth_blockNumber': return hex(st.block);
        case 'eth_getBlockByNumber': return block(params[0] === 'latest' ? st.block : BigInt(params[0]));
        case 'eth_getTransactionCount': return hex(txs.length);
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_gasPrice': return '0x3b9aca01';
        case 'eth_estimateGas': return '0x30000';
        case 'eth_call': {
          const [{ from, to, data }, tag] = params;
          const at = tag && tag !== 'latest' && tag !== 'pending' ? BigInt(tag) : null;
          if (lc(to) !== lc(st.vault)) throw new Error(`fake node: eth_call to ${to}`);
          if (at != null && !st.history.has(at)) throw Object.assign(new Error('header not found'), { code: -32000 });
          let seen = at != null ? st.history.get(at) : null;
          if (at == null && stale && stale.left > 0) {
            stale.left--;
            seen = stale;
          }
          const v = view(data, at, seen);
          if (v !== null) return v;
          const why = vaultCall(from ?? `0x${'0'.repeat(40)}`, data, true, seen);
          if (why) throw revert(why);
          return '0x';
        }
        case 'eth_sendRawTransaction': {
          const raw = params[0];
          raws.push(raw);
          const tx = parseTransaction(raw);
          const from = await recoverTransactionAddress({ serializedTransaction: raw });
          const hash = keccak256(raw);
          st.block += 1n;
          let status = '0x1';
          if (lc(tx.to) === lc(st.vault)) {
            if (lagAfterWrite > 0) stale = { nav: st.nav, paused: st.paused, left: lagAfterWrite };
            const why = vaultCall(from, tx.data, false);
            if (why) status = '0x0';
          } else if (lc(tx.to) !== lc(from)) throw new Error(`fake node: transaction to ${tx.to}`);
          st.history.set(st.block, { nav: st.nav, paused: st.paused });
          const t = { hash, from: getAddress(from), to: getAddress(tx.to), data: tx.data ?? '0x', status, block: st.block, gas: tx.gas };
          txs.push(t);
          receipts.set(hash, {
            transactionHash: hash, blockNumber: hex(st.block), blockHash: `0x${st.block.toString(16).padStart(64, '0')}`, transactionIndex: '0x0', status, gasUsed: '0x5208',
            cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca01', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: null, from, to: tx.to,
          });
          return hash;
        }
        case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
        case 'eth_sendTransaction':
        case 'wallet_sendTransaction':
          throw Object.assign(new Error('unknown account'), { code: -32000 });
        default:
          throw new Error(`fake node: unexpected ${method}`);
      }
    },
  });
  return { transport, state: st, methods, raws, txs, anchorsOf: () => txs.filter((t) => t.to === t.from).map((t) => hexToString(t.data)) };
}

// ------------------------------------------------------------------ files

/**
 * A throwaway repository root: copies of the real rulebooks with the THROWAWAY values filled
 * when `fill` is given (labelled in _doc), an empty gaps file, and — when `decision` is given —
 * a decision ledger and document that pin the rulebook (a stand-in for an anchored decision).
 */
export function tempRoot({ index = 'qbtc2x', fill = null, inception = null, vaults = null, gaps = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-root-'));
  fs.mkdirSync(path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'trackrecord', 'decisions'), { recursive: true });
  for (const ix of ['qbtc2x', 'qeth2x']) {
    const rb = JSON.parse(fs.readFileSync(path.join(KEEPER_DIR, 'rulebooks', `${ix}.json`), 'utf8'));
    if (ix === index && fill) {
      rb._doc = 'THROWAWAY test values — not a tested value, never published';
      if (fill.check !== undefined) rb.check = { ...rb.check, ...fill.check };
      if (fill.primary !== undefined) rb.level = { ...rb.level, primary: fill.primary };
      if (fill.also !== undefined) rb.level = { ...rb.level, also: fill.also };
      rb.inception = inception ? { date: inception, decision: `${inception}-${ix}-paper-inception` } : { date: null, decision: null };
    }
    fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', `${ix}.json`), JSON.stringify(rb, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(root, 'keeper', 'leverage-gaps.json'), JSON.stringify({ accepted: gaps }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), '');
  if (vaults) fs.writeFileSync(path.join(root, 'keeper', 'leverage-vaults.json'), JSON.stringify(vaults, null, 2) + '\n');
  if (inception) {
    const rbBytes = fs.readFileSync(path.join(root, 'keeper', 'rulebooks', `${index}.json`));
    const id = `${inception}-${index}-paper-inception`;
    const doc = `# THROWAWAY test decision\n\nPins keeper/rulebooks/${index}.json sha256 ${sha256(rbBytes)}.\n`;
    fs.writeFileSync(path.join(root, 'trackrecord', 'decisions', `${id}.md`), doc);
    fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), JSON.stringify({ id, file: `decisions/${id}.md`, effectiveFrom: inception, sha256: sha256(Buffer.from(doc)), txHash: `0x${'d'.repeat(64)}`, anchoredAt: `${inception}T00:00:00.000Z` }) + '\n');
  }
  return root;
}

export const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

/** Every file under `dir` (relative paths), for "nothing was written" assertions. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out.sort();
}

export { toHex, DAY, MIN };
