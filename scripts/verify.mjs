#!/usr/bin/env node
/**
 * Independent track-record verifier — no dependencies, Node 18+.
 *
 * Verifies, without trusting Quadrix:
 *   1. every record's hash is the SHA-256 of its own contents (tamper check),
 *   2. every record embeds the previous record's hash (append-only chain),
 *   3. every anchored head hash exists on GIWA Sepolia as confirmed calldata
 *      (`qxtr:<hash>` in a transaction Quadrix cannot rewrite or backdate),
 *   4. every record has an anchor (a record without one has no checkable date)
 *      and every record's list of decisions in force matches the ledger,
 *   5. every anchored decision document still hashes to the value committed on
 *      chain (`qxdec:<hash>`) and that transaction is confirmed.
 *
 * GIWA Sepolia is a testnet. What the anchors prove is that Quadrix did not
 * rewrite or backdate a record; the proof lasts as long as that chain's history.
 *
 * Anyone can run it against the published data:
 *
 *   node verify.mjs --base https://quadrix.finance
 *
 * or against local files from the repo:
 *
 *   node verify.mjs --dir ./trackrecord
 *
 * By default every published series is verified, each walked from its own
 * genesis (separate chains on purpose — spec §8): the DRY_RUN rehearsal
 * (record.jsonl, 2026-08-13 → 08-30, closed), the LIVE series (record-live.jsonl,
 * genesis 2026-09-01), the five paper-index series (record-{qrev,qdefi,qai,
 * barbell,triens}.jsonl, anchor prefix `qxpi-<index>:`), and qX20's daily
 * closes (qx20-daily.jsonl). qX20 is not hash-chained: each close names the
 * keeper's setNav transaction, and the check is that the transaction exists,
 * succeeded, went to a qX20 vault, carries the stated level, and sits in the
 * stated block at the stated time. It does not prove the close was the day's
 * last mark — the vault's full transaction list on the explorer shows that.
 *
 * Options:
 *   --base <url>     fetch <base>/trackrecord/… (the site's mirror)
 *   --dir <path>     read the files from a local directory
 *   --series <name>  dry | live | qrev | qdefi | qai | barbell | triens | qx20 | all
 *                    (default: all). The paper indexes are keeper/paper-index.mjs's
 *                    rules-only levels: same hash-chain shape, anchor prefix
 *                    `qxpi-<index>:`, no `decisions` field.
 *   --rpc <url>      JSON-RPC endpoint (default: https://sepolia-rpc.giwa.io)
 *
 * The point of this file is that you can read all of it. If you don't trust
 * the copy served by the site, verify the same data with your own code —
 * the hashing is plain SHA-256 over each record line minus its `hash` field.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = opt('--base', null);
const DIR = opt('--dir', BASE ? null : './trackrecord');
const RPC = opt('--rpc', 'https://sepolia-rpc.giwa.io');
const SERIES = opt('--series', 'all');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function loadBytes(name) {
  if (BASE) {
    const url = `${BASE.replace(/\/$/, '')}/trackrecord/${name}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} -> HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fs.readFileSync(path.join(DIR, name));
}

async function loadLines(name) {
  let text;
  if (BASE) {
    const url = `${BASE.replace(/\/$/, '')}/trackrecord/${name}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} -> HTTP ${r.status}`);
    text = await r.text();
  } else {
    text = fs.readFileSync(path.join(DIR, name), 'utf8');
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// A public RPC will occasionally refuse a call; that is a network hiccup, not a
// failed verification, so retry briefly before giving up on that check.
async function rpc(method, params, attempt = 0) {
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) {
    // HTTP 429 is the public endpoint rate-limiting a full run: back off longer.
    if (attempt < 5) {
      const wait = /429/.test(e.message) ? 2000 * 2 ** attempt : 500 * (attempt + 1);
      await new Promise((res) => setTimeout(res, wait));
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${e.message} (after ${attempt + 1} attempts)`);
  }
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

// Optional: absent on a chain that has published no decisions yet.
let decisions = [];
try {
  decisions = await loadLines('decisions.jsonl');
} catch {
  decisions = [];
}

const SERIES_FILES = {
  dry: { label: 'DRY_RUN', records: 'record.jsonl', anchors: 'anchors.jsonl', anchorPrefix: 'qxtr:', checkDecisions: true },
  live: { label: 'LIVE', records: 'record-live.jsonl', anchors: 'anchors-live.jsonl', anchorPrefix: 'qxtr:', checkDecisions: true },
  // Paper-index series (qREV, qDEFI) — keeper/paper-index.mjs. Rules-only
  // levels, no vault, not in force until an inception decision is anchored.
  // They carry no `decisions` field (that ledger is scoped to the LIVE book)
  // and anchor under their own calldata prefix, `qxpi-<index>:`, distinct
  // from the operating record's `qxtr:` — same hash-chain shape otherwise,
  // so the generic per-record checks below need no series-specific code.
  qrev: { label: 'QREV', records: 'record-qrev.jsonl', anchors: 'anchors-qrev.jsonl', anchorPrefix: 'qxpi-qrev:', checkDecisions: false },
  qdefi: { label: 'QDEFI', records: 'record-qdefi.jsonl', anchors: 'anchors-qdefi.jsonl', anchorPrefix: 'qxpi-qdefi:', checkDecisions: false },
  qai: { label: 'QAI', records: 'record-qai.jsonl', anchors: 'anchors-qai.jsonl', anchorPrefix: 'qxpi-qai:', checkDecisions: false },
  barbell: { label: 'QDUO (barbell)', records: 'record-barbell.jsonl', anchors: 'anchors-barbell.jsonl', anchorPrefix: 'qxpi-barbell:', checkDecisions: false },
  triens: { label: 'QTRI (triens)', records: 'record-triens.jsonl', anchors: 'anchors-triens.jsonl', anchorPrefix: 'qxpi-triens:', checkDecisions: false },
};
const ALL = [...Object.keys(SERIES_FILES), 'qx20'];
if (SERIES !== 'all' && !ALL.includes(SERIES)) {
  console.error(`--series must be one of ${ALL.join(', ')} or all (got ${SERIES})`);
  process.exit(2);
}
const totals = { records: 0, anchors: 0, series: [] };

async function verifySeries(key) {
  const f = SERIES_FILES[key];
  let records, anchors;
  try {
    records = await loadLines(f.records);
    anchors = await loadLines(f.anchors);
  } catch (e) {
    fail(`${f.label}: series files unreadable (${e.message})`);
    return;
  }
  totals.records += records.length;
  totals.anchors += anchors.length;
  const first = records[0]?.date ?? '—';
  const last = records[records.length - 1]?.date ?? '—';
  totals.series.push(`${f.label} ${records.length} records ${first} → ${last}`);

  console.log(`\n[${f.label}] chain — ${records.length} record(s), ${f.records}`);
  let prevHash = null;
  for (const rec of records) {
    const { hash, ...rest } = rec;
    const computed = sha256(JSON.stringify(rest));
    if (computed !== hash) {
      fail(`#${rec.seq} ${rec.date}: stored hash ${hash.slice(0, 12)}… != computed ${computed.slice(0, 12)}…`);
    } else if (rec.prevHash !== prevHash) {
      fail(`#${rec.seq} ${rec.date}: prevHash does not match record #${rec.seq - 1} (chain break)`);
    } else {
      // rec.mode (DRY_RUN/LIVE) is the operating-record label; paper-index
      // records instead carry rec.index (QREV/QDEFI) and rec.level — either
      // is printed, whichever the record shape has.
      ok(`#${rec.seq} ${rec.date} ${rec.mode ?? rec.index} head ${hash.slice(0, 12)}…${rec.benchmarks?.missing ? ' (benchmarks recorded as missing)' : ''}`);
    }
    prevHash = rec.hash;

    // A record's decision list must match the ledger for that date, in both
    // directions: nothing dropped from the record, nothing added to it.
    // Paper-index series (qREV/qDEFI) carry no `decisions` field at all —
    // that ledger is scoped to the LIVE operating record — so this check is
    // skipped for them (f.checkDecisions === false), not run-and-ignored.
    if (f.checkDecisions) {
      const expected = decisions
        .filter((d) => d.effectiveFrom <= rec.date)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      const carried = rec.decisions ?? [];
      if (carried.length !== expected.length) {
        fail(`#${rec.seq} ${rec.date}: carries ${carried.length} decision(s), ledger says ${expected.length}`);
      } else {
        for (let i = 0; i < expected.length; i++) {
          if (carried[i].id !== expected[i].id || carried[i].sha256 !== expected[i].sha256) {
            fail(`#${rec.seq} ${rec.date}: decision ${carried[i].id} does not match the ledger`);
          }
        }
      }
    }
  }

  console.log(`\n[${f.label}] anchors — ${anchors.length} on-chain commitment(s) via ${RPC}`);
  for (const a of anchors) {
    const rec = records.find((r) => r.seq === a.seq);
    if (!rec) {
      fail(`anchor seq ${a.seq}: no matching record`);
      continue;
    }
    if (rec.hash !== a.headHash) {
      fail(`anchor seq ${a.seq}: headHash does not match record hash`);
      continue;
    }
    const expected = '0x' + Buffer.from(f.anchorPrefix + a.headHash, 'utf8').toString('hex');
    let tx;
    try {
      tx = await rpc('eth_getTransactionByHash', [a.txHash]);
    } catch (e) {
      fail(`anchor seq ${a.seq}: rpc unavailable — ${e.message}`);
      continue;
    }
    if (!tx) {
      fail(`anchor seq ${a.seq}: tx ${a.txHash} not found on chain`);
      continue;
    }
    const receipt = await rpc('eth_getTransactionReceipt', [a.txHash]);
    if (!receipt || receipt.status !== '0x1') {
      fail(`anchor seq ${a.seq}: tx ${a.txHash} not confirmed`);
      continue;
    }
    if ((tx.input || '').toLowerCase() !== expected.toLowerCase()) {
      fail(`anchor seq ${a.seq}: calldata does not carry ${f.anchorPrefix}${a.headHash.slice(0, 12)}…`);
      continue;
    }
    ok(`seq ${a.seq} ${a.date} anchored in ${a.txHash.slice(0, 14)}… (block ${parseInt(receipt.blockNumber, 16)})`);
  }
  // Every record must have exactly one anchor — a record without one is a
  // claim nobody can check the date of.
  for (const rec of records) {
    if (!anchors.some((a) => a.seq === rec.seq)) fail(`#${rec.seq} ${rec.date}: no anchor for this record`);
  }
}

// qX20: the keeper's setNav(uint256 navPerShare, uint256 indexLevel) marks,
// one close per UTC day. The two vaults are the published qX20 contracts
// (docs §10); a close that points anywhere else fails.
const QX20_VAULTS = ['0x1d1115b961832dd921be78cf1362a531b69bcaa0', '0x2a165501dda6e430ff98e82682f53ca8465bb21f'];
const SETNAV = '0xec75710f';
async function verifyQx20() {
  let closes;
  try {
    // The site serves it under /trackrecord/; the repo keeps it under keeper/.
    closes = BASE || fs.existsSync(path.join(DIR, 'qx20-daily.jsonl'))
      ? await loadLines('qx20-daily.jsonl')
      : (await fs.promises.readFile(path.join(DIR, '..', 'keeper', 'qx20-daily.jsonl'), 'utf8'))
          .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (e) {
    fail(`QX20: qx20-daily.jsonl unreadable (${e.message})`);
    return;
  }
  totals.marks = closes.length;
  totals.series.push(`QX20 ${closes.length} daily closes ${closes[0]?.date ?? '—'} → ${closes[closes.length - 1]?.date ?? '—'}`);
  console.log(`\n[QX20] daily closes — ${closes.length}, each a setNav transaction on GIWA Sepolia`);
  let prevDate = '';
  for (const c of closes) {
    if (c.date <= prevDate) fail(`QX20 ${c.date}: out of order or repeated after ${prevDate}`);
    prevDate = c.date;
    let tx, receipt, block;
    try {
      tx = await rpc('eth_getTransactionByHash', [c.tx]);
      receipt = tx ? await rpc('eth_getTransactionReceipt', [c.tx]) : null;
      block = receipt ? await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
    } catch (e) {
      fail(`QX20 ${c.date}: rpc unavailable — ${e.message}`);
      continue;
    }
    if (!tx || !receipt || receipt.status !== '0x1' || !block) {
      fail(`QX20 ${c.date}: tx ${c.tx} missing or not confirmed`);
      continue;
    }
    const to = (tx.to || '').toLowerCase();
    const input = (tx.input || '').toLowerCase();
    const nav = Number(BigInt('0x' + input.slice(10, 74))) / 1e6;
    const level = Number(BigInt('0x' + input.slice(74, 138))) / 1e6;
    const at = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
    if (!QX20_VAULTS.includes(to) || to !== String(c.vault).toLowerCase()) fail(`QX20 ${c.date}: tx goes to ${to}, not the qX20 vault named`);
    else if (!input.startsWith(SETNAV)) fail(`QX20 ${c.date}: tx is not a setNav call`);
    else if (nav !== c.nav || level !== c.level) fail(`QX20 ${c.date}: chain says nav ${nav} level ${level}, file says ${c.nav} / ${c.level}`);
    else if (parseInt(receipt.blockNumber, 16) !== c.block || at !== c.at || at.slice(0, 10) !== c.date) fail(`QX20 ${c.date}: block/time on chain (${parseInt(receipt.blockNumber, 16)}, ${at}) differ from the file`);
    else ok(`${c.date} level ${c.level} — setNav in ${c.tx.slice(0, 14)}… (block ${c.block}, ${at})`);
  }
}

for (const key of SERIES === 'all' ? ALL : [SERIES]) {
  if (key === 'qx20') await verifyQx20();
  else await verifySeries(key);
}

if (decisions.length) {
  console.log(`\ndecisions — ${decisions.length} anchored document(s)`);
  for (const d of decisions) {
    let bytes;
    try {
      bytes = await loadBytes(d.file);
    } catch (e) {
      fail(`decision ${d.id}: document unreadable (${e.message})`);
      continue;
    }
    const computed = sha256(bytes);
    if (computed !== d.sha256) {
      fail(`decision ${d.id}: document hashes ${computed.slice(0, 12)}…, ledger says ${d.sha256.slice(0, 12)}… (edited since anchoring)`);
      continue;
    }
    const expected = '0x' + Buffer.from('qxdec:' + d.sha256, 'utf8').toString('hex');
    let tx, receipt, block;
    try {
      tx = await rpc('eth_getTransactionByHash', [d.txHash]);
      receipt = tx ? await rpc('eth_getTransactionReceipt', [d.txHash]) : null;
      block = receipt ? await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
    } catch (e) {
      fail(`decision ${d.id}: rpc unavailable — ${e.message}`);
      continue;
    }
    if (!tx || !receipt || receipt.status !== '0x1') {
      fail(`decision ${d.id}: anchor tx ${d.txHash} missing or unconfirmed`);
      continue;
    }
    if ((tx.input || '').toLowerCase() !== expected.toLowerCase()) {
      fail(`decision ${d.id}: anchor calldata does not carry qxdec:${d.sha256.slice(0, 12)}…`);
      continue;
    }
    const stamped = block ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : 'unknown time';
    ok(`${d.id} anchored ${stamped} in ${d.txHash.slice(0, 14)}… (effective ${d.effectiveFrom})`);
  }
}

console.log(
  failures === 0
    ? `\nVERIFIED — ${totals.records} records, ${totals.anchors} anchors, ${totals.marks ?? 0} qX20 closes, ${decisions.length} decisions, 0 failures\n   ${totals.series.join('\n   ')}\n`
    : `\nFAILED — ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
