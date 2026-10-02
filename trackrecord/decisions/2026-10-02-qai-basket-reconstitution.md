# qAI basket — registry reconstitution of 2026-10-01

**Decided:** 2026-10-02, on the keeper's reconstitution of 2026-10-01. **Effective on chain:** announced after this document is anchored (the announcement carries its sha256); executable from announce + 7 days — `REGISTRY_DELAY` is 7 days and is not shortened. **Series:** `trackrecord/record-qai.jsonl`, row seq 9 of 2026-10-01 (hash `f3ec61d5789a32f70e6cc29eba88ee237788b3c71c02ab70934a067369b8eb5f`, reconstituted true). **Vault:** `0x75B072e674AfAd13Ff0C2b75A8937656643cBE97` (GIWA Sepolia, chain 91342), `assetCount` 10 at block 37575755; 12 once the change is executed, 10 once every removal is finalized.

## What enters

| Name | Mock (GIWA Sepolia) | Decimals | Book weight | First reference price on 2026-10-02 (USD × 1e18 per base unit) | Source A | Source B | Apart |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NEAR | `0x7e2Ffbefc4597C37ee6168E94eba3064Bb942393` | 9 (read from the mock) | 28.57% | `4990000000` | 4.99 | 4.9790012413111855 | 22 bp |
| ICP | `0xAe331a90C8aC9b7820EBE69f81d6808A8b6C4d16` | 9 (read from the mock) | 10.33% | `3300000000` | 3.3 | 3.297663532961859 | 7 bp |

The first reference price of a new asset is band-free by construction (`setRefPrice` applies the ±15% band only from the second post), so it is the one number in this change that nothing on chain bounds. Policy: it is posted only when two independent sources agree within 2.00% and the mock's `decimals()` on chain equals the value above; a wrong decimal is a 10× price and the band then needs about fifteen steps to walk it back. The price posted is taken from the two sources on the execution day, when the plan is regenerated; the prices above are those of 2026-10-02.

## What leaves

| Name | Mock | Vault balance at planning | Already in removal |
| --- | --- | --- | --- |
| GRT | `0x8BB34857ffF580158357102fa96bB0931e07E373` | 12377289558745 | no |
| AKT | `0x05C6B7e4b96F15Dd30A5A75977F7645619eB8634` | 3376900564245 | no |

A leaving asset stays in every redemption payout until auctions drain its balance to exactly zero; only then does `finalizeRemoval` drop it, by swap-and-pop, which changes the on-chain order of the remaining assets. The site's creation vector must follow `assets(i)`, not the manifest.

`finalizeRemoval` is called right after the auction that drains the asset. Anything that reaches the vault in between — a transfer from anyone, or the pro-rata slice a creation pays in — is drained again at once (a remainder under $1 is filled at the start of the curve, at most 2% above reference), up to five times; after that the asset is recorded as pending in the session's plan file (`keeper/plans/qai/`) and drained again in a later session. A pending remainder stays in redemption payouts and does not change the record.

## Target weights and the vault today

"Target (book)" is the keeper's book after the reconstitution, at the plan's prices; "vault" is the vault's holdings at the same prices. "Record row" is the weight the record row of 2026-10-01 prints, at that row's prices. On that row the weight column is the rule's target weight; the book keeps a name inside the tolerance at its drifted unit count and then scales every holding by one factor, so the two columns differ. What this session trades: a name that enters or leaves the registry; a held name whose vault weight is 5 points or more away from its book target (the rulebook's reconstitution tolerance, applied here to the vault's weights); any name above the 35.00% cap. Every other name is held and not auctioned.

| Name | Target (book) | Record row | Vault | Drift | Action | Auctions aim at |
| --- | --- | --- | --- | --- | --- | --- |
| NEAR | 28.57% | 35.00% | 0.00% | -28.6 pt | trade (add) | 27.34% |
| TAO | 19.71% | 21.91% | 34.84% | +15.1 pt | trade (drift 15.1pt) | 18.86% |
| ICP | 10.33% | 11.67% | 0.00% | -10.3 pt | trade (add) | 9.89% |
| AKE | 7.79% | 4.54% | 8.65% | +0.9 pt | hold | — |
| VVV | 7.62% | 8.46% | 15.91% | +8.3 pt | trade (drift 8.3pt) | 7.29% |
| FET | 5.76% | 3.45% | 6.40% | +0.6 pt | hold | — |
| RENDER | 5.74% | 6.27% | 12.07% | +6.3 pt | trade (drift 6.3pt) | 5.49% |
| VIRTUAL | 5.62% | 3.39% | 6.24% | +0.6 pt | hold | — |
| GRASS | 5.11% | 3.09% | 5.68% | +0.6 pt | hold | — |
| UB | 3.75% | 2.23% | 4.16% | +0.4 pt | hold | — |
| GRT | 0.00% | — | 3.71% | +3.7 pt | trade (remove) | 0.00% |
| AKT | 0.00% | — | 2.33% | +2.3 pt | trade (remove) | 0.00% |

"Auctions aim at" is what this session's trades reach. Only the names marked "trade" are auctioned: together they keep the value they hold today and share it in proportion to their book targets. A held name is not sold to pay for an entering one. The book did otherwise on 2026-10-01: it set each traded name, the entering ones included, to its target and then scaled every holding by one factor. After the session the vault therefore holds 1.67 points less of the entering names than the book (NEAR 27.34% against 28.57%, ICP 9.89% against 10.33%) and 3.10 points more of the names it does not trade. The session leaves this difference between the vault and the index open; it stays until a later session trades those names. A change to the planning tool so that entering names are bought to their book weights, as the book does, is in preparation; if it is in force by the execution day, a separate anchored decision states it before the session.

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
| 1 | TAO | NEAR | 49727695923976 | 153,544 | 1800 s | drift 15.1pt → add |
| 2 | VVV | NEAR | 29501474618968 | 82,870 | 1800 s | drift 8.3pt → add |
| 3 | RENDER | NEAR | 13369986582439 | 26,339 | 1800 s | drift 6.3pt → add |
| 4 | RENDER | ICP | 18739164008200 | 36,916 | 1800 s | drift 6.3pt → add |
| 5 | GRT | ICP | 12377289558745 | 35,656 | 1800 s | drains the removal to zero |
| 6 | AKT | ICP | 3376900564245 | 22,432 | 1800 s | drains the removal to zero |

The amounts and weights here are those of the plan of 2026-10-02. On the execution day the plan is regenerated with that day's prices and balances under the same rules, and the session follows that plan; a removal's last slice sells whatever balance remains. The auctions aim at, and the executor verifies against, these weights of the traded names: TAO 18.86%, VVV 7.29%, RENDER 5.49%, NEAR 27.34%, ICP 9.89%; GRT, AKT drained to zero. The plan's own projection of the weights after these fills at its prices agrees with those targets within 0.00 pt (generator tolerance 0.5 pt).

## Pinned

| Item | Value |
| --- | --- |
| Plan file | `keeper/plans/qai/2026-10-02.json` as generated 2026-10-02T06:01:20.235Z, sha256 `a2593a8bbe539366bc1c554475101cc779bef689fcd7a84ad10abf428b2ad594`. Later stages rewrite this path (the plan stage adds the decision id, the announce stage the announce transaction), so the hash is of that earlier version, which stays in the repository history |
| Rulebook | `keeper/rulebooks/qai.json` sha256 `6cd6d623a70c9d2a2b361c7cbb1876672d484e712d09bbaa914c2b44660c4b88` |
| Book | `keeper/state-qai.json` |
| Prices | A: coingecko (fetched, cached as keeper/cache/cg-markets-top500-2026-10-02.json); B: coinpaprika (fetched, cached as keeper/cache/cp-tickers-2026-10-02.json) |
| Record row | 2026-10-01 seq 9, `f3ec61d5789a32f70e6cc29eba88ee237788b3c71c02ab70934a067369b8eb5f` |
| Plan run | basket-reconstitution 36971531606 |
| Chain read | block 37575755 (2026-10-02T06:01:11.000Z) |

