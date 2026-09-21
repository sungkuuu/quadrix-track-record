# qREV — fifteen names from the 2026-10-01 reconstitution, decided 2026-09-21

**Decided:** 2026-09-21 (owner). **Effective:** at the first reconstitution on or after 2026-10-01 — the scheduled
quarterly run, the next one on the calendar. **Series:** `trackrecord/record-qrev.jsonl`, unchanged until that run.
The ledger's `effectiveFrom` for this file is 2026-09-21, the date the decision was made and written; the parameter
it changes takes effect on 2026-10-01, and the record between the two dates is the ten-name rule as anchored on 2026-09-16.

## What changes

| Parameter | Until the 2026-10-01 reconstitution | From it |
| --- | --- | --- |
| Names held (`ranking.targetCount`) | 10 | **15** |
| Rank buffer — enter at or above / stay while at or above | 8 / 13 | **12 / 19** |

The buffer is the rulebook's rule scaled to the new count with the backtest's own rounding — enter at floor(0.85 N),
stay while at or above ceil(1.25 N) (`qrev-backtest.py` `in_buf` / `out_buf`): 8.5 → 8 and 12.5 → 13 at ten names,
12.75 → 12 and 18.75 → 19 at fifteen. Rounding the entry line to 13 instead would be a different rule from the one
tested (turnover 8–17 points higher, 2024→ 2.47× instead of 2.61×), so 12 it is.

Nothing else moves: circulating market-cap floor **$150M** (kept; the grid's best-scoring row was fifteen names at
$300M and the owner did not take it), $10M volume floor, holder revenue ≥ $1M and positive for six consecutive
months, listing age 365 days, value-trap 25%, net-burn rule for chain tokens, P/HR ranking cheapest first, weighting by
holder revenue net of issuance with the 2% floor, 35% cap cut at every reconstitution, quarterly cadence, two-quarter
exit hysteresis, 5-point tolerance with the cap override, the special-event rule, the protocol map and the supply
registry. The thresholds written for ten names — "fewer than ten eligible and the index is not made" (rulebook §12-1)
and the intra-quarter reconstitution below eight (§9) — are not changed by this decision; whether they should follow
the count is an open item.

## Why — the numbers behind it

Basis: the point-in-time parameter grid published on 2026-09-21 in the site repository,
`public/methodology/qrev/qrev-parameter-grid.csv` (sha256 `84965f74d71c97bfb90141784e10bf477ab880eb1459014af6223e75fc3536b8`
at commit `a2b2734`), row `G-Q-6M-N15-150` against the rule in force `G-Q-6M-N10-150`. Same data (DefiLlama daily holder
revenue for every adapter with $1M all-time, CoinMarketCap weekly top-1,000 to 2026-09-20, on-chain issuance registry
where complete), same code, same six windows. Gross | net; net deducts the 1%/yr launch fee accrued at every weekly mark
and 30 bp per side on what each reconstitution trades.

| Window | 15 names, gross \| net | 10 names, gross \| net | Bitcoin |
| --- | --- | --- | --- |
| 2021-11→ (cycle top) | 0.30 \| 0.28 | 0.30 \| 0.27 | 1.28 |
| 2022-01→ | 0.64 \| 0.59 | 0.58 \| 0.53 | 1.71 |
| 2023-01→ | 3.39 \| 3.19 | 3.28 \| 3.06 | 4.88 |
| 2024-01→ | 2.61 \| 2.49 | 2.43 \| 2.31 | 1.85 |
| 2024-07→ | 2.39 \| 2.30 | 2.88 \| 2.76 | 1.45 |
| 2025-01→ | 1.29 \| 1.25 | 1.16 \| 1.12 | 0.83 |

| | 15 names | 10 names |
| --- | --- | --- |
| Max drawdown from 2024-01 (bitcoin −52%) | **−54%** | −72% |
| Max drawdown from 2021-11 (bitcoin −75%) | −92% | −92% |
| Turnover, one-way, per year | **127%** | 155% |
| Names held, median / minimum (20 reconstitutions since 2021-11) | **12** / 3 | 10 / 3 |
| Reconstitutions with fewer eligible names than the count | 12 of 20 | 8 of 20 |
| Cost drag, gross CAGR − net, from the top / from 2024 | 1.4 / 2.3 pp a year | 1.5 / 2.6 pp a year |
| Windows beating bitcoin / with a shallower drawdown than bitcoin (of 6) | 3 / 0 | 3 / 0 |
| Grid robustness score (0–12), gross and net | 3 | 3 |

Resampled futures (bootstrap of the run's own quarters, 20,000 three-year paths, bitcoin on the same draws; pool B =
the fifteen quarters since 2023-01):

| Pool B, median three-year multiple / chance of a loss | 15 names | 10 names | Bitcoin |
| --- | --- | --- | --- |
| Weights kept, gross | 2.65 / 22% | 2.61 / 28% | 3.57 / 10% |
| Weights kept, net | 2.52 / 24% | 2.46 / 29% | |
| Returns shuffled among the names (no information in the weights) | **0.86 / 54%** | **0.85 / 54%** | |
| Chance of beating bitcoin, kept / shuffled | 32% / 7% | 37% / 7% | |

## What it is not

It is **not a return claim.** With the weights' information removed the two rules are the same distribution
(0.86× against 0.85×, a loss in 54% of paths either way); the kept-weights medians differ by 0.04×, inside the range of
one sample; the grid scores are equal; and in the most recent full window (2024-07→) the ten-name rule is ahead by half a
turn. What the fifteen-name row buys is **diversification** — two more names in the median quarter, a fifth less
turnover, a drawdown from 2024 that is 18 points shallower — and part of that shallower drawdown is simply an emptier
book, because in twelve of twenty reconstitutions the universe could not fill fifteen seats. The owner chose the row for
the spread, knowing the return evidence cannot separate it from the rule in force.

## What stays

- The paper record (`record-qrev.jsonl`, since 2026-09-16) and the testnet basket vault on GIWA Sepolia
  (`0xba83462fdfede13dc7eb1d1fd893ae76dcaad975`) keep the ten members selected on 2026-09-16 — HYPE, SKY, CAKE, UNI,
  RAY, CRV, PENDLE, JUP, AERO, ZRO — until the 2026-10-01 reconstitution. Daily marks read no ranking parameter.
- On that run the keeper selects fifteen under the buffer 12/19 with the two-quarter hysteresis, writes the record and
  `keeper/pending-registry-qrev.json`; the vault follows through the registry path (announce → 7 days → execute →
  auctions) under its own dated decision document. Runbook: site repository `contracts/DEPLOY-INDEX-BASKET.md` §7.
- The inception decision of 2026-09-16 stands; this document amends one parameter of it from a stated date and is
  anchored beside it, not in its place.

## How the keeper carries it

`keeper/rulebooks/qrev.json` keeps `ranking.targetCount 10` and `rankBuffer 8/13` as the base and adds
`ranking.scheduled: [{ effectiveFrom: "2026-10-01", decision: "2026-09-21-qrev-fifteen-names", targetCount: 15,
rankBuffer: { entryMaxRank: 12, exitMinRank: 19 } }]`. `keeper/rulebook-schedule.mjs` `rankingFor(rulebook, date)`
returns the block as it stands on a date — base values with every scheduled entry dated on or before that date merged
in — and `keeper/paper-index.mjs` reads the count and the buffer through it at reconstitution, printing the resolved
values in the run log. Resolved: 2026-09-21 and 2026-09-30 → 10, 8/13 (base); 2026-10-01 and after → 15, 12/19.
Dry run on 2026-09-21: mark-to-market only, ten members, vault registry equal to the book, nothing pending.

Pinned (sha256): `keeper/rulebooks/qrev.json` `aecd53c18f5e38cd34d110d010384e3981bf99901ab01b8f031aa60a9543ddc9` ·
`keeper/rulebook-schedule.mjs` `161cea3fde8030b27e07aab14b069481c88adf609ae11382273b96ccb570bfd8` ·
`keeper/paper-index.mjs` `b9b24ad2ac5b25f953e6d4b721796bf35a26019b6b2f793061f663c2b1d276ac`.

## Limits of the evidence

- One sample, twenty quarters, of which the universe held fifteen or more eligible names in eight. The rule count was
  chosen on the same sample as every other parameter (the fourth pass on it); the paper record is the out-of-sample test
  and it is five days old.
- The comparison is between two rows of a grid whose scores tie; the resample cannot rank them; the semiannual cadence,
  twelve positive months and the $300M floor also tie or win on this universe and remain open (rulebook D21).
- Holder revenue is a single source (DefiLlama) and adapters it has deleted are outside the sample; the backtest matches
  protocols to market data by ticker (D22, VELO ±1%); issuance for names without a complete on-chain census is the
  vendor's supply figure.

## How to verify

1. The grid: site repository, `public/methodology/qrev/qrev-parameter-grid.csv` at `a2b2734` (sha256 above), rows
   `G-Q-6M-N15-150` and `G-Q-6M-N10-150`, and the Monte Carlo block below them; regenerable with `parameter-grid.py`
   from the fetch scripts in the same folder.
2. The backtest CSVs republished with this decision (site branch `staging/qrev-n15` at `a91a4fe`, then main): `QREV` is the
   fifteen-name rule, `QREV-N10` the ten-name rule, byte-identical per window to the previous `QREV-N15` and `QREV` rows
   (previous `qrev-backtests.csv` sha256 `38d76234989199999ca0d4c64c3f6957a80237388d7ebe922b28113f117a7a58`).
3. The keeper: `node -e` over `rankingFor` with the dates above; from 2026-10-01 the run log line
   "ranking parameters for 2026-10-01: targetCount 15, rank buffer enter ≤ 12 / exit > 19 (scheduled change
   2026-09-21-qrev-fifteen-names effective 2026-10-01)" and a record row with up to fifteen members.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix (site: grid and prior CSVs on main; rulebook D23, regenerated CSVs and runbook §7 on branch `staging/qrev-n15`, to merge after preview verification) | main `a2b2734` · `staging/qrev-n15` `a91a4fe` |
| quadrix-track-record (keeper, this file — before this commit) | `66be7a1` |
