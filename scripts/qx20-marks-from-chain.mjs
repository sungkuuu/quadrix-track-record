// qX20 keeper marks, read back from GIWA Sepolia — every setNav(uint256,uint256)
// transaction the keeper sent to the index vaults, decoded, and reduced to one
// close per UTC day (the day's last mark). This is the qX20 record: the level
// the keeper posted from the public methodology, on chain, since 2026-07-21.
//   node scripts/qx20-marks-from-chain.mjs   → keeper/qx20-daily.jsonl (rewritten, sorted)
// Source: the explorer's transaction list for each vault (Blockscout API); no key.
import fs from 'node:fs';
const VAULTS = [
  '0x1d1115b961832dd921be78cf1362a531b69bcaa0', // 2026-07-21 → 2026-09-14 (superseded; marks stay on chain)
  '0x2A165501ddA6e430fF98E82682f53CA8465Bb21f', // 2026-09-14 → (current)
];
const SETNAV = '0xec75710f'; // setNav(uint256 newNavPerShare, uint256 indexLevel)
const EXPLORER = 'https://sepolia-explorer.giwa.io/api';
const marks = [];
for (const vault of VAULTS) {
  let page = 1;
  for (;;) {
    const url = `${EXPLORER}?module=account&action=txlist&address=${vault}&sort=asc&page=${page}&offset=1000`;
    const res = await fetch(url, { headers: { 'user-agent': 'quadrix-record/1.0' } });
    const body = await res.json();
    const rows = Array.isArray(body.result) ? body.result : [];
    for (const t of rows) {
      if (t.isError !== '0' || !t.input.startsWith(SETNAV) || t.to.toLowerCase() !== vault.toLowerCase()) continue;
      const nav = Number(BigInt('0x' + t.input.slice(10, 74))) / 1e6;
      const level = Number(BigInt('0x' + t.input.slice(74, 138))) / 1e6;
      const ts = Number(t.timeStamp);
      marks.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), ts, vault: vault.toLowerCase(), block: Number(t.blockNumber), tx: t.hash, nav, level });
    }
    if (rows.length < 1000) break;
    page += 1;
  }
}
marks.sort((a, b) => a.ts - b.ts);
const byDay = new Map();
for (const m of marks) byDay.set(m.date, m); // last mark of the day wins
const lines = [...byDay.values()].map((m) => JSON.stringify({ date: m.date, nav: m.nav, level: m.level, marks_that_day: marks.filter((x) => x.date === m.date).length, vault: m.vault, block: m.block, tx: m.tx, at: new Date(m.ts * 1000).toISOString() }));
fs.writeFileSync('keeper/qx20-daily.jsonl', lines.join('\n') + '\n');
console.log(`${marks.length} marks on chain → ${lines.length} daily closes, ${lines[0] ? JSON.parse(lines[0]).date : '—'} → ${lines.length ? JSON.parse(lines[lines.length - 1]).date : '—'}`);
