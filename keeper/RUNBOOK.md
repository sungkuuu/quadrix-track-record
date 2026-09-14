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
mode 6 below — because the sanity gate only sees the size of the move.

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

The keeper prices the book from the top-60 market feed. A held constituent
that drops out of that feed (rank, delisting, a ticker collision — prices are
keyed by ticker, so two coins with the same symbol overwrite each other) is
logged as `constituents without a live price (dropped)` and **left out of the
valuation**. The run does not fail. If the resulting NAV moves less than 15%
it is posted, low by that constituent's weight, and the drift check for it is
`NaN`, so nothing rebalances it away either. The next run that sees a price
again restores the value. Treat the warning as an alert: check the ledger for
a dip that coincides with it, and if the coin is genuinely gone from the
universe, wait for the monthly reconstitution or re-run after the feed
recovers.

---

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
