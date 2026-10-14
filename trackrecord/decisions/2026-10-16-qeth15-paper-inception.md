# qETH1.5X synthetic level — inception, 2026-10-16

**Effective:** 2026-10-16 (UTC). **Series:** `trackrecord/record-qeth15.jsonl`, anchors `trackrecord/anchors-qeth15.jsonl`, calldata prefix `qxpi-qeth15:`.

## What starts today

Stage A of ETH 1.5x (ticker qETH1.5X, series id `qeth15`): a rules-only level for a book that holds ether against a stablecoin
debt and is brought back to one and a half times its equity at the end of every UTC day — the level of a
**daily 1.5× of ether's UTC-day return**. Genesis level 100 at the 00:00 UTC close of 2026-10-16. A line dated D holds the bars of UTC day D − 1:
the genesis line, dated 2026-10-16, holds only the starting book, and the line dated 2026-10-17 is the
first day of returns. Nothing is borrowed, swapped or liquidated. The level is what the book's equity would have been, computed bar by bar from
closed 15-minute bars built from Binance spot ETHUSDT one-minute bars, with no fallback source, by the
keeper `keeper/leverage-index.mjs --index qeth15`. One line per UTC day, written once the day has ended,
recomputed by `scripts/verify.mjs` (a second implementation) before it is appended, hash-chained and
anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send — the same mechanism as the other
records. Append-only.

No testnet vault follows this level yet: there is nothing to deposit into and nothing is marked. A mark
vault, its deposit cap and its mark gate are a later decision; before it takes deposits, its deposit screen
shows the two disclosures under "What this record does and does not show" and a depositor confirms them.

## The rules in force (pinned)

The rulebook is `rulebooks/qeth15.md` at commit `3b355eaf3a8d55856b979fda706a40d3bf986a89` of this
repository (sha256 `c48aaec5595a2ee4423f13597e8aaf441bde5f47d2f2e2af319e7b3ecdb27409`), as implemented in
`keeper/rulebooks/qeth15.json` (sha256 `b417ca3d96f897cf8ce926642d06ca0712d5122455ed3f54fcb1bd8e9e384fde`),
`keeper/leverage-index.mjs` (sha256 `71b617af9e30a09f1f53a79854f81c9b886cac06bad48db01577dea0ad43fc59`) and
`keeper/leverage-step.mjs` (sha256 `ababc503d9ef28cc98ff74e3fff1a6f6826f21bc174b341725fe62bcda0fa1f4`),
recomputed by `scripts/verify.mjs` (sha256 `a346b0f51378638c5edba8d7b9f89588f0d1f2501a662b2ef30fecf9c5df8114`),
at commit `3b355eaf3a8d55856b979fda706a40d3bf986a89` of this repository. In one paragraph:

The book is ether worth λ times its equity against a stablecoin debt of (λ − 1) times its equity. It is
evaluated at the close of every 15-minute bar. At the last close of each UTC day (normally the bar that
opens at 23:45 and closes at 00:00 UTC) it is brought back to λ = 1.5, whatever λ is. Every **15 minutes**
on the UTC grid counted from 00:00 — that is, at every bar close — if that close is not the day's last and **λ ≥ 2.3**, the book is
brought back to 1.5; the trigger only reduces leverage and leverage is never raised during the day. There
is no other trade, and never more than one at a close. When the exchange has no bar across grid times,
the last close before the gap stands for them and is judged once; interest accrues for the elapsed time.
Each trade pays 30 bp of its notional out of equity, and the debt accrues 4.5% a year (set by the owner on
2026-10-13, the convention of qBTC2X; the test's headline is 6%): at every 15-minute bar it is multiplied by
(1 + 0.045/365)^(elapsed minutes / 1,440).

The product definition — a daily 1.5× of the underlying's UTC-day return, reset at 00:00 UTC, back to
exactly 1.5 after a trigger, the trigger only reducing leverage — is the 2× definition of qBTC2X at 1.5,
set by the owner on 2026-10-13. It cannot be tested and is disclosed as an exception (below).

## The tested value, and the track it was chosen on

The check interval and the trigger (15 minutes, 2.3) are the output of the pre-registered ETH 1.5x
daily-reset test on its "miss one check" track — registration fixed at commit `d7fec51` on the site repository's main (private; the public check is
the copies `REGISTRATION-public` and `MANIFEST.sha256` in this repository),
result file (the publishable copy in this repository) `docs/research/leverage/eth-1p5/results-1.5-p2-public.csv.gz`
(sha256
`31886fbd30539434c04bb7ba385675758f86160a8aa17863c9c1a65e23821e32`), row
`trk_asset_outcome,ETH,A,miss1,all`: "sole survivor of the filter". The test applies the decision rule of
the sixth leverage test to a 1.5 target: it keeps only variants of the daily-reset book whose margin holds
at one-minute resolution (below) and ranks them by how closely their daily return follows one and a half
times ether's daily return (root mean square of the daily difference over three historical windows and
resampled paths). The "miss one check" track keeps only the variants whose margin still holds when the
unchecked window is doubled to 30 minutes; "one" is a policy value, not a tested one. On that track the
rule returns 15 minutes and λ ≥ 2.3 under all seven cost scenarios; its headline equivalence class held
two variants (15 minutes with 2.3 or 2.2). Two independent re-computations — one from the merged results,
one from their own 15-minute ledger and paths without the engine's tracking numbers as input — produced
the same values.

What the value is: the variant with the smallest daily tracking difference among those whose margin holds
with one check missed, computed by a rule registered before the run. The test did not choose the track,
did not choose the daily reset and did not choose the 1.5 target. **The owner chose the "miss one check"
track on 2026-10-13, after the results were known; the values are the registered rule's output on that
track, not values the owner set.** With the interval left free (ether has no owner-set interval, so the
owner's track is the free track), the same rule returns 15 minutes and λ ≥ 2.4: a check may then be at
most 9 minutes late, and missing one check takes the loan-to-value to 86.95%, outside the margin. At
λ ≥ 2.3 a check may be 22 minutes late, and missing one takes it to 84.25%, inside. The price of that
choice in the 2018 window: a root mean square of the daily difference of 2.73442 × 10⁻⁴ against 1.66747 ×
10⁻⁴ for 2.4. The interval of 15 minutes is the shortest the test's grid holds; shorter intervals were not
measured.

**One day decides the free track.** 15 minutes with 2.5 never fires in the three windows; 2.4 fires once,
on 2020-03-12 (the 23:30 UTC bar), and 2.3 once, on the same day (the 23:15 UTC bar). The 2021 and 2023
windows give the three the same value. At the headline costs (30 bp · 6%) 2.4 beats 2.5 in the 2018 window
by 0.14% of the measure (1.66747 against 1.66975 × 10⁻⁴) — the cost arithmetic of that one day. With no
costs the order reverses and the free track's output becomes 120 minutes and λ ≥ 2.0; at 10 bp · 6% it is
the same 120 minutes and 2.0. On the free track the cost assumption decides the output.

**Selection effects**, which pre-registration does not remove: the question of a 1.5× ether book was
asked after the sixth test's numbers for ether at 2× were known (a large loss at the Monte Carlo median),
and testing two targets (1.5 and 1.75) is itself a multiple test; the top of the trigger grid was set after
the static margin table was known, and its bottom (target + 0.1) was known to pass; band variants were
left out of the Monte Carlo (for cost) and are not part of the verdict; the data, the static margin, the
simulation arithmetic and the decision rule are the sixth test's, and that test's selection effects
(appendix C of `rulebooks/qbtc2x.md`) carry over. After registration, one cross-check comparison gained an
absolute floor (not part of the verdict arithmetic; before the results were read), and three labels of the
check script and one reported cell (90 minutes with 1.9: 0.5563 → 0.5562) were corrected after the results
were seen (not part of the verdict arithmetic). The track was chosen after the results (above). The 1.75
target is run after this verdict and disclosed as a run made after the 1.5 results were seen; it does not
touch this rulebook.

## The standard

Listed single-stock 2× products (Hong Kong, Korea, United States) state the same thing in their offering
documents: a multiple of the underlying's **daily** return, reset once a day, and no promise of the
multiple over periods longer than a day. The law in those places sets only a ceiling. This product follows
that definition at a multiple of 1.5 (owner, 2026-10-13); the offering document of a US-listed single-stock
1.5× product states the same at 1.5 ("Tested, and not tested" gives the filing). The standard does not fix the reset time of an asset that trades around
the clock, and listed products have no intraday de-leverage trigger: 00:00 UTC and the trigger are ours.
On a day the trigger fires, the day's return departs from 1.5× the underlying's.

## Margin at one-minute resolution

A variant is eligible only if, from λ = 2.3, a fall 1.25 times the deepest fall within one check interval
stays under the 86% liquidation line, with falls measured from every minute of the decision window
(from 2017-09-01, UTC) to the lowest one-minute low within the interval. For ether the deepest 15-minute
fall in that window is −23.5206%. At λ ≥ 2.3 the fall takes the loan-to-value to 80.06%, a check may be up
to 22 minutes late before the margin is gone (129 minutes at a factor of 1.0), and missing one check
entirely takes it to 84.25%, still inside. Without a trigger, the daily reset alone reaches 102.68%. The
factor 1.25 is a policy value, not a probability, and 86% is a placeholder for a lending market's
liquidation line, not a confirmed term. The margin is computed without interest. The range of liquidation
lines over which the same rule returns the same value was not computed; a different line needs a new verdict.

**Over the full history no variant is eligible.** Before the window, the Binance bar of 2017-08-22 04:00
UTC opened at a low of 144.21 after a close of 280.00 (−48.5% in one bar; three other venues' lows for that
hour were 4.6–5.0% below their opens). With it, the deepest 15-minute fall is −53.94%, and the margin would
need a trigger below 1.389 — below the 1.5 target itself. The window from 2017-09-01 is the test's
pre-registered value; the owner confirmed it on 2026-10-13.

**These values are for stage A only.** Before any real borrowing (stage B), eligibility is recomputed
against the real liquidation line and a new verdict is made, the market's oracle is compared with the
exchange bars, and an execution environment that keeps the 15-minute check interval (22 minutes of
lateness at most) is in place — how that is assured is decided before the stage-B decision, after the
actual run intervals are measured (owner, 2026-10-13). Stage B is a separate anchored decision.

## What the level assumes in place of a market

- **Liquidation.** At every bar, before any trade, the book is tested at the bar's low: if debt ÷
  collateral is 86% or more there, the level is zero and the series ends. A total loss is harsher than a
  market's partial liquidation; it is the tests' convention. That line is written only after a person has
  accepted it (below).
- **Costs.** 30 bp of notional per trade and 4.5% a year on the debt (set by the owner on 2026-10-13, as for
  qBTC2X; measured USDC borrowing had medians of 4.0–4.9% over the last 365 days in six pools — nothing was
  measured on GIWA). The test's verdict used 30 bp and 6% as the headline and ran 4.5% as a reference
  outside the verdict. These are assumptions, not measurements.
- **Timing.** The level assumes every check happens exactly on the grid and trades at that bar's close.
  When the keeper actually ran is written beside the level and not applied to it.
- **Fees.** The management fee is 1% a year (a price set by the owner on 2026-10-13; it can only be
  lowered). It is not collected yet: it is not applied to the stage A level, so the published level is
  before the fee, and there is no vault to charge it.

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
never filled. A day whose bars would end the series in a model liquidation halts it the same way: no line
or anchor until a person has compared that low with other venues' bars for the same minutes and accepted
that exact liquidation (the day, the sha256 of its one-minute bars, the bar and the debt ÷ collateral at
its low); the level-0 line then names the acceptance (`liquidationAccepted`), and `scripts/verify.mjs`
fails a liquidation line without it.

## What this record does and does not show

It shows that the rule runs as written, without discretion, on bars anyone can re-pull and recompute. It
is not the record of a product: no asset is held, no rate is paid, no trade is filled. It shows nothing
about returns until it is long.

In the test's historical windows (30 bp · 6%, no fee) the rule ended at 0.3570 times its start from 2018
(ether held: 3.6486), 1.4010 from 2021 (3.6365) and 1.6128 from 2023 (2.2389), with drawdowns of daily
closes of −99.26%, −94.12% and −86.02%; with no costs, 0.5790, 1.8987 and 1.9349. The trigger fired once
in the 2018 window (2020-03-12) and never in the other two. Over 3,333 resampled 2,100-day paths (the 108
months from 2017-09 to 2026-08 drawn in six-month blocks, decision seed, 30 bp · 6%) the median ended at
0.5767 times its start; 1,869 paths ended below their start, 1,016 at or below 0.10 and 368 at or below
0.01; the median drawdown was −98.27%; the 5th, 25th, 50th, 75th and 95th percentiles were 0.0024, 0.0569,
0.5767, 6.17 and 159.6. At the level's convention (30 bp · 4.5%) the median was 0.6022. On the same paths,
ether held had percentiles of 0.0640, 0.5556, 2.5744, 12.46 and 114.6, 1,139 paths below the start and a
median drawdown of −88.97% — disclosed, not a benchmark. No path was liquidated, under any block
length or cost scenario, which follows from the margin and is not separate evidence — the paths reuse
days of history and cannot hold a bar deeper than those days hold. The drift from a simple 1.5× over 7, 30
and 90 days was not computed for this rule.

**Holding period and costs.** The product claims a holding period of one UTC day, from one 00:00 UTC reset
to the next; the measure of that period is the registered daily tracking difference, whose root mean
square was 0.0273%, 0.0159% and 0.0144% in the three windows. Held longer, it is not 1.5 times the
period's return: over the same 3,333 paths of 2,100 days the median ended at 0.7942 times its start with no
costs, at 0.6022 with 30 bp a trade and 4.5% a year to borrow, and at 0.5767 at 6%. Even with no costs the
median is below the start, so the share of a cost-free gain taken by costs is not defined; the median of
each path's cost (its cost-free end less its end with costs) is 0.1915 at 4.5% (0.2175 at 6%). Held that long it
loses at the median (2,100 days is the only path length resampled). It is built for short holding. The
owner chose this disclosure, in the form of qBTC2X's, on 2026-10-13.

Not claimed: that a real book would have kept this level; that the margin holds in a market whose
liquidation line is lower, whose oracle prints a deeper low than Binance spot, or whose keeper runs late;
that a fall deeper than any in the window cannot happen (the data hold one); that the book is better than
holding ether; that a 1.5× of ether's return over any period longer than a day is delivered. Any of the
first three can take a real book to zero.

## Tested, and not tested (pinned)

Parameter citation table: appendix P of `rulebooks/qeth15.md` at commit `3b355eaf3a8d55856b979fda706a40d3bf986a89`
(sha256 `c48aaec5595a2ee4423f13597e8aaf441bde5f47d2f2e2af319e7b3ecdb27409`); keeper provenance
`keeper/rulebooks/qeth15.provenance.json` (sha256 `49d7b93ae7991857e95756bd30c613f7c9df480539c9dac750f912025a2f2543`).
Checklist run record: `docs/methodology/checklist-runs/qeth15/2026-10-13.json` (site repository, private; sha256
`e3ca50416599f6bdab0228755a43616c124ad16a8af5976dec0bc2bd7793895a`). Every
evidence file the run record pins is a copy that can be published, in this repository; the two data inputs
(R09, R59) are the registered inputs in the site repository. The run record names no internal evidence file,
as the qBTC2X inception decision undertook for this decision. Gate report: `rulebooks/qeth15.gate.json` (sha256
`7bf3107f79ba929a92b735fac9a60ea36ce0152f914ba6295b81ee2914a235c4`). Track: trading tool (`track` in `keeper/rulebooks/qeth15.json`) —
a product that gives the exposure of a set short holding period (one UTC day); values the owner set without a
test are disclosed as exceptions, each with its reason and expiry.

| Basis | Count | Parameters |
| --- | --- | --- |
| Tested — pre-registered backtest and Monte Carlo | 2 | P06 trigger λ ≥ 2.3 · P07 check interval 15 minutes (the output of the "miss one check" track, which the owner chose on 2026-10-13 after the results) |
| Partly tested — backtest only, or run without pre-registration | 0 | — |
| Definition | 4 | P01 underlying, ether alone · P02 what the book never holds · P03 price source, Binance spot 1-minute → 15-minute closed bars, no fallback · P22 stage-B execution reference (not built) |
| Price | 1 | P18 management fee 1% a year (owner, 2026-10-13; not applied to the stage A level, not collected) |
| Exception — not tested, decided by the owner, disclosed with its reason and expiry (trading-tool track only) | 10 | product definition 5: P04 target 1.5 · P05 daily reset · P12 back to exactly 1.5 after a trigger · P13 reset at 00:00 UTC · P14 trigger reduces leverage only, no intraday re-leverage — model assumption 5: P09 margin factor 1.25 · P11 liquidation line 86% (a placeholder) · P15 exchange gaps are not filled · P16 a model liquidation is a total loss and ends the series · P17 the level's cost convention, 30 bp and 4.5% a year |
| Not tested — listed in the rule audit | 1 | P25 15-minute bars (the test's simulation step; the keeper reads it) |

Values this decision introduces: every value above is new. Ten of them are exceptions, decided by the owner
on 2026-10-13 and listed here; one (P25) is not tested. All eleven are entered in the rule audit register
(site repository, private), the exceptions with their expiry. The check grid (P08) is arithmetic — every
15 minutes from the 00:00 UTC reset, so every bar close; the deposit cap (P19) and the mark gate (P24) do not
exist because there is no vault; a rule for a late check (P20) and a borrowing-rate ceiling (P21) are absent
because no candidate rule was tested (limits, below).
The citation gate (report-only) does not pass this decision. Its report of 2026-10-14 reads "fail" with 24
violations: one value it introduces is not tested (P25, C6); the checklist run record still has one open step,
the public block (C4); the launch checks are internal records the run record does not pin (C4, two); the page
block is not yet in the form the gate reads (C10, 20).
The owner decisions the run record cites — the track and the ten exceptions — are quoted in this repository at
`docs/owner/qeth15-decisions-2026-10-13.md` (sha256 `84bbf12d2e19d9face2ee82322caf49bdfc09195f88988ea6dfc4617216abd29`).

| Parameter | Value | Why it is not tested | Owner decision | Tested again when | Measured effect |
| --- | --- | --- | --- | --- | --- |
| P04 | 1.5 | product definition — the objective (the gap to 1.5 times the day's return) is defined by this value, and the standard is outside: a US-listed single-stock 1.5× product states its objective as "150% of the daily performance" and sets none for other periods (below) | 2026-10-13 | never — it defines the product | not measurable — the objective is defined by this value |
| P05 | daily reset | product definition — the same standard resets once a day | 2026-10-13 | never — it defines the product | not measurable — the same reason; the band versions are comparison numbers only |
| P12 | back to 1.5 after a trigger | product definition — set by the target | 2026-10-13 | never — it defines the product | not measurable — the same reason |
| P13 | reset at 00:00 UTC | product definition — the objective's day is defined by this boundary; the standard sets "once a day", not the hour of an asset that trades around the clock, so the hour is ours | 2026-10-13 | never — it defines the product | not measurable — another hour measures another day |
| P14 | reduce only, no intraday re-leverage | product definition — the standard's products do not raise leverage during the day; the intraday trigger is ours | 2026-10-13 | never — it defines the product | not measurable — intraday re-leverage is another product |
| P09 | margin factor 1.25 | model assumption — the real liquidation line, oracle lows and execution delays are not known yet | 2026-10-13 | before the stage-B decision | static margin rows, factor 1.0 column: at 15 minutes and 2.3 the loan-to-value reaches 73.90% and a check may be 129 minutes late (80.06% and 22 minutes at 1.25) |
| P11 | liquidation line 86% | model assumption — no lending market's line is known yet | 2026-10-13 | before the stage-B decision, against the real market's line | not measurable — the range of lines that keeps the same output was not computed; another line needs a new verdict |
| P15 | gaps not filled | model assumption — how a real execution meets an exchange gap is an outside fact | 2026-10-13 | before the stage-B decision | not measurable — the effect of gaps was not measured separately |
| P16 | model liquidation = total loss | model assumption — a real market's partial liquidation rule is not known yet | 2026-10-13 | before the stage-B decision | the result file has no liquidation in any window or path, so the assumption touched no number |
| P17 | 30 bp · 4.5% a year | model assumption — the real borrowing rate and fill cost are outside facts (measured USDC borrowing, 365-day medians 4.0–4.9% in six pools, as for qBTC2X) | 2026-10-13 | before the stage-B decision, with rates measured on GIWA | `mc_end` rows of the result copy: 2,100-day median 0.7942 with no costs, 0.6022 at 30 bp · 4.5%, 0.5767 at 30 bp · 6% |

Pre-registration commit: `d7fec51` on the site repository's main (ETH 1.5x daily-reset test). Result files — every test file this decision
pins is a copy that can be published, in this repository at `docs/research/leverage/eth-1p5/` (map:
`MANIFEST.sha256` in the same folder — it checks with `shasum -a 256 -c`; notes in `MANIFEST-notes.md`): results `results-1.5-p2-public.csv.gz` sha256
`31886fbd30539434c04bb7ba385675758f86160a8aa17863c9c1a65e23821e32` (uncompressed
`f216afb3ea07c53afc356909360744e7e860aab1eb83aa78ecf83e08369d6faf`); results document `results-1.5-public.md`
sha256 `c51f1894c29c270dd1f0179d6cc17559a501af076b8568a44d75e55042ad2410`; registration `README-public.md`
sha256 `4297018ab08b3eea639cbb06cd15bbbf26afcd67e29f187cb8804c3dfa93141e`; registration constants
`REGISTRATION-public` sha256 `fbdf5f3a3792996701a8493e8837554531051f21db6e88906753b9f9f6911e5a`;
post-registration changes `post-registration-change-1-public.md` sha256
`0296ec391a18e4be08dc85156d427ffffa364b5b9f7b24b18ea7b7b01d5df878` and `post-registration-change-2-public.md`
sha256 `cbe99591943811ef642c3bd484025d5e35d295802199df085c921ce1111a797c`; the two independent check reports
`verify-ga-report-public.csv` sha256 `ca4e9625786bf376fa80024912fc94560066825914b03649576e7729c7f77cf1` and
`verify-na-report-public.csv` sha256 `3538f2df2b849816eaaa17f79fb444e76798cf19b772a183fadfbdc8a6b725b5`. The
copies differ from the registered outputs (site repository, private) only in text: internal work-item
numbers, worker-decision numbers, internal record references and a form of address are replaced by neutral
words; in the registration copy the execution plan and the run instructions (execution environment, work
assignment, internal operations) are each replaced by one line saying they are an internal record, and quoted
owner words by "owner decision (private record)"; two CSV section names are renamed (`mc_end`, `mc_cost`); in the CSV copies every numeric cell is
byte-identical and the row count is the same (appendix C of the rulebook lists what changed). The check
scripts are not among the pinned copies; their two reports are.
The outside standard for P04 and P05: SEC EDGAR, summary prospectus (Form 497K) filed 2022-09-07, accession
number 0001193125-22-239112, `https://www.sec.gov/Archives/edgar/data/1424958/000119312522239112/d330896d497k.htm`
(the file as retrieved on 2026-10-13 has sha256 `96717442256736e4dd4de55d05350f8d0d170068c4d7551a2daf252b99cefb9b`);
its investment objective is daily results of 150% of the underlying's daily performance, and it sets no
objective for a period other than a trading day.
Policy values of the decision rule (in the registration; not rule values): the doubled unchecked window of the
"miss one check" track — registered, sensitivity not run; the margin factor 1.25 — registered, also disclosed
as exception P09, sensitivity: the factor 1.0 column of the static margin rows; the decision window from
2017-09-01 (P23) — registered, confirmed by the owner for ether on 2026-10-05 and for this product on 2026-10-13, sensitivity: the full-history column of
the static margin rows (no eligible variant).
Before this anchor, the keeper's day-by-day arithmetic at 15 minutes and 2.3 was compared with the registered
engine's continuous simulation (`keeper/test/leverage-engine-diff-eth15.test.mjs`): every day-end equity of
2017-09-01 to 2026-09-29 (3,316 days) is equal at 30 bp · 4.5% and at 30 bp · 6%, with one trigger and no
liquidation in both; evidence `docs/research/leverage/eth-1p5/evidence/engine-diff-2026-10-13.txt` (sha256
`51c2fd1eefb6cfb9257e1ee5ddf55097c1e62ea586ec249a6543d09e77653e07`).
Checks not run for this product, and why: holdability of collateral and debt on GIWA (R08) — not applicable
with nothing held, required before stage B; security items R44–R46 — no new contract code and no vault; roles
on chain (R64) — no vault. One item that applies only in some cases was not run: a distinctness measurement
against listed daily-1.5× products (R03). The overfitting account (R16) is the registration's own count of the
variants tried (`README-public.md`, lines 46-47 and 118).
A red-team proof-of-concept pass over the new keeper code (R47) ran on 2026-10-14
(`docs/research/leverage/eth-1p5/evidence/red-team-2026-10-14.txt`, tests
`keeper/test/leverage-redteam-eth15.test.mjs`): no wrong level from honest inputs; six weaknesses, none high. The
four low ones are fixed in this change; the re-pin of the keeper files shared with qBTC2X is stated below; the
public check against the website's copy of the record (`verify.mjs --base`) needs this series' files on the
website before 2026-10-17 00:00 UTC, which is the website's deployment, not this repository's.

Judgments — values that differ from the decision rule's output: none. The tested values (P06, P07) are the
decision rule's output on the track the owner chose.

## Keeper code shared with qBTC2X

The qBTC2X inception decision (`2026-10-13-qbtc2x-paper-inception`) pins three files this series also runs on.
This decision changes all three — the target leverage may be 1.5 or 2, a rulebook JSON that still lists owner
decisions (`pendingOwner`) is refused, the series `qeth15` is added, and a fork URL is judged by its host — and
pins the new bytes:

| File | Pinned by the qBTC2X inception decision | Pinned by this decision |
| --- | --- | --- |
| `keeper/leverage-index.mjs` | `1e2a1e6a7e13a623c4a52619e10127ddbd25061913eaa397cc07b09ceca258fb` | `71b617af9e30a09f1f53a79854f81c9b886cac06bad48db01577dea0ad43fc59` |
| `keeper/leverage-step.mjs` | `0266e0f339813591be3584cef41c5107533b83a2df1cd49aab5c68d4a0880e25` | `ababc503d9ef28cc98ff74e3fff1a6f6826f21bc174b341725fe62bcda0fa1f4` |
| `scripts/verify.mjs` | `ecc5d13bee9ed0c83465502e8ad2a69a48128a99bff7b6bdc1d1cde0f216a992` | `a346b0f51378638c5edba8d7b9f89588f0d1f2501a662b2ef30fecf9c5df8114` |

The qBTC2X rule, level and lines do not change: `keeper/test/leverage-redteam-eth15.test.mjs` computes the same
qBTC2X days with the files the qBTC2X decision pins and with these files, and the book, check log and level are
the same. From this anchor the qBTC2X series runs on the files in the right-hand column.

## Known limits, stated at the start

The margin above is the deepest recorded fall in the window times 1.25 and nothing more: a deeper fall —
the data already hold one, before the window — a market whose oracle prints a deeper low than one
exchange's one-minute bar, or a liquidation line below the placeholder can each take a real book to zero.
The shortest interval tested is 15 minutes, and it is the output. A one-minute low can be a single trade.
The data are one exchange's spot bars; checks are assumed to fill at the bar's close with no gas,
congestion or delay.

A wrong one-minute low does not end this series by itself: the run that meets a low at which debt ÷
collateral reaches 86% writes and anchors nothing and opens the failure issue; only a person's acceptance
lets the next run write the level-0 line. What remains: until a person decides, the series has no new
line; a person who accepts a wrong low ends the series; a low judged wrong leaves the series halted,
because the code that would continue it from a corrected book is not written yet and continuing needs an
anchored correction decision.

If Binance is unreachable, or a day's one-minute bars are incomplete, no line is written and the series
waits; no other exchange's bars stand in. A day is never written before it has ended.

No rule covers a keeper that misses the interval, a borrowing rate above a ceiling, an oracle failure or a
sequencer halt: none has been tested, so none is in the rulebook. A wrong line that is already anchored is
answered by an anchored correction decision; the code that would continue the series from a corrected book
is not written yet. There is no vault, so there is no deposit cap and no mark gate; a decision that deploys a
vault sets them.

The gate report pinned by the qBTC2X inception decision (`rulebooks/qbtc2x.gate.json`) records its track as
"general", although qBTC2X is on the trading-tool track (owner, 2026-10-06). A correction decision is separate.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix-track-record (rulebook, rulebook JSON, keeper, verifier, publishable test copies `docs/research/leverage/eth-1p5/`; the provenance file, the gate report and the owner-decision extract are added with this decision and pinned by sha256 above) | `3b355eaf3a8d55856b979fda706a40d3bf986a89` |
| quadrix (site, private — checklist run record; the commit the gate report was run on) | `119b02c6d07d7bd4b8c7697557678170495cebf6` |
