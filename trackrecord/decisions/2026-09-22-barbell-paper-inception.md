# Barbell paper index — inception, 2026-09-22

**Effective:** 2026-09-22 (UTC). **Series:** `trackrecord/record-barbell.jsonl`, anchors `trackrecord/anchors-barbell.jsonl`, calldata prefix `qxpi-barbell:`.

## What starts today

A daily, rules-only index level for Barbell, a two-sleeve basket: **BTC 60% / working capital 40%**.
Genesis level 100 on 2026-09-22. No vault, no capital, no shares: the record is the index itself,
computed by the keeper `keeper/paper-index.mjs --index barbell` from public sources and appended one
line per day, hash-chained and anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send,
the same mechanism as the N1Q live record and the qREV/qDEFI paper indices. Append-only; a missed day
is a permanent gap.

## The rules in force (pinned)

The rulebook is `docs/methodology/barbell.md` in the site repository at commit `e50d157`
(sha256 `c1a95d093d37d42009064c7cc76bcb1ffc2fe261d9dac53163e35c19b6c98f1f`), as implemented in
`keeper/rulebooks/barbell.json` (sha256 `2ee6cc8a54a4529f951813bb3d972653483af3c7f5b16e982d3c4323751b21cc`),
`keeper/working-capital.mjs` (sha256 `c7a07b284565520915b2776c34c7690dc689215594381e75f6b0332eadaa43ee`)
and `keeper/paper-index.mjs` at record-repo commit `de4d1dc`. In one paragraph:

Two sleeves, BTC and working capital, at 60/40. The BTC sleeve is bitcoin alone; the working-capital
sleeve is, by rule, fully-reserved fiat-backed stablecoins that pay interest (fiat or short-dated
government bills held 100% against issuance, issuer attestation published) — no partially reserved,
synthetic or crypto-collateralised stables. Quarterly reset to 60/40 on the first run after 00:00 UTC
on 1 Jan / Apr / Jul / Oct; no trade when both sleeves are within five points of target; no drift band
and no conditional switch between quarters. Interest accrues inside the working-capital sleeve and is
redistributed only at the quarterly reset. Levels are gross; the management fee decided for a future
vault (0.5% a year, decrease-only once in a contract) is carried as data and not applied to the level.

## What the record uses in place of a stablecoin

No fully-reserved fiat-backed stablecoin exists on GIWA today. Until one does, the working-capital
sleeve in this record is a synthetic one-dollar unit accruing the 3-month US Treasury bill rate daily
(FRED series DTB3, last published rate carried forward on days without a print). Every record line
says so (`wcProxy: "DTB3"`). The gap between this proxy and a real interest-bearing stable — issuer
spread, redemption terms, depeg risk — is not modelled. The depeg rule in the rulebook draft ($0.98
for 72 hours) is carried as data and not implemented.

## What this record does and does not show

From day one it shows that the rule runs as written, without discretion, on sources anyone can
re-pull. It shows nothing about returns until it is long. The backtest behind the ratio covers
2017-12 → 2026-09 and was used to choose a drawdown budget, not to promise an outcome: in that
history a 60/40 book fell about half as far as bitcoin and earned less than bitcoin in every window
that began at a market low. A vault, if one is ever built on this index, is a separate anchored
decision and is not possible while GIWA carries no canonical BTC.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix (site, rulebook, research) | `e50d157` |
| quadrix-track-record (keeper, this file) | `de4d1dc` |
