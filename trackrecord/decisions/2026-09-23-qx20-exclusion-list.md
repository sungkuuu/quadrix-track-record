# qX20 — nine tickers leave the exclusion list, decided 2026-09-23 (DRAFT — not anchored)

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

## Dry run

_To be filled from `node keeper/update-nav.mjs --dry-run` after the list change: which of the nine would
enter at the 2026-10 reconstitution on today's snapshot, and the resulting weights._

## Pinned

_Filled at anchoring: site commit, `docs/methodology/qx20.md` sha256, this repo's keeper commit._
