# BTC volatility index (working name) — two draft lines

**Status: the realized line (qVOL) starts with its inception decision
`2026-11-05-qvol-inception`: in force from the day that decision is anchored,
its first line dated 2026-11-06. Until the decision is in
`trackrecord/decisions.jsonl`, nothing is written to `trackrecord/` and
nothing is anchored.** Its rulebook is `rulebooks/qvol.md`; every value in
`keeper/rulebooks/qvol.json` is a definition or a measurement convention with
its citation in that rulebook's appendix P, and the one pre-registered test of
the line is of reproducibility (`docs/research/qvol/prereg-2026-10-13/`). The
name of the implied line is a working name; its series id `volbtc-implied` is
a neutral placeholder, and its values are not rules.

**The implied line is switched off until its own decision**
(`"active": false` in its rulebook): the keeper does not run it in any mode.
The realized line has no switch: it is in force only through its
`inception.date`.
Its code and tests stay. The realized line starts first (owner, 2026-11-02).

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
   read, nothing written. Otherwise `inception.decision` must be an id of the
   form `<YYYY-MM-DD>-qvol-inception` (a decision of another series never
   starts this one) and be in `trackrecord/decisions.jsonl` (the ledger the
   decision anchor appends to) effective on the date in its id; the decision
   file must still hash to the ledger's value and contain the sha256 of
   `keeper/rulebooks/qvol.json`, and the decision must be effective on the day
   before `inception.date`: the decision is effective on the day it is
   anchored, and the first line is dated the next UTC day. An id of another
   form, a decision not in the ledger yet, or a run before `inception.date`
   00:00 UTC, is NOT IN FORCE (exit 0, nothing written, no request). A
   decision in the ledger that the files no longer satisfy is refused (exit
   2), and so is any of these once the record has a line.
2. **The record as a whole**, once per run, before anything is sent or
   appended: `scripts/verify-vol.mjs` recomputes every line (seq, hash chain,
   dates, windows, values, the rule against the rulebook JSON); no line may be
   dated after the runner's clock, none may be a dry-run line, and only the
   first line carries this decision's `inception`. A failure is refused (exit
   2): nothing sent, appended or marked.
3. **The decision's own anchor.** A run that can anchor (it has the key) reads
   the decision's anchor transaction (the ledger's `txHash`): it must be on
   chain, successful, and a zero-value self-send from the signer whose
   calldata is `qxdec:` and the decision file's sha256, as
   `scripts/anchor-decision.mjs` sends it. Otherwise NOT IN FORCE, exit 1,
   nothing read from Binance, nothing written. A run without the key reads no
   chain: it writes lines unanchored, and the next run with the key checks the
   decision's anchor before it anchors anything.
4. **The anchors.** Every entry of `trackrecord/anchors-qvol.jsonl` must name a
   line of the record by seq, date and hash, and only the last lines may be
   unanchored (a run anchors them first, in order); anything else is refused
   (exit 2), nothing sent. A run that can anchor reads the last anchor's
   transaction again: one no longer on chain (dropped, as by a reorg) has its
   line anchored again first (and the anchor before it is read the same way);
   one sent by another key or carrying other calldata is refused (exit 2).
   A line without an anchor is anchored only after the record as a whole
   passed step 2 in this run and the bars it records are fetched again from
   Binance (the first line: every window day) and match it — the sha256 of
   their canonical text, the row count, the last bar and the close (other
   bars: exit 1, nothing sent). A line the keeper cannot confirm is never
   anchored with its key. A run without the key skips the decision's anchor
   (step 3), the reading of the last anchor and the fetch of an unanchored
   line's bars: it writes lines unanchored, and the run with the key makes
   these checks before it anchors them.
5. **Lines.** Before the first new line of a run, the bars of the last line's
   day are fetched again (one more fetch) and must match the line as above;
   other bars stop the run (exit 1, nothing written, the message names the day
   and both sha256). Then every closed UTC day since the last line, in order.
   The first line is dated `inception.date`; no day before it is ever
   written. Each line is the line a dry run builds from the same bars (same
   fields, same order, same values), without `shadow`, and the first line
   carries `inception: {decision, decisionSha256}`. Before it is written,
   Binance's daily candle of the newest window day (on the first line: of
   every window day, in one request) must close where the 1-minute bars close
   that day, compared as `String(Number(close))`; a difference or a missing
   candle stops the run (exit 1, nothing written). The pre-registered
   reproducibility test made the same comparison as part of its check V3:
   6,844 closes against the exchange's daily candles, 0 mismatches
   (`docs/research/qvol/prereg-2026-10-13/README-public.md`).
   `scripts/verify-vol.mjs` then recomputes the line
   (a mismatch: exit 1, nothing appended, anchored or marked). It is appended
   to `trackrecord/record-qvol.jsonl` and anchored on GIWA Sepolia like the
   other daily series: a zero-value transfer to the keeper's own address
   whose calldata is `qxpi-qvol:` and the line's hash, signed locally
   (`trackrecord/anchors-qvol.jsonl`). The keeper waits for each receipt at
   most 5 minutes (`RECEIPT_TIMEOUT_MS`): past it, exit 1, the line stays on
   disk without an anchor entry and the next run anchors it first (if the
   first transaction is mined later, the line has two anchor transactions
   with the same calldata; harmless — the anchors file names the later one).
   Line D is never written before D 00:00 UTC on the runner's clock; a source
   that still calls the day open a full day after that is a failure (exit 1).
   A day that earlier runs missed is written by a later run from the same
   closed bars and carries `"late": true`. Without `--anchor` or without the
   key, lines are written unanchored and the next run with the key anchors
   them first.
6. **The display vault** (`keeper/leverage-vaults.json`, entry `qvol`; deposit
   cap 0) is marked to the last line after that line is anchored, never
   before: share price n6 = floor(value x 1,000,000) in the contract's unit of
   1e-6 (the unrounded record value, cut; no decimal rounding), sent as
   `setNav(step, n6)` in steps inside the contract's bound of 25% per mark,
   each step read back (`keeper/marks-qvol.jsonl`). It marks only a vault
   whose registry entry's `deployTx` is the keeper's own contract creation of
   that address (in the entry's `block`), whose `symbol()` is the rulebook's
   ticker (qVOL), whose `keeper()` is the signer and whose `depositCap()` is 0
   (a display vault takes no deposits; a cap above 0 is refused: no mark,
   exit 1). No address or no mark method in the registry, no key, or an
   unanchored last line: no mark. The keeper sends that vault nothing but
   `setNav`, and `keeper/deploy-mark-vault.mjs` refuses `open-deposits` for
   `qvol` before any RPC call. A failed or refused mark leaves the line written
   and anchored and exits 1; the next run goes on from the vault's value
   (no step is sent twice).

Every transaction is signed by the keeper itself: its hash is computed from
the signed bytes, and the node's answer and the receipt must name that hash
(else exit 1, no anchor entry; the next run anchors the line again).

**What these checks cannot see.** The keeper checks the 1-minute bars against
the exchange's daily candle; if both reach the runner falsified to the same
close, the line is written and anchored with a wrong value, and only a
re-fetch of the bars from another network path (`scripts/verify.mjs
--refetch-bars --strict-source`) or another venue's prices reveals it.

**Halts and how the series resumes.** Each stop below leaves the record as it
was; the message names what stopped. Two of them can be passed once a person
confirms what they found, in `keeper/vol-index-source-checks.json` (absent
until needed; a public commit, so an owner confirmation, like the gap
acceptance file). The halt prints the entry to add; the person adds an `id`,
a `note` and `confirmedAt`. An entry is used only when every value in it
matches what the run reads, and never makes the keeper anchor a line it did
not write. Every use of the file is a commit in this public repository, and
that commit is the only trace: the line written after it carries no mark of
the entry. A reader who checks a line therefore reads the history of
`keeper/vol-index-source-checks.json` too.

| Halt (exit) | What a person checks | How the series resumes |
|---|---|---|
| `SOURCE CHANGED — line #N D was built from the bars of <day> (…, canonical text sha256 A), but the source now serves (…, sha256 B) — … The line is anchored …` (1) | fetch the day from `data-api.binance.vision` and compare its canonical text with the line's `source` | if Binance changed the day after the line was written: the printed entry `{series, day, check: "refetch", recorded: A, served: B}` goes into the file and the next run continues; the line stays as written |
| `SOURCE CHANGED — … — #N has no anchor and is not anchored …` (1), or `the bars still hash to the line's sha256 but the line holds another row count, close or last bar` (1) | who committed the line; whether Binance ever served those bars | a line the source does not confirm is removed (with every line after it) by a commit; the next run writes those days again from Binance (`late`) |
| `DAILY CLOSE DIFFERS — the 1-minute bars close <day> at X, Binance's daily candle closes it at Y` (1) | both at the source (`interval=1m` and `interval=1d`) | if the 1-minute bars are right: the printed entry `{series, day, check: "daily-close", minuteClose: X, dailyClose: Y}` goes into the file and the next run writes the line from the 1-minute bars, as the definition says; otherwise the series waits |
| `the record does not verify: …` (2) | the repository's history of `trackrecord/record-qvol.jsonl` | the file is restored from history (an anchored line is never edited or removed; a line that is not anchored and not the keeper's is removed by a commit); the next run continues |
| `line #N has no anchor …, but line #M after it has one`, `the anchor of #N … names … but line #N is … — the line changed after it was anchored`, `… names an anchor of #N …, a line the record does not hold` (2) | the history of the record and of `trackrecord/anchors-qvol.jsonl` | both files are restored from history; the next run continues |
| `the anchor of #N D in trackrecord/anchors-qvol.jsonl (tx) … — it is not the keeper's anchor of that line` (2) | who wrote that entry; the transaction on the explorer | the anchors file is restored from history; the next run continues |
| `NOT IN FORCE: inception.decision "…" is not an inception decision of this series` (0 before the first line, 2 after) | the rulebook's `inception.decision` | the inception commit is corrected: the rulebook names the series' own anchored decision |
| `decision … is effective from X in the ledger, not on the date in its id` (2) | the history of `trackrecord/decisions.jsonl` (the decision anchor writes `effectiveFrom` from the id) | the ledger is restored from history |
| `NOT IN FORCE: the inception decision … is in trackrecord/decisions.jsonl, but its anchor transaction … is not on chain / was sent by … / is not a self-send / does not carry qxdec:… / did not succeed` (1) | the transaction on the explorer; the history of the ledger | a ledger line without its anchor is removed and the decision is anchored with `scripts/anchor-decision.mjs`; nothing was written meanwhile |
| `the anchor of #N D (0x…) is not on chain any more (dropped, as by a reorg) — #N is anchored again` (0; not a halt) | the old and the new transaction on the explorer | the keeper has anchored the line again; the old entry stays in the anchors file and fails every reader's `--rpc` check until a person removes it in a dated commit (`keeper/RUNBOOK.md`, "A dropped anchor") |
| `the chain failed while reading …` (1) | the GIWA endpoint | nothing to do: the next run reads it again |
| `line #N D is written but its anchor failed: no receipt for … within 300 s` (1); `vault marks FAILED … no receipt for setNav step k/n … within 300 s` (1) | the transaction on the explorer | nothing to do: the next run anchors the line again first / goes on from the vault's value |
| `vault marks FAILED … REFUSED: keeper/leverage-vaults.json qvol names …, but its deployTx …` (1) | the entry against `keeper/mark-vaults.jsonl` and the explorer | the entry is corrected to the keeper's own deployment (a public commit); the next run marks |

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
#   --daily <file>    Binance daily candles (the JSON array GET /api/v3/klines?interval=1d answers, .gz allowed):
#                     each new line's window closes are compared with them, as the line in force compares
#                     them with Binance's; without it a dry run reads no daily candle

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
is written, and the next run anchors it first) — among them a day read again
that differs from its line, a daily candle that differs from the 1-minute
close, a decision whose anchor transaction is not the signer's, and a receipt
that does not come within 5 minutes — or a mark that failed or was refused
after the line was written and anchored; 2 = configuration or a record that
is not what the keeper wrote (bad option, bad rulebook, bad acceptance or
source-check file, an anchored inception decision that the files no longer
satisfy, a record that does not verify as a whole, an unanchored line before
an anchored one, an anchor entry that does not name its line or is not the
keeper's anchor). The halts and how the series resumes after each: "The
realized line in force", above. A dry run that continues a record first
reads the last line's day again (its offline file, or one more fetch) and
stops (exit 1, nothing written) when the bars are not those the line
records. Retries: at most 3 attempts per call, 2 s then
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
The tests named "in force T-IF1" … "T-IF27" in `keeper/test/vol-index.test.mjs`
run the in-force path against a stand-in decision in a scratch ledger, a fake
Binance and a fake GIWA node, with a key generated by the test; T-IF14 to
T-IF16 run its fork rehearsal against the same fake node standing in for a
fork that holds the `--from` account unlocked. T-IF17 to T-IF25 test the
checks added after the red-team run of 2026-11-04 (each case beside a control
that passes), T-IF26 and T-IF27 two idempotency cases (an anchor whose
receipt answer was lost; a mark that failed part-way). Tests that describe
the state before the inception decision run from a scratch root with the
rulebook's inception null, so they hold before and after the decision.

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
