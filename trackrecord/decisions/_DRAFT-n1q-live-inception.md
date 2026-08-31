# LIVE inception — N1Q, {{EFFECTIVE_DATE}}

**Effective:** {{EFFECTIVE_DATE}} (UTC), forward only.

> ⚠️ DRAFT — not anchored. Fill `{{EFFECTIVE_DATE}}`, `0x9C0e27Be3c541373ce4f47f6df9b4023E999Ce6A`, and the
> executed amounts, rename the file to `{{EFFECTIVE_DATE}}-n1q-live-inception.md`,
> then anchor. Nothing in this file is final until it is anchored.

## What this is

The first capital enters the vault. From this date the record carries a **LIVE**
series, kept in its own files and never concatenated with the DRY_RUN series that
precedes it (spec §8). The DRY_RUN series is not restated, not extended, and not
joined to this one; it stands as what it was — proof that the pipeline ran before
there was anything to report.

| | |
| --- | --- |
| Vault | Nexus One Quality Vault (**N1Q**) |
| Venue | Enzyme Onyx, Arbitrum |
| Address | `0x9C0e27Be3c541373ce4f47f6df9b4023E999Ce6A` |
| Capital at inception | {{AMOUNT}} USDC, own funds |
| Fees | 0% management / 20% performance, high-water mark |

The vault was named **Nexus One Deep Value (N1DV)** through 2026-08-26 and renamed
before creation. The ticker N1DV appears in records predating this document and in
the anchored allocation decision of 2026-08-21; those are left exactly as they were.

## Allocation at inception — and where it departs from the target

The allocation in force is the one anchored on 2026-08-21. It is not executed in full
at inception:

| Sleeve | Target | Executed | Gap |
| --- | --- | --- | --- |
| USDC — working capital | 30% | **50%** | +20pp |
| BTC | 25% | 25% | — |
| ETH | 20% | 20% | — |
| HYPE | 15% | **0%** | −15pp |
| PENDLE | 5% | 5% | — |
| AERO | 5% | **0%** | −5pp |

**Why.** HYPE and AERO are not reachable from an Arbitrum vault without bridging, and
bridging them for a position of this size would cost more in risk and friction than the
position is worth. The twenty percentage points sit in USDC until they can be executed
on their own chains or the sleeve is revised. This is an execution constraint, recorded
as such — not a change to the strategy, and not a view on those assets.

The gap is published on the vault page for as long as it persists. Closing it will be
its own decision document, or the target will be revised in one; it will not be quietly
reconciled.

## What this is not

**This is not a track record of managing other people's money.** The capital is our own.
A curve built on own funds is evidence of discipline and of a pipeline that runs — it is
not traction, and it is not presented as such. The first third-party deposit, whenever it
comes, is the milestone that changes that sentence.

**No performance is claimed from the DRY_RUN series.** It had no book.

**The amount is small on purpose.** What is being started here is the clock, not a
position. Time is the one input that cannot be bought later.

## Effect on the published record

From {{EFFECTIVE_DATE}} the daily record runs in LIVE mode against the vault at
`0x9C0e27Be3c541373ce4f47f6df9b4023E999Ce6A`. Benchmarks continue from the same source (Binance daily close,
BTC and ETH) and are flagged, never backfilled, when a day is missing.

## Verifying this document

This file's SHA-256 is committed to GIWA Sepolia as transaction calldata
(`qxdec:<hash>`) and is carried in the daily track record from its effective date
onward, so the date of this decision does not rest on our word. To check it:

```
shasum -a 256 {{EFFECTIVE_DATE}}-n1q-live-inception.md
```

and compare against `/trackrecord/decisions.jsonl` and the anchor transaction it names.
Editing a single character of this file breaks that match.
