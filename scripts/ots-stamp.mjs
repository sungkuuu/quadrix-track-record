/**
 * Second, chain-independent time proof for every anchored hash.
 *
 * Every record head hash and decision hash is anchored on GIWA Sepolia — a
 * testnet, whose history has no guarantee of surviving. This stamps the same
 * hashes with OpenTimestamps (Bitcoin calendar servers, free), so "this hash
 * existed by this time" survives even if the testnet is reset.
 *
 *   node scripts/ots-stamp.mjs            stamp anything not yet stamped
 *   node scripts/ots-stamp.mjs --upgrade  fold Bitcoin attestations into pending proofs
 *   node scripts/ots-stamp.mjs --verify   report attestation status per proof
 *
 * Proofs live in trackrecord/ots/<name>.ots, one per hash, append-only like the
 * rest of trackrecord/. A pending proof becomes a Bitcoin-attested proof after
 * the calendar aggregates it (typically hours); --upgrade rewrites it in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import OpenTimestamps from 'opentimestamps';

const { DetachedTimestampFile, Ops } = OpenTimestamps;
const DIR = 'trackrecord';
const OTS = path.join(DIR, 'ots');
fs.mkdirSync(OTS, { recursive: true });
const mode = process.argv.includes('--upgrade') ? 'upgrade' : process.argv.includes('--verify') ? 'verify' : 'stamp';
const lines = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const targets = [];
for (const [series, file] of [['dry', 'record.jsonl'], ['live', 'record-live.jsonl']]) {
  for (const r of lines(path.join(DIR, file))) targets.push({ name: `${series}-${String(r.seq).padStart(4, '0')}-${r.date}`, hash: r.hash });
}
for (const d of lines(path.join(DIR, 'decisions.jsonl'))) targets.push({ name: `decision-${d.id}`, hash: d.sha256 });

let stamped = 0, upgraded = 0, pending = 0, attested = 0;
for (const t of targets) {
  const file = path.join(OTS, `${t.name}.ots`);
  if (mode === 'stamp') {
    if (fs.existsSync(file)) continue;
    const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), Buffer.from(t.hash, 'hex'));
    await OpenTimestamps.stamp(detached);
    fs.writeFileSync(file, Buffer.from(detached.serializeToBytes()));
    stamped++;
    console.log(`stamped  ${t.name}`);
    continue;
  }
  if (!fs.existsSync(file)) { console.log(`missing  ${t.name}`); continue; }
  const detached = DetachedTimestampFile.deserialize(fs.readFileSync(file));
  if (mode === 'upgrade') {
    const changed = await OpenTimestamps.upgrade(detached).catch(() => false);
    if (changed) { fs.writeFileSync(file, Buffer.from(detached.serializeToBytes())); upgraded++; console.log(`upgraded ${t.name}`); }
  }
  const bitcoin = detached.timestamp.allAttestations().size &&
    [...detached.timestamp.allAttestations().values()].some((a) => a.constructor.name === 'BitcoinBlockHeaderAttestation');
  if (bitcoin) attested++; else pending++;
  if (mode === 'verify') console.log(`${bitcoin ? 'bitcoin ' : 'pending '} ${t.name}`);
}
console.log(`\n${targets.length} hashes · stamped ${stamped} · upgraded ${upgraded} · bitcoin-attested ${attested} · pending ${pending}`);
