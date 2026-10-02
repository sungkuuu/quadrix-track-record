# qTRI basket — registry reconstitution of 2026-10-01

**Decided:** 2026-10-02, on the keeper's reconstitution of 2026-10-01. **Effective on chain:** announced after this document is anchored (the announcement carries its sha256); executable from announce + 7 days — `REGISTRY_DELAY` is 7 days and is not shortened. **Series:** `trackrecord/record-triens.jsonl`, row seq 9 of 2026-10-01 (hash `748188f51f47f755b3f905720f608dc7b0fc5128cb45aeb4eb9ddd48e3ec74a2`, reconstituted true). **Vault:** `0xaFd422C43e8a0aFD36a9bce01Bb20DB19e4324A5` (GIWA Sepolia, chain 91342), `assetCount` 10 at block 37575828; 11 once the change is executed.

## What enters

| Name | Mock (GIWA Sepolia) | Decimals | Book weight | First reference price on 2026-10-02 (USD × 1e18 per base unit) | Source A | Source B | Apart |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AERO | `0x2BefB7Fcb681b20014c9E19b023ae4c9ccB28D4d` | 8 (read from the mock) | 0.66% | `7871100000` | 0.78711 | 0.7865125741277387 | 8 bp |

The first reference price of a new asset is band-free by construction (`setRefPrice` applies the ±15% band only from the second post), so it is the one number in this change that nothing on chain bounds. Policy: it is posted only when two independent sources agree within 2.00% and the mock's `decimals()` on chain equals the value above; a wrong decimal is a 10× price and the band then needs about fifteen steps to walk it back. The price posted is taken from the two sources on the execution day, when the plan is regenerated; the prices above are those of 2026-10-02.

## What leaves

Nothing leaves the registry in this change.

## Target weights and the vault today

"Target (book)" is the keeper's book after the reconstitution, at the plan's prices; "vault" is the vault's holdings at the same prices. "Record row" is the weight the record row of 2026-10-01 prints, at that row's prices. What this session trades: a name that enters or leaves the registry; a held name whose vault weight is 5 points or more away from its book target (the rulebook's reconstitution tolerance, applied here to the vault's weights); and every name, if any sleeve is that far from its target (every sleeve then resets). Every other name is held and not auctioned.

| Name | Sleeve | Target (book) | Record row | Vault | Drift | Action | Auctions aim at |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WC | workingCapital | 46.17% | 46.51% | 46.15% | +0.0 pt | hold | — |
| BTC | monetary | 29.94% | 29.56% | 29.92% | +0.0 pt | hold | — |
| HYPE | quality | 7.83% | 7.82% | 8.07% | +0.2 pt | hold | — |
| TRX | quality | 7.50% | 7.63% | 7.73% | +0.2 pt | hold | — |
| SKY | quality | 2.38% | 2.26% | 2.45% | +0.1 pt | hold | — |
| CAKE | quality | 1.81% | 1.82% | 1.86% | +0.1 pt | hold | — |
| UNI | quality | 1.50% | 1.48% | 1.55% | +0.0 pt | hold | — |
| RAY | quality | 0.79% | 0.80% | 0.82% | +0.0 pt | hold | — |
| BNB | quality | 0.71% | 0.71% | 0.73% | +0.0 pt | hold | — |
| PENDLE | quality | 0.70% | 0.72% | 0.72% | +0.0 pt | hold | — |
| AERO | quality | 0.66% | 0.71% | 0.00% | -0.7 pt | trade (add) | 0.00% |

"Auctions aim at" is what this session's trades reach. Only the names marked "trade" are auctioned: together they keep the value they hold today and share it in proportion to their book targets. A held name is not sold to pay for an entering one. The book did otherwise on 2026-10-01: it bought the entering name at its target inside its sleeve and scaled every holding of that sleeve by one factor. After the session the vault therefore holds 0.66 points less of the entering names than the book (AERO 0.00% against 0.66%) and 0.66 points more of the names it does not trade. The session leaves this difference between the vault and the index open; it stays until a later session trades those names. A change to the planning tool so that entering names are bought to their book weights, as the book does, is in preparation; if it is in force by the execution day, a separate anchored decision states it before the session.

## The seven-day lag

The paper index reconstituted on 2026-10-01; the record row of that day carries the new membership and weights. The vault cannot: `announceRegistryChange` fixes the tuple (adds, removes, this document's sha256) and `executeRegistryChange` accepts exactly that tuple only after 7 days — from announce + 7 days. Between the two the vault holds the old shape, `navPerShare` keeps tracking the index, and redemptions pay the old shape. Only one change can be pending per vault and announcing again restarts the clock, so the tuple above is not to be amended by a second announcement. Over the lag the vault's holdings are on chain and the index is in the record, so the difference between the two can be computed by anyone.

## Auction policy in force

- Every weight change goes through the vault's bounded dutch auctions (keeper opens `openAuction(sell, buy, amount, 1800 s)`; the curve runs from +2% to −1% of the reference over the duration; per-fill floor 100 bp and daily budget 300 bp are the contract's and are not changed).
- Fills by our own bidder are taken at the curve's fair point (`fill` policy `fair`: factor 10,000 to 10,010 bp, `lossAtRef` 0), so share value at reference prices is unchanged by the session and the record shows no gift either way.
- During a session a reference price is re-posted only at the value already on chain (to refresh the v3.1 staleness clock, `maxRefAge` 3600 s); a session never moves a reference, and it refuses to start while any reference is more than 5.00% away from the day's mark.
- Roles as deployed: owner `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`, keeper `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` — the same key, which is also whitelisted to create and to bid. This is the testnet shape and not the mainnet one; the contract cannot bound a keeper that both marks and fills, so every safety of this reconstitution rests on the script guards stated here. Fills are signed by that same key (`isBidder` is true for it on this vault); no separate bidder key is used in this session.

## Planned auctions

None. No held name is marked for trading, and this session buys an entering name only with the value of the names it trades, so AERO enters the registry with a zero balance. The book holds 0.66% of it; the vault holds 0% until a later session trades other names of this basket, which this method does not guarantee at the next reconstitution either.

## Pinned

| Item | Value |
| --- | --- |
| Plan file | `keeper/plans/triens/2026-10-02.json` as generated 2026-10-02T06:02:32.219Z, sha256 `926750419759bc53c4cafc4ebf3233970f4394e000ba67d953aaa0c254f8cfdc`. Later stages rewrite this path (the plan stage adds the decision id, the announce stage the announce transaction), so the hash is of that earlier version, which stays in the repository history |
| Rulebook | `keeper/rulebooks/triens.json` sha256 `94fd4573466f5f44909d1d6b16ade497e52972024ee6dd4cb4bb268c8af2f6bc` |
| Book | `keeper/state-triens.json` |
| Prices | A: coingecko (fetched, cached as keeper/cache/cg-markets-top500-2026-10-02.json); B: coinpaprika (fetched, cached as keeper/cache/cp-tickers-2026-10-02.json) |
| Record row | 2026-10-01 seq 9, `748188f51f47f755b3f905720f608dc7b0fc5128cb45aeb4eb9ddd48e3ec74a2` |
| Plan run | basket-reconstitution 36971626401 |
| Chain read | block 37575828 (2026-10-02T06:02:24.000Z) |

