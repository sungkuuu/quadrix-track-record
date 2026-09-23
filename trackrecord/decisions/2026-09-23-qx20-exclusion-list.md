# qX20 — nine tickers leave the exclusion list, decided 2026-09-23

**Decided:** 2026-09-23 (owner). **Effective:** at the first keeper run of 2026-10 — the scheduled monthly
reconstitution — once this document is anchored. **Series:** the qX20 keeper book (`keeper/state.json`, NAV
marks on chain) and the published simulation; unchanged until that run.

## What changes

The engine's exclusion list carries nine tickers that no stated exclusion category explains — the list's
categories are stablecoins, wrapped/bridged representations, staking derivatives, LP/vault shares, exchange
tokens, tokenised RWA/money-market shares and gold-pegged tokens — and the rulebook has carried them as open
item Q1 since 2026-09-11:

**LTC · XMR · DASH · ZEC · PIVX · XVG · KMD · OMG · TON**

They are removed. From the 2026-10 reconstitution a name among them that ranks inside the rank buffer
(enter at 17 or better) on the run's snapshot enters the index like any other name. Nothing else changes:
the categorical exclusions, the 60% cap, monthly reconstitution at the first run of the calendar month, the
5-point drift band, the 17/23 rank buffer.

## Where the list lives

The same base list is code in three places and is changed in all three by the commit that carries this file:
`keeper/update-nav.mjs` (qX20 live keeper), `keeper/paper-index.mjs` (`QX20_EXCLUDE`, reused as the base
exclusion set by the paper indexes before their own sector screens), and the site engine
`src/engine/indexEngine.ts` (`DEFAULT_EXCLUSIONS`, the published simulation). The paper indexes are not
expected to change: none of the nine carries a DeFi, holder-revenue or AI classification today; the keeper
dry run after the change is recorded below.

## Why

The nine were inherited with the engine's default list and never had a rule behind them. A rulebook that
says "the whole market by market cap after the stated exclusions" cannot silently drop the tenth- and
twentieth-largest names by an unwritten preference. The owner's decision is to make the list match the rule
rather than write a rule to fit the list.

## Stated once, honestly

Four of the nine (XMR, ZEC, DASH, PIVX) are privacy coins that Korean exchanges delisted in 2019–2021 under the
travel rule. On a testnet every constituent is a mock, so the index and its testnet basket can hold them; a
mainnet vault whose non-EVM path runs through Upbit custody could not, and a mainnet vault is a separate
anchored decision in any case. That constraint is a holdability fact, disclosed on the record, not a rule of
the index — the same treatment qAI gives TAO and AKT.

## Dry run (2026-09-23, the keeper's own source — CoinGecko top-60)

With the nine allowed, today's ranks among the eligible names: **ZEC 7 · XMR 10 · LTC 18**; DASH, PIVX, XVG, KMD, OMG,
TON are outside the top 60. Under the rank buffer (enter at 17 or better, leave only below 23) ZEC and XMR would
enter at the 2026-10 reconstitution; LTC at 18 would not clear the entry line. Raw market-cap weights at today's
prices: ZEC 1.08%, XMR 0.42%. Which incumbents leave depends on the ranks on the run day; today the lowest incumbents
would be pushed to 21–23 and stay unless they fall below 23. This is a projection on 2026-09-23 data, not the run.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `keeper/update-nav.mjs` (`LEGACY_EXCLUDE`, `LEGACY_EXCLUDE_UNTIL = 2026-09-30`) | the commit that carries this file |
| `keeper/paper-index.mjs` (`QX20_LEGACY_EXCLUDE`, same gate) | the commit that carries this file |
| site `src/engine/indexEngine.ts`, `scripts/gen-qx20-series.mjs`, `docs/methodology/qx20.md` Q1 | the site commit that follows this anchor, referenced from the rulebook |
