#!/usr/bin/env node
/**
 * Independent track-record verifier — no dependencies, Node 18+.
 *
 * Verifies, without trusting Quadrix:
 *   1. every record's hash is the SHA-256 of its own contents (tamper check),
 *   2. every record embeds the previous record's hash (append-only chain),
 *   3. every anchored head hash exists on GIWA Sepolia as confirmed calldata
 *      (`qxtr:<hash>` in a transaction Quadrix cannot rewrite or backdate).
 *
 * Anyone can run it against the published data:
 *
 *   node verify.mjs --base https://quadrix.finance
 *
 * or against local files from the repo:
 *
 *   node verify.mjs --dir ./trackrecord
 *
 * Options:
 *   --base <url>   fetch <base>/trackrecord/{record,anchors}.jsonl
 *   --dir <path>   read record.jsonl / anchors.jsonl from a local directory
 *   --rpc <url>    JSON-RPC endpoint (default: https://sepolia-rpc.giwa.io)
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

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

const records = await loadLines('record.jsonl');
const anchors = await loadLines('anchors.jsonl');
// Optional: absent on a chain that has published no decisions yet.
let decisions = [];
try {
  decisions = await loadLines('decisions.jsonl');
} catch {
  decisions = [];
}

console.log(`\nchain — ${records.length} record(s)`);
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

console.log(`\nanchors — ${anchors.length} on-chain commitment(s) via ${RPC}`);
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
  const tx = await rpc('eth_getTransactionByHash', [a.txHash]);
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
    ? `\nVERIFIED — ${records.length} records, ${anchors.length} anchors, ${decisions.length} decisions, 0 failures\n`
    : `\nFAILED — ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
