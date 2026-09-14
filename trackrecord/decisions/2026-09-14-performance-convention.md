# Performance figures — one convention, computed once, 2026-09-14

**Effective:** 2026-09-14 (UTC).

## What changed

Until today the site computed its simulated performance figures in the visitor's
browser, from a price table that was refreshed on each visit. Two visitors could
see two numbers for the same statistic, and the two charts used different date
conventions for the BTC and ETH reference lines (one labelled by open, one by
close). Both are corrected in one change:

1. **One convention.** UTC daily closes only; a value dated D is the close of D;
   completed days only; cumulative return = close(end) / close(start) − 1 over one
   shared window that starts 2026-02-01. Rule id `utc-close-to-close/v1`,
   source file `src/engine/benchmarkConvention.ts`.
2. **Computed once.** The figures are produced at build time from committed
   inputs and published as `src/data/performance.generated.json` with an
   `asOf` date and the SHA-256 of every input. Pages read that file. The same
   inputs produce the same bytes.
3. **Inception aligned with the stated methodology.** The N1Q simulation now
   starts at target weights on the 2026-02-01 close. The previous browser model
   rolled a book forward from September 2025 and carried January's drift into the
   window, which the methodology never described.

## What moved

| Figure (to the 2026-09-13 close) | Before | After |
| --- | --- | --- |
| N1Q simulated cumulative return since 2026-02-01 | +23.6% | +22.2% |
| BTC reference, fixed window 2026-02-01 → 2026-09-03 (N1Q chart) | −1.72% | +5.68% |
| BTC reference, same window (qX20 chart, Binance) | +5.59% | +5.59% |
| Outperformance vs BTC shown on the home page | varied by visitor | +22.3 pp, as-of labelled |

These are simulations, gross of fees and costs. The live N1Q record is unaffected:
it is a hash-chained per-share series read from the chain, not a model.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| github.com/sungkuuu/quadrix | `dd5fcf1933a040c93654ad4e90fa41e45d0ed254` |

The convention file, the build script (`scripts/build-performance.mjs`) and the
generated JSON at that commit are what the site now serves.
