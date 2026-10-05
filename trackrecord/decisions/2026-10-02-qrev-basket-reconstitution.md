# qREV basket — registry reconstitution of 2026-10-01

**Decided:** 2026-10-02, on the keeper's reconstitution of 2026-10-01. **Effective on chain:** announced after this document is anchored (the announcement carries its sha256); executable from announce + 7 days — `REGISTRY_DELAY` is 7 days and is not shortened. **Series:** `trackrecord/record-qrev.jsonl`, row seq 13 of 2026-10-01 (hash `fad09f996ae0032a14ae35ce3c7708d4f4a7bf486dcb7f99853b2db9453f4b4d`, reconstituted true). **Vault:** `0xBa83462fDFeDE13DC7Eb1D1fd893aE76dCaaD975` (GIWA Sepolia, chain 91342), `assetCount` 10 at block 37575667; 15 once the change is executed.

## What enters

| Name | Mock (GIWA Sepolia) | Decimals | Book weight | First reference price on 2026-10-02 (USD × 1e18 per base unit) | Source A | Source B | Apart |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SYRUP | `0x13dB3B252c993dD7AD7e6b02964dADD7d181D460` | 8 (read from the mock) | 2.18% | `2342400000` | 0.23424 | 0.23418545597020982 | 2 bp |
| TRX | `0xA8C8310bF839B24CB10fD40c0323C9BF8f19ddc2` | 8 (read from the mock) | 23.48% | `3342130000` | 0.334213 | 0.33406296039671535 | 4 bp |
| LINK | `0x9F23FF0f9f58a391603c07dC12ca2bb881BC0F45` | 10 (read from the mock) | 2.13% | `1445000000` | 14.45 | 14.434172119146401 | 11 bp |
| NEAR | `0xbD815b0c9601f32A5bab22E7cff38E483789E4e8` | 9 (read from the mock) | 1.93% | `4980000000` | 4.98 | 4.9790012413111855 | 2 bp |
| BNB | `0x495fA29f63cbAE7e1Abbfdb209413a8dC4b950e9` | 11 (read from the mock) | 2.15% | `7768100000` | 776.81 | 776.6013747942885 | 3 bp |

The first reference price of a new asset is band-free by construction (`setRefPrice` applies the ±15% band only from the second post), so it is the one number in this change that nothing on chain bounds. Policy: it is posted only when two independent sources agree within 2.00% and the mock's `decimals()` on chain equals the value above; a wrong decimal is a 10× price and the band then needs about fifteen steps to walk it back. The price posted is taken from the two sources on the execution day, when the plan is regenerated; the prices above are those of 2026-10-02.

## What leaves

Nothing leaves the registry in this change.

## Target weights and the vault today

"Target (book)" is the keeper's book after the reconstitution, at the plan's prices; "vault" is the vault's holdings at the same prices. "Record row" is the weight the record row of 2026-10-01 prints, at that row's prices. On that row the weight column is the rule's target weight; the book keeps a name inside the tolerance at its drifted unit count and then scales every holding by one factor, so the two columns differ. What this session trades: a name that enters or leaves the registry; a held name whose vault weight is 5 points or more away from its book target (the rulebook's reconstitution tolerance, applied here to the vault's weights); any name above the 35.00% cap. Every other name is held and not auctioned.

| Name | Target (book) | Record row | Vault | Drift | Action | Auctions aim at |
| --- | --- | --- | --- | --- | --- | --- |
| HYPE | 28.32% | 35.00% | 31.05% | +2.7 pt | hold | — |
| TRX | 23.48% | 26.42% | 0.00% | -23.5 pt | trade (add) | 20.77% |
| SKY | 6.15% | 6.45% | 15.97% | +9.8 pt | trade (drift 9.8pt) | 5.44% |
| ZRO | 5.80% | 2.38% | 6.36% | +0.6 pt | hold | — |
| CAKE | 5.35% | 5.94% | 12.47% | +7.1 pt | trade (drift 7.1pt) | 4.73% |
| RAY | 4.65% | 2.38% | 5.10% | +0.4 pt | hold | — |
| JUP | 4.59% | 2.38% | 5.03% | +0.4 pt | hold | — |
| AERO | 4.41% | 2.38% | 4.83% | +0.4 pt | hold | — |
| CRV | 3.54% | 2.38% | 3.88% | +0.3 pt | hold | — |
| PENDLE | 3.15% | 2.38% | 3.45% | +0.3 pt | hold | — |
| SYRUP | 2.18% | 2.38% | 0.00% | -2.2 pt | trade (add) | 1.93% |
| UNI | 2.18% | 2.38% | 11.86% | +9.7 pt | trade (drift 9.7pt) | 1.93% |
| BNB | 2.15% | 2.38% | 0.00% | -2.2 pt | trade (add) | 1.90% |
| LINK | 2.13% | 2.38% | 0.00% | -2.1 pt | trade (add) | 1.89% |
| NEAR | 1.93% | 2.38% | 0.00% | -1.9 pt | trade (add) | 1.71% |

"Auctions aim at" is what this session's trades reach. Only the names marked "trade" are auctioned: together they keep the value they hold today and share it in proportion to their book targets. A held name is not sold to pay for an entering one. The book did otherwise on 2026-10-01: it set each traded name, the entering ones included, to its target and then scaled every holding by one factor. After the session the vault therefore holds 3.67 points less of the entering names than the book (SYRUP 1.93% against 2.18%, TRX 20.77% against 23.48%, LINK 1.89% against 2.13%, NEAR 1.71% against 1.93%, BNB 1.90% against 2.15%) and 5.25 points more of the names it does not trade. The session leaves this difference between the vault and the index open; it stays until a later session trades those names. A change to the planning tool so that entering names are bought to their book weights, as the book does, is in preparation; if it is in force by the execution day, a separate anchored decision states it before the session.

## The seven-day lag

The paper index reconstituted on 2026-10-01; the record row of that day carries the new membership and weights. The vault cannot: `announceRegistryChange` fixes the tuple (adds, removes, this document's sha256) and `executeRegistryChange` accepts exactly that tuple only after 7 days — from announce + 7 days. Between the two the vault holds the old shape, `navPerShare` keeps tracking the index, and redemptions pay the old shape. Only one change can be pending per vault and announcing again restarts the clock, so the tuple above is not to be amended by a second announcement. Over the lag the vault's holdings are on chain and the index is in the record, so the difference between the two can be computed by anyone.

## Auction policy in force

- Every weight change goes through the vault's bounded dutch auctions (keeper opens `openAuction(sell, buy, amount, 1800 s)`; the curve runs from +2% to −1% of the reference over the duration; per-fill floor 100 bp and daily budget 300 bp are the contract's and are not changed).
- Fills by our own bidder are taken at the curve's fair point (`fill` policy `fair`: factor 10,000 to 10,010 bp, `lossAtRef` 0), so share value at reference prices is unchanged by the session and the record shows no gift either way.
- During a session a reference price is re-posted only at the value already on chain (to refresh the v3.1 staleness clock, `maxRefAge` 3600 s); a session never moves a reference, and it refuses to start while any reference is more than 5.00% away from the day's mark.
- Roles as deployed: owner `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`, keeper `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` — the same key, which is also whitelisted to create and to bid. This is the testnet shape and not the mainnet one; the contract cannot bound a keeper that both marks and fills, so every safety of this reconstitution rests on the script guards stated here. Fills are signed by that same key (`isBidder` is true for it on this vault); no separate bidder key is used in this session.

## Planned auctions

| # | Sell | Buy | Sell amount (base units) | ≈ USD at plan prices (testnet mocks, no market value) | Duration | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | SKY | TRX | 16481622671130 | 139,519 | 1800 s | drift 9.8pt → add |
| 2 | UNI | TRX | 14421272175495 | 131,666 | 1800 s | drift 9.7pt → add |
| 3 | CAKE | TRX | 1586383459999 | 4,140 | 1800 s | drift 7.1pt → add |
| 4 | CAKE | SYRUP | 9792139135486 | 25,557 | 1800 s | drift 7.1pt → add |
| 5 | CAKE | BNB | 9666958609152 | 25,231 | 1800 s | drift 7.1pt → add |
| 6 | CAKE | LINK | 9573382412453 | 24,987 | 1800 s | drift 7.1pt → add |
| 7 | CAKE | NEAR | 8676482388778 | 22,646 | 1800 s | drift 7.1pt → add |

The amounts and weights here are those of the plan of 2026-10-02. On the execution day the plan is regenerated with that day's prices and balances under the same rules, and the session follows that plan; a removal's last slice sells whatever balance remains. The auctions aim at, and the executor verifies against, these weights of the traded names: SKY 5.44%, CAKE 4.73%, UNI 1.93%, SYRUP 1.93%, TRX 20.77%, LINK 1.89%, NEAR 1.71%, BNB 1.90%. The plan's own projection of the weights after these fills at its prices agrees with those targets within 0.00 pt (generator tolerance 0.5 pt).

## Pinned

| Item | Value |
| --- | --- |
| Plan file | `keeper/plans/qrev/2026-10-02.json` as generated 2026-10-02T05:59:56.361Z, sha256 `a5c8133b5ade990ff49226d09f5d88ec3fa58ea0282df0ff9fc2218057c2319d`. Later stages rewrite this path (the plan stage adds the decision id, the announce stage the announce transaction), so the hash is of that earlier version, which stays in the repository history |
| Rulebook | `keeper/rulebooks/qrev.json` sha256 `3a1fed4b3bddd84ab250a3b6b953579a15f8008e9e865cc5d459e78ea7e927d8` |
| Book | `keeper/state-qrev.json` |
| Prices | A: coingecko (fetched, cached as keeper/cache/cg-markets-top500-2026-10-02.json); B: coinpaprika (fetched, cached as keeper/cache/cp-tickers-2026-10-02.json) |
| Record row | 2026-10-01 seq 13, `fad09f996ae0032a14ae35ce3c7708d4f4a7bf486dcb7f99853b2db9453f4b4d` |
| Plan run | basket-reconstitution 36971405900 |
| Chain read | block 37575667 (2026-10-02T05:59:43.000Z) |

