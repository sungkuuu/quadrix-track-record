// qETH1.5X P19 (deposit cap, exposure limit) — usual cost: how close did the deposits of the two testnet vaults with
// the same cap come to it? For the qX20 tracking vault and the qBTC2X mark vault (GIWA Sepolia, chainId 91342) this
// replays every event of the vault from its creation block to a pinned block and rebuilds the deposit-cap measure the
// contract itself uses — totalAssets() = totalSupply() × navPerShare / 1e6 (QuadrixIndexVault.sol) — after every
// event, then reports its largest value against the cap in force at that moment. The replayed end state is checked
// against eth_call reads at the pinned block (supply, price, cap, totalAssets must be equal).
// The starting state (cap, price, pause) is read by eth_call at the creation block — the constructor sets the cap
// without an event. Logs: the explorer's Etherscan-compatible API (module=logs&action=getLogs), read in pages of
// block ranges. Cross-check: every transaction sent to the vault (module=account&action=txlist), tallied by function.
// Usage: node docs/research/leverage/eth-1p5/evidence/p19-usual-cost.mjs <pinned block>
const RPC = 'https://sepolia-rpc.giwa.io';
const API = 'https://sepolia-explorer.giwa.io/api';
const VAULTS = [
  { name: 'qX20 tracking vault', address: '0x2A165501ddA6e430fF98E82682f53CA8465Bb21f', created: 36015792 },
  { name: 'qBTC2X mark vault', address: '0x7C10C33aEd202207Bb0C054B32C0708ABAC54070', created: 38422951 },
];
const T = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  deposit: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
  withdraw: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',
  nav: '0x1e1223c1f6274c6d64fdb08c485e192bd2896c9abf70e840e199ac1f54d6d1d5',
  cap: '0x333b26cca69716ad4680ddb07663f5bfb4f06045671f336af9a83690a3ae00f9',
  paused: '0x5ef34f53269a04b5b817e5be24a51ba6b477118b399ec9dd5b2baf5b299563dc',
};
const ZERO = '0x' + '0'.repeat(64);
const PIN = Number(process.argv[2]);
if (!Number.isInteger(PIN)) throw new Error('usage: p19-usual-cost.mjs <pinned block>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let a = 0; a < 8; a++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json().catch(() => null);
    if (j && j.result !== undefined) return j.result;
    await sleep(1500 * (a + 1));
  }
  throw new Error(`${method} failed`);
}
const call = async (to, sig, block) => BigInt(await rpc('eth_call', [{ to, data: sig }, '0x' + block.toString(16)]));
const SEL = { totalSupply: '0x18160ddd', navPerShare: '0xae097223', depositCap: '0xdbd5edc7', totalAssets: '0x01e1d114' };
const FN = { '0x6e553f65': 'deposit', '0x7bde82f2': 'redeem', '0xec75710f': 'setNav', '0x86651203': 'setDepositCap', '0x1c481e2d': 'setDepositsPaused', '0x748747e6': 'setKeeper', '0xf2fde38b': 'transferOwnership' };
async function txlist(address) {
  for (let a = 0; a < 8; a++) {
    const r = await fetch(`${API}?module=account&action=txlist&address=${address}&sort=asc&page=1&offset=10000`);
    const j = await r.json().catch(() => null);
    if (j && Array.isArray(j.result)) return j.result;
    await sleep(1500 * (a + 1));
  }
  throw new Error('explorer txlist failed');
}

async function logs(address, from, to) {
  const out = [];
  let lo = from;
  while (lo <= to) {
    let j = null;
    for (let a = 0; a < 8 && !j; a++) {
      const r = await fetch(`${API}?module=logs&action=getLogs&address=${address}&fromBlock=${lo}&toBlock=${to}`);
      j = await r.json().catch(() => null);
      if (!j || (j.status !== '1' && j.message !== 'No logs found')) { j = null; await sleep(1500 * (a + 1)); }
    }
    if (!j) throw new Error('explorer getLogs failed');
    const page = Array.isArray(j.result) ? j.result : [];
    if (page.length === 0) break;
    const seen = new Set(out.map((l) => `${l.transactionHash}:${l.logIndex}`));
    for (const l of page) if (!seen.has(`${l.transactionHash}:${l.logIndex}`)) out.push(l);
    if (page.length < 1000) break;
    const last = Math.max(...page.map((l) => parseInt(l.blockNumber, 16)));
    if (last === lo) throw new Error(`more than 1000 logs in block ${lo}`);
    lo = last; // re-read the last block; duplicates are dropped above
  }
  return out.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
}

const usd = (x) => (Number(x) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
const ts = async (block) => new Date(parseInt((await rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false])).timestamp, 16) * 1000).toISOString();

console.log(`pinned block ${PIN} (${await ts(PIN)})`);
for (const v of VAULTS) {
  const L = await logs(v.address, v.created, PIN);
  let supply = await call(v.address, SEL.totalSupply, v.created), nav = await call(v.address, SEL.navPerShare, v.created);
  let cap = await call(v.address, SEL.depositCap, v.created), paused = (await call(v.address, '0x60da3e83', v.created)) !== 0n;
  const start = { supply, nav, cap, paused };
  let max = { ta: -1n }, maxRatio = { r: -1 }, deposits = 0, withdraws = 0, navs = 0, caps = [], pausedEv = [], counts = {}, other = 0;
  const depositors = new Set();
  for (const l of L) {
    const t0 = l.topics[0], b = parseInt(l.blockNumber, 16);
    counts[t0] = (counts[t0] ?? 0) + 1;
    if (t0 === T.transfer) {
      const amt = BigInt(l.data);
      if (l.topics[1] === ZERO) supply += amt;
      if (l.topics[2] === ZERO) supply -= amt;
    } else if (t0 === T.nav) { nav = BigInt('0x' + l.data.slice(2, 66)); navs++; }
    else if (t0 === T.cap) { cap = BigInt(l.data); caps.push({ block: b, cap }); }
    else if (t0 === T.paused) { paused = BigInt(l.data) !== 0n; pausedEv.push({ block: b, paused }); }
    else if (t0 === T.deposit) { deposits++; depositors.add(l.topics[2]); }
    else if (t0 === T.withdraw) withdraws++;
    else other++;
    const ta = (supply * nav) / 1_000_000n;
    if (ta > max.ta) max = { ta, block: b, tx: l.transactionHash, supply, nav, cap };
    if (cap > 0n) { const r = Number(ta) / Number(cap); if (r > maxRatio.r) maxRatio = { r, block: b, ta, cap }; }
  }
  const read = {};
  for (const [k, s] of Object.entries(SEL)) { read[k] = await call(v.address, s, PIN); await sleep(300); }
  const replay = { totalSupply: supply, navPerShare: nav, depositCap: cap, totalAssets: (supply * nav) / 1_000_000n };
  const agree = Object.keys(SEL).every((k) => read[k] === replay[k]);
  console.log(`\n== ${v.name} ${v.address} — created block ${v.created}; logs to block ${PIN}: ${L.length}`);
  console.log(`events: Deposit ${deposits} (receivers ${depositors.size}) · Withdraw ${withdraws} · NavUpdated ${navs} · DepositCapUpdated ${caps.length} · DepositsPaused ${pausedEv.length} · Transfer ${counts[T.transfer] ?? 0}`);
  console.log(`other events (ownership and the like): ${other}`);
  console.log(`state at the creation block (eth_call): supply ${usd(start.supply)} · navPerShare ${usd(start.nav)} · cap ${usd(start.cap)} · paused ${start.paused}`);
  const TX = await txlist(v.address);
  const tally = {}; for (const x of TX) { const k = x.to && x.to.toLowerCase() === v.address.toLowerCase() ? (FN[x.input.slice(0, 10)] ?? x.input.slice(0, 10)) + (x.isError === '1' ? ' (failed)' : '') : 'creation'; tally[k] = (tally[k] ?? 0) + 1; }
  console.log(`transactions sent to the vault (explorer txlist, ${TX.length}): ${JSON.stringify(tally)}`);
  console.log(`cap history: ${caps.map((c) => `block ${c.block} → ${usd(c.cap)}`).join(' · ') || 'none'}`);
  console.log(`pause history: ${pausedEv.map((p) => `block ${p.block} → ${p.paused}`).join(' · ') || 'none'}`);
  console.log(`replayed end state: supply ${usd(supply)} · navPerShare ${usd(nav)} · cap ${usd(cap)} · totalAssets ${usd(replay.totalAssets)} · paused ${paused}`);
  console.log(`eth_call at ${PIN}: supply ${usd(read.totalSupply)} · navPerShare ${usd(read.navPerShare)} · cap ${usd(read.depositCap)} · totalAssets ${usd(read.totalAssets)} — ${agree ? 'EQUAL to the replay' : 'DIFFERS from the replay'}`);
  if (max.ta >= 0n) console.log(`largest totalAssets: ${usd(max.ta)} test dollars at block ${max.block} (${await ts(max.block)}, tx ${max.tx}); supply ${usd(max.supply)} × price ${usd(max.nav)}; cap then ${usd(max.cap)} → ${max.cap > 0n ? ((Number(max.ta) / Number(max.cap)) * 100).toFixed(4) + '% of the cap' : 'cap 0'}`);
  if (maxRatio.r >= 0) console.log(`largest totalAssets ÷ cap in force: ${(maxRatio.r * 100).toFixed(4)}% at block ${maxRatio.block} (${usd(maxRatio.ta)} of ${usd(maxRatio.cap)})`);
}
