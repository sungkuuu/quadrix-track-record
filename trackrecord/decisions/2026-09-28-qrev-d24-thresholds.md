# qREV — count-derived thresholds at fifteen names and the empty-seat rule from the 2026-10-01 reconstitution, decided 2026-09-21 and 2026-09-23

**Decided:** 2026-09-21 (owner; the two thresholds) and 2026-09-23 (owner; what happens when fewer than fifteen names
are eligible, and how §9 behaves from there). **Effective:** at the first reconstitution on or after 2026-10-01 — the
scheduled quarterly run, the same run at which `2026-09-21-qrev-fifteen-names` takes effect. **Series:**
`trackrecord/record-qrev.jsonl`, unchanged until that run. The ledger's `effectiveFrom` for this file is 2026-09-28, the
date this document is written and anchored; the decisions it records were made on 2026-09-21 and 2026-09-23 and entered
in the rulebook on those dates (site commits `709c664`, `6da32e7` and `111e853`); the thresholds take effect on
2026-10-01, and the record between 2026-09-21 and the 2026-10-01 reconstitution is the ten-name rule with the thresholds
as written for ten names — eight and ten — as the rulebook stood at inception on 2026-09-16 and as the decision of
2026-09-21 left them.

## What changes

`2026-09-21-qrev-fifteen-names` (rulebook D23) raised the name count from ten to fifteen and said of the two numbers
derived from the count that "whether they should follow the count is an open item." This document closes that item
(rulebook D24) and records the owner's rule for a reconstitution day that counts fewer eligible names than seats.

| Rule | Until the 2026-10-01 reconstitution | From it |
| --- | --- | --- |
| §9 — after a special-event removal (trigger A, B or C), an interim reconstitution under the regular rules when the index holds fewer than … names | 8 | **12** |
| §12-1 — the index is not made with fewer than … eligible names after §2, §3 and §11 | 10 | **15** |

The ratios to the count are the ones the ten-name rulebook had — 80% for the §9 trigger, 100% for the §12-1 floor. They
are a judgement of an acceptable range, not values the backtest produced: the parameter grid of 2026-09-21 varies the
count, the cadence, the positive-months rule and the market-cap floor; the backtest's 27 variants vary the count, the weighting,
the cap and its trim line, the floor weight, the hysteresis, the tolerance, the value-trap filter, the ranking metric,
the issuance source, the cadence, the positive months, the market-cap floor and the treatment of chain tokens (one row,
the fee and cost convention); none tests these two thresholds. The rank buffer is not touched — enter at rank 12 or better, stay while at 19 or better — because
12/19 is the backtest's own rounding of the buffer rule at fifteen names, and an entry line of 13 would be a different
rule from the one tested (owner, 2026-09-21, as recorded in `2026-09-21-qrev-fifteen-names`).

## When fewer than fifteen names are eligible (owner, 2026-09-23)

If fewer than fifteen names pass §2, §3 and §11 on a reconstitution day, the index holds the eligible names only (plus
any incumbent in its §6 grace quarter) and the remaining seats stay empty. The shortfall does not, by itself, re-open the
question of whether the product exists; §12-1 keeps its number as the floor and now states what happens below it. The
owner's words: "없으면 없는대로 배포" — if the names are not there, run with the ones that are.

## How §9 behaves when the index starts below twelve (owner, 2026-09-23)

The paragraph entered in rulebook §9 on 2026-09-23 on the owner's instruction, verbatim, with an English rendering
beneath it:

> **적격 미달로 12 미만에서 출발할 때(오너 2026-09-23)**: 10/1 재구성에서 적격이 15에 못 미치면 적격 종목만 담는다(§12-1). 보유가 이미 12 미만이면 이 문턱은 처음부터 충족된 상태이므로, **이 절의 사건(A·B·C)으로 한 종목만 빠져도 분기를 기다리지 않고 그 다음 실행에서 정규 규칙으로 재선별**한다 — 적격 종목이 새로 생겼으면 그때 채우고, 없으면 남은 종목으로 간다. 사건 없이 문턱 미달 자체로는 재구성하지 않는다(매 실행 반복 재구성 없음). D24 결정문에 이 문장을 그대로 넣는다.

> Starting below twelve for lack of eligible names (owner 2026-09-23): if fewer than fifteen are eligible at the
> 2026-10-01 reconstitution, the index holds the eligible names only (§12-1). If the holding is already below twelve, the
> §9 threshold is met from the outset, so a single event under this section (A, B or C) that removes one name re-selects
> under the regular rules at the next run, without waiting for the quarter — filling seats if eligible names have since
> appeared, otherwise continuing with the remaining names. Without an event, the shortfall by itself does not trigger a
> reconstitution (no repeated reconstitution at every run). This sentence is placed in the D24 decision document verbatim.

Everything else in §9 stands: the triggers (A — a fall of 40% or more against bitcoin in 24 hours on two price sources,
together with TVL down 50% or more in 48 hours or an official incident notice of a loss above 10% of TVL; B — 5% or more
of circulating supply leaving, in one week, the protocol-controlled (foundation and vesting) addresses listed in the
supply registry; C — price lost or delisted, handled as in the qX20 rulebook §9), the sale in full at the next run with
the proceeds spread pro rata across the remaining names, no new admissions intra-quarter other than through the interim
reconstitution, and the two-quarter bar on a triggered name re-entering.

## Why

The two thresholds were written for ten names as a proportion of the count. D23 moved the count and, on the owner's
instruction that everything else stay, left them where they were; this decision carries the proportion to fifteen. That
is the whole of the reasoning — a proportion held, and a judgement that the proportion is an acceptable one. No backtest
was run on the thresholds and none is claimed.

The shortfall rule follows from what the index is: a rule that holds the protocols that pass the screens. A quarter in
which fewer than fifteen pass is a fact about the universe, and the owner's decision is that the record shows that fact
— fewer names held — rather than a product paused or a screen loosened to fill the seats.

## What it is not

It is not a forecast that the 2026-10-01 count will be short, and not a return claim. Nothing in this document changes
which names the rule selects or how they are weighted; it changes when an interim reconstitution is allowed and what the
record does with seats the universe cannot fill.

## What stays

- Everything else in the rulebook: the universe (protocol tokens with a DefiLlama holder-revenue adapter, plus chain
  tokens whose trailing-year burn exceeds new issuance), the circulating market-cap floor of $150M, $10M volume, holder
  revenue ≥ $1M and positive for six consecutive months, listing age 365 days, value-trap 25%, the net-burn rule for
  chain tokens, P/HR ranking cheapest first, weighting by holder revenue net of issuance with the 2% floor, the 35% cap cut
  at every reconstitution, quarterly cadence, the rank buffer 12/19 from 2026-10-01, two-quarter exit hysteresis, 5-point
  tolerance with the cap override, the protocol map and the supply registry.
- §12-6 ("fewer than ten names holdable in a live vault through the GIWA canonical bridge") is not part of this
  decision; it is an unverified item and keeps its number.
- The paper record (`record-qrev.jsonl`, since 2026-09-16; latest row 2026-09-28, re-read when this document
  was anchored) keeps the ten members selected on 2026-09-16 — HYPE, SKY, CAKE, UNI, RAY, CRV, PENDLE, JUP,
  AERO, ZRO — until the 2026-10-01 reconstitution. The testnet basket vault on GIWA Sepolia holds the same ten at least until
  its registry change executes, which the contract allows no earlier than seven days after the change is announced
  (`REGISTRY_DELAY = 7 days`, `QuadrixBasketVault.sol`), and thereafter changes only as the auctions trade. Keeper state at the same moment:
  `lastReconQuarter 2026Q3`, nothing on notice.
- The inception decision of 2026-09-16 and the count decision of 2026-09-21 stand; this document amends two thresholds
  of the rulebook they anchor, adds the shortfall rule, and is anchored beside them, not in their place.

## How the keeper carries it

It does not need to. `keeper/rulebooks/qrev.json` has no field for the §9 interim-reconstitution count or for the §12-1
minimum — the only `viability.minimumEligibleNames` among the rulebooks is Triens's own Quality-sleeve floor
(`keeper/rulebooks/triens.json`, 5), read on that index's path and nowhere else — so the file is unchanged by this
decision. Its sha256 below differs from the value pinned on 2026-09-21 because of the census-status rule added on
2026-09-22, not because of this document; `keeper/paper-index.mjs` likewise differs from its 2026-09-21 pin for commits
unrelated to this decision.

On a short universe `keeper/paper-index.mjs` already does what the owner decided: `resolveMembership` fills seats to
`targetCount` by rank, holds fewer when fewer are eligible, prints `universe short: <k> member(s) vs target 15 (<n>
eligible this run) — rulebook §12 applies, held as-is`, and `weightQrev` computes the §4 weights across the names held.

An empty seat is a name not held, not a cash position. Rulebook §4 and both implementations compute the weights across
the names present: `cap_weights` in `qrev-backtest.py` (site repository, `docs/research/qrev/`, lines 197–198) divides
each name's value by the total over the names held and iterates the cap among them, and `weightQrev` in
`keeper/paper-index.mjs` does the same with the 2% floor and `applyCap`. Neither has a cash leg; the record's weights sum
to one within rounding (four decimals).

The §9 triggers are not evaluated by the keeper (`specialEvents.inScope: false` — a special event surfaces as a missing
price or a data gap and the run is reviewed by hand). The keeper reconstitutes only when the run date's calendar quarter
differs from `state.lastReconQuarter`; it has no off-calendar reconstitution switch, and record rows have no field that
references a decision. If a §9 event occurs, the operator adds that path under its own dated note before re-selecting;
the re-selection itself follows the regular rules as this document states them.

## Measured context (not a projection)

- 2026-09-14, the rulebook's hand measurement of 25 mapped candidates (appendix A-1/A-2), on the draft screen of that
  day — market cap ≥ $300M, holder revenue ≥ $1M over the trailing year, the 25% value-trap test, listing age ≥ 12 months, the
  Launchpad/Meme/Gamified-Mining exclusions, chain tokens excluded as a category (no net-burn rule yet), no $10M volume gate, the positive-months rule not tested (A-3, item 9): **11** names
  passed. AAVE, ETHFI and ONDO showed positive trailing-year holder revenue and zero in the trailing 30 days — adapter halt
  or distribution halt, undetermined (A-3, item 2) — and failed the trap test; if those three resolve, 14. Both counts are
  below fifteen, and both were known when the threshold was set.
- 2026-09-20, the research note's fifth pass on the point-in-time universe — 116 symbols and 17 chains, every adapter
  with $1M all-time, with the $150M floor and the net-burn rule (site repository `docs/research/qrev/README.md`): **18**
  eligible before the $10M volume gate, **16** after it (CVX and SYRUP fall out — rulebook appendix A-4 and the candidate
  page, `src/data/candidates.ts:316`). A different screen from the 2026-09-14 count, and this document does not reconcile
  the two.
- The count that governs is the one the keeper measures on the 2026-10-01 run, with both trailing windows ending the day
  before the run — reconstitution date exclusive (rulebook §6, keeper `sumWindow`, `qrev.json` `trailing12mEndDate`).
  Nothing above is a forecast of it.

## How to verify

1. The rulebook text: site repository `docs/methodology/value-capture.md` at `8f6816d` (sha256 below) — §9 (the
   "12 미만" clause and the 2026-09-23 paragraph that follows it), §12-1, and the D23 and D24 rows of appendix B; the
   three commits that entered them, `709c664` (2026-09-21, the two thresholds), `6da32e7` (2026-09-23, the empty-seat
   rule in §12-1 and the D24 row) and `111e853` (2026-09-23, the §9 paragraph).
2. The keeper carries no such number: `grep -n minimumEligibleNames keeper/rulebooks/*.json` matches `triens.json`
   only, and `node -e "const rb=require('./keeper/rulebooks/qrev.json'); console.log(rb.viability, rb.specialEvents.inScope)"`
   prints `undefined false`.
3. From the run that reconstitutes — 2026-10-01 if the scheduled run succeeds that day — the run log line `ranking
   parameters for <date>: targetCount 15, rank buffer enter ≤ 12 / exit > 19 (scheduled change
   2026-09-21-qrev-fifteen-names effective 2026-10-01)`; if the universe is short, the `universe short:` line with the
   eligible count; and a record row whose members are the names held, with weights summing to one within rounding (four
   decimals), no cash entry, and `eligibleCount` with `eligibleAsOf` equal to that run's date (the screen runs only at a
   reconstitution, so the pair is carried unchanged in the daily rows until the next one).

## Pinned

| File | Commit / sha256 |
| --- | --- |
| site `docs/methodology/value-capture.md` (§9, §12-1, appendix B D23–D24) | main `8f6816d`, sha256 `43944d0ff0e6b20670c90788af01359f612cb3162a982385905eaf599041ee05`; the two thresholds entered at `709c664` (2026-09-21), the §12-1 empty-seat rule and the D24 row at `6da32e7` (2026-09-23), the §9 paragraph at `111e853` (2026-09-23) |
| `2026-09-21-qrev-fifteen-names` (`trackrecord/decisions.jsonl`) | sha256 `d47cad2eb9ba2b8d78e9a4752dad26faf89531db43901d27268b183ec6426f9a`, tx `0xd292092aae7abdb09840892d87fb23ac9c7482f4f0900df64d2a4a9f19b8f02e` |
| `2026-09-16-qrev-paper-inception` (`trackrecord/decisions.jsonl`) | sha256 `44df04cae810ccc2d9714be17fa080367f908794623b227203a91a5f6172fa4c`, tx `0x6c7bbaf367042764d5fe722de58ca58aaa8a4c75f1c1ae43f761ee6adfedfa82` |
| `keeper/rulebooks/qrev.json` — unchanged by this decision | sha256 `1411918cbfd722741e969cc15d898e8697dfc9c7231760c30feba386ee175128` (differs from the 2026-09-21 pin `aecd53c1…` for the census-status rule of 2026-09-22) |
| `keeper/paper-index.mjs` — unchanged by this decision | sha256 `b273e94e97e1795138bc79763f913c5dc4b7ec10d7ff9cb171897e86582b6946` (differs from the 2026-09-21 pin `b9b24ad2…` for nine commits since — the Barbell/Triens and qAI legs, the census-status fallback, sleeve marking, the eligible-count fields, qAI's listing-date source, the qAI chain-rule and qX20 exclusion gates — none of them this decision) |
| `keeper/rulebook-schedule.mjs` — unchanged by this decision | sha256 `161cea3fde8030b27e07aab14b069481c88adf609ae11382273b96ccb570bfd8` (same as the 2026-09-21 pin) |
| quadrix-track-record (this file — before this commit) | `b88e9a4` |
