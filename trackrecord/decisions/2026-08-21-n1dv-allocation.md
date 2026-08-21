# Allocation decision — N1DV, 2026-08-21

**Effective:** 2026-08-21 (UTC), forward only.

## What changed

| Sleeve | Before | After |
| --- | --- | --- |
| USDT — working capital | 40% | 30% |
| BTC | 20% | 25% |
| ETH | 20% | 20% |
| HYPE | 10% | 15% |
| PENDLE | 5% | 5% |
| AERO | 5% | 5% |

Ten percentage points move from the working-capital sleeve to the growth sleeve;
the split goes from 40 / 60 to 30 / 70.

## Why

The halving cycle leaves open the possibility that the low is behind us. That is a
possibility, not a conviction, and it is recorded here as the reason for reducing the
working-capital sleeve — not as a forecast, and not as a claim about where the market
goes next. The vault does not predict cycles; it decides how much of the book is
exposed to them.

## What this is not

N1DV holds no capital at this time. This is a change to the strategy definition, not
an executed trade: nothing was bought or sold on the strength of this decision, and no
performance is claimed from it.

## Effect on the published record

The revision applies forward from its effective date. Every day before 2026-08-21
remains simulated under the previous weights and is not recomputed — the curve behind
the revision is left as it was. The revision is marked on the N1DV chart and listed in
the vault's allocation history.

## Verifying this document

This file's SHA-256 is committed to GIWA Sepolia as transaction calldata
(`qxdec:<hash>`) and is carried in the daily track record from its effective date
onward, so the date of this decision does not rest on our word. To check it:

```
shasum -a 256 2026-08-21-n1dv-allocation.md
```

and compare against `/trackrecord/decisions.jsonl` and the anchor transaction it names.
Editing a single character of this file breaks that match.
