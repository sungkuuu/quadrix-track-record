# qX20 NAV keeper — operations runbook

The keeper marks the qX20 model book to market and posts the resulting NAV to
`QuadrixIndexVault` on GIWA Sepolia every 6 hours (`.github/workflows/keeper.yml`).

**What a failure means:** the NAV on chain is *stale*, not wrong. The vault keeps
quoting the last posted mark. Deposits and redemptions still work — they just
transact at an old price. There is no path by which a failed keeper run locks
funds or corrupts state; the model book only advances when a run succeeds.

**How you find out:** a failed run opens (or comments on) a GitHub issue labelled
`keeper-failure`, which emails every repo watcher. A successful run closes it. An
open issue therefore always means "broken right now", not "broke once". A Slack
webhook can be added as a second channel by setting the `SLACK_WEBHOOK_URL`
repository secret — no code change needed.

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
managed vault and cannot move user assets — its only power is `setNav` on qX20,
itself bounded by the contract's ±25%.

### 4. Transaction reverted

Almost always the contract's ±25% bound (the script's own ±15% gate should have
caught it first — if it did not, the two are out of sync, which is a bug) or an
out-of-gas keeper account. Check the keeper address's ETH balance on the GIWA
Sepolia explorer; top up from the faucet.

### 5. `git push` failed on "Commit model state"

The NAV was posted on chain but `state.json` was not committed, so the model
book will be recomputed from the previous state on the next run and will
disagree with the posted NAV. Re-run the workflow manually; it converges within
one run. This is the one failure mode where the on-chain state ran ahead of the
repository state — the `concurrency: keeper` group exists to keep two runs from
racing into it.

---

## Manual run (local)

```bash
export KEEPER_PK=0x...            # testnet burner only
node contracts/keeper/update-nav.mjs
```

Add `KEEPER_ACK_MOVE=true` to bypass the sanity gate locally. Commit the
resulting `contracts/keeper/state.json` — an uncommitted local run desynchronises
CI (failure mode 5).

## Known limitations

- **Alerting depends on GitHub.** If Actions itself is down, no run happens and
  no alert fires. There is no external heartbeat monitor.
- **`contents: write` cannot be narrowed to one file.** As long as keeper state
  lives in `main`, the token can write anywhere in the repo. Moving state out of
  the repository, or to a bot branch merged after verification, is the long-term
  fix; it is not the current priority.
- **No paging.** Email and Slack are the channels. Nothing wakes anyone up,
  which is correct while the vault holds test assets and stale NAV is the worst
  outcome.

## Override log

| Date (UTC) | Move | Source | Reason | Operator |
| --- | --- | --- | --- | --- |
| — | — | — | no overrides to date | — |

## Alert-path drills

The alert path is only worth having if it has been fired at least once. To
re-drill: branch, replace the `Post NAV` step's command with `exit 1`, push, run
the workflow on that ref, then delete the branch. A successful run on `main`
closes whatever the drill opened.

| Date (UTC) | Result |
| --- | --- |
| 2026-07-22 | Full cycle verified — failure opened [#1](https://github.com/sungkuuu/quadrix/issues/1) with the keeper log attached; a second failure commented on the same issue instead of opening a new one; a successful run on `main` closed it automatically. |
