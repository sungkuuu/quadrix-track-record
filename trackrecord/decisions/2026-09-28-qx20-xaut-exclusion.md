# qX20 — XAUt joins the exclusion list under the gold-pegged category, decided 2026-09-28

**Decided:** 2026-09-28 (owner; the words: "제외해" — exclude it). **Effective:** at the first keeper run of 2026-10 —
the scheduled monthly reconstitution, the same run at which the nine legacy tickers leave the list
(`2026-09-23-qx20-exclusion-list`) — once this document is anchored; the ledger's `effectiveFrom` is the date in the
filename. **Series:** the qX20 keeper book (`keeper/state.json`, NAV marks on chain), the paper indexes that reuse the
shared exclusion set (qDEFI · qREV · qAI · the Quality sleeve of Triens) and the published simulation; none of them
changes before that run.

## What changes

The rulebook's exclusion categories already include gold-pegged tokens, with one ticker enumerated. Rulebook §10 item 3
asks a revision to state before/after, the start date and the reason; here they are.

| | Rulebook §3, gold category | Enumerated list (`EXCLUDE`, `keeper/update-nav.mjs`) |
| --- | --- | --- |
| **Before** | "**금 등 실물 연동**: PAXG." | 43 tickers; `PAXG` the only gold-pegged one |
| **After** | "**금 등 실물 연동**: PAXG · XAUt." | 44 in force from 2026-10-01 UTC (43 in `EXCLUDE` + `XAUT` in `EXCLUDE_FROM`) |

**Start date:** the first keeper run on or after 2026-10-01 00:00 UTC (`index-nav-keeper.yml`, cron `17 */6 * * *`; that
run is the reconstitution because `state.reconstitutedIn !== '2026-10'`, `update-nav.mjs` line 217 — line numbers in
this document are those of the keeper files as committed with it). No retroactive
application, no recomputation (§10 item 3). **Reason:** XAUt (Tether Gold — CoinGecko id `tether-gold`; among its six
CoinGecko categories, Tokenized Assets, Tokenized Gold, Ethereum Ecosystem, Real World Assets (RWA), Tokenized
Commodities and Tether Ecosystem, are "Tokenized Gold" and "Tokenized Commodities") is the same thing the category
describes and was
simply not enumerated when the list was written. The list is enumerated, so a name of a listed category enters it only
by a code change, and the rulebook's own §3 box says every list change carries an anchored decision (§10). This is that
decision. Nothing else changes: the other categories, ticker-string matching, the 60% cap, monthly reconstitution at the
first run of the calendar month, the 5-point drift band, the 17/23 rank buffer.

## The facts (measured 2026-09-28)

1. **Identity across the record's three sources.** CoinGecko `tether-gold`, symbol `xaut`, name "Tether Gold".
   CoinPaprika `xaut-tether-gold`, symbol `XAUT`, rank 85 on that source (market cap $1.03B as CoinPaprika states it),
   outside the 80-row fallback fetch. CoinMarketCap id 5176 prints the symbol as `XAUt` (the `listings/historical` row
   for 2026-09-06, read today, rank 34). Every path upper-cases the symbol (`update-nav.mjs` lines 107 and 118,
   `gen-qx20-series.mjs` `cmcSnapshot`), so the string `XAUT` matches on each.
2. **Rank on the keeper's own feed — not in the entry zone.** CoinGecko `coins/markets` top 60, the keeper's own query,
   data stamped 2026-09-28T10:15:30Z: raw rank 39, market cap $2.87B (PAXG: rank 56, $1.81B). Under the keeper's window
   (top 60, exclusions applied, then ranked) XAUt is
   **26th** under today's list (41 eligible names in the window) and **29th** under the 2026-10 list (44 eligible before
   this decision, 43 after it: ZEC, XMR and LTC come back inside the window, XAUt leaves it). The paper-index caches say
   the same: 25/28 on 09-21, 09-22 and 09-23, 26/29
   on 09-28 08:22Z. The entry line (rank 17) under the 2026-10 list is UNI at $5.50B, 1.92× XAUt's market cap; then LTC
   $5.46B, CC $5.27B, HBAR $5.01B in the 20th seat, AVAX $4.90B, SUI $4.77B, GRAM $4.74B at 23. On today's data the rank
   buffer would not admit XAUt whether or not this decision exists; the decision is about the category, not the rank.
3. **Never in the keeper book.** `git log -S'XAUT' -- keeper/state.json` returns nothing over the file's 146 commits
   (first state `e588239`, 2026-08-21); the site repository's `contracts/keeper/state.json` from the first keeper
   (`93d1445`, 2026-07-21) likewise; no row of `keeper/qx20-daily.jsonl` or `keeper/nav-marks.jsonl` carries it; no paper
   or allocation state (`state-qdefi.json`, `state-qrev.json`, `state-qai.json`, `state-triens.json`,
   `state-barbell.json`) holds it or ever did. Today's book is the twenty listed under "What stays".
4. **The published simulation is a different question, and is stated so the record does not overclaim.** The generator
   (`scripts/gen-qx20-series.mjs`) takes the buffer-less top 20 from a first-of-month CoinMarketCap snapshot after the
   exclusions (lines 114–120) and holds a member only on days it has a Binance USDT close, joining it "at its first priced
   day" (lines 166–168). Re-fetching those snapshots today, XAUt's rank after exclusions (legacy nine on, the rule in
   force) is 22 · **19** · 22 · 21 · 22 · **20** · 21 · 21 for 2026-02-01 through 2026-09-01. So on today's data the
   generator's top 20 contains XAUt for **2026-03** and **2026-07**. Binance's first `XAUTUSDT` daily candle is
   2026-03-26, so for March it would have entered the simulated book on 2026-03-26 — and rebalanced the book that day,
   since a target not yet held forces a rebalance (line 181, `if (!units.has(s)) rebalance = true`) — and left at the
   04-01 reconstitution (rank 22); for July it is priced throughout. Two caveats keep this a statement about a run today,
   not about the committed series: CoinMarketCap's historical endpoint revises past dates on re-fetch (rulebook §1, the
   N-backtest note), and the emitted series names no members — only the names dropped for having no pair: CC, CRO, M in
   `src/engine/qx20PreviewSeries.ts` at `5544df1` (the published CSV's method row, an older run, also lists HYPE). The
   "about 20–22" figure that has circulated comes from the monthly first-Sunday CMC snapshots under the public
   N-backtest's own eligibility (its own list, which also excludes CRO, compared against the raw symbol so `USDe` passes):
   31 in January 2026, 19 on 2026-03-01, 21–23 in the other months through 2026-09-06 — the keeper's list with upper-cased
   symbols gives the same numbers, the two differences cancelling. Not the keeper's feed; where a rank is cited, its
   source is named.
5. **The paper indexes inherit the change and nothing moves there today.** None of XAUt's six CoinGecko categories is a
   DeFi or AI category, it has no row in `keeper/rulebooks/qrev-protocol-map.json`, and it is in no paper state. Their rulebooks cite "qX20 §3 categories in full" (`qdefi.json` line 43, `qrev.json` line 23, `qai.json`
   line 37; `triens.json` line 69 through qREV §3), and PAXG is already in the shared set.

## Where the list lives — applied with this decision

In this repository, by the commit that carries this file:

- `keeper/update-nav.mjs` — a dated addition after `EXCLUDE` (line 51) and `LEGACY_EXCLUDE_UNTIL` (line 64):
  `EXCLUDE_FROM = [{ symbol: 'XAUT', from: '2026-10-01' }]` (lines 71–73), tested in `isExcluded(symbol, dateStr)`
  (lines 74–77) as `dateStr >= from`; the universe filter applies it at line 164. The gate makes the rule in force on each
  day the one anchored for that day, the shape the legacy nine already use; for the live book it is inert before the run,
  because membership is frozen between reconstitutions (lines 217–227).
- `keeper/paper-index.mjs` — `QX20_EXCLUDE_FROM` (lines 409–411), the same gate inside the `QX20_EXCLUDE` object (lines
  412–419, the test at 413–418), applied at line 495 (qREV's universe, which Triens' Quality sleeve shares), 860 (qDEFI)
  and 1090 (qAI); the paper indexes inherit it (fact 5).
- `keeper/rulebooks/qx20.json` line 15 (`universe.exclusions`, "…, PAXG — the EXCLUDE list…") — appends XAUt with the
  start date and this decision's id.
- `keeper/RUNBOOK.md` — a short "Exclusion list" section naming the two dated gates and where the site keeps its copies.

In the site repository, by the site commit that follows this anchor and is referenced from the rulebook:

- `docs/methodology/qx20.md` §3 — the gold line (line 157) and the enumerated block (line 167).
- `src/engine/indexEngine.ts` — the dated addition in `exclusionsAsOf(dateStr)` (lines 63–67). Note where the gold ticker
  actually is on the site: `CATEGORICAL_EXCLUSIONS` (lines 39–42) holds only the ten base names; `PAXG` and the 2026
  additions sit in `src/pages/Engine.tsx` `DEMO_OPTIONS` (line 55). `XAUT` goes wherever `PAXG` is kept; the placement is
  the implementer's, the rule is this document's.
- `scripts/gen-qx20-series.mjs` — `excludeSetFor(ds)` (lines 49–52) adds `XAUT` for snapshot dates ≥ 2026-10-01 only;
  snapshots through 2026-09-30 replay the rule in force on their date (fact 4), as they do for the legacy nine.
- `src/pages/VaultQX20.tsx` — the Exclusions section (lines 208–243 at `5544df1`): the prose "gold-pegged tokens" stays
  true; the ticker and this decision's id are added where the legacy nine are captioned.

Not changed by this decision: the four research replay scripts (`docs/research/cap-backtest.py`, `docs/research/qx20-band.py`,
`public/methodology/qx20/n-backtest.py`, `docs/research/ai/weighting-study-engine.py`) carry their own frozen list and
compare the snapshot's raw symbol — `XAUt`, mixed case in the first-Sunday snapshot files — against an upper-case set, so
an `XAUT` entry there would match nothing. Noted for whoever re-runs them; a research-reproducibility matter, not a rule.

Matching stays a ticker-string match (upper-cased), as the rulebook states (§3 box, Q10). Matching by source id is the
separate proposal in `2026-09-28-qx20-toncoin-ticker-note`, not decided.

## Observed, not decided

- **Same category, other names** (CoinGecko reads at 2026-09-28T10:15Z; ranks this deep drift within the day). In the
  top 100 the gold-pegged tokens are PAXG (listed) and XAUt (this decision) — no third. CoinGecko's "Tokenized Gold"
  category beyond the top 100: KAU (`kinesis-gold`, rank 147),
  XAUt0 (`tether-gold-tokens`, Tether Gold's omnichain form, unranked, $0.11B — the same ticker-sibling pattern as USDT0,
  which the list carries), GGBR 326, PGOLD 334, XAUM 387. None is inside the keeper's 60-row window.
- **A separate category, one open item.** USDY (`ondo-us-dollar-yield`, a tokenised money-market share, raw rank 48,
  $2.28B, 33rd under the 2026-10 list on the 10:15:30Z read, inside the keeper's window) is not
  enumerated under "토큰화 RWA·머니마켓 셰어". The owner has **not** decided it; it is not part of this change. Also not
  enumerated, outside the window today: EURSAFO 64, BCAP 83, USTB 90, EUTBL 91 (same category); U 63, USDGO 66,
  STABLE 92, GHO 95 (stablecoins).

## A sentence in `2026-09-23-qx20-exclusion-list` that the code does not bear out

That document's dry-run paragraph says "today the lowest incumbents would be pushed to 21–23 and stay unless they fall
below 23". The keeper's `targetMembership` (`update-nav.mjs` lines 146–160) does not work that way: it keeps incumbents
ranked ≤ 23, forces in every outsider ranked ≤ 17, and if that leaves more than twenty names it **truncates to twenty by
rank** (line 153) — so an incumbent at 21–23 can be cut without falling below 23. On the 2026-09-28T10:15:30Z data, the
2026-10 list and today's twenty as incumbents, the algorithm gives: forced in ZEC (7) · XMR (11) · NEAR (15); out by the
exit rule SHIB (26); cut by truncation SUI (22) and GRAM (23); the result is identical with and without this decision
(XAUt 29th, or excluded). This is today's data run through the rule, not the 2026-10 run, whose snapshot is its own.
Anchored text is not edited; this paragraph records the discrepancy. Rulebook §6 already lists this as step ③ of
`targetMembership()` ("③ 20 초과 시 순위순 절단"), so code and rulebook agree; the 2026-09-23 sentence overlooked it.
Whether §6's headline sentence ("기존 종목은 순위 23 밖으로 떨어질 때만 나간다") is tightened to say so is not decided here.

## What it is not

Not a change to the book, its units or weights today; not a projection of the 2026-10 membership (fact 2 is today's
rank, the run's snapshot is the run's); not a change to how exclusions are matched; not a change to the decision of
2026-09-23, whose effect on the nine is as anchored; not a decision on USDY, XAUt0 or any other name.

## What stays

- Everything else in the rulebook: the other categorical exclusions, top 20 by circulating market cap, the 60% cap,
  monthly reconstitution at the first run of the calendar month, the 17/23 rank buffer, the 5-point drift band,
  CoinGecko with CoinPaprika fallback.
- The book: BTC ETH BNB XRP SOL TRX HYPE DOGE RAIN LINK ADA XLM BCH CC GRAM UNI HBAR AVAX SHIB SUI (`keeper/state.json`,
  `reconstitutedIn 2026-09`), until the 2026-10 run.
- The order of events: this document is anchored and the code deployed before the first run of 2026-10. If either came
  after it, the rule in force at that run would be the old one — on today's ranks the book would be identical either way
  (fact 2), but the anchor fixes the rule, not the outcome, so it precedes the run.

## How to verify

1. The category and its single ticker, before this change: `grep -n "실물 연동" docs/methodology/qx20.md` (site
   repository at `5544df1`) — one line, `PAXG` only; `git show 0c0b42d:keeper/update-nav.mjs | grep -c "PAXG\|XAUT"`
   (this repository at `0c0b42d`, before the commit that carries this file) — one hit, `PAXG`, no `XAUT`.
2. The rank: `curl -s 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=60&page=1'`,
   drop the `EXCLUDE` symbols (and the nine for the current list), sort by `market_cap`, read XAUt's position — 26 and 29 on
   the read stamped 2026-09-28T10:15:30Z; any later day reproduces its own number.
3. Never in the book: `git log --format=%h -S'XAUT' -- keeper/state.json keeper/qx20-daily.jsonl keeper/nav-marks.jsonl`
   (empty); in the site repository `git log --format=%h -S'XAUT' -- contracts/keeper/state.json` (empty).
4. The simulation months: `listings/historical?date=2026-03-01&limit=200` and `…date=2026-07-01…` from
   `api.coinmarketcap.com/data-api/v3/cryptocurrency/`, upper-case `symbol`, drop the exclusions in force, sort by
   `marketCap` — XAUt at 19 and 20; `data-api.binance.vision/api/v3/klines?symbol=XAUTUSDT&interval=1d&limit=1&startTime=0`
   — first candle 2026-03-26.
5. The categories: `api.coingecko.com/api/v3/coins/tether-gold` → `categories`.
6. The sources' spellings: CoinPaprika `v1/tickers/xaut-tether-gold` → `symbol: XAUT`, `rank: 85`; the CoinMarketCap row
   above prints `XAUt`.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `2026-09-23-qx20-exclusion-list` (`trackrecord/decisions.jsonl`) | sha256 `da1c50d987797ba434da7365e2de345a9533031ba66ad0575de4c7ec877cc08a`, tx `0xb7ef357048626eed57b500708f0feea0a15a8bea0ec23b4944b78bc3ac7c9cff`, anchored 2026-09-23T05:12Z |
| `2026-09-28-qx20-toncoin-ticker-note` (`trackrecord/decisions.jsonl`) | sha256 `5fa57d45119443ff83369863df775e33cb55365798fd07797b6c77568e96e4bd`, tx `0xccb29853675555ca6d81552379155e22a520d6aa058d146f26104017256da4bc`, anchored 2026-09-28T10:14Z |
| `keeper/update-nav.mjs` — before this change (`EXCLUDE` line 51, `LEGACY_EXCLUDE_UNTIL` line 64) | sha256 `fc58d128239c126c721622000359eaf90f04f132953d5994d00a8d12928b030b`; after: the commit that carries this file |
| `keeper/paper-index.mjs` — before this change (`QX20_EXCLUDE` lines 388–404) | sha256 `b273e94e97e1795138bc79763f913c5dc4b7ec10d7ff9cb171897e86582b6946`; after: the commit that carries this file |
| `keeper/rulebooks/qx20.json` — before this change | sha256 `cbc202c7a8eccf4d49342e2ef8a32a9111f1a605f4e6077cb112c2232562ded9` |
| `keeper/state.json` at `d598f2b` (2026-09-28T05:32Z) | sha256 `573305c59be14c508fef47e8e48ceb0e47b9cb2facfd0e00dd83eb56b5c5185d` |
| site `docs/methodology/qx20.md` (§3 line 157, §10, Q10) | main `5544df1`, sha256 `70ebf8f2bfcc29fc66c83d698dd1ea11d318c2b0f013184fe362c0f2e8ef8738` |
| site `src/engine/indexEngine.ts` | main `5544df1`, sha256 `124aa61c34389b6aa69769bcecf6a39dbdadffb9b976406d742918fa50772ff5` |
| site `src/pages/Engine.tsx` (`DEMO_OPTIONS`, `PAXG` line 55) | main `5544df1`, sha256 `45f29bdf713ecfef21ea9f6b7f1cda032b1d1c737a22e9f20bf328d559e99fb9` |
| site `scripts/gen-qx20-series.mjs` | main `5544df1`, sha256 `63a68145814d672c46f6d13b469e690d78383f9dbba5aac4d82a0758b59465cf` |
| site `src/pages/VaultQX20.tsx` | main `5544df1`, sha256 `7deb4f49191cdeb612e4edc3e8db28aa3f9a52701fa35a5fd98bd6222b97cc0c` |
| quadrix-track-record (this file — before this commit) | `0c0b42d` |
