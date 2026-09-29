# qREV, Triens, qAI — two market-data sources reconciled for listing age and the issuance fallback, decided 2026-09-29, effective at the 2026-10-01 reconstitution

**Decided:** 2026-09-29 (owner). **Effective:** at the first keeper run on or after 2026-10-01 — the scheduled quarterly
reconstitution, which is the only run at which either rule is read (both are eligibility and weighting inputs, computed
only at a reconstitution). Effective date confirmed by the owner on 2026-09-29 after the impact measurement below. The
rule is not date-gated in code: if that reconstitution is deferred by a data-source outage, the rule is first read at the
deferred run. **Series:** `trackrecord/record-qrev.jsonl`, `trackrecord/record-triens.jsonl`, `trackrecord/record-qai.jsonl`
— unchanged by this decision until that run (a separate, log-only field, `specialSituation`, appears on qREV and Triens
lines from 2026-09-30 under decision-independent keeper code).

## What changes

Where a rule reads a quantity that CoinMarketCap and CoinGecko both publish, the keeper reads both, takes the one that
serves the rule — not an average — and discloses the other when the two disagree. The owner's words: "합치되 평균이
아니라 규칙의 목적에 맞는 쪽을 택하고 불일치는 공개" (reconcile them; not an average — take the side that fits the
rule's purpose, and disclose the disagreement).

| Rule | Until the 2026-10-01 reconstitution | From it |
| --- | --- | --- |
| Listing age ≥ 365 days — Triens Quality sleeve (`triens.md` §2) | the CoinGecko proxy alone: the earlier of `ath_date` and `atl_date` (the rulebook text said "CMC listing date") | counted from the **earlier** of CoinMarketCap `dateAdded` and the CoinGecko proxy; either alone when the other is missing |
| Listing age ≥ 365 days — qAI (`qai.md` §2, D5) | CoinMarketCap `dateAdded`; the proxy only when it was missing | counted from the **earlier** of the two; either alone when the other is missing |
| Issuance over the trailing 12 months when the on-chain supply registry cannot measure a name (census incomplete, under a year of weekly history, or no weekly point within 10 days of the run or of the run minus 365 days) — qREV (`value-capture.md` §8; nets the weight, and is the chain tokens' net-burn test) and Triens (`triens.md` §8; the A-1 gate, issuance ≤ holder revenue) | CoinGecko alone: circulating supply today against market cap ÷ price on (date − 365 days) (both rulebooks said "CMC circulating supply") | the **larger** of that and CoinMarketCap's: `circulatingSupply` today (data-api listing) against `circulatingSupply` in the historical listing of (date − 365 days). A source that cannot measure the name is skipped; neither = unmeasured (Triens: fails the gate, D7) |

qREV and qDEFI keep the CoinGecko proxy for listing age — their rulebooks name it (`value-capture.md` §2,
`qdefi.md` §2) and this decision does not change it.

## Disclosure on the record line

| Field | When | Meaning |
| --- | --- | --- |
| `listingSource` | qAI member rows on every daily line (set at a reconstitution and carried until the next); for Triens it appears in the keeper's evaluation log, not on the record line | `cmc-date-added`, `ath-atl-proxy` (which source supplied the earlier date) or `unavailable` |
| `listingDateCmc`, `listingDateGecko`, `listingDisagreement: true` | the two listing dates are more than **90 days** apart | both dates |
| `issuanceSource` | qREV and Triens rows, at a reconstitution | `onchain-registry`, or `coingecko` / `cmc` — whichever supplied the larger value — or `unavailable`; `-census-incomplete` is appended when the registry census is incomplete |
| `issuanceGecko`, `issuanceCmc`, `issuanceDisagreement: true` | the two issuance values differ by more than **5%** of the larger | both values, in USD at today's price |

The thresholds (90 days, 5%) are disclosure thresholds, not gates: the rule always uses the earlier date and the larger
issuance, whatever the gap.

## Why these sides

**Issuance — the larger value.** The number is a pass/fail gate in Triens (issuance ≤ holder revenue) and a deduction
from the weight in qREV; the larger of the two sources is the conservative side of both.

**Listing age — the earlier date.** The gate exists to keep out names too young to have a record; the failure that matters is reading an old name as young, not the reverse. Of two dates the earlier one is the one closer to the true first listing, so the rule takes it (owner 2026-09-29, adopting the keeper's proposal). Facts that bear on it:
the proxy is not a listing date — it reads a recent price extreme as youth (on 2026-09-22 it put VVV at 295 days
against a CoinMarketCap listing of 2025-01-28, and AKE at 73 against 2025-08-19); under the earlier-of rule both still
read from CoinMarketCap's record.

The rulebooks and the keeper disagreed on both points before this decision (rule audit 2026-09-29, M3 and M4,
`docs/research/rule-audit/review-opus-2026-09-29.md` in the site repository). A known consequence: `keeper/supply/supply-weekly.json`
ends 2026-09-13, so from 2026-09-24 no name has a weekly point within 10 days of a run and every qREV and Triens name
takes the fallback until the supply pipeline is refreshed.

## Impact on the 2026-10-01 reconstitution

**Measured 2026-09-29 in CI** (GitHub Actions run 36536183753, workflow `paper-index-dryrun.yml`: `--dry-run --as-of 2026-10-01`, the
keeper at `keeper/source-reconciliation` against `keeper/dryrun-workflow` = main without this decision, both on the same CoinGecko,
DefiLlama and CoinPaprika pulls from a copy of the live state; market data of 2026-09-29 ~07:22 UTC, so names near a threshold can
still move on the day):

- **No name changes membership in any index.** Eligible counts are equal on both sides: qREV 15, qDEFI 27, qAI 11, Triens Quality 8.
- **qREV** (issuance, the larger value): among the members, CoinMarketCap supplies the larger figure for AERO, CRV, TRX and LINK
  and is the only source for NEAR (CoinGecko could not measure it): NEAR goes from unmeasured to 273M issuance (net revenue
  +5.1M → −268M) and stays at the floor weight; 16 of the 44 candidates evaluated take the CoinMarketCap value. Weights move by at
  most 0.2 points (TRX 25.67 → 25.49%, SKY 6.11 → 6.17%, CAKE 5.65 → 5.72%); the reconstitution normalisation factor moves
  0.899744 → 0.899952. `issuanceDisagreement` is set on 7 of the 16 member rows (CRV, CVX, RAY, SKY, SYRUP, UNI, ZRO) and on 10 of
  the 44 candidates.
- **Triens**: MON (309 → 819 days) and VVV (304 → 611 days) now pass the age gate but stay out on other gates (VVV: issuance 108 > θ 1;
  MON: four gates); DBR, HNT and ORCA now pass the issuance gate but fail market-cap or volume (HNT also the months and
  value-trap gates). Among the candidates evaluated, 38 listing dates come from CoinMarketCap, 6 from the proxy, 17 disagree by
  more than 90 days. Weights move by at most 0.01 points; factor 0.970486 → 0.970313.
- **qAI**: nine candidates take the proxy date because it is earlier (BNKR, CLANKER, IQ, MAGIC, MY, NEURAL, POND, VIRTUAL, ZIG —
  POND by under a day, so its age in days is unchanged); no gate flips. `listingDisagreement` is set on 3 of the 10 member rows
  (AKE, FET, VVV) and on 32 of the 99 candidates.
- **qDEFI and Barbell**: identical, as expected.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `docs/methodology/value-capture.md`, `triens.md`, `qai.md` (site repo) | commit f689ffe — sha256 caa07149f67ff7a9… / 11d403b37158e5c8… / 61a5bdeb9a5d0014… |
| `keeper/rulebooks/qrev.json`, `triens.json`, `qai.json` | sha256 3a1fed4b3bddd84a… / 94fd4573466f5f44… / 6cd6d623a70c9d2a… (this commit) |
| `keeper/paper-index.mjs`, `keeper/source-reconciliation.mjs` | the commit that carries this file |
