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
 * Two series are published and both are verified by default: the DRY_RUN
 * rehearsal (record.jsonl / anchors.jsonl, 2026-08-13 → 08-30, closed) and the
 * LIVE series (record-live.jsonl / anchors-live.jsonl, genesis 2026-09-01, the
 * one with real capital behind it). They are separate chains on purpose —
 * spec §8 — so each is walked from its own genesis.
 *
 * Options:
 *   --base <url>     fetch <base>/trackrecord/… (the site's mirror)
 *   --dir <path>     read the files from a local directory
 *   --series <name>  dry | live | all   (default: all)
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
if (!['dry', 'live', 'all'].includes(SERIES)) {
  console.error(`--series must be dry, live or all (got ${SERIES})`);
  process.exit(2);
}

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
    if (attempt < 3) {
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
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
  dry: { label: 'DRY_RUN', records: 'record.jsonl', anchors: 'anchors.jsonl' },
  live: { label: 'LIVE', records: 'record-live.jsonl', anchors: 'anchors-live.jsonl' },
};
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
      ok(`#${rec.seq} ${rec.date} ${rec.mode} head ${hash.slice(0, 12)}…${rec.benchmarks?.missing ? ' (benchmarks recorded as missing)' : ''}`);
    }
    prevHash = rec.hash;

    // A record's decision list must match the ledger for that date, in both
    // directions: nothing dropped from the record, nothing added to it.
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
    const expected = '0x' + Buffer.from('qxtr:' + a.headHash, 'utf8').toString('hex');
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
      fail(`anchor seq ${a.seq}: calldata does not carry qxtr:${a.headHash.slice(0, 12)}…`);
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

for (const key of SERIES === 'all' ? ['dry', 'live'] : [SERIES]) await verifySeries(key);

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
    const tx = await rpc('eth_getTransactionByHash', [d.txHash]);
    const receipt = tx ? await rpc('eth_getTransactionReceipt', [d.txHash]) : null;
    if (!tx || !receipt || receipt.status !== '0x1') {
      fail(`decision ${d.id}: anchor tx ${d.txHash} missing or unconfirmed`);
      continue;
    }
    if ((tx.input || '').toLowerCase() !== expected.toLowerCase()) {
      fail(`decision ${d.id}: anchor calldata does not carry qxdec:${d.sha256.slice(0, 12)}…`);
      continue;
    }
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    const stamped = block ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : 'unknown time';
    ok(`${d.id} anchored ${stamped} in ${d.txHash.slice(0, 14)}… (effective ${d.effectiveFrom})`);
  }
}

console.log(
  failures === 0
    ? `\nVERIFIED — ${totals.records} records, ${totals.anchors} anchors, ${decisions.length} decisions, 0 failures\n   ${totals.series.join('\n   ')}\n`
    : `\nFAILED — ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
