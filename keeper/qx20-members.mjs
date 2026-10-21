/**
 * qX20 members at a mark — the model book the keeper posted, as symbol, weight
 * and price.
 *
 * keeper/update-nav.mjs writes them on each line of keeper/nav-marks.jsonl
 * (from 2026-10-22): the units held after the mark, at the prices that mark
 * used. scripts/qx20-marks-from-chain.mjs copies them onto the day's line of
 * keeper/qx20-daily.jsonl when the day's close is a mark the ledger carries
 * (same transaction hash). Closes the ledger has no members for — every close
 * before 2026-10-22, and any mark not in the ledger — are written exactly as
 * before, without the two fields.
 *
 *   weight = units × price ÷ Σ(units × price) over the members with a price,
 *   rounded to 4 decimals. A held member without a price is listed with
 *   weight null and price null: the keeper left it out of the valuation
 *   (RUNBOOK failure mode 6).
 */

export function bookMembers(units, prices) {
  const rows = Object.entries(units ?? {}).map(([symbol, u]) => {
    const price = prices?.[symbol];
    return price > 0 && u > 0 ? { symbol, value: u * price, price } : { symbol, value: null, price: null };
  });
  const total = rows.reduce((t, r) => t + (r.value ?? 0), 0);
  return rows
    .map((r) => ({ symbol: r.symbol, weight: r.value == null || !(total > 0) ? null : Number((r.value / total).toFixed(4)), price: r.price }))
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1) || a.symbol.localeCompare(b.symbol));
}

/**
 * marks: [{date, ts, vault, block, tx, nav, level}] read from chain.
 * ledger: the parsed lines of keeper/nav-marks.jsonl.
 * Returns the lines of keeper/qx20-daily.jsonl, one per UTC day (the day's
 * last mark), in the field order the file has always had, with members and
 * priceSource appended only when the ledger line of that close carries members.
 */
export function dailyCloses(marks, ledger = []) {
  const sorted = [...marks].sort((a, b) => a.ts - b.ts);
  const byTx = new Map();
  for (const l of ledger) if (l?.txHash && Array.isArray(l.members)) byTx.set(l.txHash.toLowerCase(), l);
  const byDay = new Map();
  for (const m of sorted) byDay.set(m.date, m); // last mark of the day wins
  return [...byDay.values()].map((m) => {
    const line = {
      date: m.date,
      nav: m.nav,
      level: m.level,
      marks_that_day: sorted.filter((x) => x.date === m.date).length,
      vault: m.vault,
      block: m.block,
      tx: m.tx,
      at: new Date(m.ts * 1000).toISOString(),
    };
    const l = byTx.get(String(m.tx).toLowerCase());
    if (l) {
      line.members = l.members;
      line.priceSource = l.priceSource;
    }
    return line;
  });
}
