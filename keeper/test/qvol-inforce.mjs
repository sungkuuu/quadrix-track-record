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

const DEPOSIT_CAP = toFunctionSelector('function depositCap()');
/** The fake node as viem's transport without retries (as vol-index.test.mjs); depositCap() answers 0. */
export const quick = (node) =>
  custom(
    {
      async request(req) {
        if (req.method === 'eth_fillTransaction') throw Object.assign(new Error('the method eth_fillTransaction does not exist'), { code: -32601 });
        if (req.method === 'eth_call' && String(req.params?.[0]?.data ?? '').startsWith(DEPOSIT_CAP)) return `0x${'0'.repeat(64)}`;
        return node.transport({ retryCount: 0 }).request(req);
      },
    },
    { retryCount: 0 }
  );

/**
 * One in-force run of the keeper at `iso` (the runner's clock; the fake exchange's clock is 5 minutes
 * later). `wrap(fetch)` may wrap the fake exchange (failures, hangs, timing); `wait` replaces the
 * keeper's wait (cli's default waits nothing); `runFn` replaces the keeper's run. Without `key` and
 * `node` nothing is anchored and no chain call may happen.
 */
export async function inForce(root, iso, { key = null, node = null, argv = ['--anchor'], bars = BARS, tamper = null, wrap = null, wait = null, runFn = run, extra = {} } = {}) {
  const now = Date.parse(iso);
  const bin = fakeBinance(bars, now + 300_000, tamper ? { tamper } : {});
  const r = await cli(runFn, ['--line', 'realized', ...argv], {
    root,
    now: () => now,
    fetch: wrap ? wrap(bin.fetch) : bin.fetch,
    env: key ? { KEEPER_PK: key } : {},
    transport: node ? () => quick(node) : () => { throw new Error('no chain call expected'); },
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
  const fb = fakeBinance(days, serverTime, tamper ? { tamper } : {});
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
