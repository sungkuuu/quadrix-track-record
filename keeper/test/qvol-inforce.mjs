/**
 * Test support for the qVOL realized line IN FORCE, shared by qvol-verify.test.mjs,
 * qvol-operating-values.test.mjs and watchdog-series.test.mjs.
 *
 * THROWAWAY throughout: a stand-in inception (the decision below is not a
 * decision and was never anchored; the values of the rule are the
 * repository's), SYNTHETIC bars (vol-helpers syntheticDays), the fake GIWA node
 * of leverage-helpers, a key generated here that holds nothing, and servers on
 * 127.0.0.1 only. Nothing is written outside the temporary directory, and no
 * request leaves this machine.
 *
 * These files are named qvol-*, not vol-*: like the in-force section of
 * keeper/test/vol-index.test.mjs they sign with a key generated here, and T15
 * there (no keeper/test/vol-*.mjs file reads a signing key) keeps its meaning.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { custom, toFunctionSelector, toHex, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { run } from '../vol-index.mjs';
import { syntheticDays, fakeBinance, tmpDir, readJsonl, cli, rulebookPath, addDays, REPO } from './vol-helpers.mjs';
import { fakeNode } from './leverage-helpers.mjs';

export const E = '2099-02-01'; // the stand-in decision's effective (anchor) day
export const D1 = '2099-02-02'; // its first line: the next UTC day = inception.date
export const DECISION = `${E}-qvol-inception`;
export const BARS = syntheticDays('2099-01-01', 45).days; // closes for 2098-12-31 … 2099-02-14
export const REC = 'record-qvol.jsonl';
export const ANC = 'anchors-qvol.jsonl';
export const QVAULT = getAddress('0x00000000000000000000000000000000000beef5');
export const VERIFY = path.join(REPO, 'scripts', 'verify.mjs');
export const H = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const writeJsonl = (file, lines) => fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
/** A line re-hashed after an edit (key order kept; hash last). */
export const rehash = (line) => {
  const { hash, ...rest } = line;
  return { ...rest, hash: H(JSON.stringify(rest)) };
};

/** Lines re-chained after an edit: each prevHash set to the line before's new hash, each line re-hashed (a forger's consistent chain). */
export const rechain = (lines) => {
  const out = [];
  for (const l of lines) out.push(rehash({ ...l, prevHash: out.length ? out.at(-1).hash : null }));
  return out;
};

/**
 * A scratch repository root: the repository's realized rulebook with the stand-in inception
 * (`mutate(rb)` may change that copy further), an empty gap acceptance file, a ledger line and a
 * decision file that pins the copy's sha256.
 */
export function inForceRoot({ mutate = null } = {}) {
  const root = tmpDir('vol-inforce');
  const rb = JSON.parse(fs.readFileSync(rulebookPath('realized'), 'utf8'));
  rb.status = 'TEST ONLY — a stand-in inception; not a decision';
  rb.inception = { date: D1, decision: DECISION };
  rb.pendingOwner = [];
  if (mutate) mutate(rb);
  fs.mkdirSync(path.join(root, 'keeper', 'rulebooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'trackrecord', 'decisions'), { recursive: true });
  const rbBytes = Buffer.from(JSON.stringify(rb, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', 'qvol.json'), rbBytes);
  fs.writeFileSync(path.join(root, 'keeper', 'vol-index-gaps.json'), '[]\n');
  const doc = `# TEST ONLY — stand-in decision\n\nPins keeper/rulebooks/qvol.json sha256 ${H(rbBytes)}.\n`;
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions', `${DECISION}.md`), doc);
  const entry = { id: DECISION, file: `decisions/${DECISION}.md`, effectiveFrom: E, sha256: H(Buffer.from(doc)), txHash: `0x${'d'.repeat(64)}`, anchoredAt: `${E}T09:00:00.000Z` };
  fs.writeFileSync(path.join(root, 'trackrecord', 'decisions.jsonl'), JSON.stringify(entry) + '\n');
  const tr = path.join(root, 'trackrecord');
  return { root, tr, entry, rbFile: path.join(root, 'keeper', 'rulebooks', 'qvol.json'), rec: path.join(tr, REC), anc: path.join(tr, ANC) };
}

/** A copy of a scratch root (each case edits its own copy). */
export function copyRoot(x) {
  const root = tmpDir('vol-inforce-copy');
  fs.cpSync(x.root, root, { recursive: true });
  const tr = path.join(root, 'trackrecord');
  return { ...x, root, tr, rbFile: path.join(root, 'keeper', 'rulebooks', 'qvol.json'), rec: path.join(tr, REC), anc: path.join(tr, ANC) };
}

export const keyed = () => {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
};

// ------------------------------------------------- the chain and the exchange as the keeper reads them
// DEPLOY_TX, rpcTx, chainExtras, txView, withDaily and dailyKlines are copied from
// keeper/test/vol-index.test.mjs (the keeper's own tests), so that both test the keeper
// against the same stand-ins.

/** The display vault's stand-in deployment: a contract creation in block 60 (chainExtras answers it as the signer's). */
export const DEPLOY_TX = `0x${'e'.repeat(64)}`;
const DEPOSIT_CAP = toFunctionSelector('function depositCap()');
const hexN = (n) => `0x${BigInt(n).toString(16)}`;
/** A transaction as eth_getTransactionByHash answers it. */
const rpcTx = ({ hash, from, to = null, input = '0x', block = null }) => ({
  hash, from, to, input, value: '0x0', nonce: '0x0', gas: '0xea60', type: '0x2', chainId: hexN(91342), maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x1',
  accessList: [], v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', transactionIndex: block == null ? null : '0x0',
  blockNumber: block == null ? null : hexN(block), blockHash: block == null ? null : `0x${BigInt(block).toString(16).padStart(64, '0')}`,
});
/**
 * What GIWA would answer for transactions the fake node did not see, stand-ins
 * read from a scratch root: the inception decision's anchor (the ledger's
 * txHash: a self-send from `from` with calldata qxdec:<sha256>, as
 * scripts/anchor-decision.mjs sends it) and the display vault's deployment
 * (the registry's deployTx: a contract creation by `from` whose receipt names
 * the registry's address). hash → {from, to, input, block, contractAddress}.
 */
function chainExtras(root, from, { fork = false } = {}) {
  const m = new Map();
  if (!root || !from) return m;
  for (const e of readJsonl(path.join(root, 'trackrecord', 'decisions.jsonl'))) {
    if (/^0x[0-9a-fA-F]{64}$/.test(e.txHash ?? '')) m.set(e.txHash.toLowerCase(), { from, to: from, input: toHex(`qxdec:${e.sha256}`), block: 50 });
  }
  const reg = path.join(root, 'keeper', ...(fork ? ['dryrun'] : []), 'leverage-vaults.json');
  const v = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, 'utf8')).qvol : null;
  if (v?.address && /^0x[0-9a-fA-F]{64}$/.test(v.deployTx ?? '')) m.set(v.deployTx.toLowerCase(), { from, to: null, input: '0x6080604052', block: 60, contractAddress: getAddress(v.address) });
  return m;
}
/**
 * eth_getTransactionByHash (which the fake node does not answer) for the
 * node's own transactions and the stand-ins of chainExtras, and
 * eth_getTransactionReceipt for the stand-ins; a hash in `forget` is unknown
 * (a reorg dropped it). undefined: the node answers the request itself.
 */
function txView(node, req, { root = null, from = null, fork = false, forget = null } = {}) {
  if (req.method !== 'eth_getTransactionByHash' && req.method !== 'eth_getTransactionReceipt') return undefined;
  const h = String(req.params?.[0] ?? '').toLowerCase();
  if (forget?.has(h)) return null;
  const own = node.txs.find((t) => t.hash.toLowerCase() === h);
  const x = own ? null : chainExtras(root, from, { fork }).get(h);
  if (req.method === 'eth_getTransactionByHash') return own ? rpcTx({ ...own, input: own.data }) : x ? rpcTx({ hash: h, ...x }) : null;
  if (!x) return undefined;
  return {
    transactionHash: h, blockNumber: hexN(x.block), blockHash: `0x${BigInt(x.block).toString(16).padStart(64, '0')}`, transactionIndex: '0x0', status: x.status ?? '0x1', gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca01', logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: x.contractAddress ?? null, from: x.from, to: x.to,
  };
}
/**
 * The fake node as viem's transport without retries (as vol-index.test.mjs): depositCap() answers 0;
 * transactions are looked up through txView (`chain`: {root, from, fork, forget}) — the node's own
 * (the line anchors, with their sender, recipient, calldata and block) and the decision's anchor.
 */
export const quick = (node, chain = {}) =>
  custom(
    {
      async request(req) {
        if (req.method === 'eth_fillTransaction') throw Object.assign(new Error('the method eth_fillTransaction does not exist'), { code: -32601 });
        if (req.method === 'eth_call' && String(req.params?.[0]?.data ?? '').startsWith(DEPOSIT_CAP)) return `0x${'0'.repeat(64)}`;
        const seen = txView(node, req, chain);
        if (seen !== undefined) return seen;
        return node.transport({ retryCount: 0 }).request(req);
      },
    },
    { retryCount: 0 }
  );

/**
 * The fake Binance of vol-helpers answers every klines call with 1-minute rows
 * (it does not read `interval`). Daily candles (interval=1d) are answered
 * here from the same bars, as Binance's are: a closed day's candle opens at
 * 00:00 UTC and closes at the day's last 1-minute close. `daily(day, close)`
 * may change a candle's close (undefined: unchanged; null: no candle).
 */
export function withDaily(bin, days, serverTime, { daily = null } = {}) {
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname !== '/api/v3/klines' || u.searchParams.get('interval') !== '1d') return bin.fetch(url, init);
    bin.calls.push(u.pathname + u.search);
    const rows = dailyKlines(days, { daily, from: Number(u.searchParams.get('startTime')), to: Number(u.searchParams.get('endTime')), serverTime });
    return new Response(JSON.stringify(rows.slice(0, Number(u.searchParams.get('limit')))), { status: 200 });
  };
  return { fetch, calls: bin.calls };
}
/** Daily candles (klines rows, as Binance's REST API answers interval=1d) of the closed days of `days` that open in [from, to]. */
function dailyKlines(days, { daily = null, from = -Infinity, to = Infinity, serverTime = Infinity } = {}) {
  const rows = [];
  for (const d of Object.keys(days).sort()) {
    const open = Date.parse(`${d}T00:00:00Z`);
    const mins = days[d];
    if (open < from || open > to || !mins.length || open + 86_400_000 - 1 >= serverTime) continue;
    let c = mins.at(-1).c;
    if (daily) {
      const x = daily(d, c);
      if (x === null) continue;
      if (x !== undefined) c = x;
    }
    const hi = Math.max(c, ...mins.map((m) => m.h));
    const lo = Math.min(c, ...mins.map((m) => m.l));
    rows.push([open, mins[0].o.toFixed(8), hi.toFixed(8), lo.toFixed(8), c.toFixed(8), '1440.00000000', open + 86_400_000 - 1, '1.0', 1440, '0.5', '0.5', '0']);
  }
  return rows;
}

/**
 * One in-force run of the keeper at `iso` (the runner's clock; the fake exchange's clock is 5 minutes
 * later). The exchange serves 1-minute bars and daily candles of `bars` (a day's candle closes at its
 * last 1-minute close; `daily` may change it). `wrap(fetch)` may wrap the fake exchange (failures,
 * hangs, timing); `wait` replaces the keeper's wait (cli's default waits nothing); `runFn` replaces
 * the keeper's run. Without `key` and `node` nothing is anchored and no chain call may happen.
 */
export async function inForce(root, iso, { key = null, node = null, argv = ['--anchor'], bars = BARS, tamper = null, daily = null, wrap = null, wait = null, runFn = run, extra = {} } = {}) {
  const now = Date.parse(iso);
  const bin = withDaily(fakeBinance(bars, now + 300_000, tamper ? { tamper } : {}), bars, now + 300_000, { daily });
  const from = key ? privateKeyToAccount(key).address : null;
  const r = await cli(runFn, ['--line', 'realized', ...argv], {
    root,
    now: () => now,
    fetch: wrap ? wrap(bin.fetch) : bin.fetch,
    env: key ? { KEEPER_PK: key } : {},
    transport: node ? () => quick(node, { root, from }) : () => { throw new Error('no chain call expected'); },
    pollingInterval: 5,
    readTiming: { waitMs: 50, stepMs: 1 },
    ...(wait ? { wait } : {}),
    ...extra,
  });
  return { ...r, calls: bin.calls };
}

/**
 * An in-force record of `n` lines (D1 … D1 + n - 1) written by the keeper from the exchange's `bars`, one
 * run per day at 00:25 UTC. With `anchor` every line is anchored on a fresh fake node by a fresh key (no
 * vault: no mark).
 */
export async function honestRecord(n, { anchor = true, bars = BARS } = {}) {
  const x = inForceRoot();
  const { key, address } = keyed();
  const node = anchor ? fakeNode({ vault: QVAULT, keeper: address, symbol: 'qVOL' }) : null;
  for (let k = 0; k < n; k++) {
    const r = await inForce(x.root, `${addDays(D1, k)}T00:25:00Z`, anchor ? { key, node, bars } : { argv: [], bars });
    if (r.code !== 0) throw new Error(`honest record: the run of ${addDays(D1, k)} failed (${r.code}): ${r.err || r.out}`);
  }
  return { ...x, key, address: address.toLowerCase(), node, lines: readJsonl(x.rec) };
}

// ------------------------------------------------------------------ servers on 127.0.0.1

async function listen(srv) {
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () =>
      new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      }),
  };
}

/** The fake exchange of vol-helpers as an HTTP server: `days` = {date: minutes[]}, `serverTime` (ms), `tamper` as fakeBinance's. */
export async function exchangeServer(days, serverTime, { tamper = null } = {}) {
  const fb = withDaily(fakeBinance(days, serverTime, tamper ? { tamper } : {}), days, serverTime);
  const srv = http.createServer(async (req, res) => {
    const r = await fb.fetch(`https://data-api.binance.vision${req.url}`);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return { ...(await listen(srv)), calls: fb.calls };
}

/**
 * A JSON-RPC server for scripts/verify.mjs: `txs` = Map(txHash → {input, block, time, from, to}); a field
 * left undefined is left out of the answer. Blocks are answered with the time of their transaction.
 */
export async function rpcServer(txs) {
  const hex = (n) => `0x${n.toString(16)}`;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const t = txs.get(params?.[0]);
      let result = null;
      if (method === 'eth_getTransactionByHash' && t) {
        result = { hash: params[0], input: t.input, blockNumber: hex(t.block) };
        if (t.from !== undefined) result.from = t.from;
        if (t.to !== undefined) result.to = t.to;
      }
      if (method === 'eth_getTransactionReceipt' && t) result = { status: '0x1', blockNumber: hex(t.block) };
      if (method === 'eth_getBlockByNumber') {
        const n = parseInt(params[0], 16);
        const tm = [...txs.values()].find((x) => x.block === n)?.time;
        if (tm !== undefined) result = { number: params[0], timestamp: hex(Math.floor(tm)) };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return listen(srv);
}

/**
 * The anchors of a record as the RPC's transactions, as the fake node recorded them (sender, recipient and
 * calldata of each signed transaction), with block time = the line's observedAt + 60 s; and the decision's
 * anchor: calldata qxdec:<sha256>, sent by `decisionFrom` (the keeper's address unless given) to itself.
 */
export function rpcTxsOf(x, { anchors = readJsonl(x.anc), lines = readJsonl(x.rec), decisionFrom = x.address } = {}) {
  const txs = new Map();
  for (const a of anchors) {
    const t = x.node.txs.find((y) => y.hash === a.txHash);
    if (!t) throw new Error(`anchor seq ${a.seq}: ${a.txHash} is not on the fake node`);
    const line = lines.find((l) => l.seq === a.seq);
    txs.set(a.txHash, { input: t.data, block: 1000 + a.seq, time: Date.parse(line.observedAt) / 1000 + 60, from: t.from.toLowerCase(), to: t.to.toLowerCase() });
  }
  txs.set(x.entry.txHash, { input: toHex(`qxdec:${x.entry.sha256}`), block: 900, time: Date.parse(`${E}T09:00:00Z`) / 1000, from: decisionFrom, to: decisionFrom });
  return txs;
}

/**
 * In the child: requests to https://data-api.binance.vision go to the fake exchange named by
 * QVOL_TEST_EXCHANGE, requests to 127.0.0.1 go through, every other request fails ("offline").
 */
const REDIRECT = `
const real = globalThis.fetch;
const host = 'https://data-api.binance.vision';
const to = process.env.QVOL_TEST_EXCHANGE;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.startsWith(host + '/')) return to ? real(to + u.slice(host.length), init) : Promise.reject(new Error('offline (test): ' + u));
  if (u.startsWith('http://127.0.0.1:')) return real(url, init);
  return Promise.reject(new Error('offline (test): ' + u));
};
`;
export const OFFLINE = 'data:text/javascript,' + encodeURIComponent(REDIRECT);

/** scripts/verify.mjs --dir <dir> --series qvol <args> as a child that does not block this process (local servers answer meanwhile). */
export function verifyQvol(dir, args = [], { exchange = null } = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? '', ...(exchange ? { QVOL_TEST_EXCHANGE: exchange } : {}) };
    const c = spawn(process.execPath, ['--import', OFFLINE, VERIFY, '--dir', dir, '--series', 'qvol', ...args], { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });
}
