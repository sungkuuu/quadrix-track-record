# qETH1.5X P24 mark gate — measured size: days the daily level moved outside ±25%

Measured: 2026-10-20, about 02:40 UTC (one local run, 0.4 s). Data range: UTC days 2017-09-01 … 2026-09-29 (3,316 days),
15-minute ETHUSDT bars 2017-08-17 04:00 … 2026-09-29 23:45 UTC. Source: Binance spot bars, the registered input of
the ETH 1.5x daily-reset test (`ethusdt-15m.csv.gz`, sha256 `323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478`),
run through the registered test engine (`leverage-eth15.mjs`, sha256 `63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596`,
registration commit `d7fec51`; both files in the site repository, private: `docs/research/leverage/params-v6/` and
`docs/research/leverage/eth-1p5/`). Rule: `keeper/rulebooks/qeth15.json` (target 1.5, check every 15 minutes,
trigger 2.3).

## Result

| Convention | Days outside ±25% | Of them since 2023-01-01 | Largest daily move | Marks the largest move needs |
| --- | --- | --- | --- | --- |
| 30 bp · 4.5% a year (the recorded level, `level.primary`) | **23 of 3,316** | 3 | 2020-03-12, **−65.66%** | **4** |
| 30 bp · 6% a year (the test headline; the convention of the qBTC2X measurement) | 23 of 3,316 | 3 | 2020-03-12, −65.67% | 4 |

- 22 of the 23 days need 2 marks; one day (2020-03-12) needs 4. No day of the span ends in a model liquidation,
  and the trigger fires on one day.
- Days with a move above 15%: 148 (24 since 2023-01-01).
- For comparison, the qBTC2X rulebook (`rulebooks/qbtc2x.md` §13) states for its rule over the same 3,316 days:
  28 days outside ±25% (1 since 2023), largest 2020-03-12 −69.3%, 5 marks.
- "Outside ±25%" means a day-end level ÷ the previous day-end level above 1.25 or below 0.75. The vault contract
  accepts a move of up to 25% per mark, bounds included (`MAX_NAV_MOVE_BPS = 2_500`).

## What is measured, and why the 1.5x level

The P24 row of the decision asks how often the daily level moved more than the contract's bound and how many marks
the largest move needs. The mark vault is marked to the qETH1.5X level ÷ 100 once a day, as the qBTC2X mark vault is marked to
its level (`rulebooks/qbtc2x.md` §13: line, anchor, mark), so the move the vault must take is the move of the
**1.5x level**, not of ETH spot. The qBTC2X measurement it follows was made the same way, on the 2x level of its own
rule (120 minutes, trigger 2.2), not on bitcoin spot.

## Method

The same method as the qBTC2X stage-A design measurement: the arithmetic is not re-implemented. Four functions —
`bigFlags`, `makeBars`, `interestTable`, `simulate` — are cut verbatim out of the registered engine file (after its
sha256 is checked) and evaluated with the rule read from `keeper/rulebooks/qeth15.json`; this is also how
`keeper/test/leverage-engine-diff-eth15.test.mjs` compares the keeper's level with the engine. A daily-reset book
stands at exactly 1.5 at every day end, so each UTC day is simulated on its own from the previous day's last close,
and the day's move is that day's end equity ÷ 1.

Cross-check, in the same run: one continuous simulation over the whole span gives day-end equity ratios equal to the
one-day runs (largest difference 3.6e−15), and its final equity (0.8115115505163987 at 4.5%, 0.7579201115058127
at 6%) equals the figures in `engine-diff-2026-10-13.txt` in this folder.

Marks needed are counted two ways, with the same answer: as the qBTC2X measurement (fewest moves of at most 24%
each), and with the keeper's own step list (`markSteps` in `keeper/leverage-step.mjs`: each step the contract's own
bound, old ± old × 2,500 ÷ 10,000 in 6-decimal integer units), from a share price of 1.000000.

Not a pre-registered test: this is a measurement of the size of the exception, made before the anchor. It does not
compare "no stop" with any other gate.

## Reproduce

From the root of this repository, with the two input files from the site repository:

```
P24_ENGINE=<site>/docs/research/leverage/eth-1p5/leverage-eth15.mjs \
P24_DATA=<site>/docs/research/leverage/params-v6/ethusdt-15m.csv.gz \
node docs/research/leverage/eth-1p5/evidence/p24-daily-moves.mjs
```

Script: `docs/research/leverage/eth-1p5/evidence/p24-daily-moves.mjs` (Node 22; no packages). It stops if either
input's sha256 differs from the registered value.

## Output (verbatim)

```
engine leverage-eth15.mjs sha256 63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596; functions cut: bigFlags, makeBars, interestTable, simulate; LLTV 0.86
input ethusdt-15m.csv.gz sha256 323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478; 319195 bars 2017-08-17T04:00 … 2026-09-29T23:45 UTC
rule keeper/rulebooks/qeth15.json: target 1.5, check 15 min, trigger 2.3; region [2017-09-01, 2026-09-30) UTC days

== 30 bp · 4.5% a year (the recorded level, level.primary)
days 3316 (2017-09-01 → 2026-09-29); model liquidations none; trigger days 1
continuous-run cross-check: final equity 0.8115115505163987, liquidation false, max |ratio difference| 3.55e-15
daily level outside ±25%: 23 days (since 2023-01-01: 3) by year {"2017":6,"2018":3,"2019":1,"2020":3,"2021":4,"2022":3,"2024":1,"2025":1,"2026":1}
  2017-09-04 -25.50% · 2017-09-14 -33.48% · 2017-09-15 +26.29% · 2017-12-11 +28.51% · 2017-12-12 +32.76% · 2017-12-22 -28.12% · 2018-01-16 -32.04% · 2018-09-05 -29.90% · 2018-12-28 +28.29% · 2019-09-24 -26.49% · 2020-03-12 -65.66% · 2020-03-13 +36.44% · 2020-04-06 +30.06% · 2021-01-03 +39.39% · 2021-01-21 -29.03% · 2021-05-19 -41.67% · 2021-05-24 +39.43% · 2022-07-18 +27.11% · 2022-11-09 -26.12% · 2022-11-10 +26.69% · 2024-05-20 +28.80% · 2025-05-08 +32.77% · 2026-08-19 +26.15%
daily level |move| > 15%: 148 days (since 2023-01-01: 24)
largest daily move: 2020-03-12 -65.66%; steps (≤24% each, as qBTC2X §13): 4; keeper markSteps from 1.000000: 4
next largest: 2021-05-19 -41.67% · 2021-05-24 +39.43% · 2021-01-03 +39.39% · 2020-03-13 +36.44%
days outside ±25% by steps needed — ≤24% rule {"2":22,"4":1}; keeper markSteps {"2":22,"4":1}

== 30 bp · 6% a year (the test headline; the convention of the qBTC2X §13 measurement)
days 3316 (2017-09-01 → 2026-09-29); model liquidations none; trigger days 1
continuous-run cross-check: final equity 0.7579201115058127, liquidation false, max |ratio difference| 3.33e-15
daily level outside ±25%: 23 days (since 2023-01-01: 3) by year {"2017":6,"2018":3,"2019":1,"2020":3,"2021":4,"2022":3,"2024":1,"2025":1,"2026":1}
  2017-09-04 -25.50% · 2017-09-14 -33.48% · 2017-09-15 +26.29% · 2017-12-11 +28.50% · 2017-12-12 +32.76% · 2017-12-22 -28.13% · 2018-01-16 -32.04% · 2018-09-05 -29.90% · 2018-12-28 +28.29% · 2019-09-24 -26.49% · 2020-03-12 -65.67% · 2020-03-13 +36.44% · 2020-04-06 +30.06% · 2021-01-03 +39.38% · 2021-01-21 -29.03% · 2021-05-19 -41.68% · 2021-05-24 +39.43% · 2022-07-18 +27.11% · 2022-11-09 -26.12% · 2022-11-10 +26.69% · 2024-05-20 +28.79% · 2025-05-08 +32.76% · 2026-08-19 +26.15%
daily level |move| > 15%: 148 days (since 2023-01-01: 24)
largest daily move: 2020-03-12 -65.67%; steps (≤24% each, as qBTC2X §13): 4; keeper markSteps from 1.000000: 4
next largest: 2021-05-19 -41.68% · 2021-05-24 +39.43% · 2021-01-03 +39.38% · 2020-03-13 +36.44%
days outside ±25% by steps needed — ≤24% rule {"2":22,"4":1}; keeper markSteps {"2":22,"4":1}
```
