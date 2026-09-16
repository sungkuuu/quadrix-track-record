# qREV paper index — inception, 2026-09-16

**Effective:** 2026-09-16 (UTC). **Series:** `trackrecord/record-qrev.jsonl`, anchors `trackrecord/anchors-qrev.jsonl`, calldata prefix `qxpi-qrev:`.

## What starts today

A daily, rules-only index level for the Revenue Index (qREV). Genesis level 100 on 2026-09-16.
No vault, no capital, no shares: the record is the index itself, computed by the keeper
`keeper/paper-index.mjs --index qrev` from public sources and appended one line per day,
hash-chained and anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send, the
same mechanism as the N1Q live record. Append-only; a missed day is a permanent gap.

## The rules in force (pinned)

The rulebook is `docs/methodology/value-capture.md` in the site repository at commit
`ba58017` (sha256 `2cc7fd1a0ea771cb8c63cdf1d1e90815ffb20c599a9aa5ee7274ce32a1883484`), as implemented in `keeper/rulebooks/qrev.json` (sha256 `dc3fc0aba20a2284da4a72b867e34287a53af31c6bedcd4c35fea1bc889f34c8`)
and `keeper/paper-index.mjs` at record-repo commit `3f2da36`. In one paragraph:

Universe: tokens with DefiLlama holder-attributable revenue, plus chain tokens whose trailing-12-month
burn exceeds the value of new issuance (BNB is a chain token). Eligibility: circulating market cap ≥ $150M,
24h volume ≥ $10M, holder revenue > 0 for six consecutive months and ≥ $1M over twelve, listing age ≥ 365
days, last-30-day revenue ≥ 25% of the trailing monthly average. Selection: the ten cheapest on P/HR
(circulating market cap ÷ trailing-12-month holder revenue), rank buffer enter ≤ 8 / exit > 13, one grace
quarter before an incumbent exits. Weight ∝ holder revenue net of the value of tokens issued over the same
twelve months, floor 2% of the basket's positive net revenue, cap 35% cut at every reconstitution. Issuance
= on-chain total supply less protocol-controlled addresses in the supply registry (`keeper/supply/registry.json`,
sha256 `12d79fbe2b6eca3ddb3f5106573a853d995ca2fa0a05ba3529c702f3f616c1d6`); voluntary lock-ups count as issued; names without a complete census use CoinGecko supply and
are flagged. Quarterly reconstitution on the first run after 00:00 UTC on 1 Jan / Apr / Jul / Oct; a target
that differs from the drifted weight by under five points is not traded; no trading in between.
Protocol → token mapping: `keeper/rulebooks/qrev-protocol-map.json` (sha256 `18953ee95fa1fe40637d697d9c7e7867a8e1cf87d158792647cbadaa9372d686`).

## What is not implemented in this record

The special-event rule (rulebook §9: sale on a 40% fall against bitcoin in 24h together with a 50% TVL
loss in 48h; sale on a 5% weekly outflow from protocol-controlled addresses) is recorded only as a note
when triggered; the paper series does not act on it. Hourly checks do not exist; the series is daily.
Issuance for tokens on chains without free archive access (BNB Chain, Solana, Tron, Hyperliquid, Cosmos)
is a CoinGecko proxy until the registry's own weekly record covers a year.

## What this record does and does not show

From day one it shows that the rule runs as written, without discretion, on sources anyone can re-pull.
It shows nothing about returns until it is long: the backtest behind these rules covers nine quarters
of a ten-name universe and was used to choose between rules, not to promise an outcome. Levels are gross
of any fee or cost. A vault, if one is ever built on this index, is a separate anchored decision.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix (site, rulebook, research, registry) | `ba58017` |
| quadrix-track-record (keeper, this file) | `3f2da36` |
