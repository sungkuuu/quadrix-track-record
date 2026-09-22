# Paper-index keeper — qREV, qDEFI, qDUO (Barbell), qTRI (Triens)

**Status: rules-only reference levels. No vault, no capital.**
Nothing here moves money and nothing here is a product. A series becomes
a real track record only once an owner decision anchors an inception date for
it (`keeper/rulebooks/{index}.json`, field `inception`, is `null` until then).
qREV and qDEFI have theirs, anchored 2026-09-16; Barbell (ticker qDUO) and
Triens (ticker qTRI) have theirs, anchored 2026-09-22
(`trackrecord/decisions/2026-09-22-{barbell,triens}-paper-inception.md`).
The two tickers were decided after the first mark, so the genesis lines of
2026-09-22 carry the names "Barbell"/"Triens" as their index label and later
lines carry the tickers; a series is identified by its file. Before an index
has an inception it is exactly what
`docs/track-record-spec.md` §6 calls a dry run for the operating record: the
recording pipeline built and running before the thing it would record.

Four independent series, same posture as the operating record (spec §8):
`trackrecord/record-{qrev,qdefi,barbell,triens}.jsonl`, each hash-chained and
(once an inception decision exists) anchored on GIWA Sepolia — never
concatenated with each other or with the operating record.

## What the series is

A daily level, genesis 100 on the day the series starts, computed by
re-running the index's own reconstitution and mark-to-market rules against
live market data. It is the same idea as `keeper/update-nav.mjs` (the qX20
NAV keeper) — model book, marked daily, reconstituted on a fixed cadence —
but with no on-chain vault to post a NAV to: the record IS the product at
this stage.

## Files

| File | What it is |
|---|---|
| `keeper/rulebooks/qrev.json` | Every qREV parameter as data: universe, eligibility gates, ranking, weighting, issuance definition, reconstitution cadence, tolerance, hysteresis. Mirrors `quadrix/docs/methodology/value-capture.md` with the 2026-09-15 owner decisions applied. |
| `keeper/rulebooks/qdefi.json` | Same, for qDEFI, mirroring `quadrix/docs/methodology/qdefi.md`. |
| `keeper/rulebooks/barbell.json` | Every Barbell parameter as data: two sleeves (BTC 60 / working capital 40), quarterly reset, tolerance, the working-capital definition and its paper proxy. `inception: null` — not in force. |
| `keeper/rulebooks/triens.json` | Same, for Triens: three sleeves (BTC 30 / working capital 40 / Quality 30), the Quality screen including the issuance gate, the empty-seat rule. `inception: null` — not in force. |
| `keeper/working-capital.mjs` | The working-capital proxy: FRED DTB3 fetch, parse, carry-forward and daily accrual. |
| `keeper/rulebooks/qrev-protocol-map.json` | The manual protocol-slug → symbol table qREV's rulebook requires (§1: "automatic name-matching is not used"). Copied verbatim from the site repo's `docs/research/qrev/hr-protocols.json`, 2026-09-15 snapshot. |
| `keeper/supply/registry.json`, `keeper/supply/supply-weekly.json`, `keeper/supply/supply-current.json`, `keeper/supply/README.md` | The on-chain token-supply registry qREV's issuance calculation reads, plus its own README describing how it was built and its known gaps. Copied verbatim from the site repo's `docs/research/qrev/supply/`, 2026-09-15 snapshot. |
| `keeper/paper-index.mjs` | The keeper itself. `node keeper/paper-index.mjs --index qrev\|qdefi\|barbell\|triens\|qx20 [--dry-run] [--anchor]`. |
| `keeper/cache/` | Raw API response cache (gitignored). |
| `keeper/dryrun/` | Local dry-run output — state/record/anchor files with the same shape as production but never written to `trackrecord/` (gitignored going forward; the 2026-09-15 demonstration run in this directory is force-added once for review). |
| `.github/workflows/paper-index.yml` | Daily at 00:25 UTC for qREV, qDEFI and the qX20 basket mark, plus manual dispatch. The Barbell and Triens steps are present but **disabled (`if: false`)** — they go live only after their inception decisions are anchored. One job, one `keeper-key` concurrency group: every step signs with the same key. |

## The rule set as implemented

### qREV (Revenue Index)

- **Universe**: protocol tokens with a DefiLlama `dailyHoldersRevenue`
  adapter (per the manual map), plus chain-native tokens whose trailing-12m
  burn/buyback revenue exceeds the value of new issuance over the same
  window (`netBurn12m > 0`) — a token failing this test is excluded from the
  universe outright, not merely down-weighted.
- **Eligibility**: circulating market cap ≥ $150M, 24h volume ≥ $10M,
  holder revenue positive for 6 consecutive 30-day buckets and ≥ $1M
  trailing-12m, listing age ≥ 365 days (CoinGecko `ath_date`/`atl_date`
  proxy, earliest of the two), value-trap filter (`hr30 ≥ 0.25 × hr12m/12`).
  For chain tokens every one of these is evaluated on the **net-of-issuance**
  figure, not gross — matching `qrev-backtest.py`'s `NET_OF_ISSUANCE='chains'`
  mode, which nets `hr1y`/`hr30` before every downstream gate.
- **Ranking**: P/HR = market cap ÷ trailing-12m holder revenue, ascending
  (cheapest first). N = 10. Rank buffer: incumbents kept while rank ≤ 13,
  outsiders forced in only at rank ≤ 8.
- **Exit hysteresis**: an incumbent that fails a gate, or falls outside the
  exit rank, gets one further quarter (flagged `onNotice`) before it is
  actually removed — removal requires two consecutive failures.
- **Weighting**: weight ∝ max(netRevenue, floor), where netRevenue =
  trailing-12m holder revenue − trailing-12m issuance value (chain tokens:
  already net by construction), and floor = 2% of the sum of *positive* net
  revenues in the basket. If every member's net revenue is ≤ 0, the whole
  basket falls back to gross-revenue weighting for that quarter only.
- **Issuance**: on-chain circulating supply now (live CoinGecko) minus
  circulating supply ~365 days ago. The 365-days-ago figure comes from
  `keeper/supply/supply-weekly.json` when a data point exists within 10 days
  of the target date (`issuanceSource: "onchain-registry"`); otherwise from
  CoinGecko's `/coins/{id}/history` endpoint, using market_cap ÷ price at
  that date as the supply proxy — the same proxy `qrev-backtest.py` itself
  uses for its own point-in-time snapshots (`issuanceSource: "coingecko"`).
  A symbol whose registry entry says `census_status: "incomplete"` is not read
  from the registry at all (fixed 2026-09-22): its census was never finished,
  so the series would measure zero issuance. It takes the CoinGecko fallback
  and the record row says so.
  If neither is available, issuance is `null`: for a **protocol** token this
  falls back to gross-revenue weighting for that name only (a documented
  bias toward overweighting unmeasured names); for a **chain** token this
  fails the `netBurn12m > 0` gate outright — an unmeasurable dilution is
  never assumed to be zero for the universe test itself.
- **Cap**: 35%, iterative proportional trim-and-redistribute (same shape as
  `keeper/update-nav.mjs`'s `applyCap`).
- **Reconstitution**: quarterly, first run after 00:00 UTC on Jan/Apr/Jul/Oct
  1 — implemented as "the calendar quarter changed since the last
  reconstitution," which is exactly that rule for a keeper that runs daily.
- **Tolerance**: at reconstitution, a name within 5 points of its
  mark-to-market drifted weight is not traded; anything drifted above 35% is
  always cut to 35% regardless of the 5-point tolerance.
- **Between reconstitutions**: no trading, no drift band — the book is only
  marked to market.

### qDEFI (DeFi Index)

- **Universe**: CoinGecko category `decentralized-finance-defi` ∩ DefiLlama
  protocol listing whose category is DeFi-family (Dexs, Lending,
  Derivatives, Yield, Yield Aggregator, CDP, Liquid Staking, Liquid
  Restaking, Restaking, Basis Trading, RWA, DEX Aggregator, Options,
  Synthetics, Insurance, Leveraged Farming, Staking Pool). Chain-native gas
  tokens (any symbol DefiLlama's `/chains` lists a `tokenSymbol` for) are
  excluded. **Oracles are explicitly included** (LINK, PYTH, …) even though
  DefiLlama tags them "Oracle"/"Services", not a DeFi-family category — this
  is a named, closed policy override in the rulebook (§1: "follow the
  data"), applied unconditionally, not gated by any allowlist.
- **Eligibility**: market cap ≥ $150M, 24h volume ≥ $5M, listing age ≥ 365
  days (same ath/atl proxy as qREV).
- **Ranking**: market cap, descending. N = 15. Rank buffer: kept while rank
  ≤ 17, forced in at rank ≤ 13. No exit hysteresis (the rulebook tested it —
  qdefi.md §7 — and found it changed nothing, since exits are driven by
  market-cap rank, which the rank buffer already smooths).
- **Weighting**: market-cap proportional, 35% cap, same iterative trim.
- **Reconstitution / tolerance / between-reconstitutions**: identical
  cadence and mechanics to qREV (same calendar dates, same 5-point
  tolerance, same always-cut-above-cap, no drift band).

### Barbell and Triens (sleeve indexes, 2026-09-22)

**Neither is in force.** Both rulebooks are drafts in the site repo, `inception`
is `null` in both JSONs, and their steps in `.github/workflows/paper-index.yml`
are disabled (`if: false`). Nothing is appended to `trackrecord/` for either
index until an owner decision anchors an inception date, one per index.

These two do not hold one ranked basket. They hold **sleeves**:

| | Barbell | Triens |
|---|---|---|
| Monetary | BTC 60% | BTC 30% |
| Working capital | 40% | 40% (+ empty seats) |
| Quality | — | 30% |

- **The monetary sleeve is a list, not a screen.** BTC alone. Changing the
  list is a rule change, not a data refresh.
- **Quality (Triens only)** is the qREV universe run through a different
  question. Same manual protocol map, same DefiLlama holder-revenue series,
  same supply registry with the same CoinGecko fallback, same market data,
  same rank buffer (8/13), same two-quarter exit hysteresis, same 2% floor and
  35% cap — one function, `evaluateRevenueUniverse`, serves both legs. Two
  things differ, and they are the product: (1) the trailing-12m ratio
  issuance ÷ holder revenue is a **gate** at θ = 1, where qREV lets the same
  number net the weight and keeps the name at the floor; a name whose issuance
  cannot be measured **fails** the gate rather than passing unverified; and
  (2) ranking is by **net revenue, descending** — there is no valuation
  ranking, because "is it cheap" is not a rule in this product.
- **Empty seats go to working capital.** Each of the ten Quality seats is 1/10
  of the sleeve. Eight eligible names means a 24% Quality sleeve and a 46%
  working-capital sleeve, and the record line carries `seatsFilled`,
  `seatsTarget` and `emptySeats` so the reader never has to infer it.
- **Reconstitution** is quarterly, the same day as qREV and qDEFI. Sleeves
  reset to target unless **every** sleeve is within 5 percentage points of its
  target, in which case nothing moves between sleeves. Inside the Quality
  sleeve the qREV per-name rule applies to sleeve-internal weights, with the
  cap always cut. No drift band, no conditional switch, no overlay.
- **Between reconstitutions** the book is only marked. Interest accrued in
  working capital stays in that sleeve and is redistributed only at the
  quarterly reset — which is what the backtest did.

#### The working-capital proxy, and why the record says `wcProxy`

The sleeve's rule is fiat-backed, fully-reserved stablecoins with a published
issuer attestation; interest-bearing forms are allowed. **No such asset is
canonical on GIWA yet**, and the name list is itself an undecided item. The
paper record therefore cannot hold the sleeve's real assets, and it does not
pretend to: it holds a synthetic $1 unit that accrues the 3-month Treasury
bill rate daily,

```
unitValue *= (1 + DTB3/100) ** (1/365)      once per calendar day
```

with FRED's last published print carried forward on days FRED does not publish
(weekends, holidays, and its two-to-three-day lag). Source: FRED `DTB3`, daily
CSV, cached under `keeper/cache/`. Every record line carries
`wcProxy: "DTB3"`, and the sleeve block carries the rate used, the date it was
published, the accrued unit value and how many days were accrued.

It is the same assumption the research ran on, which is the reason to use it
rather than a zero-yield dollar. What it does **not** carry: the issuer's cut
of the bill yield, redemption risk, depeg, and any on-chain yield that is not
the bill. The real sleeve will differ by all of them. A same-day re-run accrues
nothing (the accrual window is exclusive of the last accrual date), so running
the keeper twice in one day cannot pay interest twice.

One parsing trap, recorded because it was live for an hour: FRED writes an
**empty** value field for a date with no print (800 of 18,970 rows in the
2026-09-21 download), and `Number('')` is `0` in JavaScript. Read naively, the
sleeve silently earns nothing on every holiday. `parseDTB3` drops empty fields;
the accrual was then checked against an independent computation of the same
series over the same window before it was believed.

#### Prices, and a missing price

BTC and the Quality names are marked from the same CoinGecko `coins/markets`
snapshot the other legs use — no new price source was added. A held name with
no price today is marked at its last known price for at most **three**
consecutive runs; on the fourth the run fails and writes nothing, rather than
publishing a level built on a price nobody has seen in four days.

#### Open, found by running it

- **`census_status: "incomplete"` in the supply registry — FIXED 2026-09-22
  (owner).** Some symbols in `keeper/supply/registry.json` never had their
  control-address census finished, so their weekly series is total supply with
  `excluded: 0` — flat for a token that looks fixed-supply, which measures
  issuance as zero. That is not a measurement, it is an unfinished one. The
  shared issuance path now refuses the registry for those symbols and falls
  back to the market-data supply series, with the fallback disclosed on the
  record row as `issuanceSource: "coingecko-census-incomplete"` (or
  `"unavailable-census-incomplete"` when there is no fallback either) — the
  rule both rulebooks' §8 already stated, and what the research engine does.
  LINK on 2026-09-21 is the case that surfaced it: issuance 0 and the θ ≤ 1
  gate passed before the fix, $877M against $58.5M of holder revenue and ratio
  14.99 after it — the rulebook appendix's own 15.0. **Every run before
  2026-09-22 used on-chain supply for incomplete-census names, contrary to the
  rulebook. Nothing is backfilled and no record line is rewritten**: the qREV
  and qDEFI series stand as they were recorded, and the change takes effect
  from the next reconstitution.
- **The 5-point tolerance at the sleeve level** is this keeper's reading of
  the rulebooks' §6. The backtests reset sleeve weights exactly every quarter
  and applied their 5-point tolerance to whole-portfolio name weights instead.
  Both rulebook JSONs carry the divergence in
  `reconstitution.tolerance.divergenceFromBacktest`.
- **RENDER** is in the copied protocol map with no ticker (`sym: "-"`), so it
  never enters the universe — the same known map gap listed further down, not
  a screen result.

## Data sources and fallbacks

| Use | Primary | Fallback | Notes |
|---|---|---|---|
| Market cap / price / volume (both indexes) | CoinGecko `coins/markets`, paginated to top 500 (2×250) | CoinPaprika `tickers` (price only) | CoinPaprika fallback cannot drive a reconstitution — matches both rulebooks' own §8 |
| qDEFI category universe | CoinGecko `coins/markets?category=decentralized-finance-defi` | none | membership freezes if this is unreachable |
| qDEFI DeFi-family / chain check | DefiLlama `/protocols`, `/chains` | none | |
| qREV holder revenue | DefiLlama `summary/fees/{slug}?dataType=dailyHoldersRevenue`, per protocol slug from the manual map | none (rulebook §8: no substitute source for this definition exists) | a protocol whose fetch fails for every one of its adapters is dropped from that day's candidate list, not zero-filled |
| qREV issuance | `keeper/supply/` on-chain registry | CoinGecko historical market_cap/price (≈ circulating supply) | see "Issuance" above for exactly when each applies |

Rate-limit pacing uses `ruby -e 'sleep N'` throughout (never the shell
`sleep`), with a retry-with-backoff around the CoinGecko history endpoint
specifically, since it is the one most likely to 429 right after the
500-name markets pull.

## Basket marking — the on-chain leg (prepared 2026-09-16)

Each rulebook carries a `basket` block (`keeper/rulebooks/{qx20,qrev,qdefi}.json`):

```json
"basket": { "chainId": 91342, "vault": null, "faucet": null, "navBase": 100, "assets": {} }
```

`vault: null` means no basket exists and the keeper posts nothing. Once an
index basket is deployed on GIWA Sepolia (site repo,
`.github/workflows/deploy-index-basket.yml` → `QuadrixBasketVault` v3.1 with
one mock constituent per name), the block is filled — `vault`, `faucet`,
`assets: { SYMBOL: { address, decimals } }` in the manifest's order, and
`navBase` = the index level on the deploy day — and the daily run does three
more things AFTER the record line is written (`keeper/basket-mark.mjs`,
called from `paper-index.mjs`):

1. **navPerShare** = `level / navBase × 1e6`, six decimals. The contract
   refuses any single post outside ±15% of the last one, so a larger move is
   walked in steps of at most 14.9% — one transaction and one log line per
   step. The mark is for reporting: nothing that moves assets reads it.
2. **refPrice per constituent** from the same CoinGecko snapshot, in the
   contract's unit (USD × 1e18 per base unit of the mock), stepped the same
   way. An unchanged price is re-posted anyway: the post refreshes
   `refPriceUpdatedAt`, and v3.1's `fill()` refuses to execute against a
   reference older than `maxRefAge` (1h by default). A constituent without a
   price today is simply not posted — auctions in it fail closed, exits are
   unaffected.
3. **On a reconstitution day**, if the membership no longer matches the
   vault's registry, `keeper/pending-registry-{index}.json` is written with
   the adds, the removes, a `decisionSha256: null` placeholder and the exact
   `announceRegistryChange` / `executeRegistryChange` / auction calls the
   change needs. Nothing is announced on chain by the keeper: the
   announcement carries the sha256 of an anchored decision document, which is
   a human step (RUNBOOK, "During a rebalance").

`--index qx20` runs only this leg for qX20: its book is `keeper/state.json`,
written by `keeper/update-nav.mjs`, which keeps marking the NAV-tracker vault
every six hours and is not changed. No record line and no anchor are written
for qX20 here — its ledger is `keeper/nav-marks.jsonl`.

Every chain write is skipped, with a line saying so, when `KEEPER_PK` is not
set, on `--dry-run`, or while `basket.vault` is null — the marks are still
computed and printed as `would setNav(...)` / `would setRefPrice(...)`.

**Where the basket and the index rules disagree — stated, not hidden:**

- *Seven-day registry delay vs. a reconstitution the record applies the same
  day.* The paper level trades on day 0; the vault cannot add or drop a name
  before day 7, and cannot finish the swap until the auctions drain the
  leaving asset. The basket therefore lags the index at every reconstitution
  and the tracking difference is real, not rounding. The keeper does not
  paper over it: the record is the index; the vault's `navPerShare` is the
  index; the vault's holdings are what they are and `redeem()` pays those.
- *A ±15% band vs. a daily mark.* A day the market moves 20% is posted in
  two steps within one run; the band is not a cap on the level, only on the
  step. The keeper's ±15% sanity halt in `update-nav.mjs` is a different
  thing (a bad-feed stop for the NAV tracker) and still applies there.
- *Reference precision for 18-decimal low-price tokens.* The contract's
  reference unit is USD × 1e18 per base unit, which for an 18-decimal token
  is the USD price in whole units — ETH posts as `2395`, and a sub-dollar
  18-decimal token cannot be posted at all. The testnet mocks side-step this
  by choosing decimals per price (site repo `contracts/baskets/gen-manifest.py`);
  mainnet does not get to choose and needs a scale change in the contract.
  Listed as open.

## What is NOT implemented

- **Special corporate events** (token migrations like MKR→SKY, hacks,
  delistings) — explicitly out of scope for this pass. If one happens while
  the keeper is running it will most likely surface as a missing price or a
  sudden eligibility change; that day's run should be reviewed by a person,
  not auto-resolved.
- **Hourly / intraday checks** — the keeper is a once-a-day job, same
  cadence as `scripts/track-record.mjs`. There is no sanity-move circuit
  breaker like `keeper/update-nav.mjs`'s ±15% halt (nothing here posts an
  on-chain NAV that a bad print could corrupt; the worst case is a bad
  number in a rules-only jsonl line, which the next day's run does not
  compound).
- **Rebalance execution.** The keeper marks; it does not trade. Registry
  changes (announce, wait seven days, execute, drain by auction, finalise)
  and weight rebalances (dutch auctions between members) are the next step.
  What exists today is the pending-registry file and the RUNBOOK procedure.
- **Non-EVM on-chain issuance history** — the supply registry has weekly
  history only for the EVM chains its own pipeline could reach with a free
  archive RPC (Ethereum, Base, Optimism, Arbitrum). Solana/Tron/Hyperliquid/
  Cosmos-chain tokens (JUP, RAY, PUMP, HYPE, TRX, INJ, AVAX, BNB, SOL, DYDX)
  fall back to the CoinGecko mcap/price proxy for issuance; BSC (CAKE, XVS)
  has no history at all (no free archive RPC found — see
  `keeper/supply/README.md`, copied alongside the registry, for the exact
  endpoints tried and their errors) and always uses the CoinGecko fallback.
- **A qDEFI protocol/token manual mapping table.** qREV has one
  (`qrev-protocol-map.json`); qDEFI does not yet, and qdefi.md's own D5 says
  so ("표 없음"). Two concrete, rulebook-predicted consequences observed in
  the 2026-09-15 dry run, below.
- **BNB in the qREV chain-token universe.** The rulebook's 2026-09-15
  decision treats BNB as a chain token subject to the net-burn test, but
  the copied protocol map (dated 2026-09-14, before that decision) has no
  BNB row at all. Adding one needs the same anchored-decision process as any
  other change to the manual map (rulebook §1/§10).

## Known gaps found by actually running it (2026-09-15 dry run)

- **qDEFI + HYPE**: DefiLlama lists a "Hyperliquid L1" chain entry with
  `tokenSymbol: HYPE`, so the mechanical "chains are out" rule (qdefi.md §1)
  excludes HYPE — even though qdefi.md's own worked appendix includes HYPE
  at #1 (35%, capped). The rulebook's D5 names exactly this ambiguity as
  unresolved ("HYPE/PUMP cases — no table yet"). This implementation follows
  the written mechanical rule as it stands today rather than quietly
  special-casing HYPE; closing D5 with a manual override table (same
  mechanism as qREV's protocol map) is an owner decision, not something to
  infer from the appendix.
- **qDEFI + PUMP**: qdefi.md §3 predicts, by name, that PUMP's DefiLlama
  symbol lookup collides with an unrelated protocol ("PumpSwap", category
  Dexs) and is wrongly classified as DeFi-family as a result, absent a
  manual mapping table. The 2026-09-15 dry run reproduces exactly that:
  PUMP appears in the qDEFI basket at ~6.3% via the PumpSwap collision, not
  because pump.fun (a Launchpad, meant to be excluded) actually qualifies.
  Same fix as HYPE: a manual protocol/token table, not yet built.

## How to run

```bash
cd quadrix-track-record
node keeper/paper-index.mjs --index qrev  --dry-run   # writes keeper/dryrun/
node keeper/paper-index.mjs --index qdefi --dry-run
node keeper/paper-index.mjs --index qrev              # writes trackrecord/
KEEPER_PK=0x... node keeper/paper-index.mjs --index qrev --anchor
node keeper/paper-index.mjs --index barbell --dry-run  # sleeve index, dry run only for now
node keeper/paper-index.mjs --index triens  --dry-run
node keeper/paper-index.mjs --index qx20 --dry-run    # basket leg only, from keeper/state.json
KEEPER_PK=0x... node keeper/paper-index.mjs --index qx20   # posts the qX20 basket's marks (once basket.vault is set)
```

`--dry-run` does not de-duplicate by date (unlike the production path),
specifically so it can be run more than once in one day to exercise both the
reconstitution branch (first run / new quarter) and the mark-to-market-only
branch (any other day) without waiting for a real quarter boundary.

Refreshing the copied inputs (`keeper/rulebooks/qrev-protocol-map.json`,
`keeper/supply/*.json`) is a manual step: re-run the site repo's
`docs/research/qrev/supply/{build_registry.py,fetch-supply.py}` and the
hr-protocols scrape, then copy the outputs over. Per both rulebooks (§1,
§10), any change to the manual maps is itself a decision that should be
anchored, not a silent data refresh — this keeper does not do it
automatically, on purpose.

## Verification

`scripts/verify.mjs` now accepts `--series qrev` and `--series qdefi` in
addition to the existing `dry`/`live`/`all` (which still means dry+live
only — unchanged). Paper-index records hash-chain and anchor-check exactly
like the operating record, under their own calldata prefix
(`qxpi-qrev:`/`qxpi-qdefi:` vs. the operating record's `qxtr:`); they carry
no `decisions` field, so that check is skipped for them rather than failing.
