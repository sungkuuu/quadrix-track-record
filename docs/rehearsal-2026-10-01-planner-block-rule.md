# Rehearsal — the block rule of the planner (2026-10-01 work orders)

Local anvil forks of GIWA Sepolia, one basket at a time, `keeper/rehearse-day7.mjs --keeper-bids`
(the keeper key fills its own auctions, as on the chain while no `BIDDER_PK` is set). Nothing was
sent to the public chain; no key was read (the harness blanks `KEEPER_PK` and `BIDDER_PK`).

- Code: commit `6361162` (block rule, chain-reference sizing, the executor's reference checks and
  fill bound, this harness). qAI was run again on `68f75d9` (each fill bounded by its own factor):
  39 PASS / 0 FAIL, fork block 37524916.
- Inputs: the work orders `keeper/pending-registry-*.json` of 2026-10-01, the books, the record rows,
  and the day's cached prices (CoinGecko top 500 as source A, CoinPaprika as B) from the plan stage
  of 2026-10-01; each basket forked at the block in the table.
- Flow per basket: set-bidder → deploy-mocks → plan → decision draft → plan with the decision →
  announce guards → announce → 7 days → re-plan (the day's prices) → the daily mark, emulated → the
  day-7 plan (sized at the marked references) → day7 (execute → first prices → auctions → finalize →
  verify); then, from a snapshot before day 7: a reference moved by 0.1% after the plan (day7 must
  refuse before execute) and the option-K cases of the harness (qREV and qX20: a third party executes
  first; qDEFI: donation, creation and redemption in window 1, PENDING then a later plan; qAI:
  donations between the drain and the finalize; qX20: a donation between the drain and the finalize,
  a creation in window 1).
- "Public chain, one at a time" is fills × 1,196 s (the executor's aim point of an 1,800 s auction,
  1,166 s, plus four transactions), the planner spec's figure; execute, first prices and finalize are
  not included. The GitHub job limit is 6 hours.
- The fill bound is the planner spec's §4: 0.1% × (value bought into the name + its weight × all
  bought) / vault value + traded names × $1 / vault value, re-derived in the harness.

| Basket | Fork block | Planned auctions | Fills (baseline) | Public chain, one at a time | Traded name closest to its fill bound: gap to its trade target, pt (bound) | Largest gap to the book, pt | Checks pass / fail | Local wall time |
|---|---|---|---|---|---|---|---|---|
| qREV | 37523372 | 14 | 14 | 4.65 h | HYPE -0.0044 (bound 0.0104) | TRX 0.0074 | 43 / 0 | 7 min |
| qDEFI | 37524139 | 15 | 15 | 4.98 h | ASTER 0.0017 (bound 0.0051) | ASTER 0.0017 | 59 / 0 | 13 min |
| qAI | 37523765 | 11 | 11 | 3.65 h | TAO -0.0038 (bound 0.0090) | NEAR 0.0085 | 39 / 0 | 6 min |
| qX20 | 37521818 | 22 | 22 | 7.31 h | ZEC 0.0006 (bound 0.0033) | ZEC 0.0006 | 55 / 0 | 18 min |
| qTRI | 37523222 | 8 | 8 | 2.66 h | AERO 0.0003 (bound 0.0016) | WC -0.0154 | 32 / 0 | 2 min |

Total: 70 auctions, 23.3 hours one at a time. qX20 alone is 7.3 hours.

Not rehearsed: anvil running in real time (the harness jumps the clock with `--warp`), so a fair
window on the public chain and the spacing of transactions there are not measured; `--main-recon`
(⑦) was not run; the older harness `keeper/rehearse.mjs` was not run (its qDUO scenario plans at
market prices before the mark and does not fit the chain-reference sizing).

## Per basket (baseline session)

### qREV

Fork block 37523372 (2026-10-01T15:28:08.000Z), anvil/v1.8.3. largest gap to the book TRX 0.0074 pt.

| Name | vault after % | book % | auctions aimed at % |
|---|---|---|---|
| HYPE | 28.4284 | 28.4328 | 28.4328 |
| TRX | 24.1451 | 24.1378 | 24.1378 |
| SKY | 5.7320 | 5.7329 | 5.7329 |
| CAKE | 5.3784 | 5.3792 | 5.3792 |
| ZRO | 5.1307 | 5.1315 | 5.1315 |
| RAY | 4.5877 | 4.5884 | 4.5884 |
| AERO | 4.5686 | 4.5693 | 4.5693 |
| JUP | 4.5197 | 4.5204 | 4.5204 |
| CRV | 3.6692 | 3.6698 | 3.6698 |
| PENDLE | 3.2193 | 3.2198 | 3.2198 |
| UNI | 2.1600 | 2.1604 | 2.1604 |
| BNB | 2.1553 | 2.1545 | 2.1545 |
| LINK | 2.1308 | 2.1299 | 2.1299 |
| SYRUP | 2.1136 | 2.1129 | 2.1129 |
| NEAR | 2.0612 | 2.0604 | 2.0604 |

Checks:

- PASS [setup] set-bidder: the keeper is whitelisted already, nothing sent, nothing logged — 0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902 isBidder true
- PASS [setup] set-bidder again: nothing sent
- PASS deploy-mocks exits 0
- PASS [setup] deploy-mocks: one m{SYMBOL} mock per add, decimals as recorded, inventory with the bidder — SYRUP mSYRUP 8dec bidder 26998490816834; TRX mTRX 8dec bidder 203992337687659; LINK mLINK 10dec bidder 42787856657478; NEAR mNEAR 9dec bidder 11252196787058; BNB mBNB 11dec bidder 8037075042997
- PASS [setup] deploy-mocks again: every add skipped
- PASS plan exits 0
- PASS [setup] plan: adds carry the deployed mock addresses; tuple waits for the decision — SYRUP 0xEB745D, TRX 0xA636dE, LINK 0x9e9970, NEAR 0x97F145, BNB 0xdbC07b
- PASS decision draft written
- PASS [setup] draft: no "to be deployed" address left; the TO FILL comment no longer asks for mocks
- PASS plan with decision exits 0
- PASS plan: announce tuple complete
- PASS [announce] announce refuses a duplicate address in the tuple; nothing pending — REFUSED: duplicate address in adds: 0xeb745ddd04caa0717c31dce7f32f3edaad4bf0c7 — the contract would accept this announcement and refuse it at execute forever
- PASS [announce] announce refuses an add whose chain symbol is not mSYRUP; nothing pending — REFUSED: SYRUP: 0x9bAaB117304f7D6517048e371025dB8f89a8DbE5 is mDECOY on chain, not mSYRUP — wrong mock address in the plan
- PASS [announce] announce dry run: simulated, the checks line printed, nothing sent
- PASS announce live exits 0
- PASS a change is pending
- PASS re-plan while pending exits 0 and carries the tuple
- PASS day-7 plan after the mark exits 0 and carries the tuple
- PASS [plan] day-7 plan: every held name sized at the reference now on chain (chainRefAtPlan) — 10/10 names
- PASS [plan] day-7 plan: every entering name is bought by a planned auction — 14 auction(s); traded 15/15 names
- PASS baseline: day7 exits 0, verify passed — verify: all checks passed
- PASS baseline: every fill by the keeper key (no separate bidder), lossAtRef 0 — 14 fill(s)
- PASS baseline: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10004,10005,10005,10005,10006,10005,10005,10005,10005,10006,10004,10005,10005; remnants —
- PASS baseline: removals finalized — finalized [—], still in registry [—]; plan.finalize —; finalizePending —
- PASS baseline: every add in the registry with a reference — assetCount 15
- PASS [spec §4] baseline: every planned auction filled once, for the amount the plan sized (14) — 14 fill(s)
- PASS [spec §4] baseline: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] baseline: every traded name within the fill bound of its trade target — 15 traded; closest to its bound HYPE -0.00442 pt (bound 0.01044 pt)
- PASS [spec §4] baseline: every name at its book weight within the fill bound — largest gap to the book TRX 0.0074 pt
- PASS [spec §4] baseline: every entering name bought (balance > 0) to its book weight — SYRUP 2.114% vs book 2.113%, TRX 24.145% vs book 24.138%, LINK 2.131% vs book 2.130%, NEAR 2.061% vs book 2.060%, BNB 2.155% vs book 2.155%
- PASS baseline: a holder redeems after the session — assetCount 15, gas 616615
- PASS [spec §1.3] day7 refuses before execute when a reference moved after the plan (HYPE +0.1%); the change stays pending, nothing filled — REFUSED: reference(s) moved since the plan sized its auctions (HYPE 8890000000→8898890000) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage
- PASS ⑥ third party executed: day7 exits 0, verify passed — verify: all checks passed
- PASS ⑥ third party executed: every fill by the keeper key (no separate bidder), lossAtRef 0 — 14 fill(s)
- PASS ⑥ third party executed: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10005,10005,10004,10005,10005,10005,10004,10004,10005,10005,10004,10005; remnants —
- PASS ⑥ third party executed: removals finalized — finalized [—], still in registry [—]; plan.finalize —; finalizePending —
- PASS ⑥ third party executed: every add in the registry with a reference — assetCount 15
- PASS [spec §4] ⑥ third party executed: every planned auction filled once, for the amount the plan sized (14) — 14 fill(s)
- PASS [spec §4] ⑥ third party executed: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] ⑥ third party executed: every traded name within the fill bound of its trade target — 15 traded; closest to its bound HYPE -0.00460 pt (bound 0.01044 pt)
- PASS [spec §4] ⑥ third party executed: every name at its book weight within the fill bound — largest gap to the book TRX 0.0082 pt
- PASS [spec §4] ⑥ third party executed: every entering name bought (balance > 0) to its book weight — SYRUP 2.114% vs book 2.113%, TRX 24.146% vs book 24.138%, LINK 2.131% vs book 2.130%, NEAR 2.061% vs book 2.060%, BNB 2.155% vs book 2.155%
- PASS [⑥] day7 names the third party and continues (plan.execute.byThirdParty) — execute tx 0x81ec61b840c1044719fbd3c83a6b047d15356f3f1e26a371e67c013e074a151b by 0x90F79bf6EB2c4f870365E785982E1f101E93b906

### qDEFI

Fork block 37524139 (2026-10-01T15:40:55.000Z), anvil/v1.8.3. largest gap to the book ASTER 0.0017 pt.

| Name | vault after % | book % | auctions aimed at % |
|---|---|---|---|
| HYPE | 30.3494 | 30.3499 | 30.3499 |
| LINK | 21.5810 | 21.5814 | 21.5814 |
| UNI | 11.2918 | 11.2920 | 11.2920 |
| ENA | 5.3655 | 5.3656 | 5.3656 |
| AAVE | 5.1767 | 5.1768 | 5.1768 |
| ONDO | 4.9654 | 4.9655 | 4.9655 |
| ASTER | 3.7182 | 3.7165 | 3.7165 |
| SKY | 3.6806 | 3.6807 | 3.6807 |
| MORPHO | 3.4733 | 3.4733 | 3.4733 |
| JST | 2.2257 | 2.2258 | 2.2258 |
| JUP | 2.1721 | 2.1721 | 2.1721 |
| CAKE | 1.6721 | 1.6721 | 1.6721 |
| AERO | 1.6099 | 1.6099 | 1.6099 |
| ETHFI | 1.4757 | 1.4758 | 1.4758 |
| PYTH | 1.2425 | 1.2425 | 1.2425 |

Checks:

- PASS [setup] set-bidder: the keeper is whitelisted already, nothing sent, nothing logged — 0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902 isBidder true
- PASS [setup] set-bidder again: nothing sent
- PASS deploy-mocks exits 0
- PASS [setup] deploy-mocks: one m{SYMBOL} mock per add, decimals as recorded, inventory with the bidder — ASTER mASTER 8dec bidder 13311047878566
- PASS [setup] deploy-mocks again: every add skipped
- PASS plan exits 0
- PASS [setup] plan: adds carry the deployed mock addresses; tuple waits for the decision — ASTER 0xEB745D
- PASS decision draft written
- PASS [setup] draft: no "to be deployed" address left; the TO FILL comment no longer asks for mocks
- PASS plan with decision exits 0
- PASS plan: announce tuple complete
- PASS [announce] announce refuses a duplicate address in the tuple; nothing pending — REFUSED: duplicate address in adds: 0xeb745ddd04caa0717c31dce7f32f3edaad4bf0c7 — the contract would accept this announcement and refuse it at execute forever
- PASS [announce] announce dry run: simulated, the checks line printed, nothing sent
- PASS announce live exits 0
- PASS a change is pending
- PASS re-plan while pending exits 0 and carries the tuple
- PASS day-7 plan after the mark exits 0 and carries the tuple
- PASS [plan] day-7 plan: every held name sized at the reference now on chain (chainRefAtPlan) — 15/15 names
- PASS [plan] day-7 plan: every entering name is bought by a planned auction — 15 auction(s); traded 16/16 names
- PASS baseline: day7 exits 0, verify passed — verify: all checks passed
- PASS baseline: every fill by the keeper key (no separate bidder), lossAtRef 0 — 15 fill(s)
- PASS baseline: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10004,10005,10005,10006,10005,10005,10006,10005,10006,10005,10005,10006,10005,10005,10004; remnants —
- PASS baseline: removals finalized — finalized [CRV], still in registry [—]; plan.finalize CRV; finalizePending —
- PASS baseline: every add in the registry with a reference — assetCount 15
- PASS [spec §4] baseline: every planned auction filled once, for the amount the plan sized (15) — 15 fill(s)
- PASS [spec §4] baseline: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] baseline: every traded name within the fill bound of its trade target — 15 traded; closest to its bound ASTER 0.00172 pt (bound 0.00508 pt)
- PASS [spec §4] baseline: every name at its book weight within the fill bound — largest gap to the book ASTER 0.0017 pt
- PASS [spec §4] baseline: every entering name bought (balance > 0) to its book weight — ASTER 3.718% vs book 3.716%
- PASS baseline: a holder redeems after the session — assetCount 15, gas 616615
- PASS [spec §1.3] day7 refuses before execute when a reference moved after the plan (HYPE +0.1%); the change stays pending, nothing filled — REFUSED: reference(s) moved since the plan sized its auctions (HYPE 8890000000→8898890000) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage
- PASS ① 1 base unit donated in window 1: day7 exits 0, verify passed — verify: all checks passed
- PASS ① 1 base unit donated in window 1: every fill by the keeper key (no separate bidder), lossAtRef 0 — 16 fill(s)
- PASS ① 1 base unit donated in window 1: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10006,10005,10004,10005,10005,10006,10004,10005,10004,10005,10006,10005,10004; remnants 1.r1:open:10200
- PASS ① 1 base unit donated in window 1: removals finalized — finalized [CRV], still in registry [—]; plan.finalize CRV; finalizePending —
- PASS ① 1 base unit donated in window 1: every add in the registry with a reference — assetCount 15
- PASS [①] CRV: donation landed in window 1 and was re-drained at once; finalized in the same run — 1 donation(s); remnant fills 1.r1 took 1 at 10200 bp
- PASS ④ 1,000-share creation in window 1: day7 exits 0, verify passed — verify: all checks passed
- PASS ④ 1,000-share creation in window 1: every fill by the keeper key (no separate bidder), lossAtRef 0 — 16 fill(s)
- PASS ④ 1,000-share creation in window 1: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10005,10005,10005,10005,10005,10005,10004,10005,10005,10005,10005,10004,10005; remnants 1.r1:fair:10005
- PASS ④ 1,000-share creation in window 1: removals finalized — finalized [CRV], still in registry [—]; plan.finalize CRV; finalizePending —
- PASS ④ 1,000-share creation in window 1: every add in the registry with a reference — assetCount 15
- PASS [④] CRV: a creation's pro-rata slice in window 1 is re-drained and CRV finalized — remnant fills 1.r1 fair took 4213180000 at 10005 bp
- PASS [spec §4] ④ after the creation: verify within the fill bound after the residual rounds — fills by round {"1":16}
- PASS ⑤ redemption in window 1: day7 exits 0, verify passed — verify: all checks passed
- PASS ⑤ redemption in window 1: every fill by the keeper key (no separate bidder), lossAtRef 0 — 15 fill(s)
- PASS ⑤ redemption in window 1: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10005,10006,10004,10005,10005,10005,10006,10005,10005,10006,10005,10006,10005; remnants —
- PASS ⑤ redemption in window 1: removals finalized — finalized [CRV], still in registry [—]; plan.finalize CRV; finalizePending —
- PASS ⑤ redemption in window 1: every add in the registry with a reference — assetCount 15
- PASS [⑤] CRV: the fill shrank to the live balance, the rest of the auction was cancelled, CRV finalized — took 4257679474985 of an auction for 4258100792975; auction open false
- PASS PENDING, then a later plan: day7 exits 0, verify passed — verify: all checks passed (PENDING: CRV)
- PASS PENDING, then a later plan: every fill by the keeper key (no separate bidder), lossAtRef 0 — 20 fill(s)
- PASS PENDING, then a later plan: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10006,10005,10005,10006,10006,10005,10005,10005,10005,10004,10005,10006,10004,10004; remnants 1.r1:open:10200,1.r2:open:10200,1.r3:open:10200,1.r4:open:10200,1.r5:open:10200
- PASS PENDING, then a later plan: removals finalized except PENDING CRV — finalized [—], still in registry [CRV]; plan.finalize —; finalizePending CRV(5)
- PASS PENDING, then a later plan: every add in the registry with a reference — assetCount 16
- PASS [K-4] a later plan lists CRV as in removal and plans no auction for a remnant under $1 — removes CRV balance 1 inRemoval true; trades 0
- PASS [K-4] CRV: the auctions stage of a later plan drains and finalizes the PENDING remnant — exit 0; in registry false; finalize CRV
- PASS [K-4] verify passes after the later drain, nothing PENDING — verify: all checks passed
- PASS [limit] known limit: a day-7 plan made AFTER a third party executed is refused by the planner (work order vs registry) — manual path — keeper/pending-registry-qdefi.json says adds [ASTER] removes [CRV] but the book vs the registry says adds [] removes [CRV] — resolve before planning

### qAI

Fork block 37523765 (2026-10-01T15:34:41.000Z), anvil/v1.8.3. largest gap to the book NEAR 0.0085 pt.

| Name | vault after % | book % | auctions aimed at % |
|---|---|---|---|
| NEAR | 29.6404 | 29.6319 | 29.6319 |
| TAO | 19.3245 | 19.3283 | 19.3283 |
| ICP | 10.2762 | 10.2730 | 10.2730 |
| AKE | 7.7749 | 7.7764 | 7.7764 |
| VVV | 7.4307 | 7.4322 | 7.4322 |
| FET | 5.6675 | 5.6686 | 5.6686 |
| VIRTUAL | 5.5645 | 5.5655 | 5.5655 |
| RENDER | 5.4840 | 5.4851 | 5.4851 |
| GRASS | 4.9588 | 4.9597 | 4.9597 |
| UB | 3.8784 | 3.8792 | 3.8792 |

Checks:

- PASS [setup] set-bidder: the keeper is whitelisted already, nothing sent, nothing logged — 0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902 isBidder true
- PASS [setup] set-bidder again: nothing sent
- PASS deploy-mocks exits 0
- PASS [setup] deploy-mocks: one m{SYMBOL} mock per add, decimals as recorded, inventory with the bidder — NEAR mNEAR 9dec bidder 121722702539536; ICP mICP 9dec bidder 66555924335770
- PASS [setup] deploy-mocks again: every add skipped
- PASS plan exits 0
- PASS [setup] plan: adds carry the deployed mock addresses; tuple waits for the decision — NEAR 0xEB745D, ICP 0xA636dE
- PASS decision draft written
- PASS [setup] draft: no "to be deployed" address left; the TO FILL comment no longer asks for mocks
- PASS plan with decision exits 0
- PASS plan: announce tuple complete
- PASS [announce] announce refuses a duplicate address in the tuple; nothing pending — REFUSED: duplicate address in adds: 0xeb745ddd04caa0717c31dce7f32f3edaad4bf0c7 — the contract would accept this announcement and refuse it at execute forever
- PASS [announce] announce dry run: simulated, the checks line printed, nothing sent
- PASS announce live exits 0
- PASS a change is pending
- PASS re-plan while pending exits 0 and carries the tuple
- PASS day-7 plan after the mark exits 0 and carries the tuple
- PASS [plan] day-7 plan: every held name sized at the reference now on chain (chainRefAtPlan) — 10/10 names
- PASS [plan] day-7 plan: every entering name is bought by a planned auction — 11 auction(s); traded 12/12 names
- PASS baseline: day7 exits 0, verify passed — verify: all checks passed
- PASS baseline: every fill by the keeper key (no separate bidder), lossAtRef 0 — 11 fill(s)
- PASS baseline: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10004,10004,10005,10006,10005,10005,10004,10004,10005; remnants —
- PASS baseline: removals finalized — finalized [GRT,AKT], still in registry [—]; plan.finalize GRT,AKT; finalizePending —
- PASS baseline: every add in the registry with a reference — assetCount 10
- PASS [spec §4] baseline: every planned auction filled once, for the amount the plan sized (11) — 11 fill(s)
- PASS [spec §4] baseline: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] baseline: every traded name within the fill bound of its trade target — 10 traded; closest to its bound TAO -0.00375 pt (bound 0.00898 pt)
- PASS [spec §4] baseline: every name at its book weight within the fill bound — largest gap to the book NEAR 0.0085 pt
- PASS [spec §4] baseline: every entering name bought (balance > 0) to its book weight — NEAR 29.640% vs book 29.632%, ICP 10.276% vs book 10.273%
- PASS baseline: a holder redeems after the session — assetCount 10, gas 431457
- PASS [spec §1.3] day7 refuses before execute when a reference moved after the plan (TAO +0.1%); the change stays pending, nothing filled — REFUSED: reference(s) moved since the plan sized its auctions (TAO 3054700000→3057754700) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage
- PASS ②③ donations between fill and finalize: day7 exits 0, verify passed — verify: all checks passed (PENDING: AKT)
- PASS ②③ donations between fill and finalize: every fill by the keeper key (no separate bidder), lossAtRef 0 — 19 fill(s)
- PASS ②③ donations between fill and finalize: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10004,10005,10005,10005,10005,10005,10005,10005,10004,10005,10005; remnants 5.r1:open:10200,5.r2:open:10200,5.r3:open:10200,6.r1:open:10200,6.r2:open:10200,6.r3:open:10200,6.r4:open:10200,6.r5:open:10200
- PASS ②③ donations between fill and finalize: removals finalized except PENDING AKT — finalized [GRT], still in registry [AKT]; plan.finalize GRT; finalizePending AKT(5)
- PASS ②③ donations between fill and finalize: every add in the registry with a reference — assetCount 11
- PASS [②] GRT: three donations between the drain fill and the finalize, three immediate re-drains, finalized — 3 re-drain(s): 5.r1@10200, 5.r2@10200, 5.r3@10200
- PASS [③] AKT: a donation at every attempt → PENDING after five re-drains, verify passes with PENDING, exit 0 — finalizePending {"symbol":"AKT","address":"0x05C6B7e4b96F15Dd30A5A75977F7645619eB8634","balance":"1","valueUsd":"0.000000","attempts":5,"lastTx":"0xf6a7adaccc51994f7182a1befa6e645f8cdb531151d37d1e1868ad54a6dcb55e","at":"2026-10-08T19:15:12.000Z","stage":"final
- PASS [③] AKT: a later auctions run drains and finalizes the PENDING remnant — exit 0; finalize GRT,AKT

### qX20

Fork block 37521818 (2026-10-01T15:02:14.000Z), anvil/v1.8.3. largest gap to the book ZEC 0.0006 pt.

| Name | vault after % | book % | auctions aimed at % |
|---|---|---|---|
| BTC | 60.0647 | 60.0651 | 60.0651 |
| ETH | 17.1543 | 17.1546 | 17.1546 |
| BNB | 5.3419 | 5.3420 | 5.3420 |
| XRP | 4.8931 | 4.8932 | 4.8932 |
| SOL | 3.6244 | 3.6244 | 3.6244 |
| TRX | 1.6833 | 1.6833 | 1.6833 |
| ZEC | 1.2532 | 1.2526 | 1.2526 |
| HYPE | 1.0382 | 1.0382 | 1.0382 |
| DOGE | 0.7708 | 0.7708 | 0.7708 |
| LINK | 0.5573 | 0.5573 | 0.5573 |
| XMR | 0.5381 | 0.5378 | 0.5378 |
| ADA | 0.4849 | 0.4849 | 0.4849 |
| RAIN | 0.4553 | 0.4553 | 0.4553 |
| XLM | 0.4094 | 0.4094 | 0.4094 |
| NEAR | 0.3583 | 0.3581 | 0.3581 |
| BCH | 0.3229 | 0.3229 | 0.3229 |
| UNI | 0.2897 | 0.2897 | 0.2897 |
| AVAX | 0.2567 | 0.2567 | 0.2567 |
| CC | 0.2566 | 0.2566 | 0.2566 |
| SUI | 0.2472 | 0.2472 | 0.2472 |

Checks:

- PASS [setup] set-bidder: the keeper is whitelisted already, nothing sent, nothing logged — 0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902 isBidder true
- PASS [setup] set-bidder again: nothing sent
- PASS deploy-mocks exits 0
- PASS [setup] deploy-mocks: one m{SYMBOL} mock per add, decimals as recorded, inventory with the bidder — ZEC mZEC 12dec bidder 20494041778847; XMR mXMR 11dec bidder 2270571788328; NEAR mNEAR 9dec bidder 1578736484584
- PASS [setup] deploy-mocks again: every add skipped
- PASS plan exits 0
- PASS [setup] plan: adds carry the deployed mock addresses; tuple waits for the decision — ZEC 0x9D9F66, XMR 0xEB745D, NEAR 0xA636dE
- PASS decision draft written
- PASS [setup] draft: no "to be deployed" address left; the TO FILL comment no longer asks for mocks
- PASS plan with decision exits 0
- PASS plan: announce tuple complete
- PASS [announce] announce refuses a duplicate address in the tuple; nothing pending — REFUSED: duplicate address in adds: 0x9d9f66878cf9ba82ee7488fe26e7de3b3d15e97e — the contract would accept this announcement and refuse it at execute forever
- PASS [announce] announce dry run: simulated, the checks line printed, nothing sent
- PASS announce live exits 0
- PASS a change is pending
- PASS re-plan while pending exits 0 and carries the tuple
- PASS day-7 plan after the mark exits 0 and carries the tuple
- PASS [plan] day-7 plan: every held name sized at the reference now on chain (chainRefAtPlan) — 20/20 names
- PASS [plan] day-7 plan: every entering name is bought by a planned auction — 22 auction(s); traded 23/23 names
- PASS baseline: day7 exits 0, verify passed — verify: all checks passed
- PASS baseline: every fill by the keeper key (no separate bidder), lossAtRef 0 — 22 fill(s)
- PASS baseline: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10004,10005,10005,10006,10005,10005,10005,10005,10005,10005,10005,10005,10005,10005,10005,10004,10005,10005,10004,10005,10005; remnants —
- PASS baseline: removals finalized — finalized [GRAM,HBAR,SHIB], still in registry [—]; plan.finalize HBAR,GRAM,SHIB; finalizePending —
- PASS baseline: every add in the registry with a reference — assetCount 20
- PASS [spec §4] baseline: every planned auction filled once, for the amount the plan sized (22) — 22 fill(s)
- PASS [spec §4] baseline: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] baseline: every traded name within the fill bound of its trade target — 20 traded; closest to its bound ZEC 0.00058 pt (bound 0.00332 pt)
- PASS [spec §4] baseline: every name at its book weight within the fill bound — largest gap to the book ZEC 0.0006 pt
- PASS [spec §4] baseline: every entering name bought (balance > 0) to its book weight — ZEC 1.253% vs book 1.253%, XMR 0.538% vs book 0.538%, NEAR 0.358% vs book 0.358%
- PASS baseline: a holder redeems after the session — assetCount 20, gas 801774
- PASS [spec §1.3] day7 refuses before execute when a reference moved after the plan (BTC +0.1%); the change stays pending, nothing filled — REFUSED: reference(s) moved since the plan sized its auctions (BTC 8323100000→8331423100) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage
- PASS ⑥ third party executed: day7 exits 0, verify passed — verify: all checks passed
- PASS ⑥ third party executed: every fill by the keeper key (no separate bidder), lossAtRef 0 — 22 fill(s)
- PASS ⑥ third party executed: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10006,10005,10005,10005,10006,10006,10006,10005,10006,10005,10005,10005,10005,10005,10005,10005,10005,10005,10005,10005; remnants —
- PASS ⑥ third party executed: removals finalized — finalized [GRAM,HBAR,SHIB], still in registry [—]; plan.finalize HBAR,GRAM,SHIB; finalizePending —
- PASS ⑥ third party executed: every add in the registry with a reference — assetCount 20
- PASS [spec §4] ⑥ third party executed: every planned auction filled once, for the amount the plan sized (22) — 22 fill(s)
- PASS [spec §4] ⑥ third party executed: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] ⑥ third party executed: every traded name within the fill bound of its trade target — 20 traded; closest to its bound ZEC 0.00061 pt (bound 0.00332 pt)
- PASS [spec §4] ⑥ third party executed: every name at its book weight within the fill bound — largest gap to the book ZEC 0.0006 pt
- PASS [spec §4] ⑥ third party executed: every entering name bought (balance > 0) to its book weight — ZEC 1.253% vs book 1.253%, XMR 0.538% vs book 0.538%, NEAR 0.358% vs book 0.358%
- PASS [⑥] day7 names the third party and continues (plan.execute.byThirdParty) — execute tx 0x39a1dbf28dadd3324d5ea1a2af4282748328569ceff41641cd3a2aa7cdea6ca2 by 0x90F79bf6EB2c4f870365E785982E1f101E93b906
- PASS 1 base unit between drain and finalize: day7 exits 0, verify passed — verify: all checks passed
- PASS 1 base unit between drain and finalize: every fill by the keeper key (no separate bidder), lossAtRef 0 — 23 fill(s)
- PASS 1 base unit between drain and finalize: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10005,10006,10005,10005,10005,10005,10005,10005,10005,10006,10005,10004,10004,10005,10004,10005,10006,10004,10005,10005,10004; remnants 5.r1:open:10200
- PASS 1 base unit between drain and finalize: removals finalized — finalized [GRAM,HBAR,SHIB], still in registry [—]; plan.finalize HBAR,GRAM,SHIB; finalizePending —
- PASS 1 base unit between drain and finalize: every add in the registry with a reference — assetCount 20
- PASS [②] HBAR: one base unit between the drain fill and the finalize → one immediate re-drain, finalized in the same run — 5.r1 took 1 paid 2 at 10200 bp
- PASS ④ 1,000-share creation in window 1: day7 exits 0, verify passed — verify: all checks passed
- PASS ④ 1,000-share creation in window 1: every fill by the keeper key (no separate bidder), lossAtRef 0 — 23 fill(s)
- PASS ④ 1,000-share creation in window 1: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10005,10004,10005,10005,10005,10005,10004,10005,10004,10004,10005,10005,10004,10004,10004,10004,10004,10005,10004,10005,10004,10005; remnants 8.r1:fair:10005
- PASS ④ 1,000-share creation in window 1: removals finalized — finalized [GRAM,HBAR,SHIB], still in registry [—]; plan.finalize HBAR,GRAM,SHIB; finalizePending —
- PASS ④ 1,000-share creation in window 1: every add in the registry with a reference — assetCount 20
- PASS [④] GRAM: a creation in window 1 → re-drained and finalized — 8 fair 1768378726120, 8.r1 fair 1733072000
- PASS [spec §4] ④ after the creation: verify within the fill bound after the residual rounds — fills by round {"1":23}

### qTRI

Fork block 37523222 (2026-10-01T15:25:38.000Z), anvil/v1.8.3. largest gap to the book WC -0.0154 pt; sleeves workingCapital -0.0154 pt, monetary -0.0097 pt, quality 0.0251 pt; largest inside Quality HYPE 0.0081 pt.

| Name | vault after % | book % | auctions aimed at % |
|---|---|---|---|
| WC | 46.7494 | 46.7648 | 46.7495 |
| BTC | 29.3495 | 29.3591 | 29.3496 |
| HYPE | 7.8350 | 7.8269 | 7.8351 |
| TRX | 7.6868 | 7.6788 | 7.6868 |
| SKY | 2.2104 | 2.2081 | 2.2104 |
| CAKE | 1.8132 | 1.8113 | 1.8132 |
| UNI | 1.4828 | 1.4812 | 1.4828 |
| RAY | 0.7800 | 0.7791 | 0.7800 |
| PENDLE | 0.7097 | 0.7090 | 0.7097 |
| BNB | 0.7067 | 0.7060 | 0.7067 |
| AERO | 0.6766 | 0.6755 | 0.6763 |

Checks:

- PASS [setup] set-bidder: the keeper is whitelisted already, nothing sent, nothing logged — 0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902 isBidder true
- PASS [setup] set-bidder again: nothing sent
- PASS deploy-mocks exits 0
- PASS [setup] deploy-mocks: one m{SYMBOL} mock per add, decimals as recorded, inventory with the bidder — AERO mAERO 8dec bidder 1678560189776
- PASS [setup] deploy-mocks again: every add skipped
- PASS plan exits 0
- PASS [setup] plan: adds carry the deployed mock addresses; tuple waits for the decision — AERO 0xEB745D
- PASS decision draft written
- PASS [setup] draft: no "to be deployed" address left; the TO FILL comment no longer asks for mocks
- PASS plan with decision exits 0
- PASS plan: announce tuple complete
- PASS [announce] announce refuses a duplicate address in the tuple; nothing pending — REFUSED: duplicate address in adds: 0xeb745ddd04caa0717c31dce7f32f3edaad4bf0c7 — the contract would accept this announcement and refuse it at execute forever
- PASS [announce] announce refuses an add whose chain symbol is not mAERO; nothing pending — REFUSED: AERO: 0x9bAaB117304f7D6517048e371025dB8f89a8DbE5 is mDECOY on chain, not mAERO — wrong mock address in the plan
- PASS [announce] announce dry run: simulated, the checks line printed, nothing sent
- PASS announce live exits 0
- PASS a change is pending
- PASS re-plan while pending exits 0 and carries the tuple
- PASS day-7 plan after the mark exits 0 and carries the tuple
- PASS [plan] day-7 plan: every held name sized at the reference now on chain (chainRefAtPlan) — 10/10 names
- PASS [plan] day-7 plan: every entering name is bought by a planned auction — 8 auction(s); traded 9/11 names
- PASS baseline: day7 exits 0, verify passed — verify: all checks passed
- PASS baseline: every fill by the keeper key (no separate bidder), lossAtRef 0 — 8 fill(s)
- PASS baseline: planned fills inside the fair window, remnant fills at the open (≤ 10,200 bp) — planned 10004,10005,10005,10005,10005,10005,10005,10006; remnants —
- PASS baseline: removals finalized — finalized [—], still in registry [—]; plan.finalize —; finalizePending —
- PASS baseline: every add in the registry with a reference — assetCount 11
- PASS [spec §4] baseline: every planned auction filled once, for the amount the plan sized (8) — 8 fill(s)
- PASS [spec §4] baseline: no residual round and no re-drain (no creation or redemption in the session) — none
- PASS [spec §4] baseline: every traded name within the fill bound of its trade target — 9 traded; closest to its bound AERO 0.00032 pt (bound 0.00159 pt)
- PASS [spec §4] baseline: untraded names (WC, BTC) hold exactly their pre-session balances — unchanged
- PASS [spec §4] baseline: every entering name bought (balance > 0) to its book weight — AERO 0.677% vs book 0.676%
- PASS baseline: a holder redeems after the session — assetCount 11, gas 468489
- PASS [spec §1.3] day7 refuses before execute when a reference moved after the plan (WC +0.1%); the change stays pending, nothing filled — REFUSED: reference(s) moved since the plan sized its auctions (WC 1000982315→1001983297) — regenerate the plan (keeper/basket-plan.mjs) after the mark, then run this stage

