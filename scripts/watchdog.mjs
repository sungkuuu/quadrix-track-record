/**
 * Watchdog for the things that fail silently.
 *
 * The daily record and the qX20 keeper run on schedules that GitHub delays by
 * hours; a run that never starts raises no failure. This checks the *outputs*:
 *
 *   1. the LIVE record is not stale (latest record landed within 30h of the
 *      close of the day it covers),
 *   2. every LIVE record has an anchor with a txHash,
 *   3. the keeper has posted a NAV mark within 12h,
 *   4. the anchoring account still holds gas.
 *
 * Exit 1 with a report on stdout when anything trips; the workflow turns that
 * into an issue. `--simulate <check>` trips one check on purpose so the alert
 * path itself can be tested — an untested alarm is not an alarm.
 */
import fs from 'node:fs';

const RPC = 'https://sepolia-rpc.giwa.io';
const simulate = process.argv.includes('--simulate') ? process.argv[process.argv.indexOf('--simulate') + 1] : null;
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const problems = [];
const now = Date.now();
const H = 3600 * 1000;

// 1. record freshness
const records = lines('trackrecord/record-live.jsonl');
const last = records[records.length - 1];
const closeOfDay = Date.parse(last.date + 'T00:00:00Z') + 24 * H;
const ageH = (now - closeOfDay) / H;
if (ageH > 30 || simulate === 'stale') problems.push(`record stale: latest is ${last.date} (seq ${last.seq}), ${ageH.toFixed(1)}h after that day closed — the next record is overdue`);

// 2. anchor coverage
const anchors = lines('trackrecord/anchors-live.jsonl');
for (const r of records) {
  const a = anchors.find((x) => x.seq === r.seq);
  if (!a || !/^0x[0-9a-f]{64}$/i.test(a.txHash || '') || simulate === 'anchor') { problems.push(`record seq ${r.seq} (${r.date}) has no anchor txHash`); if (simulate === 'anchor') break; }
}

// 3. keeper liveness
const marks = lines('keeper/nav-marks.jsonl');
const lastMark = marks[marks.length - 1];
const markAgeH = (now - Date.parse(lastMark.postedAt)) / H;
if (markAgeH > 12 || simulate === 'keeper') problems.push(`keeper silent: last NAV mark ${lastMark.postedAt} (${markAgeH.toFixed(1)}h ago)`);

// 4. gas on the anchoring account (read from the last anchor tx — nothing hardcoded)
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
try {
  const tx = await rpc('eth_getTransactionByHash', [anchors[anchors.length - 1].txHash]);
  const bal = Number(BigInt(await rpc('eth_getBalance', [tx.from, 'latest']))) / 1e18;
  if (bal < 0.001 || simulate === 'gas') problems.push(`anchoring account ${tx.from.slice(0, 10)}… holds ${bal.toFixed(6)} ETH — below the 0.001 floor`);
} catch (e) {
  problems.push(`could not read anchoring account balance: ${e.message}`);
}

console.log(`checked ${records.length} records, ${anchors.length} anchors, last mark ${lastMark.postedAt}`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length})${simulate ? ' — simulated: ' + simulate : ''}`);
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log('all clear');
