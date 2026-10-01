/**
 * Synthetic inputs for keeper/test/plan-trades.test.mjs (computeTrades). No
 * tests here: the file is imported by the test, and was imported once by the
 * script that recorded what computeTrades on main (6036647, before the block
 * rule) returns for the regression cases — those outputs are pinned in the
 * test as literals.
 *
 * Every row is { symbol, address, decimals, balance (bigint base units),
 * ref (bigint USD × 1e18 per base unit), targetWeight, isAdd, isRemove,
 * inRemoval, sleeve }. A token's value is balance × ref / 1e18 USD.
 */
export const E18 = 10n ** 18n;

/** A token priced at `usd` per whole token with `decimals`, holding `value`
 *  USD (whole dollars, so balance × ref is exact). */
export function tok(symbol, { usd = 1, decimals = 6, value = 0, target = 0, isAdd = false, isRemove = false, inRemoval = false, sleeve } = {}) {
  // ref = usd × 1e18 / 10^decimals, exact for the integers used here
  const ref = (BigInt(Math.round(usd * 1e6)) * E18) / (10n ** BigInt(decimals) * 1_000_000n);
  const balance = ref > 0n ? (BigInt(Math.round(value * 1e6)) * E18) / (ref * 1_000_000n) : 0n;
  const address = `0x${Buffer.from(symbol.padEnd(20, '_')).toString('hex').slice(0, 40)}`;
  return { symbol, address, decimals, balance, ref, targetWeight: target, isAdd, isRemove, inRemoval, ...(sleeve ? { sleeve } : {}) };
}

export const RANKED = { tolerancePoints: 5, capMaxWeight: 0.6, qualityCap: null, sleeve: false, duration: 1800, minTradeUsd: 1, fill: 'fair' };
export const SLEEVE = { tolerancePoints: 5, capMaxWeight: null, qualityCap: 0.35, sleeve: true, duration: 1800, minTradeUsd: 1, fill: 'fair' };

export const cases = {
  // 1 / 5 — the qTRI defect: a new Quality name, zero balance, no other mark.
  // Sleeves on target (30/40/30); inside Quality the three held names are
  // 1.3 pt from their in-sleeve targets (inside the 5-point tolerance) and
  // under the 35% cap.
  newNameAlone: () => ({
    policy: SLEEVE,
    rows: [
      tok('BTC', { usd: 100_000, decimals: 14, value: 300_000, target: 0.30, sleeve: 'monetary' }),
      tok('WC', { usd: 1, decimals: 9, value: 400_000, target: 0.40, sleeve: 'workingCapital' }),
      tok('Q1', { usd: 25, decimals: 10, value: 100_000, target: 0.096, sleeve: 'quality' }),
      tok('Q2', { usd: 3, decimals: 9, value: 100_000, target: 0.096, sleeve: 'quality' }),
      tok('Q3', { usd: 0.4, decimals: 8, value: 100_000, target: 0.096, sleeve: 'quality' }),
      tok('NEW', { usd: 0.5, decimals: 8, value: 0, target: 0.012, isAdd: true, sleeve: 'quality' }),
    ],
  }),
  // 2 — a ranked basket with one add.
  rankedAdd: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 500_000, target: 0.45 }),
      tok('B', { usd: 50, decimals: 10, value: 300_000, target: 0.27 }),
      tok('C', { usd: 0.2, decimals: 8, value: 200_000, target: 0.18 }),
      tok('D', { usd: 7, decimals: 9, value: 0, target: 0.10, isAdd: true }),
    ],
  }),
  // 3 — add + removal, the removal split over two buys.
  rankedAddRemove: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 300_000, target: 0.45 }),
      tok('B', { usd: 50, decimals: 10, value: 300_000, target: 0.25 }),
      tok('X', { usd: 0.03, decimals: 7, value: 400_000, target: 0, isRemove: true }),
      tok('D', { usd: 7, decimals: 9, value: 0, target: 0.30, isAdd: true }),
    ],
  }),
  // 6 — a sleeve reset (BTC 10 points over): every name, as before.
  sleeveReset: () => ({
    policy: SLEEVE,
    rows: [
      tok('BTC', { usd: 100_000, decimals: 14, value: 400_000, target: 0.30, sleeve: 'monetary' }),
      tok('WC', { usd: 1, decimals: 9, value: 300_000, target: 0.40, sleeve: 'workingCapital' }),
      tok('Q1', { usd: 25, decimals: 10, value: 150_000, target: 0.16, sleeve: 'quality' }),
      tok('Q2', { usd: 3, decimals: 9, value: 150_000, target: 0.14, sleeve: 'quality' }),
    ],
  }),
  // 7 — the vault already equals the book.
  unchanged: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 500_000, target: 0.5 }),
      tok('B', { usd: 50, decimals: 10, value: 500_000, target: 0.5 }),
    ],
  }),
  // 8 — only an earlier session's removal remnant, flagged on chain.
  remnantOnly: (remnantUsd = 0.5) => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 500_000, target: 0.5 }),
      tok('B', { usd: 50, decimals: 10, value: 500_000, target: 0.5 }),
      tok('X', { usd: 0.25, decimals: 6, value: remnantUsd, target: 0, isRemove: true, inRemoval: true }),
    ],
  }),
  // 9 — nothing marked (2 points of drift).
  smallDrift: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 520_000, target: 0.5 }),
      tok('B', { usd: 50, decimals: 10, value: 480_000, target: 0.5 }),
    ],
  }),
  // 10 — no registry change; A 8 points over, C 10 points under, B 2 over.
  ruleMarkOnly: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 580_000, target: 0.50 }),
      tok('B', { usd: 50, decimals: 10, value: 270_000, target: 0.25 }),
      tok('C', { usd: 0.2, decimals: 8, value: 150_000, target: 0.25 }),
    ],
  }),
  // 10b — the vault matches a book that has itself drifted above the 60%
  // cap (qX20 BTC on 2026-10-01: book 60.07%).
  bookAboveCap: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 610_000, target: 0.61 }),
      tok('B', { usd: 50, decimals: 10, value: 390_000, target: 0.39 }),
    ],
  }),
  // 10c — the vault above the cap while the book is not.
  vaultAboveCap: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 620_000, target: 0.58 }),
      tok('B', { usd: 50, decimals: 10, value: 190_000, target: 0.21 }),
      tok('C', { usd: 1, decimals: 6, value: 190_000, target: 0.21 }),
    ],
  }),
  // 11 — decimals 0 and 18, odd amounts, an add.
  rounding: () => ({
    policy: RANKED,
    rows: [
      tok('Z0', { usd: 1234.5, decimals: 0, value: 370_350, target: 0.3317 }),
      tok('E18', { usd: 1, decimals: 18, value: 333_333, target: 0.2501 }),
      tok('M', { usd: 0.0731, decimals: 9, value: 296_317, target: 0.3001 }),
      tok('N', { usd: 3.3, decimals: 18, value: 0, target: 0.1181, isAdd: true }),
    ],
  }),
  // 13 — a block worth nothing.
  emptyBlock: () => ({
    policy: RANKED,
    rows: [
      tok('A', { usd: 2000, decimals: 12, value: 0, target: 0.5 }),
      tok('D', { usd: 7, decimals: 9, value: 0, target: 0.5, isAdd: true }),
    ],
  }),
  // …and a Quality sleeve worth nothing, no sleeve reset (3 points short).
  emptySleeve: () => ({
    policy: SLEEVE,
    rows: [
      tok('BTC', { usd: 100_000, decimals: 14, value: 300_000, target: 0.30, sleeve: 'monetary' }),
      tok('WC', { usd: 1, decimals: 9, value: 700_000, target: 0.67, sleeve: 'workingCapital' }),
      tok('NEW', { usd: 0.5, decimals: 8, value: 0, target: 0.03, isAdd: true, sleeve: 'quality' }),
    ],
  }),
};

/** The saved plans of 2026-10-01 as rows (bigints restored). */
export function savedRows(fx) {
  return fx.rows.map((r) => ({ ...r, balance: BigInt(r.balance), ref: BigInt(r.ref) }));
}

/** Balances after every trade fills at `factorBps` (10,000 = fair), the
 *  contract's arithmetic (buyPay rounded up). */
export function applyFills(rows, trades, factorBps = 10_000n) {
  const bal = Object.fromEntries(rows.map((r) => [r.symbol, r.balance]));
  const ref = Object.fromEntries(rows.map((r) => [r.symbol, r.ref]));
  for (const t of trades) {
    const s = BigInt(t.sellAmount);
    bal[t.sell] -= s;
    const num = s * ref[t.sell] * factorBps;
    const den = ref[t.buy] * 10_000n;
    bal[t.buy] += (num + den - 1n) / den;
  }
  return rows.map((r) => ({ ...r, balance: bal[r.symbol] }));
}

export const sig = (trades) => trades.map((t) => [t.sell, t.buy, String(t.sellAmount), !!t.drain]);
