# qBTC2X synthetic level — inception, 2026-10-13

**Effective:** 2026-10-13 (UTC). **Series:** `trackrecord/record-qbtc2x.jsonl`, anchors `trackrecord/anchors-qbtc2x.jsonl`, calldata prefix `qxpi-qbtc2x:`.

## What starts today

Stage A of BTC 2x (ticker qBTC2X): a rules-only level for a book that holds bitcoin against a stablecoin
debt and is brought back to twice its equity at the end of every UTC day — the level of a **daily 2× of
bitcoin's UTC-day return**. Genesis level 100 at the 00:00 UTC close of 2026-10-13. A line dated D holds the bars of UTC day D − 1:
the genesis line, dated 2026-10-13, holds only the starting book, and the line dated 2026-10-14 is the
first day of returns. Nothing is borrowed, swapped or liquidated. The level is what the book's equity would have been, computed bar by bar from
closed 15-minute bars built from Binance spot BTCUSDT one-minute bars, with no fallback source, by the
keeper `keeper/leverage-index.mjs --index qbtc2x`. One line per UTC day, written once the day has ended,
recomputed by `scripts/verify.mjs` (a second implementation) before it is appended, hash-chained and
anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send — the same mechanism as the other
records. Append-only.

A testnet vault on GIWA Sepolia, `0x7C10C33aEd202207Bb0C054B32C0708ABAC54070` (created in `0x95d302033a982d1a5fe43c459944eb75a82afb9ea098fb1e77d6dcec690c6524`, deposit cap 0 at deployment), has
its share price marked to this level (level ÷ 100) once a day, after the day's line is anchored, by the
keeper's daily run. It holds test dollars only — no bitcoin and no debt — and issues and redeems at the
marked price. It displays the level; it is not the book. It runs the same contract as the qX20 tracking
vault; that contract's comments describe qX20. Owner and keeper: the keeper key, as for the six testnet
basket vaults. Deposits open only after the first mark (line 1) has been checked by a person, up to
1,000,000 test dollars — the qX20 tracking vault's cap; an untested value.

## The rules in force (pinned)

The rulebook is `rulebooks/qbtc2x.md` at commit `6f32e12995ccdef044f57fb39b0e06ac6a39944e` of this
repository (sha256 `8dfa8b49c6a06a62079173e82a4c3e285aa2b7915321ab1a8b331a6d87d7febb`), as implemented in
`keeper/rulebooks/qbtc2x.json` (sha256 `ae8db495ba8bb9336aa598d8ef4ff36d51c7335cfe77de702ce74c525235ce88`),
`keeper/leverage-index.mjs` (sha256 `1e2a1e6a7e13a623c4a52619e10127ddbd25061913eaa397cc07b09ceca258fb`) and
`keeper/leverage-step.mjs` (sha256 `0266e0f339813591be3584cef41c5107533b83a2df1cd49aab5c68d4a0880e25`),
recomputed by `scripts/verify.mjs` (sha256 `ecc5d13bee9ed0c83465502e8ad2a69a48128a99bff7b6bdc1d1cde0f216a992`),
at commit `⟦RECORD-HEAD⟧` of this repository. In one paragraph:

The book is bitcoin worth λ times its equity against a stablecoin debt of (λ − 1) times its equity. It is
evaluated at the close of every 15-minute bar. At the last close of each UTC day (normally the bar that
opens at 23:45 and closes at 00:00 UTC) it is brought back to λ = 2.0, whatever λ is. Every **120 minutes**
on the UTC grid counted from 00:00, if that close is not the day's last and **λ ≥ 2.2**, the book is
brought back to 2.0; the trigger only reduces leverage and leverage is never raised during the day. There
is no other trade, and never more than one at a close. When the exchange has no bar across grid times,
the last close before the gap stands for them and is judged once; interest accrues for the elapsed time.
Each trade pays 30 bp of its notional out of equity, and the debt accrues 4.5% a year (set by the owner on
2026-10-05; the tests' headline is 6%): at every 15-minute bar it is multiplied by
(1 + 0.045/365)^(elapsed minutes / 1,440).

## The tested value, and the interval it was chosen in

The trigger (2.2) is the output of the sixth pre-registered leverage test within the 120-minute check
interval the owner set — registration fixed at site-repository commit `8b355b7`, engine sha256
`ceadadd3003fcbbb858a9b19adcbbc3db5873308c0f7705c68cb11b7d0c2fab3`, result file
`docs/research/leverage/params-v6/results/results.csv.gz` (site repository, branch
`research/leverage-params-v6` at `c9bd7a2`; sha256
`5cdd706e6ecb5fbc3bb7841634b7598657d173364c09b4860701fca3c3c2791e`), row
`trk_asset_outcome,BTC,A,own,all`: "best". The test keeps only variants of the daily-reset book whose
margin holds at one-minute resolution (below) and ranks them by how closely their daily return follows
twice bitcoin's daily return (root mean square of the daily difference over three historical windows and
resampled paths). Among the three triggers that keep the margin at 120 minutes (2.1, 2.2, 2.3), the rule's output is
λ ≥ 2.2. In the historical windows neither 2.2 nor 2.3 is closer throughout: 2.2 from 2018 (0.28% against
0.32%), 2.3 from 2021 and from 2023 (0.096% against 0.099%; 0.046% against 0.047%). On resampled paths 2.2
was closer on 2,848 of 3,333 and 2.3 on 485 (six-month blocks), and the same output came under all seven
cost scenarios and both report seeds. An independent re-computation and
a third re-computation produced the same values.

What the value is: the variant with the smallest daily tracking difference inside a safety condition
computed deterministically. The test did not choose the 120-minute interval, did not choose the daily
reset and did not confirm daily tracking. **The 120-minute interval was set by the owner on 2026-10-01,
before the one-minute measurement; the test chose the trigger within it.** With the interval left free,
the same rule returns 120 minutes and λ ≥ 2.3 — a fallback by simplicity, which loses to 120 minutes and
λ ≥ 2.2 on 2,848 of 3,333 paths. The registration listed the interval, before the run, among the values
the test does not choose, and the free track reaches 120 minutes only through its simplicity order: no
variant was best among the four that no other beats (120 minutes with 2.3 or 2.2, 60 with 2.4, 30 with
2.5), and the order takes the longest interval. **The interval is therefore counted as not tested**
(owner, 2026-10-06).

**A few days decide it.** Daily-reset variants differ only on days their triggers fire differently. 2.2
and 2.3 differed on 76 of 3,287 days; the days that favoured 2.2 most were 2018-02-06, 2018-01-17,
2017-12-10, 2017-12-09 and 2020-03-16, and without the first two the 2018 window's difference changes
sign. On resampled paths that hold none of the months 2017-12, 2018-01, 2018-02 and 2020-03, 2.2 won
17.6% (one-month blocks) and 46.1% (six-month blocks).

**Selection effects**, which pre-registration does not remove: the sixth test was designed after the
fourth test's output was re-measured on one-minute bars and found outside the margin; trigger 2.1 and the
intervals under one hour were added knowing roughly what would pass; the criterion was changed after the
fifth test's result was known (its rule returned a band variant that does not give a daily 2×) and after
the one-minute margin table was known. The registration expected a less frequently firing trigger to track
better; the results disagree in 33 pairs (29 for bitcoin), because when two triggers both fire on a day,
the higher one sells later, lower and more — on 2018-02-06 trigger 2.2 fired at 04:00 (λ 2.215) and 2.3 at
08:00 (λ 2.349, near the day's low) before the price recovered. Which pairs keep the margin (26 for
bitcoin), each track's candidates and every variant's tracking difference in the three windows were fixed
before the run; the resampled paths decided only which candidate is the output. The measure itself, the
root mean square of the daily difference, and the tie rule (weak dominance; more paths won than lost) were
set knowing that daily-reset variants differ only on days their triggers fire differently; the measure is
the designer's choice and was not re-measured with another statistic.

**The grid phase was not tested.** Performance was measured on one grid phase only (from 00:00 UTC). A
calculation made after the results (not used in the verdict): of the 24 cells of
eight 120-minute phases × three windows, 2.2 tracks better than 2.3 in 12; the spread across phases of
2.2 alone is wider than the difference between the two triggers at the registered phase. The margin is
measured from every minute and does not depend on the phase. A re-test with the phase in it will be
pre-registered before stage B (owner, 2026-10-05).

## The standard

Listed single-stock 2× products (Hong Kong, Korea, United States) state the same thing in their offering
documents: a multiple of the underlying's **daily** return, reset once a day, and no promise of the
multiple over periods longer than a day. The law in those places sets only a ceiling. The standard does
not fix the reset time of an asset that trades around the clock, and listed products have no intraday
de-leverage trigger: 00:00 UTC and the trigger are ours. On a day the trigger fires, the day's return
departs from 2× the underlying's.

## Margin at one-minute resolution

A variant is eligible only if, from λ = 2.2, a fall 1.25 times the deepest fall within one check interval
stays under the 86% liquidation line, with falls measured from every minute of 2017-09-01 to 2026-09-30
(UTC) to the lowest one-minute low within the interval. For bitcoin the deepest 120-minute fall is
−25.7456%, from the 22:11 UTC close of 2020-03-12; the full history gives the same value. At λ ≥ 2.2 the
fall takes the loan-to-value to 80.43% (73.46% at a factor of 1.0), and a check may be up to 50 minutes
late before the margin is gone (238 minutes at 1.0); missing one check entirely takes it to 99.22%. The
same rule returns the same value for a liquidation line above 80.43% and up to 86.01%; outside that range
the verdict must be made again. The factor 1.25 is a policy value, not a probability, and 86% is a
placeholder for a lending market's liquidation line, not a confirmed term. The margin is computed without
interest. The highest leverage the book reached at a bar's low in the 2018 window was 3.507 (2020-03-12
10:45 UTC).

**These values are for stage A only.** Before any real borrowing (stage B), eligibility is recomputed
against the real liquidation line and a new verdict is made, the market's oracle is compared with the
exchange bars, and an execution environment that keeps the check interval (50 minutes of lateness at
most) is in place. Stage B is a separate anchored decision.

## What the level assumes in place of a market

- **Liquidation.** At every bar, before any trade, the book is tested at the bar's low: if debt ÷
  collateral is 86% or more there, the level is zero and the series ends. A total loss is harsher than a
  market's partial liquidation; it is the tests' convention. That line is written only after a person has
  accepted it (below).
- **Costs.** 30 bp of notional per trade and 4.5% a year on the debt (set by the owner on 2026-10-05).
  The tests' verdict used 30 bp and 6% as the headline and ran 4.5% as a reference outside the verdict
  (measured USDC borrowing had medians of 4.0–4.9% over the last 365 days in six pools, and averages of
  5.1–7.0% over each pool's full period since 2022-08-26; nothing was measured on GIWA). Rate scenarios of 3, 6 and 12% rank the variants almost alike, so the rate barely
  touches the verdict; it does touch the level — a 2× book borrows its equity, so 6% against 4.5% is
  about 1.5 points a year. These are assumptions, not measurements.
- **Timing.** The level assumes every check happens exactly on the grid and trades at that bar's close.
  When the keeper actually ran is written beside the level and not applied to it.
- **Fees.** No management fee is applied; none has been set.

## What each line contains

The level; the book left at the day's end (collateral, debt, equity, last bar, last close — the next line
starts from it); every check of the day (grid time, bar, λ before, action — none, trigger, reset, or
liquidated — notional, cost, λ after, level); the day's trades, triggers, turnover, cost and highest debt
÷ collateral at a bar low; every 15-minute bar of the day (open, high, low, close, one-minute bars in it)
with the sha256 of the day's one-minute bars as Binance served them, so the line can be recomputed from
itself and compared with the exchange; the rule it ran under, including this rulebook JSON's sha256; when
it was written and how late. A day the keeper missed is written when it next runs, from the same bars,
and marked `late`; the anchor's block time shows when the line came to exist. A day with fewer than 1,440
one-minute bars halts the series until a person confirms the gap against that exact set of bars; bars are
never filled. A day whose bars would end the series in a model liquidation halts it the same way (owner,
2026-10-06): no line, anchor or mark until a person has compared that low with other venues' bars for the
same minutes and accepted that exact liquidation (the day, the sha256 of its one-minute bars, the bar and
the debt ÷ collateral at its low); the level-0 line then names the acceptance (`liquidationAccepted`), and
`scripts/verify.mjs` fails a liquidation line without it.

## What this record does and does not show

It shows that the rule runs as written, without discretion, on bars anyone can re-pull and recompute. It
is not the record of a product: no asset is held, no rate is paid, no trade is filled. It shows nothing
about returns until it is long.

In the tests' historical windows (30 bp · 6%, no fee) the rule ended at 0.30 times its start from 2018
(bitcoin held: 6.10), 0.67 from 2021 (2.89) and 7.96 from 2023 (5.06), with drawdowns of daily closes of
−98.66%, −97.85% and −82.48%; the daily tracking difference had a root mean square of 0.28%, 0.10% and
0.05% and a mean of −3.41, −3.07 and −2.71 bp a day, and the trigger fired 8.2, 5.7 and 1.3 times a year.
From 2017-09 the largest one-day deviations from twice bitcoin's day were −10.08% (2020-03-13) and +9.67%
(2020-03-12), and 99.49% of days were within 1 point. Over 3,333 resampled 2,100-day paths (the 108 months
from 2017-09 to 2026-08 drawn in six-month blocks, 30 bp · 6%) the median ended at 0.71 times its start
and the 5th percentile at 0.0029 — one path in twenty lost more than 99.7% (0.0025–0.0044 across block
lengths of 1, 3, 6 and 12 months); 526 of 3,333 paths ended above bitcoin held. No path was liquidated,
which follows from the margin and is not separate evidence — the paths reuse days of history and cannot
hold a bar deeper than those days hold. Without a trigger, the daily reset alone is liquidated on
2020-03-12. Holding longer than a day drifts from a simple 2× (root mean square of the gap over 7, 30 and
90 days: 1.33, 6.76 and 39.17 points from 2018; 1.10, 4.01 and 9.81 from 2021; 0.76, 3.21 and 8.45 from
2023); the ±0.2 band version of the same rule drifts less over 7 and 30 days and tracks the daily 2× worse —
comparison numbers only.

**Holding period and costs.** The product claims a holding period of one UTC day, from one 00:00 UTC reset
to the next; from 2017-09, 99.49% of days were within 1 point of twice bitcoin's day. Held longer, it is not
twice the period's return: over the same 3,333 paths of 2,100 days the median ended at 1.36 times its start
with no costs and at 0.78 with 30 bp a trade and 4.5% a year to borrow (1.3612 and 0.7787), so costs take
161% of the cost-free gain (179% at 6%), and held that long it loses at the median (2,100 days is the
only path length resampled). It is built for short holding. The owner chose this disclosure on 2026-10-06.

Not claimed: that a real book would have kept this level; that the margin holds in a market whose
liquidation line is lower, whose oracle prints a deeper low than Binance spot, or whose keeper runs late;
that a fall deeper than any in the data cannot happen; that the book is better than holding bitcoin; that
a 2× of bitcoin's return over any period longer than a day is delivered. Any of the first three can take a
real book to zero.

## Tested, and not tested (pinned)

Parameter citation table: appendix P of `rulebooks/qbtc2x.md` at commit `6f32e12995ccdef044f57fb39b0e06ac6a39944e`
(sha256 `8dfa8b49c6a06a62079173e82a4c3e285aa2b7915321ab1a8b331a6d87d7febb`); keeper provenance
`keeper/rulebooks/qbtc2x.provenance.json` (sha256 `5bc1a4c9a260e37ea08f2f8e1cbab288cca4ac1f712949fa4444fe2ac302846e`).
Checklist run record: `docs/methodology/checklist-runs/qbtc2x/2026-10-12.json` (site repository, private;
sha256 `e4d7f8ea9de155c1bcb5388e1fca272a8ab7aac3a5924473a3f35401a82ba3bb`). The run record also names, by path,
internal evidence files of the security tests and the launch preparation, and pins the result files among them by
sha256; they are not published. Before the
next anchored decision, the run record will pin only evidence that can be published. Gate report:
`rulebooks/qbtc2x.gate.json` (sha256 `⟦GATE-sha256⟧`).

| Basis | Count | Parameters |
| --- | --- | --- |
| Tested — pre-registered backtest and Monte Carlo | 1 | P06 trigger λ ≥ 2.2 (the output of the owner's track, inside its 120-minute condition) |
| Partly tested — backtest only, or run without pre-registration | 0 | — |
| Definition | 4 | P01 underlying, bitcoin alone · P02 what the book never holds · P03 price source, Binance spot 1-minute → 15-minute closed bars, no fallback · P22 stage-B execution reference (not built) |
| Price | 1 | P18 management fee — none in stage A (recorded as fees.managementBps 0 in the rulebook JSON) |
| Not tested — product definition, disclosed as an exception (owner, 2026-10-05) | 5 | P04 target 2.0 · P05 daily reset · P12 back to exactly 2.0 after a trigger · P13 reset at 00:00 UTC · P14 trigger reduces leverage only, no intraday re-leverage |
| Not tested — model assumption, disclosed as an exception (owner, 2026-10-05) | 5 | P09 margin factor 1.25 (a policy value) · P11 liquidation line 86% (a placeholder) · P15 exchange gaps are not filled · P16 a model liquidation is a total loss and ends the series · P17 the level's cost convention, 30 bp and 4.5% a year (basis: measured USDC borrowing, 365-day medians of 4.0–4.9% in six pools; full-period averages 5.1–7.0%) |
| Not tested — other, disclosed | 8 | P07 check interval 120 minutes (set by the owner on 2026-10-01 before the one-minute measurement; the free track returns it only as a fallback by simplicity) · P08 check grid phase, from 00:00 UTC (re-test before stage B) · P19 deposit cap 1,000,000 test dollars · P20 no rule for a check that runs late · P21 no borrowing-rate ceiling · P23 the margin is measured from 2017-09-01 (for bitcoin the full history gives the same result) · P24 mark gate: marks in steps within the contract's 25% bound, never stopping on size (a 15% stop failed the pre-registered stress study, which measured an upper-bound book re-levered to 2.4 every 120 minutes: 1.25 × its worst 14-hour move is 209%; no test chose "no stop") · P25 15-minute bars |

Values this decision introduces: every value above is new. Eighteen of them are not tested, each with its
own source: the check interval (P07) — set by the owner on 2026-10-01 before the one-minute measurement,
listed by the registration among the values the test does not choose, counted as not tested by the owner
on 2026-10-06; the product definition (P04, P05, P12, P13, P14) and four model assumptions (P09, P11, P15,
P16) — the owner decided on 2026-10-05 to disclose them as exceptions and open; the level's cost
convention (P17) — set by the owner on 2026-10-05; the grid phase (P08) — measured on one phase only,
disclosed and re-tested with the phase before stage B (owner, 2026-10-05); the deposit cap (P19) and the
mark gate (P24) — defaults of the opening preparation, accepted by the owner on 2026-10-05; no
rule for a late check (P20) and no borrowing-rate ceiling (P21) — no default covers them, they are absent
because no candidate rule was tested; the decision region (P23) — the sixth test's default, adopted on the
night of 2026-10-01 and fixed in its registration before the run (for bitcoin the full history gives the
same result); the 15-minute bar (P25) — the sixth test's simulation step. All eighteen are entered in the
rule audit register for a later test (site repository, private).
The citation gate (report-only) does not pass this decision. Its report of 2026-10-12 reads "fail" with
19 violations, all for the checklist run record (C4): 9 design steps not done (among them D11–D18; D13,
D16, D17 and D18 can only follow this anchor) and 10 fields of the record format that the record, first written
on 2026-10-05, does not carry. None is for the rule audit (C9): the eighteen are registered.
Pre-registration commit: `8b355b7` (sixth leverage test). Result files: `docs/research/leverage/params-v6/results/results.csv.gz`
sha256 `5cdd706e6ecb5fbc3bb7841634b7598657d173364c09b4860701fca3c3c2791e`; `docs/research/leverage/params-v6/results/verdicts.csv`
sha256 `c1e2d12e97499f74afe4e78b6c78bcd949ff3bab1bb4a938e92633fd53c18a3b`; `docs/research/leverage/params-v6/stats.csv`
sha256 `64ebb30b01f64bab14d58f28c7184839bbe3cdb08419d793f9efd7b0caa40a72` (site repository, branch
`research/leverage-params-v6` at `c9bd7a2`; no published copy yet).
Registration, a copy of the registration fixed at `8b355b7`: `docs/research/leverage/params-v6/registration.md` sha256
`f9bf113c41666ea5490fbab8d7589cdf2279033e8ffa4f6d6d2565c2194bf1e7`; independent check
`docs/research/leverage/params-v6/verify-p2/summary.csv` sha256
`2f64759ec40fcfcf5f5c70e68083c8ffc942fd7ba6d12f8b4de8ba216f546dcc`; third re-computation
`docs/research/leverage/params-v6/recomputation.md` sha256 `877014fa70ad4c5dda95f158112adc98c8ad2a7456c66037b5ee7b379f42fb9d`
and its raw output `docs/research/leverage/params-v6/recomputation/output.txt` sha256
`41353be92dadca49f60233373de28b0abbce36bc381d6460b447a0639d9348a1` (the three copies at site commit `ad67f57`).
Checks not run for this product, and why: holdability of collateral and debt on GIWA (R08) — not
applicable in stage A, required before stage B; security items R44–R46 — no new contract code, the vault is
the qX20 tracking vault's contract (its eight existing tests pass). Roles on chain (R64) were read back after the
deployment: owner and keeper are the keeper key, the deposit cap is 0, the share price 1.000000. A red-team proof-of-concept pass over the new keeper code (R47) was run on 2026-10-05, on the
code before the fixes it led to (site repository, private): ten findings, none a wrong level from honest inputs. The fixes made for nine of
them (for one of them, all but a watch on the vault's mark, which is not built yet) are in this repository: in the
keeper and the verifier pinned above, the freshness alarm (`scripts/watchdog-series.mjs`), two workflow
files and one test. One of the nine (one wrong one-minute low ended the series with no person in between) is answered by
the acceptance step under "What each line contains" (owner, 2026-10-06); what it leaves is under "Known
limits". The tenth (the site's mirror of the record) is not fixed. What each finding led to is in the
checklist run record.

Judgments — values that differ from the decision rule's output: none. The tested value (P06) is the
decision rule's output.

## Known limits, stated at the start

The margin above is the deepest recorded fall times 1.25 and nothing more: a deeper fall, a market whose
oracle prints a deeper low than one exchange's one-minute bar, or a liquidation line below the placeholder
can each take a real book to zero. The shortest interval tested is 15 minutes; performance was measured on
one grid phase. A one-minute low can be a single trade. The data are one exchange's spot bars; checks are
assumed to fill at the bar's close with no gas, congestion or delay.

A wrong one-minute low no longer ends this series by itself: the run that meets a low at which debt ÷
collateral reaches 86% writes and anchors nothing, does not mark the vault, and opens the failure issue;
only a person's acceptance lets the next run write the level-0 line. What remains: until a person decides,
the series has no new line and the vault keeps its last marked price, at which deposits and redemptions
still settle; a person who accepts a wrong low ends the series, and the vault is then stepped down to the
contract's floor, from which no key can raise it; a low judged wrong leaves the series halted, because the
code that would continue it from a corrected book is not written yet and continuing needs an anchored
correction decision. Binance has printed such a low once (ETHUSDT, 2017-08-22 04:00 UTC: 144.21 after a
close of 280.00, −48.5% in one bar; three other venues' lows for that hour were 4.6–5.0% below their opens).

If Binance is unreachable, or a day's one-minute bars are incomplete, no line is written and the series
waits; no other exchange's bars stand in. A day is never written before it has ended.

The vault's price can move at most 25% per transaction and cannot be set to zero: a large move is marked
in steps within that bound, and after an accepted model liquidation the vault is stepped down to the
contract's floor and closed to deposits by the keeper. Deposits and redemptions between marks settle at the last
marked price, so a vault user's profit or loss is not a performance figure.

No rule covers a keeper that misses the interval, a borrowing rate above a ceiling, an oracle failure or a
sequencer halt: none has been tested, so none is in the rulebook. A wrong line that is already anchored is
answered by an anchored correction decision; the code that would continue the series from a corrected book
is not written yet.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix-track-record (rulebook, rulebook JSON, provenance, keeper, verifier, gate report) | `⟦RECORD-HEAD⟧` |
| quadrix (site, private — research `docs/research/leverage/params-v6/` on `research/leverage-params-v6`) | `c9bd7a2` |
| quadrix (site, private — copies `registration.md`, `recomputation.md`, `recomputation/output.txt`, `stress-results.csv`) | `ad67f57caf39eed1ddbfbdf4882250f5ab19caed` |
| quadrix (site, private — checklist run record) | `ad67f57caf39eed1ddbfbdf4882250f5ab19caed` |
