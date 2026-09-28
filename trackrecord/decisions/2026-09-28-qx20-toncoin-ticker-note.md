# qX20 — Toncoin was never excluded: the list said TON, the ticker is GRAM; a correction to the record, decided 2026-09-28

**Decided:** 2026-09-28 (owner; Toncoin stays in the book, no out-of-cycle removal). **Effective:** 2026-09-28 — the
ledger's `effectiveFrom` is the date in the filename; nothing in the book changes on that date or because of this
document. **Series:** the qX20 keeper book (`keeper/state.json`, NAV marks on chain) and the published simulation —
unchanged.

## What this document does

It records that one of the nine tickers `2026-09-23-qx20-exclusion-list` removes from the exclusion list, **TON**,
never excluded anything: the exclusion is a ticker-string match, Toncoin's ticker on the keeper's price source is
**GRAM**, and GRAM has been a constituent of the book since the first keeper state. It corrects one sentence of that
anchored document, records the owner's decision of 2026-09-28 to leave the name where it is, and states an amendment
to how exclusions are matched, for the owner to confirm.

## The facts

1. **Exclusion is a ticker-string match.** `keeper/update-nav.mjs` reads CoinGecko `coins/markets` (top 60; CoinPaprika
   `tickers` on fallback) and keeps only `symbol` (upper-cased), `price` and `marketCap` — no asset id (`fetchMarkets`,
   lines 85–110). `isExcluded(symbol, dateStr)` (line 65) tests that string against `EXCLUDE` (line 51) and, through
   2026-09-30, `LEGACY_EXCLUDE` (line 63); the universe filter applies it at line 153. The rulebook says the same
   (`docs/methodology/qx20.md`, the "현재 구현과의 차이" block after §3: "제외는 티커 문자열 일치다") and carries the
   switch to source ids as open item **Q10** ("티커 일치" — appendix).
2. **The string `TON` has been on the list since the first keeper.** Site repository commit `93d1445`
   (2026-07-21, the first qX20 keeper) lists `'TON'` in `EXCLUDE` (`contracts/keeper/update-nav.mjs`, line 36 of that
   version).
3. **Toncoin's ticker is GRAM.** CoinGecko id `the-open-network`, symbol `gram`, name "Gram (prev. Toncoin)", rank 30
   (read 2026-09-28T09:47Z). CoinPaprika id `toncoin-the-open-network`, symbol GRAM, rank 33 (same read). CoinMarketCap
   id 11419 appears as GRAM in the weekly historical listings from the week of 2026-06-21 and as TON in the week of
   2026-06-14 (the site repository's local `docs/research/cmc-weekly.json` cache, a git-ignored file written by
   `docs/research/qx20-band.py` from the `listings/historical` endpoint; not in any repository). The rename date itself is not determined here — only
   that it falls before 2026-07-21, since the first keeper state already held GRAM, and, by that one cache, between
   2026-06-14 and 2026-06-21 on CoinMarketCap.
4. **GRAM has been in the book from the first state to today.** `93d1445` `contracts/keeper/state.json` (2026-07-21T00:41Z,
   level 1): `GRAM 0.003076277938015472`. This repository's first state, `e588239` (2026-08-21T07:24Z): `GRAM
   0.0020500717466642396`. The 2026-09-01 reconstitution, `276c0bb` (`reconstitutedIn 2026-09`): `GRAM 0.0020346925824529082`.
   Today, `d598f2b` (2026-09-28T05:32Z, level 1.3033540005866453): the same units. The string `TON` matched no row on
   any of those days because no row carried it.
5. **Weight today: about 0.26%.** 0.0020346925824529082 units × $1.66 (CoinGecko, 2026-09-28T09:47Z) = 0.003378 per
   unit of level; the whole book at the same prices values at 1.29755, so 0.260% (0.259% against the state level of
   05:32Z). Eighteenth of twenty by weight. What the level would have been had the string matched — the seat going
   to the twenty-first name at each reconstitution since 2026-07-21 — is not computed here; at a quarter of one
   percent of the book the difference is of the order of basis points, whichever way it runs.

## What was wrong in `2026-09-23-qx20-exclusion-list`

Its dry-run paragraph says "DASH, PIVX, XVG, KMD, OMG, TON are outside the top 60". For TON that sentence is false:
the dry run looked for the string and found no row. Toncoin, as `the-open-network`/GRAM, ranked 32nd by market cap in
the paper-index run's CoinGecko top-500 cache written 2026-09-23T10:06Z (`keeper/cache/cg-markets-top500-2026-09-23.json`,
local, git-ignored, written by `keeper/paper-index.mjs` — five hours after the 05:12Z anchor, so not the dry run's own
data; 30th in the 2026-09-21T02:08Z cache, 29th in the 2026-09-28T08:22Z cache, 30th on the live read at
2026-09-28T09:47Z), and it was in the book. The other five are outside the top 60 in the same 2026-09-23 cache (DASH 90,
XVG 485; PIVX, KMD, OMG not in the top 500), and the ZEC/XMR/LTC projection is unaffected.

Anchored documents are not edited: `scripts/anchor-decision.mjs` refuses a changed hash under an existing id and
says to publish a new dated decision instead. This document is that correction, anchored beside the original.

## Owner decisions

- **2026-09-23** (anchored, tx `0xb7ef357048626eed57b500708f0feea0a15a8bea0ec23b4944b78bc3ac7c9cff`): the nine legacy
  tickers, TON among them, leave the exclusion list at the first keeper run of 2026-10. For TON the removal changes
  nothing in the book — there was nothing for the string to exclude — and the decision stands as written.
- **2026-09-28**: Toncoin/GRAM stays in the book; no out-of-cycle removal. The owner's words: "제외할 이유가 없어 시장
  전체 대변하는데 충분해 그러니까 제외시키지마" — there is no reason to exclude it; it is enough to represent the whole
  market; so do not exclude it.

The record's reading: the name is eligible under the anchored rule from the first run of 2026-10, three days after this
document, and selling it in between would be a discretionary trade — itself a breach of the no-discretion rule the
record exists to demonstrate.

## Proposed amendment — not decided; pending the owner's confirmation

From the 2026-10 reconstitution, the remaining exclusions — stablecoins including yield-bearing ones, wrapped and
bridged representations, liquid-staking and restaking derivatives, LP and vault shares, exchange tokens, tokenised RWA
and money-market shares, gold-pegged tokens; the enumerated list is `EXCLUDE` in `keeper/update-nav.mjs` — are matched
by **asset id** (CoinGecko `id`; on the CoinPaprika fallback, the CoinPaprika id through a per-asset alias table the
keeper does not yet have), not by ticker string. A ticker rename can then neither bypass the list nor, in the other
direction, catch an unrelated token that adopts a listed ticker (the rulebook's own `GT`/`G` example). Rulebook **Q10**
closes accordingly, and the list is restated as ids in the same change.

This is a rulebook change and, under the rulebook's own rule, a list change carries an anchored decision. The code
that must change before the 2026-10-01 run, if confirmed: `keeper/update-nav.mjs` (`fetchMarkets` to carry `id`,
`isExcluded` → id-based), `keeper/paper-index.mjs` (`QX20_EXCLUDE`, lines 388–404, applied at 480, 845 and 1075 — the
paper indexes reuse the base set), and in the site repository `src/engine/indexEngine.ts` (`CATEGORICAL_EXCLUSIONS`,
`buildTargetWeights` lines 95–97) and `scripts/gen-qx20-series.mjs` (`excludeSetFor`, lines 49–52 — its universe comes
from CoinMarketCap snapshots, so its ids are CoinMarketCap's). Until that decision is anchored, matching stays by
ticker string as the rulebook states.

## What it is not

Not a change to the book, its units or weights; not a claim about the level; not a change to the decision of
2026-09-23, whose effect on the nine is as anchored; not an amendment of the rulebook — the paragraph above is a
proposal until the owner confirms it and it is anchored under its own id.

## What stays

- Everything else in the rulebook: the categorical exclusions, top 20 by circulating market cap, the 60% cap, monthly
  reconstitution at the first run of the calendar month, the 17/23 rank buffer, the 5-point drift band, CoinGecko with
  CoinPaprika fallback.
- The book: BTC ETH BNB XRP SOL TRX HYPE DOGE RAIN LINK ADA XLM BCH CC GRAM UNI HBAR AVAX SHIB SUI (`keeper/state.json`,
  `reconstitutedIn 2026-09`), until the 2026-10 run.
- The site: at the time of writing, the qX20 page's exclusions section on production prints the legacy nine including
  TON under the caption "The nine above, until the 2026-10 reconstitution (decision 2026-09-23-qx20-exclusion-list)."
  (`src/pages/VaultQX20.tsx`, `LEGACY_EXCLUSIONS.join`) while the
  holdings come from a book that holds GRAM; branch `staging/qx20-live-book` adds a footnote saying so to that section,
  to the Q1 row, and to the Engine page's "Excluded by rule" readout (whose readout itself lists only feed rows that
  matched, so it never printed TON). Uncommitted and not deployed when this document was written.

## How to verify

1. The string and the match: `grep -n "'TON'" keeper/update-nav.mjs keeper/paper-index.mjs` (one hit each, the legacy
   set); `sed -n 85,110p keeper/update-nav.mjs` shows no `id` field in what `fetchMarkets` returns.
2. GRAM in every state: `for c in e588239 276c0bb d598f2b; do git show $c:keeper/state.json | grep -n GRAM; done`; in the
   site repository, `git show 93d1445:contracts/keeper/state.json | grep GRAM` and
   `git show 93d1445:contracts/keeper/update-nav.mjs | grep -n "'TON'"`.
3. The ticker: `curl -s 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=the-open-network'` returns
   `"symbol":"gram"`, `"name":"Gram (prev. Toncoin)"`; no row of the top 60 carries `"symbol":"ton"`.
4. The weight: multiply `units.GRAM` in `keeper/state.json` by the CoinGecko price at the time of the check and divide by
   the sum of the same product over all twenty members; on 2026-09-28T09:47Z the result is 0.260%.
5. The 2026-09-23 sentence: the file below at its anchored hash, the "Dry run" paragraph; the rank on that day is in a
   local cache only and is reproducible for any later day from CoinGecko's top-500 by market cap.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `2026-09-23-qx20-exclusion-list` (`trackrecord/decisions.jsonl`) | sha256 `da1c50d987797ba434da7365e2de345a9533031ba66ad0575de4c7ec877cc08a`, tx `0xb7ef357048626eed57b500708f0feea0a15a8bea0ec23b4944b78bc3ac7c9cff`, anchored 2026-09-23T05:12Z |
| `keeper/update-nav.mjs` — unchanged by this document | sha256 `fc58d128239c126c721622000359eaf90f04f132953d5994d00a8d12928b030b` |
| `keeper/state.json` at `d598f2b` (2026-09-28T05:32Z) | sha256 `573305c59be14c508fef47e8e48ceb0e47b9cb2facfd0e00dd83eb56b5c5185d` |
| site `docs/methodology/qx20.md` (§3 block, appendix Q10) | main `5544df1`, sha256 `70ebf8f2bfcc29fc66c83d698dd1ea11d318c2b0f013184fe362c0f2e8ef8738` |
| site `src/engine/indexEngine.ts` | main `5544df1`, sha256 `124aa61c34389b6aa69769bcecf6a39dbdadffb9b976406d742918fa50772ff5` |
| site `scripts/gen-qx20-series.mjs` | main `5544df1`, sha256 `63a68145814d672c46f6d13b469e690d78383f9dbba5aac4d82a0758b59465cf` |
| site repository, first keeper (`contracts/keeper/update-nav.mjs`, `contracts/keeper/state.json`) | `93d1445` (2026-07-21) |
| quadrix-track-record (this file — before this commit) | `3ea3db9` |
