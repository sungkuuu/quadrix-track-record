# qETH1.5X P24 mark gate — independent check of the measured size

Checked: 2026-10-20 (one local run, about 1.5 s). What is checked: the figures of
`p24-daily-moves-2026-10-20.md` in this folder — the days of 2017-09-01 … 2026-09-29 on which the daily level moved
outside ±25%, the largest move, and the marks it needs.

## Method

A second implementation, written from the text of the rulebook alone (`rulebooks/qeth15.md` §2 · §4 · §5 · §8 of
this repository), without the measurement script `p24-daily-moves.mjs` and without the registered test engine.
Python standard library only. Each UTC day starts at leverage 1.5 at the previous day's last 15-minute close; every
bar, the debt accrues at the yearly rate, the book is liquidated (equity 0) if the bar low takes debt ÷ collateral
to 86% or more, and the collateral moves to the close; at a close that is not the day's last, leverage of 2.3 or
more is traded back to 1.5; at the day's last close the book is reset to 1.5; each trade costs 30 bp of the traded
notional. The day's move is the day-end equity ÷ 1. Marks are counted two ways from a share price of 1.000000: with
the contract's bound per mark (old × 2,500 ÷ 10,000 in 6-decimal integer units) and as the fewest moves of at most
24% each.

Input: `ethusdt-15m.csv.gz`, the registered input of the ETH 1.5x daily-reset test (site repository, private:
`docs/research/leverage/params-v6/ethusdt-15m.csv.gz`, sha256
`323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478`; the script stops if it differs).
Script: `docs/research/leverage/eth-1p5/evidence/p24-independent-check.py` (sha256 `601ad5799f1f005182e5869ba83e8dfb0ec2849fa3546d78d22031be22c011e6`).
Convention: 30 bp · 4.5% a year (the recorded level, `level.primary`).

## Result

| Figure | Measurement (`p24-daily-moves-2026-10-20.md`) | Independent check |
| --- | --- | --- |
| Days in the span | 3,316 | 3,316 |
| Days outside ±25% | 23 (3 since 2023-01-01) | 23 (3 since 2023-01-01) — the same 23 dates |
| Largest daily move | 2020-03-12, −65.66% | 2020-03-12, −65.66% |
| Marks the largest move needs | 4 | 4 (both counts) |
| Marks by day, days outside ±25% | 22 days need 2, one day needs 4 | {2: 22, 4: 1} |
| Days with a move above 15% | 148 | 148 |
| Trigger days · model liquidations | 1 · 0 | 1 (2020-03-12) · 0 |

One difference: 2017-12-11 is +28.51% in the measurement and +28.50% here (0.01 percentage point). The check models
the trading cost more simply than the registered engine; no count and no date changes.

## Reproduce

From the root of this repository, with the input file from the site repository:

```
python3 docs/research/leverage/eth-1p5/evidence/p24-independent-check.py <site>/docs/research/leverage/params-v6/ethusdt-15m.csv.gz
```

## Output (verbatim)

```
input sha256 323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478 OK
rate 0.045 cost 30bp; days 3316 (2017-09-01 → 2026-09-29); trigger days 1 [datetime.date(2020, 3, 12)]; liquidations []
days outside ±25%: 23 (since 2023-01-01: 3)
  2017-09-04 -25.50% · 2017-09-14 -33.48% · 2017-09-15 +26.29% · 2017-12-11 +28.50% · 2017-12-12 +32.76% · 2017-12-22 -28.12% · 2018-01-16 -32.04% · 2018-09-05 -29.90% · 2018-12-28 +28.29% · 2019-09-24 -26.49% · 2020-03-12 -65.66% · 2020-03-13 +36.44% · 2020-04-06 +30.06% · 2021-01-03 +39.39% · 2021-01-21 -29.03% · 2021-05-19 -41.67% · 2021-05-24 +39.43% · 2022-07-18 +27.11% · 2022-11-09 -26.12% · 2022-11-10 +26.69% · 2024-05-20 +28.80% · 2025-05-08 +32.77% · 2026-08-19 +26.15%
largest: 2020-03-12 -65.66%; marks (contract bound, from 1.000000) 4; fewest ≤24% moves 4
marks by day (contract bound): {2: 22, 4: 1}
days |move| > 15%: 148
```
