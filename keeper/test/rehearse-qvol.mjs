/**
 * qVOL — the realized line in force, rehearsed on a local anvil fork of GIWA
 * Sepolia before its inception decision is anchored.
 *
 * Needs a running fork (one at a time on the machine) and Binance's public
 * REST (read-only):
 *
 *   anvil --fork-url https://sepolia-rpc.giwa.io --port 8599 --host 127.0.0.1 &
 *   node keeper/test/rehearse-qvol.mjs --rpc http://127.0.0.1:8599 --out <dir>
 *
 * Everything runs in temporary copies of this repository (the real
 * trackrecord/ and keeper/dryrun/ are never touched), with two fresh
 * addresses impersonated on the fork (no key exists or is read; KEEPER_PK and
 * BIDDER_PK must not be set). The days are the machine's (UTC): D2 = today,
 * D1 = yesterday, E = the day before. Each copy holds a STAND-IN inception
 * decision, written here and never committed: keeper/rulebooks/qvol.json with
 * only status, inception {date D1, decision <E>-qvol-inception} and
 * pendingOwner [] changed; a document that pins that file's sha256,
 * anchored on the fork only with the calldata scripts/anchor-decision.mjs
 * sends (qxdec:<sha256>); and the ledger line that script appends. The leg
 * runs in its fork mode (keeper/vol-index.mjs --line realized --anchor --rpc
 * <fork> --from <keeper>): record, anchors, marks and the vault registry under
 * the copy's keeper/dryrun/.
 *
 *   1  deploy the qVOL display vault with keeper/deploy-mark-vault.mjs as the
 *      mark-vault-setup workflow (target qvol) runs it — deposit cap 0, the
 *      second address as guardian — and read it back
 *   2  run 1 at D1 00:25 UTC, the first line's daily run: line D1 →
 *      scripts/verify-vol.mjs → the anchor (qxpi-qvol:<hash>) → the mark to
 *      n6 = floor(value x 1e6), in steps inside 25%
 *   3  run 2 at D2 00:25 UTC: line D2, its anchor, the mark from
 *      the last value; run 3, the same command on the machine's clock, writes
 *      and sends nothing; the two lines against a dry run of the same bars;
 *      scripts/verify.mjs --series qvol on the fork
 *   4  refusals, one run each: a deposit cap above 0 (the line written and
 *      anchored, no mark, exit 1; the cap back at 0, the next run marks); the
 *      decision missing, not anchored, or anchored with its document missing
 *      (no line); open-deposits on the display vault (refused before any
 *      request) and a deposit at cap 0 (the contract reverts); a registry
 *      that names a vault whose symbol is not qVOL (the line written and
 *      anchored, no mark, exit 1)
 *   5  scripts/watchdog-series.mjs on the copy's record: fresh, stale 40 h
 *      after the last line's day began, missing 16 h after the first line's
 *      day began
 *
 * Binance (data-api.binance.vision): runs 1 and 2 read it; the refusal runs
 * and the dry run replay the answers runs 1 and 2 received (the same URLs,
 * so the same bars). Runs 1, 2 and the refusal runs are the module's run()
 * with the runner's clock set; run 3 and every other tool run as a command.
 * The stand-in decision is anchored on the fork's clock (today), after its
 * file-name date E — scripts/anchor-decision.mjs refuses that for a real
 * decision; it is dated E only so that the two lines are days whose bars
 * exist. Run it after 00:05 UTC (today's first 1-minute bar must be closed).
 * Exit status is 1 when any check fails. LOCAL ONLY: it refuses to run under
 * GitHub Actions.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createPublicClient, createWalletClient, http, defineChain, getAddress, parseAbi, parseAbiItem, encodeAbiParameters, toHex } from 'viem';
import { markSteps } from '../leverage-step.mjs';
import { checkSeries } from '../../scripts/watchdog-series.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const RPC = opt('--rpc', 'http://127.0.0.1:8599');
const outArg = opt('--out', null);
const OUT = path.resolve(outArg ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qvol-rehearsal-')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw new Error('--rpc must be a local anvil (http://127.0.0.1:<port>)');
if (process.env.KEEPER_PK || process.env.BIDDER_PK) throw new Error('unset KEEPER_PK and BIDDER_PK: the rehearsal signs with accounts impersonated on the fork only');
if (process.env.GITHUB_ACTIONS === 'true') throw new Error('local only: the rehearsal does not run in a workflow');
const insideRepo = path.relative(REPO, OUT);
if (!insideRepo || !insideRepo.startsWith('..')) throw new Error('--out must be outside this repository');
fs.mkdirSync(OUT, { recursive: true });
const STARTED = Date.now();

// ------------------------------------------------------------------ constants
const dayAt = (ms) => new Date(ms).toISOString().slice(0, 10);
const D2 = dayAt(STARTED); // today (UTC): the second line
const D1 = dayAt(Date.parse(`${D2}T00:00:00Z`) - 86_400_000); // yesterday: the first line (inception.date)
const E = dayAt(Date.parse(`${D2}T00:00:00Z`) - 2 * 86_400_000); // the stand-in decision's effective day
if (STARTED < Date.parse(`${D2}T00:05:00Z`)) throw new Error(`run after ${D2}T00:05Z: yesterday must be closed on Binance (a closed 1-minute bar of today)`);
const DECISION = `${E}-qvol-inception`;
const T1 = Date.parse(`${D1}T00:25:00Z`); // the daily run of the first line's day
const T2 = Date.parse(`${D2}T00:25:00Z`);
const MOCK_USD = getAddress('0xf70B2b744eE604728D661b7D07460843DBD1be76');
const NAME = 'Quadrix BTC Realized Volatility Vault';
const CAP = 1_000_000_000_000n; // 1,000,000 mUSD: the cap of the refusal run

// Fresh addresses, impersonated on the fork. NOT anvil's default accounts: on
// GIWA Sepolia those carry EIP-7702 delegations, so a self-send with calldata
// (an anchor) would run someone else's code (keeper/test/rehearse-leverage.mjs).
const fresh = () => getAddress(`0x${crypto.randomBytes(20).toString('hex')}`);
const ACCT0 = fresh(); // manager = owner = keeper of every vault here; anchors the stand-in decision and the lines
const ACCT1 = fresh(); // the guardian of every vault here; also the user whose deposit is refused
const chain = defineChain({ id: 91342, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });
const w0 = createWalletClient({ account: ACCT0, chain, transport: http(RPC) });
const w1 = createWalletClient({ account: ACCT1, chain, transport: http(RPC) });
const VAULT = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function navPerShare() view returns (uint256)', 'function depositCap() view returns (uint256)',
  'function keeper() view returns (address)', 'function owner() view returns (address)', 'function guardian() view returns (address)', 'function totalSupply() view returns (uint256)',
  'function depositsPaused() view returns (bool)', 'function setDepositCap(uint256)', 'function deposit(uint256,address) returns (uint256)',
]);
const USD = parseAbi(['function faucet()', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const NAV_UPDATED = parseAbiItem('event NavUpdated(uint256 navPerShare, uint256 indexLevel)');

// ------------------------------------------------------------------ report
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const subs = [...new Set([[OUT, '<out>'], [REPO, '.'], [os.tmpdir(), '<tmp>'], [os.homedir(), '~']].flatMap(([p, to]) => [[fs.realpathSync(p), to], [p, to]]).map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
subs.sort((a, b) => b[0].length - a[0].length); // the longest path first (OUT may sit inside the temporary folder)
const clean = (s) => subs.reduce((t, [a, b]) => t.split(a).join(b), String(s));
const report = [];
const runs = [];
const results = { steps: {} };
let failures = 0;
let checks = 0;
const say = (m) => {
  const c = clean(m);
  console.log(c);
  report.push(c);
};
const check = (label, cond, detail = '') => {
  checks++;
  if (!cond) failures++;
  say(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const logRun = (label, cmd, out, code, ms) => {
  const text = clean(`${cmd}\n${out.trimEnd()}\nexit ${code} (${(ms / 1000).toFixed(1)} s)`);
  fs.writeFileSync(path.join(OUT, `${label}.log`), text + '\n');
  runs.push(`--- ${label}\n${text}`);
};

function copyRepo(tag) {
  const dst = path.join(OUT, tag);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(REPO, dst, { recursive: true, filter: (src) => !/\/(\.git|node_modules)(\/|$)/.test(src) && !/\/keeper\/(dryrun|cache)(\/|$)/.test(src) });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dst, 'node_modules'));
  fs.mkdirSync(path.join(dst, 'keeper', 'dryrun'), { recursive: true });
  return dst;
}
/** A tool as a command, in a copy: cwd = the copy, environment PATH only. */
function node(root, tag, args, label) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args.map((a) => a.replace('{root}', root)), { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 100_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  logRun(label, `(${tag}) $ node ${args.map((a) => a.replace('{root}/', '')).join(' ')}`, out, r.status, Date.now() - t0);
  return { code: r.status, out };
}
/** The leg in process (the copy's own keeper/vol-index.mjs), with the runner's clock set and the given Binance fetch. */
const legModules = new Map();
async function leg(root, tag, clock, fetchImpl, label, { replay = false } = {}) {
  if (!legModules.has(root)) legModules.set(root, await import(pathToFileURL(path.join(root, 'keeper', 'vol-index.mjs')).href));
  const { run } = legModules.get(root);
  const legArgv = ['--line', 'realized', '--anchor', '--rpc', RPC, '--from', ACCT0];
  const lines = [];
  const t0 = Date.now();
  const code = await run(legArgv, {
    root, now: () => clock, env: {}, fetch: fetchImpl, pollingInterval: 100,
    ...(replay ? { wait: async () => {} } : {}), // recorded answers: no spacing between calls
    log: (m) => lines.push(String(m)), err: (m) => lines.push(`[stderr] ${m}`),
  });
  const out = lines.join('\n');
  logRun(label, `(${tag}, runner's clock ${new Date(clock).toISOString()}, Binance ${replay ? 'replayed' : 'live'}) node keeper/vol-index.mjs ${legArgv.join(' ')}   [in process: run(argv, {now, fetch})]`, out, code, Date.now() - t0);
  return { code, out };
}

// Binance: runs 1 and 2 read it and keep every answer; the other runs replay those answers.
const answers = new Map();
const binance = { live: 0, replayed: 0 };
const liveFetch = async (url, init) => {
  binance.live++;
  const r = await fetch(url, init);
  const body = Buffer.from(await r.arrayBuffer());
  if (r.status === 200) answers.set(String(url), body);
  return new Response(body, { status: r.status });
};
const replayFetch = (count = { n: 0 }) => async (url) => {
  count.n++;
  binance.replayed++;
  const body = answers.get(String(url));
  if (!body) return new Response(`rehearsal: no recorded answer for ${String(url).split('?')[0]}`, { status: 404 });
  return new Response(body, { status: 200 });
};

async function sendRaw(wallet, req) {
  const hash = await wallet.sendTransaction(req);
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`transaction reverted (${hash})`);
  return rc;
}
async function write(wallet, req) {
  const hash = await wallet.writeContract(req);
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${req.functionName} reverted (${hash})`);
  return rc;
}
const read = (address, functionName) => pc.readContract({ address, abi: VAULT, functionName });
const nonce = (a) => pc.getTransactionCount({ address: a });
/** The revert reason of a call that must revert ("no revert" when it does not). */
async function reason(fn) {
  try {
    await fn();
    return 'no revert';
  } catch (e) {
    return (/reason:\s*\n?([^\n]+)/.exec(e.shortMessage ?? '')?.[1] ?? /reverted: ([^\n]+)/.exec(`${e.details ?? ''}\n${e.message ?? ''}`)?.[1] ?? String(e.message).split('\n')[0]).trim();
  }
}
/** The part of a message from `start` up to and including `end` (on one line). */
const upTo = (text, start, end) => {
  const m = new RegExp(`${start}[^\\n]*?${end}`).exec(text);
  return m ? m[0] : text.split('\n').at(-1);
};
const navEvents = (address, fromBlock) => pc.getLogs({ address, event: NAV_UPDATED, fromBlock, toBlock: 'latest' });
/** Every NavUpdated within ±25% of the share price before it, starting from `start`. */
const withinBound = (events, start) => {
  let prev = start;
  for (const e of events) {
    const x = e.args.navPerShare;
    const d = (prev * 2500n) / 10000n;
    if (x < prev - d || x > prev + d) return false;
    prev = x;
  }
  return true;
};
/** A line's anchor on the fork: a zero-value self-send by the keeper, calldata qxpi-qvol:<line hash>, mined. */
async function anchorOnFork(a, line) {
  const tx = await pc.getTransaction({ hash: a.txHash });
  const rc = await pc.getTransactionReceipt({ hash: a.txHash });
  return { ok: a.headHash === line.hash && getAddress(tx.from) === ACCT0 && getAddress(tx.to) === ACCT0 && tx.value === 0n && tx.input === toHex(`qxpi-qvol:${line.hash}`) && rc.status === 'success', block: rc.blockNumber };
}
const timeless = (line) => {
  const { observedAt, late, keeper, hash, prevHash, shadow, inception, ...rest } = line;
  return { ...rest, source: { ...rest.source, fetchedAt: null } };
};

// ------------------------------------------------------------------ setup
const REAL = ['trackrecord/record-qvol.jsonl', 'trackrecord/anchors-qvol.jsonl', 'trackrecord/decisions.jsonl', 'keeper/marks-qvol.jsonl', 'keeper/leverage-vaults.json', 'keeper/rulebooks/qvol.json', 'keeper/dryrun/record-qvol.jsonl', 'keeper/dryrun/anchors-qvol.jsonl', 'keeper/dryrun/marks-qvol.jsonl', 'keeper/dryrun/leverage-vaults.json'];
const snapshotReal = () => Object.fromEntries(REAL.map((f) => [f, fs.existsSync(path.join(REPO, f)) ? sha(fs.readFileSync(path.join(REPO, f))) : null]));
const realBefore = snapshotReal();

for (const a of [ACCT0, ACCT1]) {
  const code = await pc.getCode({ address: a });
  if (code && code !== '0x') throw new Error(`${a} has code on the fork`);
  await pc.request({ method: 'anvil_setBalance', params: [a, '0x56bc75e2d63100000'] });
  await pc.request({ method: 'anvil_impersonateAccount', params: [a] });
}
const info = await pc.request({ method: 'anvil_nodeInfo' }).catch(() => null);
const forkNumber = info?.forkConfig?.forkBlockNumber != null ? BigInt(info.forkConfig.forkBlockNumber) : await pc.getBlockNumber();
const forkBlock = await pc.getBlock({ blockNumber: forkNumber });
const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).stdout.trim();
const FILES = ['keeper/vol-index.mjs', 'keeper/test/vol-index.test.mjs', 'docs/vol-index.md', 'scripts/verify.mjs', 'scripts/verify-vol.mjs', 'keeper/test/rehearse-qvol.mjs'];
results.setup = {
  startedAt: new Date(STARTED).toISOString(),
  rpc: RPC, client: await pc.request({ method: 'web3_clientVersion' }), chainId: await pc.getChainId(),
  forkBlock: { number: Number(forkNumber), hash: forkBlock.hash, time: new Date(Number(forkBlock.timestamp) * 1000).toISOString() },
  node: process.version, commit: git(['rev-parse', 'HEAD']), treeClean: git(['status', '--porcelain']) === '',
  keeper: ACCT0, guardian: ACCT1,
  files: Object.fromEntries(FILES.map((f) => [f, sha(fs.readFileSync(path.join(REPO, f)))])),
};
say(`qVOL fork rehearsal ${results.setup.startedAt} · rpc ${RPC} (${results.setup.client}) · chain id ${results.setup.chainId} · fork block ${results.setup.forkBlock.number} (${results.setup.forkBlock.hash}, ${results.setup.forkBlock.time})`);
say(`code ${results.setup.commit} (tree ${results.setup.treeClean ? 'clean' : 'NOT clean'}) · node ${process.version} · keeper/manager/owner ${ACCT0} · guardian/user ${ACCT1} (fresh, impersonated on the fork; no key)`);
for (const [f, h] of Object.entries(results.setup.files)) say(`sha256 ${h}  ${f}`);

// The stand-in inception decision: the rulebook JSON with three keys changed, its document, its anchor on the fork, its ledger line.
const rbBase = readJson(path.join(REPO, 'keeper', 'rulebooks', 'qvol.json'));
const RB = Buffer.from(JSON.stringify({ ...rbBase, status: 'REHEARSAL STAND-IN — written into a temporary copy for a fork rehearsal; not a decision', inception: { date: D1, decision: DECISION }, pendingOwner: [] }, null, 2) + '\n');
const RB_SHA = sha(RB);
const DOC = Buffer.from(
  [
    `# ${DECISION} — REHEARSAL STAND-IN, not a decision`,
    '',
    'Written by keeper/test/rehearse-qvol.mjs into a temporary copy of the record repository for a',
    'rehearsal of the qVOL realized line in force on a local fork of GIWA Sepolia. It is never committed,',
    'and its sha256 is anchored on that fork only.',
    '',
    `Pins keeper/rulebooks/qvol.json (the stand-in, inception.date ${D1}) sha256 ${RB_SHA}.`,
    '',
  ].join('\n')
);
const DOC_SHA = sha(DOC);
const decRc = await sendRaw(w0, { to: ACCT0, value: 0n, data: toHex(`qxdec:${DOC_SHA}`) });
const decBlock = await pc.getBlock({ blockNumber: decRc.blockNumber });
const LEDGER = { id: DECISION, file: `decisions/${DECISION}.md`, effectiveFrom: E, sha256: DOC_SHA, txHash: decRc.transactionHash, anchoredAt: new Date(Number(decBlock.timestamp) * 1000).toISOString() };
results.standIn = { decision: DECISION, rulebookSha256: RB_SHA, documentSha256: DOC_SHA, anchorTx: decRc.transactionHash, anchorBlock: Number(decRc.blockNumber), anchoredAt: LEDGER.anchoredAt };
say(`stand-in decision ${DECISION}: rulebook JSON sha256 ${RB_SHA} (keeper/rulebooks/qvol.json with status, inception {date ${D1}, decision ${DECISION}} and pendingOwner [] changed) · document sha256 ${DOC_SHA} · anchored on the fork in ${decRc.transactionHash} (block ${decRc.blockNumber}, ${LEDGER.anchoredAt}), calldata qxdec:<sha256>`);
/** Writes the stand-in into a copy: the rulebook JSON, the document, the ledger line (each optional). */
function standIn(root, { doc = true, ledger = true } = {}) {
  fs.writeFileSync(path.join(root, 'keeper', 'rulebooks', 'qvol.json'), RB);
  const docPath = path.join(root, 'trackrecord', 'decisions', `${DECISION}.md`);
  if (doc) fs.writeFileSync(docPath, DOC);
  else fs.rmSync(docPath, { force: true });
  const led = path.join(root, 'trackrecord', 'decisions.jsonl');
  const kept = fs.readFileSync(led, 'utf8').split('\n').filter((l) => l.trim() && JSON.parse(l).id !== DECISION);
  fs.writeFileSync(led, [...kept, ...(ledger ? [JSON.stringify(LEDGER)] : [])].join('\n') + '\n');
}

try {
  await main();
} catch (e) {
  failures++;
  say(`ABORT: ${e?.stack ?? e}`);
} finally {
  results.binance = binance;
  results.elapsedSeconds = Math.round((Date.now() - STARTED) / 1000);
  say(`\nBinance: ${binance.live} live call(s), ${binance.replayed} replayed · ${results.elapsedSeconds} s`);
  say(`${failures === 0 ? 'REHEARSAL PASSED' : `REHEARSAL FAILED — ${failures} check(s)`} — ${checks - failures}/${checks} checks · logs in ${OUT}`);
  fs.writeFileSync(path.join(OUT, 'rehearsal-summary.txt'), report.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'rehearsal-runs.txt'), runs.join('\n\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'rehearsal-transcript.txt'), `${report.join('\n')}\n\n== every run, in order (command, output, exit code)\n\n${runs.join('\n\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'rehearsal-results.json'), clean(JSON.stringify(results, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)) + '\n');
  process.exitCode = failures === 0 ? 0 : 1;
}

async function main() {
  // ------------------------------------------------------------------ 1 deploy the display vault
  const A = copyRepo('copy-a');
  let r = node(A, 'copy-a', ['{root}/keeper/deploy-mark-vault.mjs', '--index', 'qvol', '--manager', ACCT0, '--guardian', ACCT1, '--live', '--confirm', 'EXECUTE', '--rpc', RPC, '--from', ACCT0], '1-deploy-qvol');
  const regA = readJson(path.join(A, 'keeper', 'dryrun', 'leverage-vaults.json'));
  const vA = getAddress(regA.qvol.address);
  const deployLog = readJsonl(path.join(A, 'keeper', 'dryrun', 'mark-vaults.jsonl'));
  const deploySent = deployLog.find((l) => l.index === 'qvol' && l.what === 'deploy' && l.status === 'sent');
  check('1 deploy: keeper/deploy-mark-vault.mjs --index qvol (the mark-vault-setup target qvol) deploys and reads back the display vault, sets the guardian and writes the fork registry', r.code === 0 && /read back ok/.test(r.out) && /guardian 0x[0-9a-fA-F]{40} set/.test(r.out),
    `${vA} tx ${deploySent?.tx} block ${regA.qvol.block}`);
  const got = { name: await read(vA, 'name'), symbol: await read(vA, 'symbol'), depositCap: await read(vA, 'depositCap'), navPerShare: await read(vA, 'navPerShare'), keeper: getAddress(await read(vA, 'keeper')), owner: getAddress(await read(vA, 'owner')), guardian: getAddress(await read(vA, 'guardian')), totalSupply: await read(vA, 'totalSupply') };
  check('1 on the fork: name "Quadrix BTC Realized Volatility Vault", symbol qVOL (the rulebook ticker), deposit cap 0, share price 1.000000, keeper = owner = the keeper address, guardian = the second address, no shares',
    got.name === NAME && got.symbol === 'qVOL' && got.depositCap === 0n && got.navPerShare === 1_000_000n && got.keeper === ACCT0 && got.owner === ACCT0 && got.guardian === ACCT1 && got.totalSupply === 0n, JSON.stringify(got, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  check('1 fork registry entry qvol: the vault, chain 91342, mark method {"mode":"step"} kept from the committed entry', regA.qvol.chainId === 91342 && JSON.stringify(regA.qvol.gate) === '{"mode":"step"}' && regA.qvol.deployTx === deploySent?.tx, JSON.stringify(regA.qvol));
  const deployTx = deploySent ? await pc.getTransaction({ hash: deploySent.tx }) : null;
  const ctorArgs = encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }], [MOCK_USD, NAME, 'qVOL', 0n, ACCT0]);
  check('1 the creation input ends with the constructor arguments (usd, "Quadrix BTC Realized Volatility Vault", "qVOL", cap 0, manager)', !!deployTx && deployTx.input.endsWith(ctorArgs.slice(2)));
  results.steps.deploy = { vault: vA, tx: deploySent?.tx, block: regA.qvol.block };

  // ------------------------------------------------------------------ 2 run 1: the first line
  standIn(A);
  const recA = path.join(A, 'keeper', 'dryrun', 'record-qvol.jsonl');
  const ancA = path.join(A, 'keeper', 'dryrun', 'anchors-qvol.jsonl');
  const marksA = path.join(A, 'keeper', 'dryrun', 'marks-qvol.jsonl');
  const b1 = (await pc.getBlockNumber()) + 1n;
  let L = await leg(A, 'copy-a', T1, liveFetch, `2-run1-${D1}`);
  let lines = readJsonl(recA);
  const L0 = lines[0];
  if (!L0) throw new Error(`run 1 wrote no line (exit ${L.code}): ${L.out.split('\n').slice(-3).join(' | ')}`);
  check(`2 run 1 (${D1}T00:25Z): exit 0, one line ${D1} under keeper/dryrun/ — seq 0, inception {${DECISION}, the document's sha256}, no "shadow", no "late", the stand-in rulebook's sha256`,
    L.code === 0 && lines.length === 1 && L0.date === D1 && L0.seq === 0 && L0.inception?.decision === DECISION && L0.inception?.decisionSha256 === DOC_SHA && !('shadow' in L0) && !('late' in L0) && L0.rule.rulebookSha256 === RB_SHA,
    `value ${L0?.value} · variance ${L0?.variance} · source day ${L0?.source?.day} rows ${L0?.source?.rows} sha256 ${L0?.source?.sha256} · head ${L0?.hash}`);
  check('2 run 1: scripts/verify-vol.mjs recomputed the line before it was appended — agrees (the leg prints it)', new RegExp(`#0 ${D1} recomputed by scripts/verify-vol\\.mjs before it was appended — agrees`).test(L.out));
  r = node(A, 'copy-a', ['{root}/scripts/verify-vol.mjs', '--dir', '{root}/keeper/dryrun', '--line', 'realized', '--rulebook', '{root}/keeper/rulebooks/qvol.json'], '2-verify-vol');
  const vv = (() => {
    try {
      return JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    } catch {
      return null;
    }
  })();
  check('2 scripts/verify-vol.mjs on the written record, the rule against the stand-in rulebook JSON — exit 0', r.code === 0 && vv?.failures === 0 && vv?.report?.realized?.lines === 1 && vv?.rulebook?.realized === RB_SHA,
    `lines ${vv?.report?.realized?.lines}, failures ${vv?.failures}, largest relative difference ${vv?.maxRelativeDiff}`);
  let anchors = readJsonl(ancA);
  const an0 = anchors[0] ? await anchorOnFork(anchors[0], L0) : { ok: false };
  const n6a = BigInt(Math.floor(L0.value * 1e6));
  const ev1 = await navEvents(vA, b1);
  const marks1 = readJsonl(marksA);
  const nav1 = await read(vA, 'navPerShare');
  check(`2 run 1: anchored on the fork — a zero-value self-send by the keeper address, calldata qxpi-qvol:<line hash>, mined after the decision's anchor`, anchors.length === 1 && an0.ok && an0.block > decRc.blockNumber, `${anchors[0]?.txHash} (block ${an0.block})`);
  check(`2 run 1: marked after the anchor to n6 = floor(${L0.value} x 1e6) = ${n6a} — markSteps from 1.000000, every NavUpdated within ±25% of the price before it, indexLevel n6 in each, read back`,
    nav1 === n6a && marks1.length === markSteps(1_000_000n, n6a).length && marks1.every((m, k) => BigInt(m.nav) === markSteps(1_000_000n, n6a)[k] && m.indexLevel === Number(n6a) && m.seq === 0) && ev1.length === marks1.length && withinBound(ev1, 1_000_000n) && ev1.every((e) => e.args.indexLevel === n6a) && (ev1[0]?.blockNumber ?? 0n) > an0.block,
    `${marks1.length} setNav: ${marks1.map((m) => m.nav).join(' → ')}; txs ${marks1.map((m) => m.tx).join(' ')}`);
  results.steps.run1 = { exit: L.code, line: { date: L0.date, value: L0.value, variance: L0.variance, n6: n6a.toString(), hash: L0.hash, sourceSha256: L0.source?.sha256 }, anchor: anchors[0], marks: marks1 };

  // ------------------------------------------------------------------ 3 run 2, run 3, the dry run, verify.mjs
  const b2 = (await pc.getBlockNumber()) + 1n;
  L = await leg(A, 'copy-a', T2, liveFetch, `3a-run2-${D2}`);
  lines = readJsonl(recA);
  const L1 = lines[1];
  anchors = readJsonl(ancA);
  const an1 = anchors[1] ? await anchorOnFork(anchors[1], L1) : { ok: false };
  const n6b = BigInt(Math.floor((L1?.value ?? 0) * 1e6));
  const ev2 = await navEvents(vA, b2);
  const marks2 = readJsonl(marksA).filter((m) => m.seq === 1);
  check(`3 run 2 (${D2}T00:25Z): exit 0, line ${D2} (seq 1, chained to line 0, no inception, no "late"), recomputed — agrees, anchored on the fork after line 0's marks`,
    L.code === 0 && lines.length === 2 && L1.date === D2 && L1.seq === 1 && L1.prevHash === L0.hash && !('inception' in L1) && !('late' in L1) && new RegExp(`#1 ${D2} recomputed by scripts/verify-vol\\.mjs before it was appended — agrees`).test(L.out) && an1.ok && an1.block > (ev1.at(-1)?.blockNumber ?? 0n),
    `value ${L1?.value} · variance ${L1?.variance} · source day ${L1?.source?.day} rows ${L1?.source?.rows} sha256 ${L1?.source?.sha256} · anchor ${anchors[1]?.txHash} (block ${an1.block})`);
  check(`3 run 2: marked from ${n6a} to n6 = ${n6b} — markSteps, every NavUpdated within ±25%, after the anchor`,
    (await read(vA, 'navPerShare')) === n6b && marks2.length === markSteps(n6a, n6b).length && ev2.length === marks2.length && withinBound(ev2, n6a) && ev2.every((e) => e.args.indexLevel === n6b) && (ev2[0]?.blockNumber ?? 0n) > an1.block,
    `${marks2.length} setNav: ${marks2.map((m) => m.nav).join(' → ')} (${(((Number(n6b) / Number(n6a)) - 1) * 100).toFixed(2)}%); txs ${marks2.map((m) => m.tx).join(' ')}`);
  results.steps.run2 = { exit: L.code, line: { date: L1?.date, value: L1?.value, variance: L1?.variance, n6: n6b.toString(), hash: L1?.hash, sourceSha256: L1?.source?.sha256 }, anchor: anchors[1], marks: marks2 };
  const nonceBefore3 = await nonce(ACCT0);
  r = node(A, 'copy-a', ['{root}/keeper/vol-index.mjs', '--line', 'realized', '--anchor', '--rpc', RPC, '--from', ACCT0], '3b-run3-cli');
  check(`3 run 3, the command on the machine's clock: exit 0, nothing written (line ${addDay(D2)} not before its day), nothing sent (the vault already shows the last line)`,
    r.code === 0 && readJsonl(recA).length === 2 && (await nonce(ACCT0)) === nonceBefore3 && /no new line/.test(r.out) && /already there/.test(r.out), r.out.split('\n').filter((l) => /not written|already there/.test(l)).join(' · ').slice(0, 300));
  // a dry run of the same days from the same answers: the same values and fields
  const dryOut = path.join(OUT, 'dry-a');
  const { run: runA } = legModules.get(A);
  const dryLines = [];
  const dryCode = await runA(['--line', 'realized', '--dry-run', '--replay', `${D1}..${D2}`, '--out', dryOut], { root: A, now: () => T2, env: {}, fetch: replayFetch(), wait: async () => {}, log: (m) => dryLines.push(String(m)), err: (m) => dryLines.push(`[stderr] ${m}`) });
  logRun('3c-dry-run', `(copy-a, runner's clock ${new Date(T2).toISOString()}, Binance replayed) node keeper/vol-index.mjs --line realized --dry-run --replay ${D1}..${D2} --out <out>/dry-a   [in process]`, dryLines.join('\n'), dryCode, 0);
  const dry = readJsonl(path.join(dryOut, 'record-qvol.jsonl'));
  check('3 the two lines in force equal a dry run of the same days from the same bars (fields, order and values; the dry run adds "shadow" and no inception)',
    dryCode === 0 && dry.length === 2 && dry.every((d) => d.shadow === true && !('inception' in d)) && isDeepStrictEqual(lines.map(timeless), dry.map(timeless)) && lines.every((l, k) => l.value === dry[k].value && l.variance === dry[k].variance));
  // scripts/verify.mjs on the copy's record, with the RPC of the fork: the stand-in ledger and document beside it, the rulebook mirrored
  fs.writeFileSync(path.join(A, 'keeper', 'dryrun', 'decisions.jsonl'), JSON.stringify(LEDGER) + '\n');
  fs.mkdirSync(path.join(A, 'keeper', 'dryrun', 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(A, 'keeper', 'dryrun', 'decisions', `${DECISION}.md`), DOC);
  fs.writeFileSync(path.join(A, 'keeper', 'dryrun', 'rulebook-qvol.json'), RB);
  r = node(A, 'copy-a', ['{root}/scripts/verify.mjs', '--dir', '{root}/keeper/dryrun', '--series', 'qvol', '--rpc', RPC], '3d-verify');
  check('3 scripts/verify.mjs --series qvol on the fork: verify-vol.mjs recompute, the decision binding, both anchors and the decision\'s own anchor — 0 failures',
    r.code === 0 && /VERIFIED — 2 records, 2 anchors, 0 qX20 closes, 1 decisions, 0 failures/.test(r.out), r.out.split('\n').filter((l) => /VERIFIED|FAILED|FAIL /.test(l)).join(' ').slice(0, 200));

  // ------------------------------------------------------------------ 4 refusals, one run each
  // 4a a deposit cap above 0 (set by the owner on the fork: the tool refuses to raise a display vault's cap)
  const B = copyRepo('copy-b');
  r = node(B, 'copy-b', ['{root}/keeper/deploy-mark-vault.mjs', '--index', 'qvol', '--manager', ACCT0, '--guardian', ACCT1, '--live', '--confirm', 'EXECUTE', '--rpc', RPC, '--from', ACCT0], '4a-deploy-qvol-b');
  const vB = getAddress(readJson(path.join(B, 'keeper', 'dryrun', 'leverage-vaults.json')).qvol.address);
  const capRc = await write(w0, { address: vB, abi: VAULT, functionName: 'setDepositCap', args: [CAP] });
  standIn(B);
  const bStart = (await pc.getBlockNumber()) + 1n;
  const recB = path.join(B, 'keeper', 'dryrun', 'record-qvol.jsonl');
  const ancB = path.join(B, 'keeper', 'dryrun', 'anchors-qvol.jsonl');
  L = await leg(B, 'copy-b', T1, replayFetch(), '4a-cap-above-0', { replay: true });
  const linesB = readJsonl(recB);
  const ancBl = readJsonl(ancB);
  const anB = ancBl[0] && linesB[0] ? await anchorOnFork(ancBl[0], linesB[0]) : { ok: false };
  check(`4a deposit cap ${CAP} set by the owner (tx ${capRc.transactionHash}): the line is written, recomputed and anchored, no setNav is sent, exit 1`,
    r.code === 0 && L.code === 1 && /REFUSED: vault 0x[0-9a-fA-F]{40} has deposit cap 1000000000000, not 0 — a display vault takes no deposits; no mark sent/.test(L.out) && linesB.length === 1 && anB.ok && !fs.existsSync(path.join(B, 'keeper', 'dryrun', 'marks-qvol.jsonl')) && (await read(vB, 'navPerShare')) === 1_000_000n && (await navEvents(vB, bStart)).length === 0,
    upTo(L.out, 'qVOL vault marks FAILED', 'no mark sent'));
  check('4a the replayed bars give run 1\'s line byte for byte', linesB[0]?.hash === L0.hash && JSON.stringify(linesB[0]) === JSON.stringify(L0));
  await write(w0, { address: vB, abi: VAULT, functionName: 'setDepositCap', args: [0n] });
  L = await leg(B, 'copy-b', T1 + 15 * 60_000, replayFetch(), '4a-cap-back-at-0', { replay: true });
  check(`4a the cap back at 0: the next run (no new day) marks the anchored line — share price n6 = ${n6a}`, L.code === 0 && readJsonl(recB).length === 1 && (await read(vB, 'navPerShare')) === n6a);
  // 4b the decision: missing, not anchored, anchored but its document missing — no line, no Binance call, nothing sent
  const C = copyRepo('copy-c');
  const recC = path.join(C, 'keeper', 'dryrun', 'record-qvol.jsonl');
  for (const [label, setup, code, why] of [
    ['missing (the rulebook names it; no document, no ledger line)', { doc: false, ledger: false }, 0, new RegExp(`NOT IN FORCE: decision not anchored or does not pin this rulebook \\(${DECISION} is not in trackrecord/decisions\\.jsonl\\)`)],
    ['not anchored (its document, no ledger line)', { doc: true, ledger: false }, 0, new RegExp(`NOT IN FORCE: decision not anchored or does not pin this rulebook \\(${DECISION} is not in trackrecord/decisions\\.jsonl\\)`)],
    ['anchored (the ledger line) but its document missing', { doc: false, ledger: true }, 2, new RegExp(`the inception decision ${DECISION} is anchored, but decisions/${DECISION}\\.md missing — the series cannot start`)],
  ]) {
    standIn(C, setup);
    const n0 = await nonce(ACCT0);
    const count = { n: 0 };
    const slug = label.split(' ')[0].replace(/[^a-z]/g, '');
    L = await leg(C, 'copy-c', T1, replayFetch(count), `4b-decision-${slug === 'not' ? 'not-anchored' : slug === 'anchored' ? 'document-missing' : slug}`, { replay: true });
    check(`4b decision ${label}: exit ${code}, no line, no Binance call, nothing sent`, L.code === code && why.test(L.out) && !fs.existsSync(recC) && count.n === 0 && (await nonce(ACCT0)) === n0,
      upTo(L.out, 'qvol: ', code === 2 ? 'the series cannot start' : 'decisions\\.jsonl\\)'));
  }
  // 4c open-deposits on the display vault: refused before any request; the contract refuses a deposit at cap 0
  const nonceOpen = await nonce(ACCT0);
  r = node(A, 'copy-a', ['{root}/keeper/deploy-mark-vault.mjs', '--index', 'qvol', '--action', 'open-deposits', '--cap', String(CAP), '--live', '--confirm', 'EXECUTE', '--rpc', RPC, '--from', ACCT0], '4c-open-deposits');
  check('4c keeper/deploy-mark-vault.mjs --index qvol --action open-deposits: refused (exit 2) before any request, nothing sent, the cap still 0',
    r.code === 2 && /REFUSED: qvol is a display vault: it takes no deposits by definition \(deposit cap 0\)/.test(r.out) && (await nonce(ACCT0)) === nonceOpen && (await read(vA, 'depositCap')) === 0n, upTo(r.out, 'REFUSED: ', 'not this tool'));
  await write(w1, { address: MOCK_USD, abi: USD, functionName: 'faucet' });
  await write(w1, { address: MOCK_USD, abi: USD, functionName: 'approve', args: [vA, 1_000_000_000n] });
  const dep = await reason(() => pc.simulateContract({ account: ACCT1, address: vA, abi: VAULT, functionName: 'deposit', args: [1_000_000_000n, ACCT1] }));
  check('4c a deposit of 1,000 mUSD into the qVOL vault at cap 0 reverts "cap exceeded"; no shares exist', dep === 'cap exceeded' && (await read(vA, 'totalSupply')) === 0n, `revert reason "${dep}"`);
  // 4d the registry names a vault whose symbol is not qVOL (a qBTC2X vault deployed with the same tool, same keeper)
  const D = copyRepo('copy-d');
  r = node(D, 'copy-d', ['{root}/keeper/deploy-mark-vault.mjs', '--index', 'qbtc2x', '--manager', ACCT0, '--guardian', ACCT1, '--live', '--confirm', 'EXECUTE', '--rpc', RPC, '--from', ACCT0], '4d-deploy-qbtc2x');
  const regDPath = path.join(D, 'keeper', 'dryrun', 'leverage-vaults.json');
  const regD = readJson(regDPath);
  const vD = getAddress(regD.qbtc2x.address);
  regD.qvol = { ...regD.qvol, address: vD };
  fs.writeFileSync(regDPath, JSON.stringify(regD, null, 2) + '\n');
  standIn(D);
  const dStart = (await pc.getBlockNumber()) + 1n;
  L = await leg(D, 'copy-d', T1, replayFetch(), '4d-wrong-symbol', { replay: true });
  const linesD = readJsonl(path.join(D, 'keeper', 'dryrun', 'record-qvol.jsonl'));
  const ancD = readJsonl(path.join(D, 'keeper', 'dryrun', 'anchors-qvol.jsonl'));
  const anD = ancD[0] && linesD[0] ? await anchorOnFork(ancD[0], linesD[0]) : { ok: false };
  check(`4d the fork registry's qvol entry names the qBTC2X vault ${vD}: the line is written and anchored, no setNav is sent, exit 1`,
    r.code === 0 && (await read(vD, 'symbol')) === 'qBTC2X' && L.code === 1 && /is "qBTC2X", not qVOL — keeper\/dryrun\/leverage-vaults\.json names the wrong vault; no mark sent/.test(L.out) && linesD.length === 1 && anD.ok && (await read(vD, 'navPerShare')) === 1_000_000n && (await navEvents(vD, dStart)).length === 0,
    upTo(L.out, 'qVOL vault marks FAILED', 'no mark sent'));

  // ------------------------------------------------------------------ 5 the freshness watchdog on the copy's record
  const dirA = path.join(A, 'keeper', 'dryrun');
  const now = Date.now();
  let w = checkSeries({ dir: dirA, now, series: ['qvol'] });
  check(`5 watchdog, fresh (now, ${new Date(now).toISOString()}): no problem`, w.problems.length === 0 && w.summary[0] === `qvol 2 lines → ${D2}`, w.summary.join('; '));
  const day2 = Date.parse(`${D2}T00:00:00Z`);
  const w1559 = checkSeries({ dir: dirA, now: day2 + 40 * 3_600_000 - 60_000, series: ['qvol'] });
  w = checkSeries({ dir: dirA, now: day2 + 40 * 3_600_000 + 60_000, series: ['qvol'] });
  check(`5 watchdog, stale: nothing at ${new Date(day2 + 40 * 3_600_000 - 60_000).toISOString()}; at ${new Date(day2 + 40 * 3_600_000 + 60_000).toISOString()} "stale"`,
    w1559.problems.length === 0 && w.problems.length === 1 && new RegExp(`^qvol: stale — latest line is ${D2} \\(seq 1\\), 40\\.0h after that day began; the next line is overdue$`).test(w.problems[0]), w.problems.join('; '));
  const pend = path.join(OUT, 'watchdog-pending');
  fs.mkdirSync(pend, { recursive: true });
  fs.writeFileSync(path.join(pend, 'decisions.jsonl'), JSON.stringify(LEDGER) + '\n');
  const day1 = Date.parse(`${D1}T00:00:00Z`);
  const wp = checkSeries({ dir: pend, now: day1 + 16 * 3_600_000 - 60_000, series: ['qvol'] });
  w = checkSeries({ dir: pend, now: day1 + 16 * 3_600_000 + 60_000, series: ['qvol'] });
  check(`5 watchdog, the decision anchored and no record: "pending" until ${new Date(day1 + 16 * 3_600_000).toISOString()}, then "no record-qvol.jsonl"`,
    wp.problems.length === 0 && wp.summary[0] === `qvol pending (inception ${E}, first line ${D1})` && w.problems.length === 1 && new RegExp(`^qvol: no record-qvol\\.jsonl 16\\.0h after its first line's day ${D1} 00:00 UTC \\(decision ${DECISION}\\) — the daily job has not written the first line$`).test(w.problems[0]),
    w.problems.join('; '));

  // ------------------------------------------------------------------ the real repository
  const realAfter = snapshotReal();
  check('the real repository: trackrecord/record-qvol.jsonl, anchors-qvol.jsonl and decisions.jsonl, keeper/marks-qvol.jsonl, the registry, the rulebook JSON and keeper/dryrun/ unchanged',
    JSON.stringify(realAfter) === JSON.stringify(realBefore), Object.entries(realAfter).map(([f, h]) => `${f} ${h ? h.slice(0, 12) + '…' : 'absent'}`).join(', '));
}

function addDay(d) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
