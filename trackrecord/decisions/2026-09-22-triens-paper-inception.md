# Triens paper index — inception, 2026-09-22

**Effective:** 2026-09-22 (UTC). **Series:** `trackrecord/record-triens.jsonl`, anchors `trackrecord/anchors-triens.jsonl`, calldata prefix `qxpi-triens:`.

## What starts today

A daily, rules-only index level for Triens, a three-sleeve basket: **BTC 30% / working capital 40% /
Quality 30%**. Genesis level 100 on 2026-09-22. No vault, no capital, no shares: the record is the
index itself, computed by the keeper `keeper/paper-index.mjs --index triens` from public sources and
appended one line per day, hash-chained and anchored on GIWA Sepolia (chainId 91342) as a zero-value
self-send, the same mechanism as the N1Q live record and the qREV/qDEFI paper indices. Append-only;
a missed day is a permanent gap.

## The rules in force (pinned)

The rulebook is `docs/methodology/triens.md` in the site repository at commit `e50d157`
(sha256 `cdf8f914eb3c51207fd63d58d0d9186bd9716804b6a075e947efaa8d9c56382c`); the Quality sleeve
inherits its universe, exclusions, value-trap filter, rank buffer, hysteresis, floor and cap from the
qREV rulebook `docs/methodology/value-capture.md` (sha256
`1fe29f501f3d5cbd62df778da98fbe068a568f07eaba7d875ff389983e274a3e`). Implemented in
`keeper/rulebooks/triens.json` (sha256 `348a2633eacee9f54dacf2f12099c71daaa1b9bb5c7a6f8b5a61eef1594c518b`),
`keeper/working-capital.mjs` (sha256 `c7a07b284565520915b2776c34c7690dc689215594381e75f6b0332eadaa43ee`)
and `keeper/paper-index.mjs` at record-repo commit `de4d1dc`; protocol → token mapping
`keeper/rulebooks/qrev-protocol-map.json` (sha256 `18953ee95fa1fe40637d697d9c7e7867a8e1cf87d158792647cbadaa9372d686`),
supply registry `keeper/supply/registry.json` (sha256 `12d79fbe2b6eca3ddb3f5106573a853d995ca2fa0a05ba3529c702f3f616c1d6`).
In one paragraph:

Three sleeves at 30/40/30. BTC alone in the monetary sleeve. The working-capital sleeve is, by rule,
fully-reserved fiat-backed stablecoins that pay interest. The Quality sleeve holds up to ten names
from the qREV universe (tokens with DefiLlama holder-attributable revenue, plus chain tokens whose
trailing-12-month burn exceeds new issuance) that pass: holder revenue > 0 for six consecutive months
and ≥ $1M over twelve, **issuance over the same twelve months no greater than holder revenue** (the
gate; names whose issuance cannot be measured fail it), last-30-day revenue ≥ 25% of the trailing
monthly average, circulating market cap ≥ $150M, 24h volume ≥ $10M, listing age ≥ 365 days. Ranked
and weighted by holder revenue net of issuance, floor 2%, cap 35% within the sleeve (10.5% of the
index), rank buffer enter ≤ 8 / exit > 13, one grace quarter before an incumbent exits. Each empty
seat (fewer than ten eligible) puts 1/10 of the sleeve into working capital. Quarterly reset of the
three sleeves on the first run after 00:00 UTC on 1 Jan / Apr / Jul / Oct; no trade when every
sleeve is within five points of target; no drift band, no overlay. Issuance = on-chain total supply
less protocol-controlled addresses in the supply registry; names without a complete census use
market-data supply and are flagged (fixed to match the rulebook on 2026-09-22; no earlier record is
rewritten). Levels are gross; the management fee decided for a future vault (1% a year, decrease-only
once in a contract) is carried as data and not applied to the level.

## What the record uses in place of a stablecoin

No fully-reserved fiat-backed stablecoin exists on GIWA today. Until one does, the working-capital
sleeve in this record is a synthetic one-dollar unit accruing the 3-month US Treasury bill rate daily
(FRED series DTB3, last published rate carried forward). Every record line says so (`wcProxy: "DTB3"`).
The gap to a real interest-bearing stable is not modelled; the depeg rule in the rulebook draft is
carried as data and not implemented.

## What this record does and does not show

From day one it shows that the rule runs as written, without discretion, on sources anyone can
re-pull, including the seat count: on the dry run of 2026-09-21 the screen passed seven names and
three seats sat in working capital. It shows nothing about returns until it is long. The backtest
behind these rules covers 2021-11 → 2026-09, with the Quality seats fully filled in only two quarters;
it was used to choose a drawdown budget among sleeve ratios whose returns it could not tell apart. The
special-event rule (rulebook §9) is recorded only as a note when triggered. A vault, if one is ever
built on this index, is a separate anchored decision and is not possible while GIWA carries no
canonical BTC.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix (site, rulebook, research, registry) | `e50d157` |
| quadrix-track-record (keeper, this file) | `de4d1dc` |
