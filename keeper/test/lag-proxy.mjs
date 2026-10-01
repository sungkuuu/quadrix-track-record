#!/usr/bin/env node
/**
 * REHEARSAL ONLY — a JSON-RPC proxy in front of a local anvil that plays the
 * load-balanced public endpoint's lagging node (2026-10-01: an eth_getCode
 * right after a receipt came back empty).
 *
 *   node keeper/test/lag-proxy.mjs --port 8581 --upstream http://127.0.0.1:8571 --lag 4 --log sends.jsonl
 *
 * After every receipt it hands out (eth_getTransactionReceipt with a result,
 * for a hash it has not seen yet) the next `--lag` reads OF EACH READ METHOD
 * (so the block-time read right after the receipt does not use them all up
 * and the check after it is lagged too) are answered by a node whose head is
 * the block before that receipt's, in turn:
 *   stale    — `latest` means the old head (eth_call, eth_getCode, the block,
 *              eth_blockNumber, eth_getLogs clamped to it): the state BEFORE
 *              the transaction, which looks like a real answer; a read that
 *              names the new block errors "header not found";
 *   empty    — eth_call and eth_getCode answer "0x"; a block that is not
 *              there yet is null; eth_blockNumber is the old head;
 *   notfound — every read that names a block errors "header not found"; a
 *              block by number is null; `latest` is the old head.
 * Reads are eth_call, eth_getCode, eth_getBalance, eth_getStorageAt,
 * eth_getBlockByNumber, eth_blockNumber and eth_getLogs. Everything else
 * (sending, receipts, transactions, nonces, gas, the anvil and evm
 * methods) passes through untouched. --dark-after-selector 0x…: after the
 * receipt of the first transaction it forwards whose calldata starts with
 * that selector, every read errors "header not found" for --dark-ms (40 s) —
 * a node that does not catch up inside the tool's 30 s bound, so the tool
 * stops (with its record on disk). --exact-warp turns evm_increaseTime(d)
 * into evm_setNextBlockTimestamp(the latest block's time + d): under
 * anvil_setBlockTimestampInterval (block times independent of the wall
 * clock, so two runs compare block for block) anvil ignores
 * evm_increaseTime, which the tool's --warp uses. --log appends every
 * eth_sendTransaction and
 * eth_sendRawTransaction it forwards (JSON lines) and --events the lag it
 * played. Listens on 127.0.0.1 only; refuses a non-local upstream.
 */
import fs from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 8581));
const UPSTREAM = opt('--upstream', 'http://127.0.0.1:8571');
const LAG = Number(opt('--lag', 4));
const SEND_LOG = opt('--log', null);
const EVENT_LOG = opt('--events', null);
const MODES = (opt('--modes', 'stale,empty,notfound')).split(',');
const EXACT_WARP = argv.includes('--exact-warp');
const DARK_SELECTOR = (opt('--dark-after-selector', '') || '').toLowerCase();
const DARK_MS = Number(opt('--dark-ms', 40_000));
const darkHashes = new Set();
let darkUntil = 0;
let darkDone = false;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(UPSTREAM)) { console.error(`lag-proxy: upstream ${UPSTREAM} is not local — refusing`); process.exit(2); }

const READS = new Set(['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getStorageAt', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_getLogs']);
const seen = new Set();
let lagBlock = null; // the receipt block the lagging node has not got
let lagLeft = new Map(); // read method → lagging answers left
let cycle = 0;
const stats = { receipts: 0, lagged: 0, byMode: {}, byMethod: {} };

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const big = (x) => (typeof x === 'string' && /^0x/.test(x) ? BigInt(x) : null);
const note = (e) => { if (EVENT_LOG) fs.appendFileSync(EVENT_LOG, JSON.stringify({ t: Date.now(), ...e }) + '\n'); };

async function up(body) {
  const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const err = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

/** The block-tag position of each read method's params. */
const TAG_AT = { eth_call: 1, eth_getCode: 1, eth_getBalance: 1, eth_getStorageAt: 2, eth_getBlockByNumber: 0 };

async function lagged(req, mode) {
  const old = lagBlock - 1n;
  const { id, method } = req;
  const params = [...(req.params ?? [])];
  if (method === 'eth_blockNumber') return ok(id, hex(old));
  if (method === 'eth_getLogs') {
    const f = { ...params[0] };
    const to = f.toBlock == null || ['latest', 'pending', 'safe', 'finalized'].includes(f.toBlock) ? old : big(f.toBlock);
    if (mode === 'notfound' && to != null && to >= lagBlock) return err(id, 'header not found');
    f.toBlock = hex(to != null && to < old ? to : old);
    if (big(f.fromBlock) != null && big(f.fromBlock) > old) return ok(id, []);
    return up({ ...req, params: [f] });
  }
  const at = TAG_AT[method];
  const tag = params[at];
  const n = big(typeof tag === 'object' && tag ? tag.blockNumber : tag);
  const isLatest = tag == null || ['latest', 'pending', 'safe', 'finalized'].includes(tag);
  if (method === 'eth_getBlockByNumber') {
    if (isLatest) { params[0] = hex(old); return up({ ...req, params }); }
    if (n != null && n >= lagBlock) return ok(id, null); // not there yet, in every mode
    if (mode === 'notfound') return ok(id, null);
    return up(req);
  }
  if (mode === 'empty' && (method === 'eth_call' || method === 'eth_getCode')) return ok(id, '0x');
  if (mode === 'notfound') return err(id, 'header not found');
  // stale
  if (isLatest) { params[at] = hex(old); return up({ ...req, params }); }
  if (n != null && n >= lagBlock) return err(id, 'header not found');
  return up(req);
}

async function handle(req) {
  if (req.method === 'lagproxy_stats') return ok(req.id, stats);
  if (EXACT_WARP && req.method === 'evm_increaseTime') {
    const head = (await up({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] })).result;
    const d = BigInt(req.params[0]);
    const r = await up({ jsonrpc: '2.0', id: req.id, method: 'evm_setNextBlockTimestamp', params: [Number(BigInt(head.timestamp) + d)] });
    note({ warp: d.toString(), to: (BigInt(head.timestamp) + d).toString() });
    return r.error ? r : ok(req.id, hex(d));
  }
  if (SEND_LOG && (req.method === 'eth_sendTransaction' || req.method === 'eth_sendRawTransaction')) fs.appendFileSync(SEND_LOG, JSON.stringify({ method: req.method, params: req.params }) + '\n');
  if (READS.has(req.method) && Date.now() < darkUntil) {
    stats.dark = (stats.dark ?? 0) + 1;
    note({ dark: true, method: req.method });
    return req.method === 'eth_getBlockByNumber' && req.params?.[0] !== 'latest' ? ok(req.id, null) : err(req.id, 'header not found');
  }
  if (READS.has(req.method) && (lagLeft.get(req.method) ?? 0) > 0 && lagBlock != null) {
    lagLeft.set(req.method, lagLeft.get(req.method) - 1);
    const mode = MODES[cycle++ % MODES.length];
    stats.lagged++;
    stats.byMode[mode] = (stats.byMode[mode] ?? 0) + 1;
    stats.byMethod[req.method] = (stats.byMethod[req.method] ?? 0) + 1;
    const out = await lagged(req, mode);
    note({ lagBlock: lagBlock.toString(), mode, method: req.method, params: req.params, answered: out.error ? `error: ${out.error.message}` : out.result === null ? 'null' : out.result === '0x' ? '0x' : 'value' });
    return out;
  }
  const out = await up(req);
  if (DARK_SELECTOR && req.method === 'eth_sendTransaction' && out.result && String(req.params?.[0]?.data ?? req.params?.[0]?.input ?? '').toLowerCase().startsWith(DARK_SELECTOR)) darkHashes.add(out.result);
  if (req.method === 'eth_getTransactionReceipt' && out.result && !seen.has(out.result.transactionHash)) {
    seen.add(out.result.transactionHash);
    lagBlock = BigInt(out.result.blockNumber);
    lagLeft = new Map([...READS].map((m) => [m, LAG]));
    stats.receipts++;
    note({ receipt: out.result.transactionHash, block: lagBlock.toString(), lagReads: LAG });
    if (!darkDone && darkHashes.has(out.result.transactionHash)) { darkDone = true; darkUntil = Date.now() + DARK_MS; note({ darkFrom: Date.now(), ms: DARK_MS, after: out.result.transactionHash }); }
  }
  return out;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let out;
    try {
      const j = JSON.parse(body);
      out = Array.isArray(j) ? await Promise.all(j.map(handle)) : await handle(j);
    } catch (e) { out = err(null, `lag-proxy: ${e.message}`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`[lag-proxy] ${LAG} lagging read(s) after each receipt (${MODES.join(' → ')}) on 127.0.0.1:${PORT} → ${UPSTREAM}`));
