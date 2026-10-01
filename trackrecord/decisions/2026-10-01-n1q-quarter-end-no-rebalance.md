# N1Q — no rebalance at the 2026-09-30 quarter end, decided 2026-10-01

**Decided:** 2026-10-01 (UTC), the day after the quarter end. **Effective:**
2026-10-01 — the ledger's `effectiveFrom` is the date in the filename; nothing
in the book changes on that date or because of this document. **Applies to:**
the 2026-09-30 quarter end only. **Series:** `trackrecord/record-live.jsonl`.

## What this records

The rule in force since 2026-09-01 (`2026-09-01-rebalancing-band-removed`) is
that the book is rebalanced to target at quarter ends and at no other time.

At the 2026-09-30 quarter end the book was not rebalanced. On 2026-10-01 the
manager decided to leave it that way. This document records that departure
from the rule and the reason for the decision. It was decided and written the
day after the quarter end, not before it.

## The book at the quarter end

From the live record, seq 29 (date 2026-09-30, observed 2026-10-01T05:48:10Z):
balances as read on chain at the observation time, priced at the 2026-09-30
daily closes. Each weight is the record's value for the sleeve (`valueUSDT`,
or `cashUSDT` for working capital) divided by `aumUSDT`, rounded to two
decimals. Targets are those of `2026-08-21-n1dv-allocation`.

| Sleeve | Target | Held | Difference |
| --- | --- | --- | --- |
| Working capital (held as USDC) | 30% | 27.44% | −2.56 pp |
| BTC (held as WBTC) | 25% | 24.31% | −0.69 pp |
| ETH (held as WETH) | 20% | 19.85% | −0.15 pp |
| HYPE | 15% | 14.63% | −0.37 pp |
| PENDLE | 5% | 6.08% | +1.08 pp |
| AERO | 5% | 7.67% | +2.67 pp |

Quantities and the cash balance are identical in records seq 28 (date
2026-09-29) and seq 29 (date 2026-09-30); the weights differ between the two
only through prices.

## The decision

The book is left as it stands. The differences from target are small — the
largest is 2.67 percentage points — and the manager chooses to keep the current
positions rather than trade them back to target.

## What does not change

| Item | Status |
| --- | --- |
| Target weights | as set on 2026-08-21 |
| Quarter-end rule | stays; the next rebalance to target is at the 2026-12-31 quarter end |
| Drift band | none, as since 2026-09-01 |

## What this is not

It is not a rule change, and it is not a tested choice. No backtest stands behind
skipping this rebalance; it is a judgement, recorded when made.

N1Q is a managed vault. What it holds and at what weight is the manager's
judgement, recorded by dated decision. The rebalancing calendar is a published
rule, so departing from it once takes a document like this one.

The simulation published on the site is a model of the rule, not of the book:
it resets the simulated book to target on every quarter-end date, with no
exception for 2026-09-30. The live record shows the book as it was held.

## Verifying

From the root of the record repository:

```
node -e '
const rows = require("fs").readFileSync("trackrecord/record-live.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const r of rows.filter((r) => r.seq === 28 || r.seq === 29)) {
  const pct = (v) => (100 * v / r.aumUSDT).toFixed(2) + "%";
  console.log("seq", r.seq, r.date, r.observedAt);
  console.log("  cash", r.book.cashUSDT, pct(r.book.cashUSDT));
  for (const p of r.book.positions) console.log("  " + p.symbol, p.qty, pct(p.valueUSDT));
}'
shasum -a 256 trackrecord/decisions/2026-10-01-n1q-quarter-end-no-rebalance.md
```

The first command selects the two records by `seq`, not by their position in
the file, and prints each quantity and weight. Compare the document hash
against the anchor transaction this file's entry in /trackrecord/decisions.jsonl
names. The daily record carries the same hash from the record dated 2026-10-01
onward.
