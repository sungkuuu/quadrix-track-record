# qDEFI basket — registry reconstitution of 2026-10-01

**Decided:** 2026-10-02, on the keeper's reconstitution of 2026-10-01. **Effective on chain:** announced after this document is anchored (the announcement carries its sha256); executable from announce + 7 days — `REGISTRY_DELAY` is 7 days and is not shortened. **Series:** `trackrecord/record-qdefi.jsonl`, row seq 13 of 2026-10-01 (hash `8991a809424270e9613ce91d1ff8d3cd3ff93fa279fae4e802cf142a6189ad22`, reconstituted true). **Vault:** `0x88D3b5f638fE0d331797C612a5496bD8f0491FD4` (GIWA Sepolia, chain 91342), `assetCount` 15 at block 37575717; 16 once the change is executed, 15 once every removal is finalized.

## What enters

| Name | Mock (GIWA Sepolia) | Decimals | Book weight | First reference price on 2026-10-02 (USD × 1e18 per base unit) | Source A | Source B | Apart |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ASTER | `0xF96360330E54E861b4B95FaA023A77dAdDcf6511` | 8 (read from the mock) | 3.64% | `7469030000` | 0.746903 | 0.7468377496221398 | 1 bp |

The first reference price of a new asset is band-free by construction (`setRefPrice` applies the ±15% band only from the second post), so it is the one number in this change that nothing on chain bounds. Policy: it is posted only when two independent sources agree within 2.00% and the mock's `decimals()` on chain equals the value above; a wrong decimal is a 10× price and the band then needs about fifteen steps to walk it back. The price posted is taken from the two sources on the execution day, when the plan is regenerated; the prices above are those of 2026-10-02.

## What leaves

| Name | Mock | Vault balance at planning | Already in removal |
| --- | --- | --- | --- |
| CRV | `0x0581Ba8a63d787b4A39ed898445b1bFdde84bdF6` | 4279229590348 | no |

A leaving asset stays in every redemption payout until auctions drain its balance to exactly zero; only then does `finalizeRemoval` drop it, by swap-and-pop, which changes the on-chain order of the remaining assets. The site's creation vector must follow `assets(i)`, not the manifest.

`finalizeRemoval` is called right after the auction that drains the asset. Anything that reaches the vault in between — a transfer from anyone, or the pro-rata slice a creation pays in — is drained again at once (a remainder under $1 is filled at the start of the curve, at most 2% above reference), up to five times; after that the asset is recorded as pending in the session's plan file (`keeper/plans/qdefi/`) and drained again in a later session. A pending remainder stays in redemption payouts and does not change the record.

## Target weights and the vault today

"Target (book)" is the keeper's book after the reconstitution, at the plan's prices; "vault" is the vault's holdings at the same prices. "Record row" is the weight the record row of 2026-10-01 prints, at that row's prices. On that row the weight column is the rule's target weight; the book keeps a name inside the tolerance at its drifted unit count and then scales every holding by one factor, so the two columns differ. What this session trades: a name that enters or leaves the registry; a held name whose vault weight is 5 points or more away from its book target (the rulebook's reconstitution tolerance, applied here to the vault's weights); any name above the 35.00% cap. Every other name is held and not auctioned.

| Name | Target (book) | Record row | Vault | Drift | Action | Auctions aim at |
| --- | --- | --- | --- | --- | --- | --- |
| HYPE | 30.25% | 35.00% | 31.01% | +0.8 pt | hold | — |
| LINK | 21.57% | 19.99% | 22.11% | +0.5 pt | hold | — |
| UNI | 11.38% | 10.25% | 11.67% | +0.3 pt | hold | — |
| AAVE | 5.57% | 4.78% | 5.71% | +0.1 pt | hold | — |
| ENA | 5.01% | 5.13% | 5.13% | +0.1 pt | hold | — |
| ONDO | 4.92% | 4.57% | 5.04% | +0.1 pt | hold | — |
| SKY | 3.95% | 3.44% | 4.05% | +0.1 pt | hold | — |
| ASTER | 3.64% | 3.84% | 0.00% | -3.6 pt | trade (add) | 1.21% |
| MORPHO | 3.56% | 3.27% | 3.65% | +0.1 pt | hold | — |
| JUP | 2.20% | 2.02% | 2.26% | +0.1 pt | hold | — |
| JST | 2.11% | 2.02% | 2.16% | +0.1 pt | hold | — |
| CAKE | 1.66% | 1.59% | 1.70% | +0.0 pt | hold | — |
| AERO | 1.55% | 1.56% | 1.59% | +0.0 pt | hold | — |
| ETHFI | 1.41% | 1.39% | 1.45% | +0.0 pt | hold | — |
| PYTH | 1.20% | 1.14% | 1.23% | +0.0 pt | hold | — |
| CRV | 0.00% | — | 1.21% | +1.2 pt | trade (remove) | 0.00% |

"Auctions aim at" is what this session's trades reach. Only the names marked "trade" are auctioned: together they keep the value they hold today and share it in proportion to their book targets. A held name is not sold to pay for an entering one. The book did otherwise on 2026-10-01: it set each traded name, the entering ones included, to its target and then scaled every holding by one factor. After the session the vault therefore holds 2.43 points less of the entering names than the book (ASTER 1.21% against 3.64%) and 2.43 points more of the names it does not trade. The session leaves this difference between the vault and the index open; it stays until a later session trades those names. A change to the planning tool so that entering names are bought to their book weights, as the book does, is in preparation; if it is in force by the execution day, a separate anchored decision states it before the session.

## The seven-day lag

The paper index reconstituted on 2026-10-01; the record row of that day carries the new membership and weights. The vault cannot: `announceRegistryChange` fixes the tuple (adds, removes, this document's sha256) and `executeRegistryChange` accepts exactly that tuple only after 7 days — from announce + 7 days. Between the two the vault holds the old shape, `navPerShare` keeps tracking the index, and redemptions pay the old shape. Only one change can be pending per vault and announcing again restarts the clock, so the tuple above is not to be amended by a second announcement. Over the lag the vault's holdings are on chain and the index is in the record, so the difference between the two can be computed by anyone.

## Auction policy in force

- Every weight change goes through the vault's bounded dutch auctions (keeper opens `openAuction(sell, buy, amount, 1800 s)`; the curve runs from +2% to −1% of the reference over the duration; per-fill floor 100 bp and daily budget 300 bp are the contract's and are not changed).
- Fills by our own bidder are taken at the curve's fair point (`fill` policy `fair`: factor 10,000 to 10,010 bp, `lossAtRef` 0), so share value at reference prices is unchanged by the session and the record shows no gift either way. The one exception is a remainder under $1 of a leaving asset, filled at the start of the curve (at most 2% above reference) so that the removal can be finalized at once.
- During a session a reference price is re-posted only at the value already on chain (to refresh the v3.1 staleness clock, `maxRefAge` 3600 s); a session never moves a reference, and it refuses to start while any reference is more than 5.00% away from the day's mark.
- Roles as deployed: owner `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`, keeper `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` — the same key, which is also whitelisted to create and to bid. This is the testnet shape and not the mainnet one; the contract cannot bound a keeper that both marks and fills, so every safety of this reconstitution rests on the script guards stated here. Fills are signed by that same key (`isBidder` is true for it on this vault); no separate bidder key is used in this session.

## Planned auctions

| # | Sell | Buy | Sell amount (base units) | ≈ USD at plan prices (testnet mocks, no market value) | Duration | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | CRV | ASTER | 4279229590348 | 16,247 | 1800 s | drains the removal to zero |

The amounts and weights here are those of the plan of 2026-10-02. On the execution day the plan is regenerated with that day's prices and balances under the same rules, and the session follows that plan; a removal's last slice sells whatever balance remains. The auctions aim at, and the executor verifies against, these weights of the traded names: ASTER 1.21%; CRV drained to zero. The plan's own projection of the weights after these fills at its prices agrees with those targets within 0.00 pt (generator tolerance 0.5 pt).

## Pinned

| Item | Value |
| --- | --- |
| Plan file | `keeper/plans/qdefi/2026-10-02.json` as generated 2026-10-02T06:00:41.306Z, sha256 `e70b97eaf9deea65867a877b52d3bb4f20c4cd191ccdf4da692d8d1a80eb5234`. Later stages rewrite this path (the plan stage adds the decision id, the announce stage the announce transaction), so the hash is of that earlier version, which stays in the repository history |
| Rulebook | `keeper/rulebooks/qdefi.json` sha256 `bac255203a00ceb7e0935ffd0c14c2c5d731afd58270db71d801b64e433deadd` |
| Book | `keeper/state-qdefi.json` |
| Prices | A: coingecko (fetched, cached as keeper/cache/cg-markets-top500-2026-10-02.json); B: coinpaprika (fetched, cached as keeper/cache/cp-tickers-2026-10-02.json) |
| Record row | 2026-10-01 seq 13, `8991a809424270e9613ce91d1ff8d3cd3ff93fa279fae4e802cf142a6189ad22` |
| Plan run | basket-reconstitution 36971478909 |
| Chain read | block 37575717 (2026-10-02T06:00:33.000Z) |

