# qX20 basket — registry reconstitution of 2026-10-01

**Decided:** 2026-10-02, on the keeper's reconstitution of 2026-10-01. **Effective on chain:** announced after this document is anchored (the announcement carries its sha256); executable from announce + 7 days — `REGISTRY_DELAY` is 7 days and is not shortened. **Series:** the qX20 keeper book (`keeper/state.json`, reconstituted for 2026-10) and its NAV marks (`keeper/nav-marks.jsonl`); the first mark of 2026-10-01, which carried the reconstitution: level 1.323508, tx `0x3d70296814f0e8c5d0527015d170569b7385f203855646972811662c532397d2` on the qX20 NAV vault `0x2A165501ddA6e430fF98E82682f53CA8465Bb21f`. **Vault:** `0x39F2993f7b21B85D857C9A19de07cDcca7A0a1C9` (GIWA Sepolia, chain 91342), `assetCount` 20 at block 37575790; 23 once the change is executed, 20 once every removal is finalized.

## What enters

| Name | Mock (GIWA Sepolia) | Decimals | Book weight | First reference price on 2026-10-02 (USD × 1e18 per base unit) | Source A | Source B | Apart |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ZEC | `0x1fA38B14335e3052B5C27D59D0C4b0597483a99D` | 12 (read from the mock) | 1.20% | `1381110000` | 1381.11 | 1379.4130068681634 | 12 bp |
| XMR | `0xf150Bc6654Ec9DAFd64f44B21CF5eB74fDDd5154` | 11 (read from the mock) | 0.53% | `5476900000` | 547.69 | 547.4568478539826 | 4 bp |
| NEAR | `0xb96D35FBbC9BffCBD157A8606dc6ef43B11E4049` | 9 (read from the mock) | 0.33% | `4990000000` | 4.99 | 4.9790012413111855 | 22 bp |

The first reference price of a new asset is band-free by construction (`setRefPrice` applies the ±15% band only from the second post), so it is the one number in this change that nothing on chain bounds. Policy: it is posted only when two independent sources agree within 2.00% and the mock's `decimals()` on chain equals the value above; a wrong decimal is a 10× price and the band then needs about fifteen steps to walk it back. The price posted is taken from the two sources on the execution day, when the plan is regenerated; the prices above are those of 2026-10-02.

## What leaves

| Name | Mock | Vault balance at planning | Already in removal |
| --- | --- | --- | --- |
| GRAM | `0x293eE9abd3F625D8844b66eA82A57dcD40c6156B` | 1775334189125 | no |
| HBAR | `0x6DEeb1B63d7F4BAF8874452B80223521F6aBF895` | 280713318254 | no |
| SHIB | `0x1Bf8091DB22e3C34a9F28A53F38e3822E57195a3` | 377208489373 | no |

A leaving asset stays in every redemption payout until auctions drain its balance to exactly zero; only then does `finalizeRemoval` drop it, by swap-and-pop, which changes the on-chain order of the remaining assets. The site's creation vector must follow `assets(i)`, not the manifest.

`finalizeRemoval` is called right after the auction that drains the asset. Anything that reaches the vault in between — a transfer from anyone, or the pro-rata slice a creation pays in — is drained again at once (a remainder under $1 is filled at the start of the curve, at most 2% above reference), up to five times; after that the asset is recorded as pending in the session's plan file (`keeper/plans/qx20/`) and drained again in a later session. A pending remainder stays in redemption payouts and does not change the record.

## Membership: HBAR left while ranked inside 23

The qX20 book dropped GRAM, HBAR and SHIB on 2026-10-01 and took in ZEC, XMR and NEAR. The run did not record the ranking it used, and this repository keeps no snapshot from which it can be reproduced. On two CoinGecko snapshots taken later that day (08:36 and 12:59 UTC), with the keeper's exclusion list applied, HBAR ranked 22nd on both, GRAM 24th and 23rd, and SHIB 28th on both.

The decision anchored on 2026-09-23 (`2026-09-23-qx20-exclusion-list`) describes the rank buffer as "enter at 17 or better, leave only below 23" and says the lowest incumbents "would be pushed to 21–23 and stay unless they fall below 23". That wording leaves out one step of the keeper's membership rule (`keeper/update-nav.mjs`, `targetMembership`, in the code since the keeper was moved into this repository on 2026-08-21): the index holds 20 names, and when the incumbents ranked 23 or better and the newcomers ranked 17 or better come to more than 20, the list is cut to the 20 best ranked. On 2026-10-01 three names entered at rank 17 or better, the total came to more than 20, and HBAR was cut although it ranked inside 23 on both snapshots. GRAM may have left by the same cut or by rank; the two snapshots put it on either side of 23.

The keeper applied the rule as coded; the sentence of 2026-09-23 was incomplete. That document stays as anchored and is not edited. This vault follows the book: GRAM, HBAR and SHIB are the removals of this change.

## Target weights and the vault today

"Target (book)" is the keeper's book after the reconstitution, at the plan's prices; "vault" is the vault's holdings at the same prices. What this session trades: a name that enters or leaves the registry; a held name whose vault weight is 5 points or more away from its book target (the width of the qX20 drift band, used here as this session's threshold; the qX20 book itself re-weighted every name to its target on 2026-10-01, because its membership changed); any name above the 60.00% cap. Every other name is held and not auctioned.

| Name | Target (book) | Vault | Drift | Action | Auctions aim at |
| --- | --- | --- | --- | --- | --- |
| BTC | 60.46% | 59.50% | -1.0 pt | hold | — |
| ETH | 16.98% | 17.95% | +1.0 pt | hold | — |
| BNB | 5.29% | 5.66% | +0.4 pt | hold | — |
| XRP | 4.90% | 5.23% | +0.3 pt | hold | — |
| SOL | 3.67% | 3.90% | +0.2 pt | hold | — |
| TRX | 1.62% | 1.74% | +0.1 pt | hold | — |
| ZEC | 1.20% | 0.00% | -1.2 pt | trade (add) | 0.39% |
| HYPE | 1.03% | 1.10% | +0.1 pt | hold | — |
| DOGE | 0.77% | 0.82% | +0.1 pt | hold | — |
| LINK | 0.55% | 0.59% | +0.0 pt | hold | — |
| XMR | 0.53% | 0.00% | -0.5 pt | trade (add) | 0.17% |
| ADA | 0.49% | 0.52% | +0.0 pt | hold | — |
| RAIN | 0.44% | 0.47% | +0.0 pt | hold | — |
| XLM | 0.40% | 0.42% | +0.0 pt | hold | — |
| NEAR | 0.33% | 0.00% | -0.3 pt | trade (add) | 0.11% |
| BCH | 0.32% | 0.34% | +0.0 pt | hold | — |
| UNI | 0.29% | 0.31% | +0.0 pt | hold | — |
| AVAX | 0.25% | 0.26% | +0.0 pt | hold | — |
| SUI | 0.25% | 0.26% | +0.0 pt | hold | — |
| CC | 0.24% | 0.26% | +0.0 pt | hold | — |
| GRAM | 0.00% | 0.24% | +0.2 pt | trade (remove) | 0.00% |
| HBAR | 0.00% | 0.25% | +0.2 pt | trade (remove) | 0.00% |
| SHIB | 0.00% | 0.19% | +0.2 pt | trade (remove) | 0.00% |

"Auctions aim at" is what this session's trades reach. Only the names marked "trade" are auctioned: together they keep the value they hold today and share it in proportion to their book targets. A held name is not sold to pay for an entering one. The book did otherwise on 2026-10-01: it re-weighted every name to its target. After the session the vault therefore holds 1.38 points less of the entering names than the book (ZEC 0.39% against 1.20%, XMR 0.17% against 0.53%, NEAR 0.11% against 0.33%) and 1.38 points more of the names it does not trade. The session leaves this difference between the vault and the index open; it stays until a later session trades those names. A change to the planning tool so that entering names are bought to their book weights, as the book does, is in preparation; if it is in force by the execution day, a separate anchored decision states it before the session.

## The seven-day lag

The qX20 book reconstituted on 2026-10-01; the keeper book carries the new membership and weights from that day. The vault cannot: `announceRegistryChange` fixes the tuple (adds, removes, this document's sha256) and `executeRegistryChange` accepts exactly that tuple only after 7 days — from announce + 7 days. Between the two the vault holds the old shape, `navPerShare` keeps tracking the index, and redemptions pay the old shape. Only one change can be pending per vault and announcing again restarts the clock, so the tuple above is not to be amended by a second announcement. Over the lag the vault's holdings are on chain and the index is in the keeper book, so the difference between the two can be computed by anyone.

## Auction policy in force

- Every weight change goes through the vault's bounded dutch auctions (keeper opens `openAuction(sell, buy, amount, 1800 s)`; the curve runs from +2% to −1% of the reference over the duration; per-fill floor 100 bp and daily budget 300 bp are the contract's and are not changed).
- Fills by our own bidder are taken at the curve's fair point (`fill` policy `fair`: factor 10,000 to 10,010 bp, `lossAtRef` 0), so share value at reference prices is unchanged by the session and the record shows no gift either way. The one exception is a remainder under $1 of a leaving asset, filled at the start of the curve (at most 2% above reference) so that the removal can be finalized at once.
- During a session a reference price is re-posted only at the value already on chain (to refresh the v3.1 staleness clock, `maxRefAge` 3600 s); a session never moves a reference, and it refuses to start while any reference is more than 5.00% away from the day's mark.
- Roles as deployed: owner `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`, keeper `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` — the same key, which is also whitelisted to create and to bid. This is the testnet shape and not the mainnet one; the contract cannot bound a keeper that both marks and fills, so every safety of this reconstitution rests on the script guards stated here. Fills are signed by that same key (`isBidder` is true for it on this vault); no separate bidder key is used in this session.

## Planned auctions

| # | Sell | Buy | Sell amount (base units) | ≈ USD at plan prices (testnet mocks, no market value) | Duration | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | HBAR | ZEC | 280713318254 | 2,925 | 1800 s | drains the removal to zero |
| 2 | GRAM | ZEC | 1075227701575 | 1,667 | 1800 s | remove → add |
| 3 | GRAM | XMR | 700106487550 | 1,085 | 1800 s | drains the removal to zero |
| 4 | SHIB | XMR | 159105671078 | 932 | 1800 s | remove → add |
| 5 | SHIB | NEAR | 218102818295 | 1,278 | 1800 s | drains the removal to zero |

The amounts and weights here are those of the plan of 2026-10-02. On the execution day the plan is regenerated with that day's prices and balances under the same rules, and the session follows that plan; a removal's last slice sells whatever balance remains. The auctions aim at, and the executor verifies against, these weights of the traded names: ZEC 0.39%, XMR 0.17%, NEAR 0.11%; GRAM, HBAR, SHIB drained to zero. The plan's own projection of the weights after these fills at its prices agrees with those targets within 0.00 pt (generator tolerance 0.5 pt).

## Pinned

| Item | Value |
| --- | --- |
| Plan file | `keeper/plans/qx20/2026-10-02.json` as generated 2026-10-02T06:01:57.394Z, sha256 `259ec9ae7a8a2fd048a0cac5c396315142c467f4db2f46ffa02aa26ae38baa4b`. Later stages rewrite this path (the plan stage adds the decision id, the announce stage the announce transaction), so the hash is of that earlier version, which stays in the repository history |
| Rulebook | `keeper/rulebooks/qx20.json` sha256 `eb053007f770ded9583c2a673359e0ad69c29c41a22747ab879b036b580ba7a6` |
| Book | `keeper/state.json` |
| Prices | A: coingecko (fetched, cached as keeper/cache/cg-markets-top500-2026-10-02.json); B: coinpaprika (fetched, cached as keeper/cache/cp-tickers-2026-10-02.json) |
| Plan run | basket-reconstitution 36971581217 |
| Chain read | block 37575790 (2026-10-02T06:01:46.000Z) |

