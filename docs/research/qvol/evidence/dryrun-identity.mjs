/**
 * The dry run of keeper/vol-index.mjs against its registered version. The
 * registered file (from the commit named below) and this tree's file each run
 * in a scratch root that holds the same registered compute files, on the same
 * synthetic bars and the same clock, in four cases: an offline replay; a
 * record continued on the same --out; a replay against a fake Binance REST;
 * an append to an existing record. The record bytes and every printed line
 * must be the same in each case.
 *
 * The rulebook JSON (keeper/rulebooks/qvol.json): every line carries its
 * sha256, and the inception commit changes four of its keys (status, asOf,
 * inception, pendingOwner) that the dry run does not use. Both roots
 * therefore hold the registered rulebook bytes, and the script checks
 * separately that this tree's rulebook differs from the registered one in
 * those four keys only. Every other file the dry run reads must be
 * byte-identical in the two roots.
 *
 *   node docs/research/qvol/evidence/dryrun-identity.mjs [<registered commit>]   # default b8769aa
 *
 * Needs this repository's git history (git show <commit>:<file>). Synthetic
 * data only (keeper/test/vol-helpers.mjs); no network, no key, nothing written
 * outside a temporary folder that is removed afterwards. Exit 1 on a difference.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REG = process.argv[2] ?? 'b8769aa';
const H = await import(pathToFileURL(path.join(REPO, 'keeper', 'test', 'vol-helpers.mjs')).href);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** What a realized dry run reads: the CLI, the compute modules, the rulebooks, the gap file, the verifier it runs. */
const FILES = ['keeper/vol-index.mjs', 'keeper/vol-realized.mjs', 'keeper/vol-sources.mjs', 'keeper/vol-implied.mjs', 'keeper/vol-index-gaps.json', 'keeper/rulebooks/qvol.json', 'keeper/rulebooks/volbtc-implied.json', 'scripts/verify-vol.mjs'];
const RULEBOOK = 'keeper/rulebooks/qvol.json';
const INCEPTION_KEYS = ['status', 'asOf', 'inception', 'pendingOwner'];
const regRb = JSON.parse(execFileSync('git', ['-C', REPO, 'show', `${REG}:${RULEBOOK}`]).toString('utf8'));
const treeRb = JSON.parse(fs.readFileSync(path.join(REPO, RULEBOOK), 'utf8'));
const rbKeys = [...new Set([...Object.keys(regRb), ...Object.keys(treeRb)])].filter((k) => JSON.stringify(regRb[k]) !== JSON.stringify(treeRb[k]));
const rbOk = rbKeys.every((k) => INCEPTION_KEYS.includes(k));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qvol-identity-'));
function root(tag, fromCommit) {
  const r = path.join(base, tag);
  // this tree's CLI also imports keeper/leverage-step.mjs (the mark steps of the line in force)
  for (const f of [...FILES, ...(fromCommit ? [] : ['keeper/leverage-step.mjs'])]) {
    const registered = fromCommit || f === RULEBOOK;
    const bytes = registered ? execFileSync('git', ['-C', REPO, 'show', `${REG}:${f}`]) : fs.readFileSync(path.join(REPO, f));
    fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
    fs.writeFileSync(path.join(r, f), bytes);
  }
  return r;
}
const A = root('registered', true);
const B = root('tree', false);
const runA = (await import(pathToFileURL(path.join(A, 'keeper', 'vol-index.mjs')).href)).run;
const runB = (await import(pathToFileURL(path.join(B, 'keeper', 'vol-index.mjs')).href)).run;
const sameOthers = FILES.slice(1).every((f) => fs.readFileSync(path.join(A, f)).equals(fs.readFileSync(path.join(B, f))));

const { days } = H.syntheticDays('2099-01-01', 45); // closes for 2098-12-31 … 2099-02-14
const offline = path.join(base, 'offline');
H.writeOffline(offline, days);
const NOW = Date.parse('2099-02-20T00:25:00Z');
const quiet = { log: () => {}, err: () => {} };
const deps = (r, extra = {}) => ({ root: r, now: () => NOW, env: {}, wait: async () => {}, ...extra });

/** One case for both versions: prepare --out, run, compare the record bytes and the printed lines. */
async function both(label, argv, extra = () => ({}), prep = async () => {}) {
  const res = [];
  for (const [tag, run, r] of [['registered', runA, A], ['tree', runB, B]]) {
    const out = path.join(base, `${label}-${tag}`);
    await prep(out, run, r);
    const printed = [];
    const code = await run(argv(out), deps(r, { log: (m) => printed.push(`log ${m}`), err: (m) => printed.push(`err ${m}`), ...extra() }));
    const rec = path.join(out, 'record-qvol.jsonl');
    res.push({ code, bytes: fs.existsSync(rec) ? fs.readFileSync(rec) : Buffer.alloc(0), printed: printed.join('\n').split(out).join('<out>') });
  }
  const [a, b] = res;
  const n = a.bytes.toString('utf8').split('\n').filter(Boolean).length;
  const ok = a.code === b.code && a.bytes.equals(b.bytes) && a.printed === b.printed && n > 0;
  console.log(`${ok ? 'SAME' : 'DIFF'}  ${label}: exit ${a.code} / ${b.code} · ${n} line(s) · record sha256 ${sha(a.bytes)} / ${sha(b.bytes)} · printed lines ${a.printed === b.printed ? 'equal' : 'differ'} (${a.printed.split('\n').length})`);
  if (!ok) console.log(`registered:\n${a.printed}\ntree:\n${b.printed}`);
  return ok;
}

let all = true;
// 1 an offline replay of ten days
all &&= await both('1-offline-replay', (out) => ['--line', 'realized', '--dry-run', '--replay', '2099-02-01..2099-02-10', '--offline', offline, '--out', out]);
// 2 a record continued: each version first writes 02-01 … 02-05, then the same --out runs to 02-12
all &&= await both('2-continued', (out) => ['--line', 'realized', '--dry-run', '--replay', '2099-02-01..2099-02-12', '--offline', offline, '--out', out], () => ({}), async (out, run, r) => {
  await run(['--line', 'realized', '--dry-run', '--replay', '2099-02-01..2099-02-05', '--offline', offline, '--out', out], deps(r, quiet));
});
// 3 a replay against a fake Binance REST
all &&= await both('3-rest-fake-binance', (out) => ['--line', 'realized', '--dry-run', '--replay', '2099-02-01..2099-02-10', '--out', out], () => ({ fetch: H.fakeBinance(days, Date.parse('2099-02-15T00:30:00Z')).fetch }));
// 4 an existing record (written by the registered version, 02-01 … 02-05) appended to over REST until the source says the day is open
const seed = path.join(base, 'seed');
await runA(['--line', 'realized', '--dry-run', '--replay', '2099-02-01..2099-02-05', '--offline', offline, '--out', seed], deps(A, quiet));
all &&= await both('4-append-existing', (out) => ['--line', 'realized', '--dry-run', '--out', out], () => ({ fetch: H.fakeBinance(days, Date.parse('2099-02-11T00:30:00Z')).fetch }), async (out) => {
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(seed, 'record-qvol.jsonl'), path.join(out, 'record-qvol.jsonl'));
});
console.log(`keeper/vol-index.mjs registered (${REG}) sha256 ${sha(fs.readFileSync(path.join(A, 'keeper', 'vol-index.mjs')))}`);
console.log(`keeper/vol-index.mjs this tree          sha256 ${sha(fs.readFileSync(path.join(B, 'keeper', 'vol-index.mjs')))}`);
console.log(`the other ${FILES.length - 1} files the dry run reads: ${sameOthers ? 'byte-identical in the two roots (the rulebook JSON: the registered bytes in both)' : 'DIFFERENT'}`);
console.log(`${RULEBOOK} in this tree differs from the registered one in: ${rbKeys.length ? rbKeys.join(', ') : 'nothing'} — ${rbOk ? 'only keys the dry run does not use' : 'A KEY THE DRY RUN USES'}`);
const ok = all && sameOthers && rbOk;
console.log(ok ? 'DRY RUN UNCHANGED — byte-identical records and printed lines in all four cases' : 'DRY RUN CHANGED');
fs.rmSync(base, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
