# BTC volatility index (working name) — two draft lines

**Status: draft. Not in force. Nothing is written to `trackrecord/`, nothing
is anchored, and no number here is a rule yet.** The name is a working name.
The realized line's id and series id are `qvol`; the implied line's series id
`volbtc-implied` is a neutral placeholder.
Every number in `keeper/rulebooks/qvol.json` and
`keeper/rulebooks/volbtc-implied.json` is proposed as a measurement
convention and the classification has not been confirmed. None of these
values has been through a pre-registered test.

**The implied line is switched off until its own decision**
(`"active": false` in its rulebook): the keeper does not run it in any mode.
The realized line has no switch: it is in force only through its
`inception.date`.
Its code and tests stay. Whether the realized line starts first is open.

The keeper has the realized line's in-force path ("The realized line in
force", below). It does nothing until the line's inception decision is
anchored: with `inception` null in `keeper/rulebooks/qvol.json` every run
prints NOT IN FORCE and exits 0.

## What it is

Two numbers, one line each per UTC day, both in annualised volatility points
(sigma x 100; 40 means 40% a year):

- **Realized** (`qvol`): how much BTC actually moved over the last
  30 days, from daily closes.
- **Implied** (`volbtc-implied`): how much movement over the next 30 days the
  listed BTC option quotes price in, at one moment of the day.

They are different numbers from different inputs. There is no reason for
them to agree.

## What it is not

- It holds nothing. It is not a vault: no assets, no deposits, no redemptions.
  Once in force, a testnet display vault shows the realized value as its
  share price; that vault takes no deposits (deposit cap 0) and holds nothing.
- It cannot be bought. Holding something that follows this number takes
  derivatives, and that is not this index.
- It has no fee and no return. A higher level is nobody's gain. There is no
  "100 at inception": the value is the volatility level of the day.
- It is not a forecast. The implied line summarises quotes at one moment.
- It is not a copy of an exchange's own volatility index. The implied line
  uses the same family of formula as such indices but not the same inputs,
  smoothing or cut-offs, so the values differ.
- The implied line has no past. Past option books cannot be fetched again from
  a public source, so the line only grows forward from its first day. A missed
  day stays missing.

## Rulebooks and the switch

Each line has its own rulebook JSON: `keeper/rulebooks/qvol.json`
(`"id": "qvol"`, `"series": "qvol"`, `"line": "realized"`) and
`keeper/rulebooks/volbtc-implied.json` (`"id": "volbtc"`, `"line": "implied"`).
The `rule` of every line
carries the sha256 of its own line's file, so a later change to one line's
file (switching it on, its inception) does not change the other line's rule
and does not stop its record.

- `active` (`true` | `false`, implied line only): the switch. With `false`
  every run of that line — without `--dry-run`, with `--dry-run`, with
  `--collect-only` — prints `INACTIVE` and exits 0: no network call, nothing
  written. A line with `false` cannot carry an inception date. The realized
  rulebook has no `active` key; a realized rulebook with one is refused.
- `inception`: `{date, decision}`; `null` = not in force. For the realized
  line this is the only thing that decides whether it is in force.
- `display.decimals`: the number of decimals the page shows. A display value
  only: the keeper and the verifier never read it for a line.
- `pendingOwner`: `[{path, what}]` — the keys of this file whose value waits
  for the owner, with one sentence each. Every `path` must name a key of the
  file. A line with an inception date must have this list empty.

## Definition

### Realized

```text
C_d       = close of UTC day d = close of the Binance spot BTCUSDT 1-minute
            bar that opened latest that day (d 00:00 <= open < d+1 00:00;
            normally the 23:59 bar)
r_d       = ln(C_d / C_{d-1})
variance  = (365 / 30) x sum of r_d^2, d = D-30 … D-1   (30 returns, 31 closes)
value(D)  = 100 x sqrt(variance)   (recorded as computed, not rounded)
```

- The line dated D stands at 00:00 UTC of D and covers UTC days D-30 … D-1.
- The mean return is taken as zero. The denominator is always 30.
- Evaluation order in binary64: `C = Number(close)`; `r = ln(C / Cprev)`;
  `S = S + r * r` in ascending date order; `variance = (365 / 30) * S`;
  `x = 100 * Math.sqrt(variance)`; `value = x`. The line records x as the
  binary64 number it is (JSON as `JSON.stringify` writes it): no decimal
  rounding anywhere in the record. The page shows the value to two decimals;
  that display never feeds the record.
- A day must have 1,440 one-minute bars. Otherwise no line is written and the
  run stops (later days wait too). A day is computed only after a person has
  confirmed the gap in the acceptance file (below). With an accepted gap the
  close is the close of the latest 1-minute bar of that day. A UTC day with no bar at all has no
  close (`null` in the line's window); for the computation its close is the
  previous close, so that day's return is 0 and the next return spans both
  days. If the first close of a window is null, the nearest earlier close is
  used and written as `carriedFrom`.
- Only closed bars count (`closeTime` before Binance's server time). Day D-1
  is over once the first 1-minute bar opening at or after D 00:00 is closed
  (normally the 00:00 bar; if that minute is missing, the next bar). With
  `--offline` the same test reads the files: D-1's file exists, and D's file
  has a line, or D's file is empty and the first later file with a line comes
  before any missing file (at most 31 days on). Each day is fetched twice and
  the two canonical texts must match (not with `--offline`).
- No other exchange or price source stands in for Binance.

### Implied

Model-free 30-day variance from listed option quotes (the variance-swap
replication). The formula, the minutes-to-expiry convention, the forward and
K0 rule, the strike selection, dK and the constant-maturity interpolation
follow Cboe's public methodology document for its volatility index
("Cboe Volatility Index Mathematics Methodology"). Inputs are Deribit's two
public calls for BTC options, which are quoted and settled in BTC:

1. `get_instruments?currency=BTC&kind=option&expired=false` first, then
   `get_book_summary_by_currency?currency=BTC&kind=option`. The snapshot time
   is the second answer's `usOut` (microseconds). Only instruments present in
   both answers are used.
2. Minutes to an expiry: `M = floor((expiration_ms * 1000 - usOut) / 60,000,000)`,
   integer microseconds, floored once. Only M >= 1.
3. Near term = the furthest expiry with M <= 43,200; next term = the nearest
   with M > 43,200. If either is missing: no value (`no-bracket`).
4. Strike ladder of a term = strikes with both a call and a put, ascending.
5. A quote is valid when bid > 0 and ask > bid; a missing bid or ask is
   invalid. Price = (bid + ask) / 2, in BTC.
6. K* = the ladder strike with valid call and put and the smallest |c - p|
   (tie: the lower strike). Forward `F = K* / (1 - (c* - p*))` — the put-call
   relation for premiums paid in the underlying; no rate input, the rate is
   inside F. If `1 - (c* - p*) <= 0` there is no forward and no value
   (`k0-quote-invalid`). K0 = the highest ladder strike <= F; its call and put
   must be valid.
7. Puts below K0 walking down and calls above K0 walking up; invalid quotes
   are skipped, and two invalid quotes in a row end the walk. At K0 the price
   is the mean of call and put.
8. Per term, with `T = M / 525,600` and the dollar value at expiry of a BTC
   premium `Q~ = q x F`:
   `sigma^2 = (2 / T) x sum (dK / K^2) x Q~ - (1 / T) x (F / K0 - 1)^2`,
   summed in ascending strike order; dK is half the distance between the
   neighbours, or the distance to the one neighbour at either end.
   Evaluation order in binary64: `q = (bid + ask) / 2` (at K0, the mean of the
   call's and the put's q); `Q~ = q * F`; each term `(dK / (K * K)) * Q~`,
   added from 0 in ascending strike order; `x = F / K0 - 1`;
   `sigma^2 = (2 / T) * sum - (1 / T) * (x * x)`.
9. `V30 = [T1 s1 (M2 - 43200) / (M2 - M1) + T2 s2 (43200 - M1) / (M2 - M1)] x 525600 / 43200`;
   value = 100 x sqrt(V30), two decimals, half up.

When a value cannot be computed the line is still written, with
`value: null` and a reason: `no-bracket`, `no-atm-pair`, `k0-quote-invalid`,
`no-otm-puts`, `no-otm-calls`, `non-positive-variance`. The previous value is
never repeated. Differences from the Cboe document: a term is chosen by
minutes, not days; with no expiry at or under 30 days there is no value
(Cboe would use the nearest); every listed expiry is a candidate; a quote with
ask <= bid is counted as invalid in the walk.

## The realized line in force

The daily paper-index workflow runs `node keeper/vol-index.mjs --line realized
--anchor` with the keeper key, on node v22.23.1 (the runtime of the registered
reproducibility test; the step checks `node --version` and stops on any other).
One run:

1. **In force?** With `inception` null: NOT IN FORCE, exit 0, nothing else
   read, nothing written. Otherwise `inception.decision` must be in
   `trackrecord/decisions.jsonl` (the ledger the decision anchor appends to),
   the decision file must still hash to the ledger's value and contain the
   sha256 of `keeper/rulebooks/qvol.json`, and the decision must be effective
   on the day before `inception.date`: the decision is effective on the day it
   is anchored, and the first line is dated the next UTC day. A decision not
   in the ledger yet, or a run before `inception.date` 00:00 UTC, is NOT IN
   FORCE (exit 0, nothing written, no request). A decision in the ledger that
   the files no longer satisfy is refused (exit 2), and so is any of these once
   the record has a line.
2. A line that an earlier run wrote but did not anchor is anchored first.
3. **Lines.** Every closed UTC day since the last line, in order. The first
   line is dated `inception.date`; no day before it is ever written. Each line
   is the line a dry run builds from the same bars (same fields, same order,
   same values), without `shadow`, and the first line carries
   `inception: {decision, decisionSha256}`. `scripts/verify-vol.mjs`
   recomputes it before it is appended (a mismatch: exit 1, nothing appended,
   anchored or marked). It is appended to `trackrecord/record-qvol.jsonl` and
   anchored on GIWA Sepolia like the other daily series: a zero-value
   transfer to the keeper's own address whose calldata is `qxpi-qvol:` and the
   line's hash, signed locally (`trackrecord/anchors-qvol.jsonl`). Line D is
   never written before D 00:00 UTC on the runner's clock; a source that
   still calls the day open a full day after that is a failure (exit 1). A
   day that earlier runs missed is written by a later run from the same
   closed bars and carries `"late": true`. Without `--anchor` or without the
   key, lines are written unanchored and the next run with the key anchors
   them first.
4. **The display vault** (`keeper/leverage-vaults.json`, entry `qvol`; deposit
   cap 0) is marked to the last line after that line is anchored, never
   before: share price n6 = floor(value x 1,000,000) in the contract's unit of
   1e-6 (the unrounded record value, cut; no decimal rounding), sent as
   `setNav(step, n6)` in steps inside the contract's bound of 25% per mark,
   each step read back (`keeper/marks-qvol.jsonl`). It marks only a vault
   whose `symbol()` is the rulebook's ticker (qVOL), whose `keeper()` is the
   signer and whose `depositCap()` is 0 (a display vault takes no deposits; a
   cap above 0 is refused: no mark, exit 1). No address or no mark method in
   the registry, no key, or an unanchored last line: no mark. The keeper sends that vault nothing but
   `setNav`, and `keeper/deploy-mark-vault.mjs` refuses `open-deposits` for
   `qvol` before any RPC call. A failed mark leaves the line written and
   anchored and exits 1.

A dry run never reads a key, never anchors and never marks, and loads no
chain library: `--anchor` is refused with `--dry-run`.

**Fork rehearsal.** `node keeper/vol-index.mjs --line realized --anchor --rpc
http://127.0.0.1:8599 --from 0x…` runs the same in-force path against a local
anvil fork of GIWA Sepolia, signed by the account `--from` that the fork holds
unlocked (`eth_sendTransaction` to `--rpc`; `KEEPER_PK` is not read). The
record, the anchors, the marks and the vault registry are read and written
under `keeper/dryrun/` (the registry that `keeper/deploy-mark-vault.mjs` writes
on a fork); the decision ledger, the rulebook JSON and the gap file are read
where the line in force reads them, and nothing under `trackrecord/` is
written. `--rpc` must name 127.0.0.1, localhost or [::1]; `--rpc` or `--from`
alone, with `--dry-run`, with `--line implied` or under GitHub Actions is
refused (exit 2) before anything is read. Each step prints its result: the
decision, each line and its recompute by `scripts/verify-vol.mjs`, each
anchor, each mark step. `keeper/test/rehearse-qvol.mjs` drives it on a fork, in
temporary copies of this repository that hold a stand-in inception decision:
the display vault's deployment, yesterday's and today's lines with their
anchors and marks, the refusals, and the freshness watchdog on the copy's
record.

**Checking the published record:** `node scripts/verify.mjs --dir ./trackrecord
--series qvol` (add `--recompute-only` to skip the RPC). It runs
`scripts/verify-vol.mjs` on the record (keep the two files side by side: the
recompute is that script's code, not repeated in `verify.mjs`), checks that
every line's rule is the rulebook JSON's, that the first line names its
anchored inception decision, effective the day before the first line and
containing the rulebook JSON's sha256, that no line is a dry-run line, and,
with the RPC, every anchor's calldata and block time. The freshness watchdog
(`scripts/watchdog-series.mjs`) reports the series missing 16 hours after its
first line's day began, stale 40 hours after the last line's day began, and
any line without an anchor.

## Line formats

Both files are hash-chained like the other series:
`hash = sha256(JSON.stringify(line without hash))`, `prevHash` = the previous
line's hash (null on the first). The key order is fixed; the hash depends on
it. No state file: the last line is the state.

`record-qvol.jsonl` (`index` = `"qvol"`):
`seq, date, observedAt, index, value, variance, late?, window, carriedFrom?,
returns, source, sources? (first line only), gaps?, gapAccepted?, rule, keeper,
shadow?, inception?, prevHash, hash`.
`window` always holds the 31 closes D-31 … D-1 (`[date, close | null]`).
`carriedFrom` (only when the first close is null): on the first line
`[date, close, rows, sha256]` of the carried day, plus the acceptance id when
that day has fewer than 1,440 bars; on later lines `[date, close]`, taken from
the previous line. `returns` counts the days D-30 … D-1 that have their own
close. `source` names day D-1's input: host, symbol, interval, day, rows, the
sha256 of its canonical 1-minute text (one line per minute,
`${openTimeMs},${String(Number(o))},${String(Number(h))},${String(Number(l))},${String(Number(c))}\n`),
`lastBar` (the open time "HH:MM" of the day's latest 1-minute bar, null for a day with no bar), `finalBy`, `fetchedAt` (null with `--offline`), and
`via: "offline"` last when the bars came from `--offline` files. `sources`
(first line only) = one entry per window day, `[date, rows, sha256]`, plus the
acceptance id when the day has fewer than 1,440 bars.

`record-volbtc-implied.jsonl`:
`seq, date, observedAt, index, value, variance30, reason?, snapshot, terms,
quotes | quotesSha256, rule, keeper, shadow?, inception?, prevHash, hash`.
`snapshot` = time, `usOut`, host, row count, `expiries` (every expiry of the
instruments present in both answers, ascending, ISO) and the sha256 of both
raw answers. `terms` = per term: role, expiry, minutes, atm (K*), forward, k0,
putsUsed, callsUsed, variance, and the exchange's underlying price for that
expiry as a diagnostic (`exchangeForward`, not used in the value). `quotes` =
every instrument of the two terms as `[role, strike, "C" | "P", bid, ask]`,
near first, strike ascending, C before P. From the line alone anyone can
re-make the expiry choice (`expiries` + `usOut`) and recompute every field of
`terms`, `value`, `variance30` and `reason` (`quotes`). The line cannot show
that the quotes were the exchange's quotes at that moment, or that no
instrument of the two expiries is missing. Whether the quotes themselves are
published is open (terms of use not checked); `--quotes hash` writes
`quotesSha256 = sha256(JSON.stringify(quotes))` instead and leaves out
`exchangeForward` (`expiries` stays).

## Running it

```bash
# the daily step (KEEPER_PK in the environment); while not in force it prints
# NOT IN FORCE, exits 0, reads and writes nothing
node keeper/vol-index.mjs --line realized --anchor

# its fork rehearsal (a local anvil fork of GIWA Sepolia; writes keeper/dryrun/ only)
node keeper/vol-index.mjs --line realized --anchor --rpc http://127.0.0.1:8599 --from 0x<account unlocked on the fork>

# realized dry run over a past window (lines go under --out, each with "shadow": true)
node keeper/vol-index.mjs --line realized --dry-run --replay 2019-03-04..2019-03-31 --out keeper/dryrun
#   --offline <dir>   bars from <dir>/btcusdt-1m-<YYYY-MM-DD>.csv ("openTimeMs,open,high,low,close", no header)
#   --gaps <file>     another gap acceptance file (dry run only)

# implied (runs only while volbtc-implied.json has "active": true; now it prints INACTIVE):
# save the two raw answers (gz) and a manifest line; computes nothing
node keeper/vol-index.mjs --line implied --collect-only --out <dir>
# implied dry run from saved answers
node keeper/vol-index.mjs --line implied --dry-run --from-snapshot <book.json.gz> --instruments <inst.json.gz> --out keeper/dryrun

# independent recomputation of every field (does not import keeper/)
node scripts/verify-vol.mjs --dir keeper/dryrun
#   --rulebook keeper/rulebooks/qvol.json   also check that line's rule against its rulebook JSON
#                                           (once per line; the file's "line" key says which)
```

Exit codes: 0 = done, nothing to do, not in force, or inactive (implied); 1 = data or
chain failure (nothing written for the failed day; a line whose anchor failed
is written, and the next run anchors it first), or a mark that failed after
the line was written and anchored; 2 = configuration (bad option, bad
rulebook, bad acceptance file, an anchored inception decision that the files
no longer satisfy). Retries: at most 3 attempts per call, 2 s then
4 s apart, on a network error, a time-out (30 s per attempt), HTTP 429 or 5xx;
Binance calls at least 250 ms apart. The verifier recomputes the realized
`variance` and `value` from the window and accepts each within a relative
1e-9. Before a line is appended the keeper runs
`scripts/verify-vol.mjs --recompute-only --rulebook <the rulebook it read>` on
it in a child process and discards the line if that fails. A new line is
checked after the record's last line (`--tail`); the first line on its own.

**Gap acceptance file** (`keeper/vol-index-gaps.json`, empty): entries
`{id, series: "qvol", day, sha256, missing: [{from, to, minutes}], note, confirmedAt}`.
A day with fewer than 1,440 bars is computed only when its re-fetched
canonical text has exactly that sha256. A stopped run prints the day's row
count and sha256. Entries in this repository need the owner's confirmation.

Tests (no network, Node built-ins only, synthetic data only):
`node --test keeper/test/vol-*.test.mjs`. `keeper/test/vol-checks.test.mjs`
holds the checks C1, C7 and C9–C13 of the reproducibility test on synthetic
input; C8 is an empty number (the definition has no rounding, so there is no
rounding check). C1: closes moving ±x every day (x = ln 1.01) give
100 x sqrt(365) x x within a relative 1e-9. With `VOL_CHECK_DIR` naming a
folder that holds `record-qvol.jsonl`, C7, C11, C12 and C13 also run on that
record; without it that test is skipped. Two tests need private inputs and
are skipped without `VOL_FIXTURE_DIR`; no market data, no other firm's index
values and no table copied from a methodology document are committed here.
The tests named "in force T-IF1" … "T-IF16" in `keeper/test/vol-index.test.mjs`
run the in-force path against a stand-in decision in a scratch ledger, a fake
Binance and a fake GIWA node, with a key generated by the test; T-IF14 to
T-IF16 run its fork rehearsal against the same fake node standing in for a
fork that holds the `--from` account unlocked.

## Later wiring (not done in this build)

Done for the realized line: the in-force path of `keeper/vol-index.mjs`
(the decision check, the anchor and the display vault's mark, above), its
step in `.github/workflows/paper-index.yml` (node v22.23.1; the record, anchor
and mark files in `git add`, the failure alert), the registry entry `qvol`,
the `keeper/deploy-mark-vault.mjs` target `qvol`, the series `qvol` in
`scripts/verify.mjs` (recomputed by `scripts/verify-vol.mjs` as a child
process), the freshness watchdog and its section in `keeper/RUNBOOK.md`. The
rows below are what is not done.
To become daily series these existing files change, after the files they
share with other work have settled; the verifier first, an inception line
last:

| File | Change |
|---|---|
| `scripts/verify.mjs` | the implied series (missing days allowed and counted) |
| `keeper/vol-realized.mjs` and the other keeper that reads Binance 1-minute bars | one shared module for the bar functions (parsing klines, the canonical 1-minute text, the day-end test), so the same day gives the same sha256 by construction rather than by two copies of the same code |
| `keeper/vol-index.mjs` | the implied line's in-force path (decision check, anchor) |
| `.github/workflows/paper-index.yml` | the implied step; whether its snapshot runs early in the daily job |
| `scripts/watchdog-series.mjs` | freshness of the implied series |
| `keeper/RUNBOOK.md`, `docs/paper-index.md`, `README.md` | the implied series and its failure states (Deribit down, cannot compute); the realized line in `docs/paper-index.md` and `README.md` |
| `rulebooks/qvol.md` (realized line), a rulebook of its own for the implied line, `rulebooks/README.md` | the public rulebooks and their list entries |
| `trackrecord/decisions/` | one inception decision per line |

Open before any wiring: the classification of every number, the
pre-registered reproducibility test and its result, whether the option
quotes are published in the line, and the implied line's name; the keys
that wait for the owner are listed in each rulebook's `pendingOwner`. The two
rulebook JSON files hold numbers that cite no test.
