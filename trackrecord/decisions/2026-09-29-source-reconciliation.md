# qREV, Triens, qAI — two market-data sources reconciled for listing age and the issuance fallback, decided 2026-09-29

> **DRAFT — NOT ANCHORED.** Written 2026-09-29 on branch `keeper/source-reconciliation` for the owner to confirm. Two
> things are open before this can be anchored: the effective date below, and the impact section, whose dry run has not
> been run (see "Impact on the 2026-10-01 reconstitution"). This block is removed when the document is finalised; the
> anchored text is whatever the owner confirms.

**Decided:** 2026-09-29 (owner). **Effective:** at the first keeper run on or after 2026-10-01 — the scheduled quarterly
reconstitution, which is the only run at which either rule is read (both are eligibility and weighting inputs, computed
only at a reconstitution). *Effective date to be confirmed by the owner.* **Series:** `trackrecord/record-qrev.jsonl`,
`trackrecord/record-triens.jsonl`, `trackrecord/record-qai.jsonl`, unchanged until that run.

## What changes

Where a rule reads a quantity that CoinMarketCap and CoinGecko both publish, the keeper reads both, takes the one that
serves the rule — not an average — and discloses the other when the two disagree. The owner's words: "합치되 평균이
아니라 규칙의 목적에 맞는 쪽을 택하고 불일치는 공개" (reconcile them; not an average — take the side that fits the
rule's purpose, and disclose the disagreement).

| Rule | Until the 2026-10-01 reconstitution | From it |
| --- | --- | --- |
| Listing age ≥ 365 days — Triens Quality sleeve (`triens.md` §2) | the CoinGecko proxy alone: the earlier of `ath_date` and `atl_date` (the rulebook text said "CMC listing date") | counted from the **earlier** of CoinMarketCap `dateAdded` and the CoinGecko proxy; either alone when the other is missing |
| Listing age ≥ 365 days — qAI (`qai.md` §2, D5) | CoinMarketCap `dateAdded`; the proxy only when it was missing | counted from the **earlier** of the two; either alone when the other is missing |
| Issuance over the trailing 12 months when the on-chain supply registry cannot measure a name (census incomplete, under a year of weekly history, or no weekly point within 10 days of the run) — qREV (`value-capture.md` §8; nets the weight, and is the chain tokens' net-burn test) and Triens (`triens.md` §8; the A-1 gate, issuance ≤ holder revenue) | CoinGecko alone: circulating supply today against market cap ÷ price on (date − 365 days) (both rulebooks said "CMC circulating supply") | the **larger** of that and CoinMarketCap's: `circulatingSupply` today (data-api listing) against `circulatingSupply` in the historical listing of (date − 365 days). A source that cannot measure the name is skipped; neither = unmeasured (Triens: fails the gate, D7) |

qREV and qDEFI keep the CoinGecko proxy for listing age — their rulebooks name it (`value-capture.md` §2,
`qdefi.md` §2) and this decision does not change it.

## Disclosure on the record line

| Field | When | Meaning |
| --- | --- | --- |
| `listingSource` | Triens and qAI rows, at a reconstitution | `cmc-date-added` or `ath-atl-proxy` — which source supplied the earlier date |
| `listingDateCmc`, `listingDateGecko`, `listingDisagreement: true` | the two listing dates are more than **90 days** apart | both dates |
| `issuanceSource` | qREV and Triens rows, at a reconstitution | `onchain-registry`, or `coingecko` / `cmc` — whichever supplied the larger value (`-census-incomplete` appended when the registry census is incomplete) |
| `issuanceGecko`, `issuanceCmc`, `issuanceDisagreement: true` | the two issuance values differ by more than **5%** of the larger | both values, in USD at today's price |

The thresholds (90 days, 5%) are disclosure thresholds, not gates: the rule always uses the earlier date and the larger
issuance, whatever the gap.

## Why these sides

**Issuance — the larger value.** The number is a pass/fail gate in Triens (issuance ≤ holder revenue) and a deduction
from the weight in qREV; the larger of the two sources is the conservative side of both.

**Listing age — the earlier date.** *The owner's reason is to be written here before anchoring.* Facts that bear on it:
the proxy is not a listing date — it reads a recent price extreme as youth (on 2026-09-22 it put VVV at 295 days
against a CoinMarketCap listing of 2025-01-28, and AKE at 73 against 2025-08-19); under the earlier-of rule both still
read from CoinMarketCap's record.

The rulebooks and the keeper disagreed on both points before this decision (rule audit 2026-09-29, M3 and M4,
`docs/research/rule-audit/review-opus-2026-09-29.md` in the site repository). A known consequence: `keeper/supply/supply-weekly.json`
ends 2026-09-13, so from 2026-09-24 no name has a weekly point within 10 days of a run and every qREV and Triens name
takes the fallback until the supply pipeline is refreshed.

## Impact on the 2026-10-01 reconstitution

**Not yet measured.** The comparison — the keeper at `keeper/source-reconciliation` against the same code without this
decision, both run with `--dry-run --as-of 2026-10-01` on the same cached market data from a copy of the live state —
could not be run on 2026-09-29: CoinGecko's `coins/markets` answered HTTP 403 ("Request blocked") to the workstation that
prepared this draft, and without it the keeper falls back to CoinPaprika, which carries neither circulating supply nor
the ath/atl dates. The result goes here before anchoring: names in and out per index, and the gate that moved them.

What the rules can do, by construction: the listing age can only get older (the earlier of two dates, and the old qAI
rule already read CoinMarketCap first), so for Triens and qAI this decision can only **admit** a name the old rule aged
out, never remove one. Where CoinGecko could measure a name's issuance, the new value can only be larger, so for Triens
it can only **fail** a name the old rule passed and for qREV it can only lower a name's net revenue (its weight, or a
chain token's net-burn test); where CoinGecko could not and CoinMarketCap can, a name that was unmeasured — a failed
gate in Triens and for a qREV chain token, gross-revenue weight for a qREV protocol token — is now measured, which can
move it either way. qDEFI is not touched.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `docs/methodology/value-capture.md`, `triens.md`, `qai.md` (site repo) | branch `staging/rulebook-mismatches` — commit and sha256 to be pinned at anchoring |
| `keeper/rulebooks/qrev.json`, `triens.json`, `qai.json` | sha256 to be pinned at anchoring |
| `keeper/paper-index.mjs`, `keeper/source-reconciliation.mjs` | the commit that carries this file |
