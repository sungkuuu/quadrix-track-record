# qDEFI paper index — inception, 2026-09-16

**Effective:** 2026-09-16 (UTC). **Series:** `trackrecord/record-qdefi.jsonl`, anchors `trackrecord/anchors-qdefi.jsonl`, calldata prefix `qxpi-qdefi:`.

## What starts today

A daily, rules-only index level for the DeFi Index (qDEFI). Genesis level 100 on 2026-09-16.
No vault, no capital, no shares: the record is the index itself, computed by the keeper
`keeper/paper-index.mjs --index qdefi` from public sources and appended one line per day,
hash-chained and anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send, the same
mechanism as the N1Q live record. Append-only; a missed day is a permanent gap.

## The rules in force (pinned)

The rulebook is `docs/methodology/qdefi.md` in the site repository at commit `ba58017`
(sha256 `2f66b88d23fb8ffe7f4ebb4b57305bd4157d5095374d4021ef3eb0427dda9053`), as implemented in `keeper/rulebooks/qdefi.json` (sha256 `b7a0586c1f0edaf569d6ecacfbed30a1b670e24c5d20c66f98b2da71f3a4d8e0`) and
`keeper/paper-index.mjs` at record-repo commit `3f2da36`. In one paragraph:

Universe: the CoinGecko category `decentralized-finance-defi` intersected with a DefiLlama listing
whose category is DeFi-family (DEXs, lending, derivatives, yield, CDP, liquid staking and restaking,
basis trading, RWA, aggregators, options, synthetics, insurance); oracles in; chain tokens out unless
the token's primary adapter is a DeFi protocol (HYPE); launchpads, prediction markets, bridges and
instruments (stablecoins, wrapped assets, LSD/LRT wrappers, LP and vault shares, exchange tokens,
tokenised RWA shares) out. Eligibility: circulating market cap ≥ $150M, 24h volume ≥ $5M, listing
age ≥ 365 days. Selection: the fifteen largest by circulating market cap, rank buffer enter ≤ 13 /
exit > 17. Weight ∝ circulating market cap, cap 35% cut at every reconstitution. Quarterly
reconstitution on the first run after 00:00 UTC on 1 Jan / Apr / Jul / Oct; a target that differs
from the drifted weight by under five points is not traded; no drift band, no trading in between.
Manual token map for the two names the sources disagree on: `keeper/rulebooks/qdefi-token-map.json`
(sha256 `627d423b54123a9381c81fac95b92a832b05bde4eebaf15738752f26baaab8e3`).

## What this record does and does not show

From day one it shows that the rule runs as written, without discretion, on sources anyone can re-pull.
It shows nothing about returns until it is long. The backtest behind these rules (2019–2026) trails
bitcoin in every window; the rule was chosen as the least bad of its variants, not as a winner.
Levels are gross of any fee or cost. A vault, if one is ever built on this index, is a separate
anchored decision.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix (site, rulebook, research) | `ba58017` |
| quadrix-track-record (keeper, this file) | `3f2da36` |
