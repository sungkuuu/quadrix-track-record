# qX20 NAV keeper — operations runbook

Current vault: `0x2A165501ddA6e430fF98E82682f53CA8465Bb21f` (2026-09-14 →). Superseded: `0x1d1115b961832dd921be78cf1362a531b69bcaa0` (2026-07-21 → 2026-09-14; NAV frozen at its last mark, redemptions never gated).

The keeper marks the qX20 model book to market and posts the resulting NAV to
`QuadrixIndexVault` on GIWA Sepolia on a six-hour schedule
(`.github/workflows/index-nav-keeper.yml`, cron `17 */6`). GitHub starts the
job late: over the first 90 marks from this repository the gaps between marks
ran 0.1–13.8 h (median 6.1 h), three of them longer than 12 h.

**What a failure means:** the NAV on chain is *stale*, not wrong. The vault keeps
quoting the last posted mark. Deposits and redemptions still work — they just
transact at an old price. A failed keeper run does not lock funds or corrupt
state; the model book only advances when a run succeeds. A *successful* run can
still post a wrong NAV in one case — a constituent without a price, failure
mode 6 below — because the sanity gate only sees the size of the move. (That
is this NAV-tracker keeper. The basket vaults marked by `paper-index.mjs`
defer their marks on a missing price instead — also failure mode 6.)

**How you find out:** a failed run opens (or comments on) a GitHub issue labelled
`keeper-failure`, which emails every repo watcher. A successful run closes it. An
open issue therefore always means "broken right now", not "broke once". There
is no second channel; adding one (a webhook, for instance) would need a step
added to the workflow.

---

## Failure modes

### 1. Sanity threshold — `refusing to post NAV: …% move exceeds ±15%`

This is the designed halt, and it is the one that needs judgement. **The
threshold cannot distinguish a bad price feed from a genuine market crash**, and
it does not try to. It stops and hands the decision to a human.

The run log prints everything needed to make that call:

```
=== KEEPER HALTED — NAV not posted ===
  timestamp     2026-07-22T06:17:03.412Z
  price source  coinpaprika
  onchain NAV   1.043210
  computed NAV  0.834112
  move          -20.04%  (threshold ±15%)
  book          BTC 60.0% @ 61240, ETH 11.2% @ 2980, SOL 4.1% @ 131, …
  rebalanced    false
```

**Diagnosis — the question is always "did the market move, or did the feed?"**

| Signal | Reads as bad feed | Reads as real move |
| --- | --- | --- |
| `price source` | `coinpaprika` (the fallback — CoinGecko was down or throttled, so the run is already on degraded infrastructure) | `coingecko` (primary source healthy) |
| `book` prices | one or two constituents absurd (zero, 10×, stale), rest normal | prices move together in the same direction |
| Independent check | a third venue disagrees with the printed price | a third venue confirms it |
| News | none | a market-wide event |

Check the printed prices against a source the keeper does **not** use — e.g.
Binance or Coinbase spot — before deciding. One constituent being wrong while
everything else is flat is a feed defect, not a crash.

**Resolution**

- *Bad feed* — do nothing. The upstream recovers and the next scheduled run
  posts a correct NAV. Do not override. Close the issue only after a green run.
- *Real move* — override deliberately (below). Note the contract independently
  bounds any single update to ±25%; a larger genuine move converges over
  successive runs rather than in one jump.
- *Unclear* — do nothing and wait for the next run. A stale NAV is a smaller
  problem than a wrong one, and this vault holds test assets.

**Override procedure** (the only way past the gate)

1. Confirm the move against a source outside the keeper's two feeds.
2. Actions → `index-nav-keeper` → **Run workflow** → set
   **`acknowledge_move`** to `true`.
3. The keeper logs `OPERATOR OVERRIDE`, posts the NAV, and writes the override
   into `state.json` (`override: {movePct, priceSource, previousNav}`) so the
   decision is attributable in git history.
4. Append a line to the log at the bottom of this file.

The override is per-run. It never persists, and the scheduled runs are never
able to set it — only a human pressing the button can.

### 2. `all market sources failed`

Both CoinGecko and CoinPaprika were unreachable. No action: the next run
retries. If it persists for more than ~24h (4 runs), add a third source to
`fetchMarkets()`.

### 3. `KEEPER_PK not set`

The repository secret was deleted or rotated. Re-add `KEEPER_PK`. This key is a
testnet burner that holds only GIWA Sepolia gas; it has no authority over the
managed vault and cannot move user assets. It does sign every on-chain write in
this repository: qX20 marks (`setNav`, bounded by the contract's ±25%), the
daily record anchors (`track-record.yml`), decision anchors
(`anchor-decision.yml`) and the QBV v3 `accrueManagementFee` poke. The watchdog
derives the anchoring account from it. Rotating the key therefore changes the
address every future anchor is sent from: past anchors stay valid on chain,
but the series would from then on be anchored from two accounts, and the
watchdog's gas check moves to the new one.

### 4. Transaction reverted

Gas, nonce or RPC. The contract's ±25% bound cannot be the cause when the
script is what sent the transaction: the script's own ±15% gate stops first,
and past it (operator override) the script clamps the NAV to ±24% before
sending. A bound revert therefore means someone sent `setNav` outside this
script. For the ordinary case, check the keeper address's ETH balance on the
GIWA Sepolia explorer and top up from the faucet.

### 5. `git push` failed on "Commit model state and the mark ledger"

The NAV was posted on chain but neither `state.json` nor the new
`nav-marks.jsonl` line was committed. Two consequences:

- The model book will be recomputed from the previous state on the next run
  and will disagree with the posted NAV. Re-running the workflow converges
  within one run.
- The ledger line for that mark is lost **permanently** unless it is restored
  by hand: the next run checks out a fresh tree, and nothing re-derives the
  ledger from the chain. Before re-running, copy the mark line from the failed
  run's log (the script prints `nav <from> -> <to>` and the tx hash) and
  append it to `keeper/nav-marks.jsonl` in a commit of its own, so that the
  ledger's `navFrom` still equals the previous line's `navTo`.

This is the one failure mode where the on-chain state ran ahead of the
repository state — the `concurrency: keeper` group exists to keep two runs
from racing into it. It has not happened yet: on every ledger line so far
`navFrom` equals the prior `navTo`.

### 6. Constituent without a price

**NAV tracker (`keeper/update-nav.mjs`) — posts without it.** The keeper
prices the book from the top-60 market feed. A held constituent that drops out
of that feed (rank, delisting, a ticker collision — prices are keyed by
ticker, so two coins with the same symbol overwrite each other) is logged as
`constituents without a live price (dropped)` and **left out of the
valuation**. The run does not fail. If the resulting NAV moves less than 15%
it is posted, low by that constituent's weight. Its own drift check is `NaN`,
so it does not trigger a rebalance; but any rebalance that does happen while
it is missing — another name crossing the band, or the monthly
reconstitution — rebuilds the book from priced names only, and the name and
its value leave the book. Otherwise the next run that sees a price again
restores the value. This is qX20's rule as it stands (rulebook §9: a missing
price is valued at 0; the carry-then-zero draft is an open question), so the
keeper is not changed. Treat the warning as an alert: check the ledger for a
dip that coincides with it, and if the coin is genuinely gone from the
universe, wait for the monthly reconstitution or re-run after the feed
recovers.

**Basket vaults (`keeper/paper-index.mjs`, every leg) — defer the marks
(2026-09-30).** A basket's `navPerShare` is the whole book at today's prices,
so a name with no usable price (a finite number above zero) cannot be left out
of it — before this change a missing BTC would have walked the qX20 basket
down 59% in six band steps. If any name of the book being marked has no usable
price in the day's pull, the leg posts **nothing** to its basket vault that
run: no `setNav`, no `setRefPrice`, no registry diff. It logs

    qX20 basket marks DEFERRED — no usable price today for BTC: nothing posted to the basket vault this run, …
    markDeferred {"markDeferred":"missing-price","policy":"freeze","index":"qx20","date":"…","missing":["BTC"],"marketsSource":"…","retry":"next run"}

plus a workflow warning and a line in the job summary, and **exits 0**: a
deferral is not a failure, so the later steps still run and no
`paper-index-failure` issue is opened (the same as a reconstitution deferred
under `freeze`). The vault keeps its last marks; auction fills against a
reference older than `maxRefAge` fail closed, exits are unaffected. The next
run tries again.

- qX20: the whole leg is the mark, so the whole leg waits.
- qREV, qDEFI, qAI: only the vault post waits. The record line is still
  written and anchored, and it still values the unpriced name at 0 (log:
  `no live price today — valued at 0 in today's level`) — that is the
  rulebooks' §9 as implemented, not the marking leg's to change.
- Barbell, Triens: the daily record and its basket marks carry the last known
  price for up to three runs (rulebook §9, "Sleeve indexes" below) — not
  changed here. Only a re-post (a second run on a day that already has a
  record) defers.

Nothing alerts on a deferral that repeats — the watchdog reads the NAV
tracker's ledger, not the basket vaults — so read the warning in the day's
run. One day: nothing to do. Several: the feed has lost the name (a ticker that
differs on the CoinPaprika fallback, a delisting); fix the feed side, never
the book. To rehearse the path on real data:
`PAPER_INDEX_TEST_DROP_SYMBOL=BTC node keeper/paper-index.mjs --index qx20 --dry-run`
(dry run only; without `--dry-run` the variable is ignored, with a line saying
so).

### 7. Basket mark failed after the record — `basket marks FAILED after record #N was written and anchored`

Every record-writing leg of `keeper/paper-index.mjs` (qREV, qDEFI, qAI,
Barbell, Triens) runs in this order since 2026-10-01: record line → state →
anchor → basket marks (`markAfterRecord`). A basket mark that throws — a
reverted `setNav` / `setRefPrice` (`… reverted on chain (tx …)`), a failed
GIWA RPC read inside `keeper/basket-mark.mjs`, a NAV the band steps cannot
reach — therefore comes after the line and its anchor are on disk. The leg
logs

    qREV basket marks FAILED after record #15 was written and anchored: …
    markFailed {"markFailed":true,"index":"qrev","date":"…","seq":15,"recordWritten":true,"anchored":true,"error":"…"}

plus a workflow error annotation and a line in the job summary, and **exits
1**. In `.github/workflows/paper-index.yml`:

- the later legs still run (`!cancelled()`), each with its own line, anchor
  and marks;
- "Commit records" commits every line, state and anchor entry written;
- the job fails and the `paper-index-failure` issue opens.

What is lost is that run's marks only. Steps that landed before the failure
stay on chain — a band-stepped `setNav` can stop part-way — and the vault
keeps them. To re-post, start a **new** run the same UTC day (Actions →
`paper-index` → **Run workflow**, on `main`, after "Commit records" of the
failed run has pushed): a run on a day that already has a record re-posts the
marks only, with no second line and no second anchor. Do not edit or
re-append the record.

Do **not** use "Re-run jobs" on the failed run. A re-run checks out the commit
the failed run started from, which does not have the day's line: the keeper
would compute a second line for the day and send a second anchor, and the
push would then fail on the rebase — an anchor on chain for a line that is
not in the record. The keeper finds an existing line only by reading the last
line of `trackrecord/record-{index}.jsonl` in its checkout; it does not read
the chain or `anchors-{index}.jsonl`.

Before 2026-10-01 the anchor came after the marks: a mark failure left that
day's line committed without an anchor, and the failed step skipped every
later leg, which then had no line for that day. No line in
`record-{qrev,qdefi,qai,barbell,triens}.jsonl` lacks an anchor (checked
2026-10-01).

Unchanged — **the anchor itself fails** (gas, a nonce race past five tries,
RPC): the leg exits 1 with the line and state on disk and no anchor entry.
"Commit records" still commits them, and `scripts/verify.mjs` then reports
`no anchor for this record` for that seq. Nothing anchors it later: a
same-day re-run takes the record-exists path, which marks and does not
anchor. The next day's anchor commits to a head whose `prevHash` chain
includes the line, so its content is fixed from then, but not its date. The
anchor and the marks use the same GIWA RPC, so an RPC outage fails the anchor
before any mark is tried. The N1Q record (`scripts/track-record.mjs`,
`track-record.yml`) has no basket mark; there a failed anchor also skips the
commit step, so that day's line is not committed at all.

---

## Index baskets — marking the basket vaults (prepared 2026-09-16, no vault deployed yet)

Each index (qX20, qREV, qDEFI) is to get a basket vault
(`QuadrixBasketVault` v3.1) holding one mock per constituent; the keeper marks
it daily from the index record (`keeper/basket-mark.mjs`, run from
`paper-index.mjs`; `docs/paper-index.md`, "Basket marking"). Until a
rulebook's `basket.vault` is set the leg prints what it would post and posts
nothing. Once set, the same `KEEPER_PK` signs `setNav` and `setRefPrice` on
the basket vault — add that to the list in failure mode 3.

### During a rebalance: re-mark often, short auctions

A rebalance is the one time the vault trades, and it trades only through
dutch auctions priced off the keeper's reference prices. v3.1 refuses a fill
whose reference is older than `maxRefAge` (default one hour). So while any
auction is open:

1. **Re-mark often.** Run `node keeper/paper-index.mjs --index <index>` again
   as often as the auction needs — a re-run on a day that already has a
   record skips the record and only re-posts the marks. An unchanged price
   re-posted still refreshes the reference clock. Do not raise `maxRefAge` to
   avoid re-marking: a wide window is a wide window for a bidder too.
2. **Short auctions.** Open auctions with a duration well inside the
   re-marking cadence, and re-open rather than extend. The curve runs from
   +2% to the floor (−`maxFillLossBps`) over the duration; a long auction
   against a stale reference is the case the guard exists for.
3. **Order of a reconstitution.** The keeper's `pending-registry-{index}.json`
   lists the change. A human writes the decision document, anchors it
   (`anchor-decision` workflow), and calls `announceRegistryChange` with its
   sha256 (owner key). Seven days later anyone calls `executeRegistryChange`.
   Then the keeper opens auctions: sell the leaving asset for members until
   its balance is zero (`finalizeRemoval`), post a first `setRefPrice` for the
   entering asset, and buy it from the overweight members. Redemption pays the
   old shape until `finalizeRemoval` and the new shape after; nothing about it
   is paused at any point. The tools and the dispatch order are in
   "Basket reconstitution — tools" below.
4. **Daily loss budget.** Fills below reference draw on `dailyLossBudgetBps`;
   when it trips (`DailyBudgetExceeded`) the auction waits for the next UTC
   day. That is the policy working; do not loosen it mid-rebalance.
5. **Log every override** in the table below, as for the NAV keeper.

The paper record does not wait for any of this: the level moves on day 0,
the vault follows over the week, and the gap is a stated tracking difference.

### Basket reconstitution — tools

| Step | Tool (workflow) | Signs with |
| --- | --- | --- |
| whitelist a separate bidder | `keeper/set-bidder.mjs` (`basket-recon-setup`, task `set-bidder`) | owner (`KEEPER_PK`); bidder = `BIDDER_PK`'s address |
| deploy the entering mocks | `keeper/deploy-mocks.mjs` (`basket-recon-setup`, task `deploy-mocks`) | `KEEPER_PK`; inventory to the bidder |
| plan | `keeper/basket-plan.mjs` (`basket-reconstitution`, stage `plan`) | reads only |
| decision draft | `node keeper/gen-recon-decision.mjs --index <x> --date <d>` (local) | — |
| announce … verify | `keeper/basket-recon.mjs` (`basket-reconstitution`, stages) | owner/keeper; fills by the bidder |

Every tool is a dry run unless `live` is ticked and `confirm` is `EXECUTE`.

- **What a session trades (block rule, planner change of 2026-10-01).** The
  book re-weights every name of a block when it trades any of them, so the
  plan does too: an add, a removal not yet in removal on chain, a name 5
  points or more off its book weight, or a name over the cap while its book
  weight is not, makes every name of its block trade to the book's weight —
  the whole basket for qX20, qREV, qDEFI, qAI; the Quality sleeve for Triens
  unless the sleeves reset (then every name). The block's own value pays for
  the entering names. A remnant already in removal does not open a block.
  Expect more auctions than before (2026-10-01 plans: 22 · 14 · 15 · 11 · 8
  for qX20 · qREV · qDEFI · qAI · qTRI), about 20 minutes each one at a time.
- **Order on the day: mark, then plan, then the session.** The plan sizes
  every auction at the references on chain (`chainRefAtPlan` per name; the
  day's market price stays in `planRefPrice` for the 5% guard). The auctions
  stage refuses if any reference moved since the plan ("regenerate the
  plan"): let the daily run finish, run `plan`, then `day7` right after; if
  it refuses, run `plan` again and dispatch again.
- **Verification.** A traded name passes when it is within the bound fair
  fills allow of its trade target — fair window × (value bought into it + its
  weight × all bought) / vault value + traded names × $1 / vault value
  (`residualBound` in `basket-recon.mjs`) — not within the 5-point tolerance,
  which let a whole entering name through.
- **Resuming after execute.** A plan made after the registry change was
  executed (the manual path under "Someone else executed") sees no add; tick
  `reweight_block` on the plan stage (`--reweight-block`) so the session
  still trades the block to the book. The flag is written to the plan's
  notes.

- **Mocks.** One mock per entering name *and basket* — the deployed convention
  (no two vaults share a mock; NEAR entering three baskets gets three). The
  output `keeper/mocks/{date}.json` is keyed by index and is what the plan
  stage's `mocks` input takes. The bidder receives twice the vault's target
  holding of each new mock, because the auctions sell it into the vault.
- **Bidder log.** `setBidder` emits no event; every transaction is appended to
  `keeper/bidder-log.jsonl` with its block and the `isBidder` read-back.
- **Removals (option K).** A drain fill is followed at once by a balance read
  and `finalizeRemoval`, not by the remaining auctions. If anything reached the
  vault in between — a one-unit transfer from anyone, or a creation, which
  pays in a pro-rata slice of the leaving asset — the remnant is re-drained at
  once from the live balance (under $1: filled at the curve's open without
  waiting, at most 2% over reference on less than $1, `lossAtRef` 0), up to
  five times, then the asset is written to the plan's `finalizePending` and the
  run continues. The auctions stage, `finalize` and `verify` print it as
  **PENDING** and exit 0; the workflow summary shows the PENDING lines.
  Nothing is lost while it waits — redemptions pay the remnant pro rata and
  the record is unaffected — and re-running the `auctions` stage drains and
  finalizes it: the same UTC day with the same plan, or on a later day after
  a new `plan` (a later plan has no auction for a remnant under $1; the
  stage drains whatever is still in removal even with nothing planned). A
  remnant of $1 or more is not PENDING: it is drained like any other, and if
  it cannot be the stage fails as before. One case still stops the run with
  an error instead of PENDING: a transfer that lands after the zero balance
  was read and before `finalizeRemoval` is mined (the simulation or the
  receipt reports `RemovalNotDrained`). Re-run the `auctions` stage; it
  resumes after the fills already recorded and drains the remnant.
- **Fill size.** A fill takes the smaller of the auction amount and the
  vault's balance at that moment; a redemption in the window shrinks the fill
  instead of reverting it, and the unfilled rest is cancelled.
- **Announce checks.** The announce stage refuses a tuple with the same
  address twice (in adds, in removes, or in both — the contract accepts it at
  announce and refuses it at execute forever) and any add or remove whose
  chain `symbol()` is not `m{SYMBOL}` of the plan; the dry-run log ends with a
  `checks:` line saying both held. Read it before the live dispatch.
- **Someone else executed.** `executeRegistryChange` is open to anyone once
  the seven days have run. If the execute stage (or `day7`) finds nothing
  pending and every add already in the registry and every remove in removal,
  it says who executed (the tx, searched in the last 100,000 blocks), records
  it in the plan and goes on with first-prices; `day7` completes. With
  nothing pending and the registry NOT changed, it still refuses ("announce
  first"). The desk must read the chain registry by then (`staging/basket-recon`
  in the site repository): the creation vector changes length at execute,
  whoever calls it. This covers an execution AFTER the day's plan was made.
  If someone executes BEFORE the day-7 plan, the planner refuses ("…says
  adds [X] … but the book vs the registry says adds [] … resolve before
  planning"): the work order no longer matches the registry. By hand, in
  this order: add the new mocks to the rulebook's `basket.assets` (address
  and decimals from `keeper/mocks/{date}.json`) so the daily mark posts
  their first references through its two-source gate, remove
  `keeper/pending-registry-{index}.json`, then `plan` and `auctions` →
  `finalize` → `verify`.
- **Decision documents.** `keeper/gen-recon-decision.mjs` names the file by
  the plan's date and states the reconstitution date (the work order's)
  separately. Anchor a document on the UTC day in its file name: that date
  becomes `effectiveFrom` in `trackrecord/decisions.jsonl`, the live record
  line of a day carries every decision effective by then, and a document
  anchored later than its date would be missing from a line already written
  (`verify.mjs` would fail it for good). `scripts/anchor-decision.mjs`
  refuses a back-dated file, a file with the DRAFT or TO FILL line, and one
  that still says `_to be deployed_`. If the day has passed, run the `plan`
  stage again and regenerate the draft that day.
- **After the session.** The same day, on main: add each new mock to the
  rulebook's `basket.assets` (the daily mark prices only what the rulebook
  names — an unlisted registry asset is "not posted" and its reference goes
  stale), drop a finalized removal from it (keep one that is PENDING, so it
  stays marked), and remove `keeper/pending-registry-{index}.json` (the
  planner refuses a work order that no longer matches the registry).
- **Rehearsal.** `node keeper/rehearse-day7.mjs --date <today>` forks GIWA
  Sepolia on a local anvil and runs the day's real work orders through every
  tool above (set-bidder, deploy-mocks, plan, draft, announce with its
  guards, seven days, day7 with a separate bidder), then the option-K cases
  from a snapshot: a donation or a creation or a redemption inside the drain
  window, donations between the drain and the finalize (three times; every
  time → PENDING), a third party executing first, and a run with no
  interference against the tool as it was before K (`--main-recon <file>`).
  Local only — it refuses to run under Actions. It needs the day's
  `keeper/cache/` (run the planner once first).

### Reads after a write, and re-runs (2026-10-01)

The public endpoint (`https://sepolia-rpc.giwa.io`) is load-balanced: the
node that returned a receipt is not always the node that answers the next
request. On 2026-10-01 an `eth_getCode` right after a deployment receipt came
back empty and stopped the mock deployment. A node that has not seen the
receipt's block answers with an error ("header not found"), an empty answer
("0x", a null block), or — at `latest` — the state from BEFORE the
transaction. `keeper/basket-recon.mjs` and `keeper/set-bidder.mjs` follow two
rules (`keeper/readback.mjs`):

- **A read after a write names its block.** Either the receipt's own block
  (the checks that a write did what it should: the pending tuple and eta after
  announce, the registry after execute and after each finalize, the reference
  after a first price, `isBidder` after setBidder), or the newest block the
  RPC reports raised to the highest receipt block the run has seen (every
  read that decides the next step: balances and references before and after
  fills, the curve factor, the vault after a round, chain time — and every
  simulation, so a lagging node cannot fake a revert). A node without that
  block errors or answers empty; it cannot answer stale. Such a read is
  repeated for up to 30 s, then the run stops with a message naming the
  block. Until the run's first receipt — when the plan's `sent` list records
  none either — reads are at `latest` as before (a dry run of a fresh plan
  never leaves that path).
- **What was sent is on disk before anything else is read.** `basket-recon`
  appends each transaction hash to the plan's `sent` list and saves the plan
  the moment the RPC returns the hash (before waiting for the receipt), then
  completes the entry (block, status) from the receipt. After a successful
  receipt nothing throws until the stage has saved its record: the block's
  time is read at the receipt's block within the bound and is `null` if it
  cannot be (announce then takes `at` = eta − 7 days, exact by construction);
  the stage records announce / execute / first price / fill / finalize from
  the receipt and its events, saves, and only then reads to check. A failed
  check stops the run with the record already in the plan file, which the
  workflow commits after a failed stage too. The auction id is the one in the
  open's `AuctionOpened` event, not `auctionCount` read before the open.
  `set-bidder` prints the hash when sent and writes its `bidder-log.jsonl`
  line (with `null` for a read that never answered) before it stops.

**A re-run after a stop right after a mined transaction.** Every run first
settles the plan's `sent` entries that have no receipt: mined → completed, and
its block raises the run's read floor; no receipt → **REFUSED** with the hash
("look the hash up on chain …; if it was dropped, set `"status": "dropped"` on
that entry and re-run") — nothing is done while an earlier transaction may
still land. A live run also **refuses while a signer has a transaction sent
but not mined** (pending nonce above the latest): a workflow run that was
*cancelled* does not commit its plan file, so its `sent` list is lost, and
this keeps the re-run from acting before that transaction lands; once it is
mined the chain-side records below pick it up. Then, per stage:

| Stopped right after | A re-run |
| --- | --- |
| announce mined, not in `plan.announce` | the pending change hashes to the plan's tuple → **adopted** into `plan.announce` (`adopted: true`; tx from `sent` or the `RegistryChangeAnnounced` log since the plan's block), nothing sent, exit 0 — the day-7 planner then carries it. Another change pending → REFUSED as before. This change pending and recorded → REFUSED "already pending and recorded" (nothing to send). |
| execute mined, not in `plan.execute` | nothing pending and the registry holds the change → recorded from `sent` or the `RegistryChangeExecuted` log (signer = keeper, `byThirdParty: false`), as for a third party's execute; first-prices follows. Recorded but without `assetCount` (the check never answered) → "already executed", continues. |
| first price mined, not in `plan.firstPrices` | the chain reference equals the plan's first price → **recorded** (`adopted: true`, tx from `sent` or `RefPricePosted`), not posted again. |
| openAuction mined, not filled | the auctions stage **cancels** every auction opened since the plan's block that is still open before it opens anything (a dry run prints it). |
| same-value re-post mined | nothing to record; the trade is re-read and re-posted from the chain. |
| fill mined, not in `plan.fills` | **recorded, never traded again**: matched to the planned round-1 trade with the same sell/buy pair (the planner never repeats a pair), so round 1 skips it; two planned trades with that pair → REFUSED (record it in `plan.fills` by hand); no planned pair → recorded as `adopted-<auction id>` (residual rounds and re-drains are computed from live balances). Under `fair`/`open` an adopted fill with `lossAtRef` ≠ 0, or a planned one outside the fair window under `fair`, → HALT after it is recorded, as a fill made now would. A drain whose finalize did not run is finalized by the sweep after round 1. |
| cancelAuction mined | nothing to record (the trade reopens from live balances; an orphan is closed). |
| finalizeRemoval mined, not in `plan.finalize` | **recorded** from `RemovalFinalized` by the auctions, finalize or verify stage, so verify's asset count matches. |
| setBidder mined, not logged | the chain already says `allowed` → nothing sent. setBidder emits no event, so the line cannot be rebuilt: take the hash from the run's log (printed when sent) and add the line by hand. |
| any stage, and the day's mark has moved a reference since the plan | the plan sized its auctions at the references it read (`chainRefAtPlan`). The auctions stage first records the earlier run's fills and finalizes and cancels what it left open (rows above), then **REFUSED** "reference(s) moved since the plan sized its auctions"; `day7` refuses before it sends execute. Make a new plan after the mark and dispatch again — after execute, with `reweight_block` (the new plan sees no add; "Someone else executed" for the work-order file). The new plan reads the balances the earlier run left, so nothing is traded twice. |
| the job stopped by GitHub's 6-hour job limit (one auction takes about 20 minutes on the public chain: a 22-auction qX20 session is about 7.3 hours) | the runner is terminated, so the plan file is **not** committed: main holds the plan stage's version, with none of the stopped job's records. **Dispatch the same stage again with that plan before making any new plan.** The same UTC day: `day7` (or `auctions`) records every fill and finalize of the stopped job from the chain, cancels the auction it left open, and trades only what is left — or, if the mark moved a reference meanwhile, records all that and then refuses (row below); its commit keeps the records. A later UTC day: `auctions` and `day7` refuse the old plan before they read anything, so dispatch `verify` first — it records the stopped job's fills and finalizes into the old plan and is committed even when its weight checks fail — then the new plan with `reweight_block`. A new plan made first overwrites the same day's plan file and reads only from its own block, so the stopped job's fills would be in no plan file. Rehearsed with `keeper/rehearse-day7.mjs --stop-resume` (second review of the planner change): the same-day re-run, the re-run refused after a moved reference and the resume with `reweight_block`, and the dry-run `verify` that records; a real 6-hour termination on GitHub is not. |

Known limits: a re-run that finds a fill matching two planned trades, a
`sent` entry with no receipt, or a HALT on an adopted fill stops and says what
to check — none of them proceeds. A transaction nonce read from a lagging
node can be stale; a send it refuses as "nonce too low" is retried by
`sendNonceSafe`, and one it accepts but never mines ends as a `sent` entry
without a receipt (REFUSED on the next run until it is looked up).

**Rehearsal.** `node keeper/test/rehearse-readback.mjs --date <today> --index
qdefi --main-recon <basket-recon.mjs as on main> --stop-variant` forks GIWA
Sepolia and runs announce → 7 days → re-plan → mark → day7 (the keeper bids)
through `keeper/test/lag-proxy.mjs`, once with no lag and once lagging (after
every receipt the next reads of each read method come from a node one block
behind: stale, empty, not found, in turn), with block times fixed, and
requires the same plan records, the same mined transactions and the same
vault state. The tool on main through the same lagging proxy loses the
announcement, and with no lag it sends exactly what this tool sends.
`--stop-variant` adds a node that goes dark for 40 s right after the fill's
receipt (the run stops, fill recorded) and a re-run on the clean node, which
must finish with the same transactions and vault state as the clean run. Unit tests: `node --test keeper/test/*.test.mjs`
(`readback-helpers`, `recon-readback`, `set-bidder-readback`).

## Sleeve indexes — Barbell and Triens (added 2026-09-22, not running)

Two more paper indexes exist in this repository and **neither one runs**. Their
steps in `.github/workflows/paper-index.yml` carry `if: false`, their rulebooks
(`keeper/rulebooks/{barbell,triens}.json`) have `inception: null`, and there is
no `trackrecord/record-{barbell,triens}.jsonl` yet. That is the intended state:
the rulebooks they implement are drafts in the site repo, and a paper series
may not start before an owner decision anchors its inception date.

**What the operator may do today:** dry runs only.

```bash
node keeper/paper-index.mjs --index barbell --dry-run
node keeper/paper-index.mjs --index triens  --dry-run
```

A dry run writes `keeper/dryrun/{state,record}-{index}.*` and touches nothing
else. It does not de-duplicate by date, so running it twice in one day
exercises the reconstitution branch and then the mark-to-market branch.

**Turning one on, when the owner has decided (all four steps, in order):**

1. Write the inception decision document and anchor it (`anchor-decision`
   workflow), as for qREV on 2026-09-16.
2. Fill `inception.date` and `inception.decision` in that index's rulebook and
   update its `status` string.
3. Delete the `if: false` line from that index's step in
   `.github/workflows/paper-index.yml`, and add its files to the "Commit
   records" step's `git add` list (`trackrecord/record-{index}.jsonl`,
   `trackrecord/anchors-{index}.jsonl`, `keeper/state-{index}.json`).
4. Add the series to `scripts/verify.mjs`'s series table (one line beside the
   `qrev`/`qdefi` entries: records, anchors, `anchorPrefix: 'qxpi-<index>:'`,
   `checkDecisions: false`). It is not there today on purpose — there is no
   series to verify until an inception decision exists.
5. Run it once by hand with `--dry-run`, read the output, then let the schedule
   take it. Do **not** run the non-dry path twice in one day: the record is
   append-only and a day that already has a line is skipped, but the habit is
   what protects it.

Keep both steps in the same job. Every step there signs with the same
`KEEPER_PK`, and the `keeper-key` concurrency group is what stopped the nonce
race that killed the 2026-09-18 run. A separate workflow would sit outside the
group.

## qAI — AI sector index (added 2026-09-22, NOT running)

`keeper/rulebooks/qai.json` has `inception: null`, the qAI step in
`.github/workflows/paper-index.yml` carries `if: false`, its files are
commented out of that workflow's "Commit records" `git add` list, and there is
no `trackrecord/record-qai.jsonl`. That is the intended state: the rulebook it
implements (`quadrix/docs/methodology/qai.md`) is a draft and a paper series
may not start before an owner decision anchors its inception date.

**What the operator may do today:** dry runs only.

```bash
node keeper/paper-index.mjs --index qai --dry-run   # 1st run: reconstitution
node keeper/paper-index.mjs --index qai --dry-run   # 2nd run: mark-to-market
```

**Turning it on** follows the same five steps as the sleeve indexes above,
with three additions specific to this leg:

- Step 3 also means *uncommenting* the three qAI paths already written into
  the "Commit records" step (`trackrecord/record-qai.jsonl`,
  `trackrecord/anchors-qai.jsonl`, `keeper/state-qai.json`), not just deleting
  the `if: false`.
- Before step 1, close the open items the keeper is currently resolving by
  reading the rulebook one way rather than the other — they are listed in
  `docs/paper-index.md` under "qAI … open, found by running it". The bucket-table
  coverage question (§8/D6) is the one that can change membership. D5 (listing
  date) was closed on 2026-09-22 in favour of CoinMarketCap's `dateAdded`.
- The classification sources have **no fallback**. Watch the first scheduled
  run's `sources:` line; a run that cannot reach either source writes no
  record for that day, and a missing day is never backfilled.

### What can go wrong in qAI specifically

| Symptom | What it means | What to do |
| --- | --- | --- |
| `CoinMarketCap listing returned no rows` | the tag source answered but with nothing usable — membership cannot be decided | nothing on the day: the run fails and writes no record. If it repeats across a reconstitution the membership is frozen at the last one (qai.md §8); two quarters of that is a §12 question for the owner, not an operator fix. |
| `HTTP 4xx/5xx for https://api.coinmarketcap.com/...` | same, from the other side | as above. There is no API key to rotate — the endpoint is public and unauthenticated. |
| `§12-1 WATCH: only N eligible name(s)` | fewer than 5 names cleared both sources and all three gates | nothing operational — the level is recorded as-is and the empty seats sit in cash. It is a signal for the owner: on that quarter the rule says the product would not be launched. |
| `seats 7/10 filled … cash 0.00%` | normal for a thin category | expected. Empty seats do **not** by themselves create cash — the weights renormalise across the names that are there. Cash appears only when the caps leave weight with nowhere to go, or when nothing at all is eligible (then 100%). |
| `cmcMcap=…=disagrees` on a member | the two sources' market caps differ by 2× or more | nothing operational. The gate is on CoinGecko, the house source; both numbers are in the record so the disagreement is auditable. It is an open rulebook item, not a rule the keeper applies. |
| `age=…d(ath-atl-proxy)` on a member | CoinMarketCap had no `dateAdded` for that name, so the fallback proxy decided its age | check the name by hand before a reconstitution acts on it — the proxy is wrong for anything whose all-time high or low is recent. |
| a member's market cap jumps between the ledger line and the basket line | the ledger prints the CoinGecko *category* row, the basket prints whichever row won the daily price map | both are CoinGecko; the two endpoints are snapshotted at different moments. Only the basket line feeds the record. |

### What can go wrong in these two specifically

| Symptom | What it means | What to do |
| --- | --- | --- |
| `FRED DTB3 unavailable and nothing cached` | the working-capital proxy's only source is unreachable on a cold cache | nothing: the next run retries. A run that fails writes no record, and a missing day is never backfilled. |
| `using the cached copy fred-dtb3-…` | FRED was unreachable but a cached series exists | nothing. A missing recent print only carries the last rate forward one more day, which is the rule anyway. |
| `no live price for N consecutive runs (limit 3)` | a held name has had no price for four runs | the run stopped on purpose and wrote nothing. Check the feed; if the name is genuinely gone, that is a rulebook §9 event and needs a person, not a re-run. |
| `quality seats: 4/10` on Triens | fewer names passed the screen than the rulebook's viability floor of 5 | nothing operational — the level is still recorded. It is a signal for the owner: the rule says a product would not be launched on that quarter. |
| `sleeve reset: … outside the 5-point tolerance` | the quarterly reset traded | expected on a reconstitution day after a large move. The line prints every sleeve's target, drifted weight and gap before it decides. |

## CoinGecko access — blocked endpoint, optional key, fallback (2026-09-29)

From the 2026-09-29 run, the keyless CoinGecko `coins/markets` endpoint answers
**HTTP 403 at CloudFront ("Request blocked")** — the top-500 pull and every
category pull. A browser User-Agent and an empty `x-cg-demo-api-key` header did
not lift it; per-coin `/coins/{id}` answered 429 after a handful of calls, so
rebuilding a category from per-coin lookups (hundreds of calls) is not an
option on the keyless tier.

**What `keeper/paper-index.mjs` does when CoinGecko is unreachable**

| Day | Behaviour | Record says |
| --- | --- | --- |
| mark-to-market (every leg) | prices from CoinPaprika tickers (top 500 for the markets map; the full list for qAI's names outside it). A qAI held name with no price stops the run | `sources.marketsSource: "coinpaprika + coingecko cache <date>"` (the snapshot supplies listing dates only — never a price); qAI also `sources.categorySource: "unavailable (HTTP 403); held names priced from coinpaprika, membership not read"` |
| reconstitution due, default | **deferred** — the rulebooks' own fallback ("membership frozen at the last reconstitution"; CoinPaprika is "price only, no reconstitution"). The day is written as a mark-to-market line; `lastReconQuarter` is left as it was, so the next run tries again | `sources.reconstitutionDeferred: {quarter, policy: "freeze", reason, retry: "next run"}` |
| reconstitution due, `PAPER_INDEX_DEGRADED_RECON=cache` | reconstitutes from CoinPaprika numbers + the newest CoinGecko snapshot's listing dates and category membership. **Not what the anchored rulebooks say — enabling it is a rule decision for the owner**, made by adding that env line to the workflow step(s). No snapshot → the run fails as before | `sources.categorySource: "coingecko cache <date>"` |

Barbell holds no screened names and never defers.

**Snapshots.** `keeper/cg-snapshot/` holds the last-known-good CoinGecko pulls
reduced to id, symbol and ath/atl dates (no prices). It exists because
`keeper/cache/` is gitignored and empty on every GitHub runner. A run with a
live CoinGecko pull rewrites the file for that pull and the workflow commits it;
the directory was seeded on 2026-09-29 from the operator's local
`keeper/cache/` (markets 2026-09-28, AI categories 2026-09-22, DeFi category
2026-09-16).

**Adding a key** (the account and plan are the owner's; nothing here creates one):

1. On coingecko.com, create a Demo (free) or paid API key under the owner's account.
2. Store it as a repository secret — the command prompts for the value, so it
   never lands in shell history, chat or an issue:
   `gh secret set COINGECKO_API_KEY --repo sungkuuu/quadrix-track-record`
3. A paid (Pro) key also needs `COINGECKO_API_PLAN: pro` in the paper-index
   workflow steps' `env:` (Pro keys use `pro-api.coingecko.com` and the
   `x-cg-pro-api-key` header; Demo keys use `api.coingecko.com` and
   `x-cg-demo-api-key`). The steps already pass `COINGECKO_API_KEY`.
4. Dispatch `paper-index` and check the next line's `sources.marketsSource` is
   `"coingecko"`. With the secret absent the keeper makes exactly the keyless
   calls it always made.

Other CoinGecko callers not covered by this: `keeper/basket-plan.mjs` (source
A of the reconstitution plan — it degrades to "partial" and source B is
CoinPaprika) and `keeper/update-nav.mjs` (qX20 NAV, CoinPaprika top-80 fallback).

## Exclusion list

`EXCLUDE` in `keeper/update-nav.mjs` (mirrored as `QX20_EXCLUDE` in `keeper/paper-index.mjs`, the base set qDEFI · qREV · qAI and Triens' Quality sleeve reuse (Barbell has no universe screen)) is matched by uppercase ticker; dated changes are gated by run date — `LEGACY_EXCLUDE` (nine tickers, excluded through 2026-09-30, decision 2026-09-23-qx20-exclusion-list) and `EXCLUDE_FROM` (XAUT, gold-pegged like PAXG, excluded from 2026-10-01, decision 2026-09-28-qx20-xaut-exclusion) — so both take effect at the first run of 2026-10, the monthly reconstitution; the site keeps its own copies: `src/pages/Engine.tsx` `DEMO_OPTIONS` (where PAXG is) and `scripts/gen-qx20-series.mjs`; `src/engine/indexEngine.ts` holds only the ten base names + the legacy nine.

## Manual run (local)

```bash
export KEEPER_PK=0x...            # testnet burner only
node keeper/update-nav.mjs
```

Add `KEEPER_ACK_MOVE=true` to bypass the sanity gate locally. Commit the
resulting `keeper/state.json` and the appended `keeper/nav-marks.jsonl` line —
an uncommitted local run desynchronises CI (failure mode 5).

## Known limitations

- **Alerting depends on GitHub.** If Actions itself is down, no run happens and
  no alert fires. There is no external heartbeat monitor.
- **`contents: write` cannot be narrowed to one file.** As long as keeper state
  lives in `main`, the token can write anywhere in the repo. Moving state out of
  the repository, or to a bot branch merged after verification, is the long-term
  fix; it is not the current priority.
- **No paging.** Email, via GitHub issue notifications, is the only channel.
  Nothing wakes anyone up, which is correct while the vault holds test assets
  and stale NAV is the worst outcome.

## Override log

| Date (UTC) | Move | Source | Reason | Operator |
| --- | --- | --- | --- | --- |
| 2026-09-14 | from par 1.000000 to the model level (≈+21%, clamped to ≤1.24×) | redeploy | vault redeployed with a reentrancy guard at 0x2A165501ddA6e430fF98E82682f53CA8465Bb21f; the new contract starts at par while the model index continues — one acknowledged post to converge. Superseded vault 0x1d1115b961832dd921be78cf1362a531b69bcaa0 keeps its marks | keeper operator |

## Alert-path drills

The alert path is only worth having if it has been fired at least once. To
re-drill: branch, replace the `Post NAV` step's command with `exit 1`, push, run
the workflow on that ref, then delete the branch. A successful run on `main`
closes whatever the drill opened.

| Date (UTC) | Result |
| --- | --- |
| 2026-07-22 | Full cycle verified in the private repository, before the move — failure opened [sungkuuu/quadrix#1](https://github.com/sungkuuu/quadrix/issues/1) with the keeper log attached; a second failure commented on the same issue instead of opening a new one; a successful run on `main` closed it automatically. |
| — | Not yet re-drilled in this repository. None of the three alert labels here (`keeper-failure`, `track-record-failure`, `watchdog`) has fired; the watchdog's `--simulate` input exists for this purpose but no drill has been logged. |
