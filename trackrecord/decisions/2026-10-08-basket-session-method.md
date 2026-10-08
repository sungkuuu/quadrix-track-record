# Basket vaults — reconstitution sessions buy the entering names to the book's weights

**Decided:** 2026-10-08 (UTC), before any session that executes the registry changes announced on 2026-10-02. **Effective:** from the first of those sessions (qX20, qREV, qDEFI, qAI and Triens baskets on GIWA Sepolia, executable seven days after each announcement), and for every reconstitution session after it. **Changes:** how a session chooses, sizes and checks its auctions, and the form of the sessions that execute the changes announced on 2026-10-02. **Does not change:** any index rule or parameter, any book, any record line, or any announced registry change. **Series:** none is changed. The sessions follow the books (`keeper/state.json` for qX20, `keeper/state-<index>.json` for the others); no record line is rewritten.

## Supersedes

The five reconstitution documents of 2026-10-02 stay as anchored and are not edited. The passages listed here describe the session as the planning tool of that day would have run it; from this document on, the session runs as described below instead.

| Document | sha256 | Anchor transaction |
| --- | --- | --- |
| `2026-10-02-qx20-basket-reconstitution` | `4e485c18d1f316639f087bfcd9da254221d6636ebd5819b6e3f59fe68dd5f424` | `0xa72198c76c160a8c98aa47e1feee8caf3f17d0e6bb703c119a0b5b06165329ac` |
| `2026-10-02-qrev-basket-reconstitution` | `28479f245a33bdb4b5248c6e0d4e2e452fa37082406991f04d320c08c80bedad` | `0x91649bff98b4d0417a9861aff57821e5571df52bc052923aff4e8e9ccd7b0626` |
| `2026-10-02-qdefi-basket-reconstitution` | `c460b0d8442320dd68064896973576ffd1e076a7e38f6a4085c502edfe4cfdf8` | `0x71e40491de6fbba6bf5c6f2a9924186debb2c0a01698879bfe547cc2784e6ec6` |
| `2026-10-02-qai-basket-reconstitution` | `3b64c22574c29985fdb94d59013322ec6d5a7e4c29bf5a47265f939770c8fc41` | `0xe6a0378a9d23d34ca97523ce9dafdabe40443e09b45002bcc417ca8af44f5003` |
| `2026-10-02-triens-basket-reconstitution` | `ca01c383847e52e7cedb4325da8216f5827a58d79eb165e5d6598545617e86d0` | `0x958bc64d8357eb97c6bf3ed0501c558a2a5d6a0c9af92b9f8555734aa032bde1` |

Superseded, in each of them unless one is named:

1. Under "Target weights and the vault today", the sentence that begins "What this session trades:" and ends "Every other name is held and not auctioned."
2. In the table under the same heading, the columns "Action" and "Auctions aim at".
3. The paragraph that begins "\"Auctions aim at\" is what this session's trades reach." — including "A held name is not sold to pay for an entering one" and the statement that the vault holds fewer points of the entering names than the book after the session. That paragraph also says that a change to the planning tool was in preparation and that a separate anchored decision would state it before the session; this is that decision.
4. Under "Planned auctions", the table, and the paragraph that begins "The amounts and weights here are those of the plan of 2026-10-02"; in the Triens document, the paragraph that begins "None. No held name is marked for trading".
5. In the paragraph of item 4 (not in the Triens document), "On the execution day the plan is regenerated with that day's prices and balances under the same rules, and the session follows that plan": the sessions that execute those changes run over more than one day, and each day's part follows the plan made that day after the daily mark (see "Session form").
6. In the qX20 document, "any name above the 60.00% cap" among the names a session trades: from this document on, a session does not sell a name down to the cap when the book itself holds it above the cap (see "What changes").
7. Under "Auction policy in force", the end of the third item ("it refuses to start while any reference is more than 5.00% away from the day's mark") is kept, and read and extended as follows. "The day's mark" there is the price of each name in the plan made that day (source A); the session tool compares every reference on chain with it. The comparison is made before the registry change is executed, and again when the auctions start. A session also refuses when any reference is no longer the one the plan sized its amounts at (see "What changes").

Read with this document, in each of them:

- Under "Pinned", the plan file each 2026-10-02 document pins is the first committed version of its path (qREV `fa12044`, qDEFI `aaf3630`, qAI `78f0362`, qX20 `b2af17c`, Triens `71c6ac8`). The later plan stage read the chain and both price sources again, so the file now at that path shows other prices and amounts than the document's tables.
- Under "Pinned", the rulebook files those documents pin are the versions at the commits of their plans; `basket.assets` in each is updated on the day its registry change is executed, which changes the file's sha256 and no rule.
- The operating values those documents state — the 2.00% agreement of the two first-price sources, the 5.00% reference guard, the 1,800 s auction, the fair point of 10,000 to 10,010 bp and, in the qX20, qDEFI and qAI documents, the $1 under which a leaving remainder is filled at the start of the curve and up to five re-drains of a removal — carry no mark there; none of them has been tested (see "Tested, and not tested").

Everything else in those documents stands: what enters and what leaves (mock addresses, decimals), the first reference policy, the finalizing of a removal, the seven-day lag, the auction policy figures and the fills at the fair point, the roles and the absence of a separate bidder key, the pinned files, and the qX20 membership section.

## What changes

| | Until this document (the tool the 2026-10-02 documents describe) | From this document |
| --- | --- | --- |
| Names a session trades | the names marked: an entering name, a leaving name, a held name 5 points or more off its book weight, a name above the cap; every other name is held | a marked name trades its whole block to the book's weights. The block is the whole basket for qX20, qREV, qDEFI and qAI; for Triens it is the Quality sleeve, or every name when the sleeves reset. Barbell has no Quality sleeve: its two names trade only when the sleeves reset. A name is marked by entering, by leaving (unless it is already in removal on chain: that remnant is drained as before and opens nothing), by the 5-point tolerance, by the cap where the book itself is under the cap, or by a sleeve reset |
| What pays for an entering name | only the value the marked names hold; a held name is not sold | the block's own value: names the vault holds above their book weight are sold down to it |
| What the auctions aim at | the marked names' book weights, rescaled to the value those names hold | the book's weights (Triens without a sleeve reset: the book's weights inside the Quality sleeve, at the sleeve's present share of the vault) |
| Price the amounts are sized at | the day's market price (source A) | each held name's reference on chain when the plan is made — the price the vault fills at; an entering name's first reference. The book is valued at the same prices, so the balances after a fair session are proportional to the book's units whatever the price level. The day's market price is kept for the 5% guard |
| When a session refuses to trade | a reference more than 5% from the plan's market price, checked when the auctions start, after the registry change is executed | the same, and also when any reference is no longer the one the plan sized its amounts at (the plan is made again after the day's mark); both are checked before the registry change is executed, and again when the auctions start |
| The check after the session | within 5 points of the aim (the rulebook tolerance, used by the tool as its check) | within what the fills can leave: for each traded name, the fair window (10 bp) × (value bought into it + its aim × all value bought) ÷ vault value, plus (traded names × $1 + fills × the value of one base unit of the name whose base unit is worth most) ÷ vault value; a fill outside the window counts at its own distance from fair. The vault is weighed at the references the plan sized at |

The last slice of a removal still sells whatever balance remains.

A block trades to the book's weights as they stand on the day. Where the book holds a name above the cap between its rebalances, the vault is brought to that weight, not to the cap; the cap is applied by the book when it next rebalances, not by the session. A name above the cap opens its block only where the book itself is under the cap, and a session does not sell a name down to the cap when the book holds it above the cap. In qX20, on the plan of 2026-10-02 the book held BTC at 60.46% against the 60.00% cap and the vault at 59.50%; this method buys BTC to 60.46%. On 2026-10-05 the book held BTC at 60.45% (`keeper/state.json` at `178ad07` valued at the references on chain at block 37848854, and ZEC, XMR and NEAR at that day's source-A prices, 1319.16, 548.13 and 5.02 USD); the weight on 2026-10-09 may differ.

Before it sends the registry change's execute, the session tool makes the checks that would otherwise stop a session's first stages after the change: every reference within 5% of the plan's market price (`f75c87e`) and equal to the one the plan sized at; for each entering name, its two first-price sources within 2.00%, the decimals read from its mock equal to the plan's, and the name in the announced change; the signer is the keeper and a whitelisted bidder; no name in the registry is without a reference (`33c6abe`). A refusal there sends nothing and leaves the change pending. The planning tool prints the 5% and first-price conditions as notes. When the auctions stage runs again after an earlier run, it records that run's fills and cancels the auction it left open before its 5% check can refuse (`62d7e88`).

## Why

The vault follows the book. On 2026-10-01 the keeper's books did not trade one name at a time: each set the names its rule trades to their targets and then scaled every holding of the block by one factor (`keeper/paper-index.mjs`: `applyToleranceAndTrade`, then `renormaliseBook`; the Triens Quality sleeve by its own factor). The qX20 book re-weighted every name to its target, because its membership changed at a reconstitution (`keeper/update-nav.mjs`, the rebalance on a membership change). The planning tool of 2026-10-02 bought an entering name only with the value of the names it had marked, so the vault would have ended with less of every entering name than the book, and in Triens with none of AERO.

This is a correction of the planning tool to what the books do. No index rule, threshold, cap, weight or member changes, and the announced changes are executed exactly as announced.

## The difference this removes

From the plans of 2026-10-02 — the five plan files the 2026-10-02 documents pin, at their first committed versions (see "Pinned") — at those plans' prices, run through the planning tool as it was when they were made (`keeper/basket-plan.mjs` at the plan commits, last changed in `077912f`) and as it is at `dabb511`. The figures of the 2026-10-02 method are those the 2026-10-02 documents print. "Short of the book" is the book weight of the entering names minus what the vault would hold after a fair session.

| Basket | Entering names (vault after the 2026-10-02 method / book) | Short of the book: 2026-10-02 method → this method | Names traded | Auctions on the plan of 2026-10-02 | Value auctioned, share of the vault |
| --- | --- | --- | --- | --- | --- |
| qX20 | ZEC 0.39% / 1.20%, XMR 0.17% / 0.53%, NEAR 0.11% / 0.33% | 1.38 pt → 0.00 pt | 6 → 23 of 23 | 5 → 22 | 0.67% → 3.02% |
| qREV | SYRUP 1.93% / 2.18%, TRX 20.77% / 23.48%, LINK 1.89% / 2.13%, NEAR 1.71% / 1.93%, BNB 1.90% / 2.15% | 3.67 pt → 0.00 pt | 8 → 15 of 15 | 7 → 14 | 28.20% → 31.87% |
| qDEFI | ASTER 1.21% / 3.64% | 2.43 pt → 0.00 pt | 2 → 16 of 16 | 1 → 15 | 1.21% → 3.64% |
| qAI | NEAR 27.34% / 28.57%, ICP 9.89% / 10.33% | 1.67 pt → 0.00 pt | 7 → 12 of 12 | 6 → 11 | 37.23% → 38.91% |
| Triens | AERO 0.00% / 0.66% | 0.66 pt → 0.00 pt | 1 → 9 of 11 | 0 → 8 | 0.00% → 0.66% |

In qX20 the names already held also move to the book (the largest: ETH −0.97 pt, BTC +0.96 pt), because the book re-weighted every name. In Triens, BTC and working capital are not traded: the sleeves are within the 5-point tolerance, the book moves no value between sleeves, and neither does the vault. What remains there is the difference between the vault's and the book's sleeve shares (on the plan of 2026-10-02: working capital −0.025 pt, BTC −0.016 pt, the Quality names +0.041 pt together).

The amounts and auction counts on an execution day come from that day's plan, made after the day's mark from that day's references and balances; they can differ from these.

## Session form

The sessions that execute the changes announced on 2026-10-02 run with this method, one auction at a time, over more than one day: from 2026-10-09 to 2026-10-11, starting on 2026-10-09 right after that day's daily mark. Each day, right after the daily mark, the baskets not yet done are planned from that day's references and balances, and each session follows the plan made that day. The baskets run on a day are those whose sessions can finish within that UTC day; the others are planned again after the next day's mark. A registry change is executed at the start of its basket's session, once its seven days have passed (`pendingRegistryEta` on chain: 2026-10-09 06:55:08 UTC for qREV to 07:03:16 UTC for Triens); until then that vault holds its old registry. No record line is rewritten: the records are written each day as on any other day, and a session changes the vault, not the records.

Computed from the vault's curve and the tool, not measured on the public chain: an auction of 1,800 s is filled at its fair point about 1,166 s after it opens, and with the four transactions of an auction (open, two same-value reference posts, fill) one auction takes about 1,196 s on the public chain. One at a time, the plans of 2026-10-02 under this method need about 7.3 hours for qX20, 5.0 for qDEFI, 4.7 for qREV, 3.7 for qAI and 2.7 for Triens, 23.3 hours in all; the execute, the first references and the finalizing of removals are not included. A GitHub job stops at 6 hours.

A job that stops before the last auction, at the 6-hour limit or otherwise, is dispatched again with the same plan before any new plan is made. On the same UTC day, with the references as planned, the session records from the chain every fill and finalized removal of the stopped job, cancels the auction it left open, and trades only what is left. On a later UTC day, or once a reference has moved, the session tool refuses the old plan; the stopped job's fills and finalized removals are first recorded into that plan (on a later day by a verification run), and a new plan made after the day's mark, with every block re-opened, continues the session. Nothing is sold twice.

## What remains after a session

- The seven-day lag between the book and the vault, as stated in the 2026-10-02 documents, and, for a basket whose session starts after 2026-10-09, the days until it starts.
- In Triens, the difference between sleeve shares described above.
- What fills inside the fair window can leave: a fill there pays the vault up to 10 bp more than fair, which is what the check after the session allows for. On the plans of 2026-10-02, with one fill per planned auction at the fair point, that bound is at most 0.041 pt (qAI NEAR), 0.032 pt (qREV TRX), 0.005 pt (qDEFI ASTER), 0.005 pt (qX20 BTC) and 0.002 pt (Triens AERO).
- A creation or a redemption during a session leaves the planned amounts off by its share of the vault; the session then trades again from the balances on chain, at most three rounds.

## Tested, and not tested

Values this document introduces or changes: none. The block, the price the amounts are sized at, the check after the session and the checks before execute follow from what the books do and from settings already in force; no index rule value, threshold or weight is added or changed, so no parameter citation table changes. Judgments: none.

Checklist items (`checklists/`): R49 (basket reconstitution rehearsed on a local chain) was run, and the two independent reviews and the rehearsal that D16 asks of a decision document and D17 of a chain operation (formerly R52) were made for the tool change: the rehearsal record names both reviews and the rehearsals run for them, listed below. D14 (the execution interval the session assumes, against the measured one) was not — see "Not tested".

Tested (every commit named is on main at `dabb511`):

- Unit tests of the planning tool and the check (`keeper/test/plan-trades.test.mjs`, 29 tests): the Triens case of an entering name with no other mark, an entering and a leaving name, a leaving name split over two auctions, mixed signs (qX20), a sleeve with and without reset, a basket already at the book, a remnant already in removal, a block reopened by hand, a name above the cap where the book holds it above the cap too (its block stays closed, no auction), the vault above the cap where the book is not (the block opens), the Quality sleeve cap, rounding with 0 and 18 decimals, a session already done (nothing planned again), the five plans of 2026-10-01, sizing at chain references 1.2% to 4.6% off the market price, and the check against fills at and outside the fair window and after a later mark.
- Unit tests of the checks before execute (`keeper/test/recon-readback.test.mjs`, 32 tests): `day7` refuses before it sends the registry change's execute when a reference is more than 5% from the plan's market price, when a reference moved since the plan, and on each check of the first stages (the signer and bidder roles, a registry name without a reference, an entering name outside the announced change, each entering name's first-price gate); in each case nothing is sent and the change stays pending, and a good plan runs with the same calls as the stages run one by one. All keeper tests pass at `dabb511`: 116 of 116 in `keeper/test/`, 10 of 10 in `keeper/`.
- Rehearsals on a local copy of GIWA Sepolia with the 2026-10-01 work orders, books and prices, real tools, the keeper key filling its own auctions (`docs/rehearsal-2026-10-01-planner-block-rule.md`): all five baskets, qREV, qDEFI, qX20 and Triens at commit `6361162` and qAI at `68f75d9` (228 checks passed, none failed); qX20 again at `fa469f7`, with every reference 250 bp off the market price and a 1% creation during the session (55 passed, none failed); qAI at `2ef88d7`, with references 250 bp off the market price, a job stopped after a drain's fill, a job stopped with an auction open, a job stopped and then the mark moving a reference, a verification run recording a stopped job's fills, and a check run after a later mark (75 passed, none failed); Triens at `cf99e26`, with references 250 bp off the market price, a job stopped with an auction open, a job stopped and then the mark moving a reference, and a verification run recording a stopped job's fills (54 passed, none failed; Triens has no removal). In each stopped case the session was dispatched again from the plan file as committed before it: the fills of the stopped run were recorded from the chain, the auction it left open was cancelled, and no planned auction was sold twice. When the mark had moved a reference in between, the session was planned again with every block re-opened and finished; planned without re-opening the block, it would have traded nothing and left the entering names short.

Not tested:

- An auction on the public chain. None of the five vaults has run one (`auctionCount` 0 on 2026-10-06, blocks 37913102 to 37913115); whether the two same-value reference posts and the fill are mined inside the fair window there (1,140 to 1,205 s after an 1,800 s auction opens) is not measured. The rehearsals jump the clock to the fair point.
- A GitHub job actually stopped at its 6-hour limit; the rehearsals stop the tool instead. GitHub cancels a run waiting in the same concurrency group when another run is queued behind it (its documented default); during a long session the daily record and index runs wait in that group.
- No rehearsal recorded in this repository ran at `dabb511`; the checks before execute and the re-run order of the auctions stage, added after the rehearsals (`f75c87e`, `33c6abe`, `62d7e88`), are covered by the unit tests above.
- Not tested, in force before this document and unchanged by it: the $1 trade minimum and the 10 bp fair window (the check after the session is computed from these two), the 5% reference guard, the 2% agreement of the two first-price sources, the 1,800 s auction, up to five re-drains of a removal, and three residual rounds. They have not been tested.

## Pinned

| Item | Value |
| --- | --- |
| Tool commit | `dabb511` (`dabb5116de8fe250d23a72d0ca0b0dd44d277ffd`), the head of the branch that carries the change, which main of this repository was moved to on 2026-10-06. The branch is already on main, so no later merge commit is pinned |
| Planning tool | `keeper/basket-plan.mjs` at `dabb511` (`computeTrades`, `planRows`, `referenceGuardNote`, `firstPriceGateNote`) |
| Session tool | `keeper/basket-recon.mjs` at `dabb511` (`requireSizingBeforeExecute`, `requireStagesWouldStart`, `requireRefsNearMarket`, `requireRefsAsPlanned`, `residualBound`, `runDay7`) |
| Checks before execute | commits `f75c87e` (the 5% reference guard before execute; the plan prints it) and `33c6abe` (the other checks the first stages would refuse at the start); `62d7e88` (the auctions stage records an earlier run before its 5% check refuses) |
| Unit tests | `keeper/test/plan-trades.test.mjs`, `keeper/test/recon-readback.test.mjs` at `dabb511` |
| Rehearsal record | `docs/rehearsal-2026-10-01-planner-block-rule.md` sha256 `3c0131fe9e16d49cf52f373e01e855eb3e74bb68e3c67ae65fb9b379ff3a413b`, as committed with this document (the version at `dabb511` differs only in one section heading) |
| Plans of 2026-10-02 (the figures above) | `keeper/plans/<basket>/2026-10-02.json`, first committed versions: qREV `fa12044` sha256 `a5c8133b5ade990ff49226d09f5d88ec3fa58ea0282df0ff9fc2218057c2319d`; qDEFI `aaf3630` sha256 `e70b97eaf9deea65867a877b52d3bb4f20c4cd191ccdf4da692d8d1a80eb5234`; qAI `78f0362` sha256 `a2593a8bbe539366bc1c554475101cc779bef689fcd7a84ad10abf428b2ad594`; qX20 `b2af17c` sha256 `259ec9ae7a8a2fd048a0cac5c396315142c467f4db2f46ffa02aa26ae38baa4b`; Triens `71c6ac8` sha256 `926750419759bc53c4cafc4ebf3233970f4394e000ba67d953aaa0c254f8cfdc` — the hashes the 2026-10-02 documents pin |
| Rulebooks | `keeper/rulebooks/qrev.json` sha256 `3a1fed4b3bddd84ab250a3b6b953579a15f8008e9e865cc5d459e78ea7e927d8`; `qdefi.json` `bac255203a00ceb7e0935ffd0c14c2c5d731afd58270db71d801b64e433deadd`; `qai.json` `6cd6d623a70c9d2a2b361c7cbb1876672d484e712d09bbaa914c2b44660c4b88`; `qx20.json` `eb053007f770ded9583c2a673359e0ad69c29c41a22747ab879b036b580ba7a6`; `triens.json` `94fd4573466f5f44909d1d6b16ade497e52972024ee6dd4cb4bb268c8af2f6bc` — as pinned by the 2026-10-02 documents and unchanged at `dabb511` |
| Unit-test rows | `keeper/test/fixtures/plan-trades-2026-10-01.json` (five plans made on 2026-10-01, not committed as plan files) |
