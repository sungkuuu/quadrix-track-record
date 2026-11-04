# qVOL realized line — paper record and testnet display vault, 2026-11-05

**Effective:** 2026-11-05 (UTC), the day this decision is anchored; the first line is dated the next UTC day, 2026-11-06. **Series:** `trackrecord/record-qvol.jsonl`,
anchors `trackrecord/anchors-qvol.jsonl`, calldata prefix `qxpi-qvol:`. **Vault registry:**
`keeper/leverage-vaults.json`, entry `qvol`.

## What starts today

Two things start under this one decision.

1. **The paper record of the qVOL realized line.** qVOL (series id `qvol`) is a measurement: the
   annualised volatility of bitcoin over the 30 UTC days before 00:00 UTC of a line's date, from daily
   close-to-close returns, in volatility points (σ × 100; 40 means 40% a year). It is computed from closed
   Binance spot BTCUSDT one-minute bars, with no fallback source, by the keeper
   `keeper/vol-index.mjs --line realized`. One line per UTC day, written once the day has ended,
   recomputed by `scripts/verify-vol.mjs` before it is appended and by `scripts/verify.mjs`, hash-chained
   and anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send — the same mechanism as the
   other records. Append-only. The first line is dated 2026-11-06 and is written by the scheduled daily run of
   that day (scheduled 00:25 UTC), never before 2026-11-06 00:00 UTC. There is no starting level of 100: the value of a line is the measured
   volatility itself.
2. **A testnet display vault.** A `QuadrixIndexVault` on GIWA Sepolia, deployed on 2026-11-05 after this
   decision is anchored, has its share price marked to the qVOL value once a day, after the day's line is
   anchored, by the keeper's daily run. **It displays the level; nothing is held; it cannot be bought.** It
   takes no deposits: its deposit cap is 0, the contract refuses every deposit while the cap is 0, and no
   share exists to redeem. This decision fixes the vault's deployment parameters (below), not its address.

What this record is not: nothing is held, there is no return, there is no fee, and the value is not a
forecast. Holding the value itself is not possible; following it needs derivatives, which are not this
record. The implied line of the same measurement is not part of this decision. Values for days before the
first line are not part of the record: a value recomputed from past bars is a recomputation, not a line
written at the time.

## The rules in force (pinned)

The rulebook is `rulebooks/qvol.md` at commit `f2f719753dc43ccf67b07b3882ddd26399c5364f` of this repository (sha256
`d370e537e0f4db8976c4be06a06226636c457229b1b7f6b53313d0ff719ea3ea`), as implemented in `keeper/rulebooks/qvol.json` (sha256 `7e4d6e38f346fee0f3deb04935b4ef6c93213f1841d0c44656d722cc888a44e8`) and the calculation files of
the registered implementation, each pinned below. In one paragraph:

The close of UTC day d is the close of the latest one-minute bar that opened on that day (at or after
d 00:00 and before d+1 00:00 UTC). The return of day d is ln(C_d ÷ C_{d−1}). The line dated D uses the
31 closes of days D−31 … D−1 and their 30 returns; its variance is (365 ÷ 30) × the sum of the squared
returns, with no mean subtracted; its value is 100 × √variance, recorded as computed, with no decimal rounding;
the page shows it to two decimals (an operating value, appendix O). All arithmetic is IEEE 754 binary64, in the
order of the rulebook. A line is written only after the first one-minute bar opened at or after D 00:00
UTC has closed. A day with other than 1,440 one-minute bars halts the series until a person accepts that
exact set of bars (by its sha256); bars are never filled. On an accepted day with no bar at all, that
day's close is the previous close (its return is 0) and the divisor 30 and the year of 365 stay as they
are.

## The vault at deployment

The vault is deployed after this decision is anchored, on the same day. Its address, deployment
transaction and block are therefore not in this decision: the deploying workflow `mark-vault-setup` writes
them into `keeper/leverage-vaults.json`, entry `qvol`, and into its deployment log
`keeper/mark-vaults.jsonl`, and the values read back after deployment are recorded in the dated checklist
run record of the deployment day. This differs from the qETH1.5X mark vault, which was deployed before its
decision was anchored (decision `2026-10-22-qeth15-mark-vault`): here the owner confirms once, the anchored
text and its sha256 must be final at that confirmation, so this decision fixes the parameters, not the address.

- Contract: `QuadrixIndexVault`, the contract of the testnet vaults redeployed on 2026-10-21 (decision
  `2026-10-21-testnet-vaults-redeployment`), the same code as the qBTC2X and qETH1.5X mark vaults; that
  contract's comments describe qX20.
- Deployed by `keeper/deploy-mark-vault.mjs` (sha256 `ff2f65ad0e4eda534d032d3702a7388c3087271fe3cb162e8100f905382cafdc`) through the workflow `mark-vault-setup`,
  from the artifact `keeper/artifacts/QuadrixIndexVault.json` (sha256 `c32bb1b1ff3ec7858cce1a6ababc073290b58ede04c17292a9b2fff56666edeb`), on chain GIWA Sepolia (chain id 91342). The tool refuses unless
  the artifact has the code shape of the qBTC2X mark vault named in the registry, it refuses to raise
  the deposit cap of this vault (`open-deposits` is refused for `qvol` before any request), and it writes the address into the
  registry only after it has read back the deployment.
- Constructor: test dollar `0xf70B2b744eE604728D661b7D07460843DBD1be76`, name `Quadrix BTC Realized Volatility Vault`, symbol `qVOL`
  (the rulebook JSON's ticker; see the launch conditions under Marks), deposit cap 0,
  manager `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`, the keeper key (owner and keeper).
- Then, in a second transaction, `setGuardian(0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3)`.
- The read-back to be recorded: runtime code hash equal to that of the qBTC2X mark vault
  `0x8b0200B7e920a7fB06e94890d5Efb6aB7d2C1378`, share price 1.000000, supply 0, deposit cap 0, owner = keeper = `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`,
  pending owner 0, guardian `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3` (≠ 0, ≠ keeper, ≠ owner).
- The registry entry `qvol` before deployment: chain 91342, mark method `{"mode":"step"}`, no address,
  deployment transaction or block (`keeper/leverage-vaults.json`, sha256 `29f66da152629e94ce9a6d757b3841e62ef450f8142626ea799791b08879cb5f`).

**Unit.** The share price `navPerShare` has 6 decimals. Share price = qVOL value, cut to the contract's own unit:
the mark is `navPerShare = n6 = floor(x × 1,000,000)`, where x is the unrounded record value — a truncation to
the contract's 1e-6 unit (it rounds down); the keeper has no two-decimal rounding and no half-way rule. The page's two-decimal display is a presentation of the record value
and never feeds the record or the vault. The `indexLevel` the mark echoes in its `NavUpdated` event
is the same number.

## Order

1. After the reproducibility verdict passed (appendix A of the rulebook): the final review of this decision,
   then the owner's go-ahead, given once for all of the steps below.
2. Before it, on a GIWA Sepolia fork, the keeper's rehearsal at commit `fc89e887e6a3d15f1804adf71b1b0f9e5ee8b0c6`
   (fork block 40430399): the deployment with its guardian; two lines written, recomputed, anchored and
   marked (16 steps from 1.000000, then one); the refusals — a deposit cap above 0, a decision missing or
   not anchored, `open-deposits`, a registry entry naming another vault; the watchdog — 27 of 27 checks
   passed (`docs/research/qvol/evidence/fork-rehearsal-2026-11-04.txt`, sha256
   `1a41dad731693f951a2ee7eb2a84a3ecf4ff5528c84de041066d67c0c8522ad5`). The keeper files have not changed since that commit.
3. 2026-11-05: this decision is anchored. Until it is in `trackrecord/decisions.jsonl` and pins
   `keeper/rulebooks/qvol.json`, the daily leg writes nothing and exits 0 (NOT IN FORCE).
4. 2026-11-05, after (3): the deployment above (deposit cap 0) and its read-back, through `mark-vault-setup`
   on main. The workflow writes the address, transaction and block into the registry entry `qvol`, whose
   mark method is `{"mode":"step"}`.
5. 2026-11-06, the scheduled daily run (cron 00:25 UTC): the first line, dated 2026-11-06, is written and
   anchored; then the first mark moves the share price from 1.000000 to n6 ÷ 1,000,000 (that line's value cut
   to the contract's unit) in steps within the contract's bound per mark — 16 steps for a value between
   28.421692 and 35.527113, each step 1.25 times the last, cut. If the registry has no address yet, the run
   writes and anchors the line and skips the mark (exit 0), and the next run marks. The anchor
   transaction is in `trackrecord/anchors-qvol.jsonl`, the mark steps in `keeper/marks-qvol.jsonl`, and a
   person compares the vault's share price with that line and records it in a later dated checklist run
   record of this product.
6. After the first mark: the keeper key, still the vault's owner, proposes the timelock of the redeployed vaults,
   `0xC387f483A4a38C58c746b476340Be7F52b69090A`, as the vault's owner, and the timelock's proposer — a hardware key held by the owner —
   schedules the acceptance. The timelock can accept 72 hours after the scheduling transaction, as for the
   qETH1.5X mark vault (decision `2026-10-22-qeth15-mark-vault`; its handover date was corrected by
   `2026-10-23-qeth15-handover-date-note`). The timelock and its 72-hour delay are those of decision
   `2026-10-21-testnet-vaults-redeployment`. These transactions come after this anchor;
   they are recorded in a later dated checklist run record of this product.

## Operations: the keeper's checks and how the series resumes

Before it writes, the keeper checks its source twice, with one exchange: before a new line it fetches the
last line's day again, and before line D it compares Binance's daily candle of D−1 with the close of the
one-minute bars. A difference stops the run with nothing written, anchored or marked (exit 1). The message
names what differed — `SOURCE CHANGED — line #N D was built from the bars of <day> (… sha256 A), but the
source now serves (… sha256 B)`, or `DAILY CLOSE DIFFERS — the 1-minute bars close <day> at X, Binance's daily
candle closes it at Y` — and prints the entry a person may add. A person checks the day at the source
(`interval=1m` and `interval=1d`). If Binance changed an anchored line's day after the line was written, or
if the one-minute bars are right and the daily candle is not, the person adds the printed entry with an
`id`, a `note` and `confirmedAt` to `keeper/vol-index-source-checks.json`; the next run goes on, and the line
stays as written. The file is absent until it is needed. An entry is used only when every value in it
matches what the run reads; it never passes a line without an anchor and never makes the keeper anchor a
line it did not write — such a line is removed by a commit and its days are written again (`late`). The
file is committed to this public record, so every use of it is visible.

The keeper also recomputes the whole record once per run before it sends or appends anything, recomputes
an unanchored line before it anchors it, reads the decision's own anchor transaction and the last anchor
again, waits at most 300 seconds for each receipt, and marks only a vault whose registry `deployTx` is its
own creation of that address. Each stop and how the series resumes are in sections 9 and 9A of the
rulebook and in `keeper/RUNBOOK.md`.

## Marks

The mark method, `{"mode":"step"}` in the registry, is an operating value (appendix O of the rulebook): it
marks in steps within the contract's bound of 25% per mark (P14, a reference), never stopping on size, so
that the share price equals n6 ÷ 1,000,000; changing it leaves every record line the same (T-IF9 in
`keeper/test/vol-index.test.mjs`). The
vault takes no deposits, so the share price between two steps settles nothing: the steps have no economic
effect. A day the series halts on has no new line and the vault keeps its last mark. The mark code is placed
in `keeper/vol-index.mjs`; it takes the steps from `markSteps` of `keeper/leverage-step.mjs`, which this
decision does not change. Launch conditions, met before this anchor with tests in
`keeper/test/vol-index.test.mjs` (sha256 `d13fc356f6f341264c82c10d04df393048d86f81e366ea560f5f4aec9265e504`): the keeper does not mark a vault whose symbol is not the rulebook JSON's ticker (T-IF7),
it does not mark before the day's line is anchored (T-IF6), and it does not mark a vault whose deposit cap is
not 0 — the line stays written and anchored, and the run exits 1 (T-IF12). It also does not mark when the
registry has no address (T-IF7) or when the entry's deployment transaction is not its own (T-IF25).

## Roles

| Role | Address | Who holds it | What it can do |
| --- | --- | --- | --- |
| Owner | the keeper key, `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`, until the timelock accepts; then the timelock of the redeployed vaults, `0xC387f483A4a38C58c746b476340Be7F52b69090A` | the timelock: delay 72 hours, proposer a hardware key held by the owner (as stated in the redeployment decision) | deposit cap, pause, keeper and guardian appointment |
| Keeper | `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` | the keeper key | marks; anchors of this series |
| Guardian | `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3` | a hardware key held by the owner (the guardian of the redeployed vaults) | `disableKeeper` only |

Raising the deposit cap above 0 is not allowed by this decision; it would need a new decision. The timelock
delay of 72 hours is the redeployment decision's owner decision; this decision does not set it.

## Tested, and not tested (pinned)

Parameter citation table: appendix P of `rulebooks/qvol.md` (pinned above); keeper provenance
`keeper/rulebooks/qvol.provenance.json` (sha256 `12c0ec6086ef35ace29820ace2e01f78e52674828eafe482c918e8502d744737`). Checklist run record:
`docs/methodology/checklist-runs/qvol/2026-11-05.json` (site repository, private; sha256 `9c9e8b72288db1355ca7e23252687c3766969c85a6748e73cd61009fff9fe132`). Every evidence
file it pins can be published; the launch evidence is in this repository, `docs/research/qvol/evidence/`, and the reproducibility results are pinned by their site-repository originals, whose copies are below; the run record names no internal file. Gate report:
`rulebooks/qvol.gate.json` (sha256 `1777605b7df6a4061f90b01c3c9c9838671577a76e5c39325394f9e62f63e9fe`). Track: trading tool (`track` in `keeper/rulebooks/qvol.json`;
owner, 2026-10-06), type measurement. The owner decisions this decision cites are quoted in this
repository at `docs/owner/qvol-decisions-2026-11-05.md` (sha256 `b3337942b9e10568c82e4e601247828b06509938d62081265996aaf064608014`).

What was tested. One pre-registered test, of reproducibility; it does not choose any value, so it is not
the basis of any row below.

| Test | What it checks | Verdict | Editions | Result |
| --- | --- | --- | --- | --- |
| Reproducibility (V1–V4) | V1 two independent implementations give the same value and the same variance on every line, within the policy limit (relative difference ≤ 1e-9) · V2 the same input sha256 on every day · V3 the same day closes as the 15-minute file and as the exchange's daily bar, and the same fields where the two input ranges overlap · V4 the same bytes on two runs of the same input | Applying the decision rule, reproduced: V1, V2, V3 and V4 pass (2026-11-04) | 1 (registered limit: 3) | 0 mismatches in each: V1 3,362 lines · V2 3,422 days · V3 6,844 close rows against the exchange's daily bar, 6,658 against the 15-minute file, and 58 overlap lines · V4 3,299 lines; `docs/research/qvol/prereg-2026-10-13/results-public/verdict.json` sha256 `849905b829435af3c08ff0ce733dc4ae2586da40d01fde0f3afcc03a33d792f8` |

Pre-registration commit: `0649c4b495fa3729587c581d82489ee8ef9f6ca0`, 2026-11-03 07:45:42 UTC (site repository;
publishable copy in this repository, `docs/research/qvol/prereg-2026-10-13/README-public.md`, sha256 `d37c82d33f3cc4cd575adca7f7935790e7a6e6c3efc771b3964fa3f1a25bfc8e`, and
`docs/research/qvol/prereg-2026-10-13/REGISTRATION-public/registration.md`, sha256 `891497d5d3e96b367d5f1b2a8937ac22ba3495fa9cdd6b9c9d7aa1cf444e5c92`). After it and before
the main runs, the comparison script and implementation B were frozen in commit `0af158e4` (site repository).
Result files: `docs/research/qvol/prereg-2026-10-13/results-public/` (its run notes `RUN.md`, sha256 `b912ff6bb7a01c3840254f87ad99f83836037e527bfb350a01be33fae4142343`), each with its sha256 in
`docs/research/qvol/prereg-2026-10-13/MANIFEST.sha256` (sha256 `3f29a508d6f8b3515fbdcc861877e54a4c1f05c7f8395c876da19bf8b21dc786`). Three files of the registration commit are
not in the public copy — `open-decisions.md`, `w6-sources-2026-11-02.md` and `impl-a-2026-11-02.md`: they are
internal working notes with internal references and words this public copy excludes, and the registration
text does not depend on them (`MANIFEST-notes.md`, "Left out").

The verdict, 2026-11-04 02:46:58 UTC. V1 compared the two implementations on 3,362 lines: the file range,
2017-09-18 to 2026-09-29 (3,299 lines), and the REST range, 2026-09-01 to 2026-11-02 (63 lines); the largest
relative difference was 3.7137324887372116e-16 for the value and 3.802507002870737e-16 for the variance (limit
1e-9). V2 compared the input sha256 of 3,422 days, and of the REST range also against the registration's
snapshot (93 days). V3 checked the closes of both implementations against the exchange's daily bar (6,844 rows)
and, in the file range, against the 15-minute file (6,658 rows), and the fields of the 29 days where the two
ranges overlap (58 lines, both implementations). V4 ran implementation A twice under the registered runtime,
node v22.23.1, in two different containers. An independent check recounted V1, V2 and V4 with its own code:
0 mismatches.

Editions: 1. The registration counts editions toward its limit of 3: the run after a fix is a new edition, and
each new edition has its own registration commit (registration §6-4, "if it does not pass", items 3 and 9; the
registration's header names it edition 1). Nothing was fixed and there is one registration commit, so the test
used one edition. That edition had two verdict runs, and both passed. The first used two file-range runs of
implementation A under node v22.23.4 in one container; its results are kept. The second used two new
file-range runs under the registered runtime, node v22.23.1, in two different containers, as §6-3 (C12) and
§6-4 (V4) are written; it is the verdict above. The definition, the two implementations, the comparison
script, the inputs and the ranges are the same in both.

| Basis | Count | Parameters |
| --- | --- | --- |
| Tested — pre-registered backtest and Monte Carlo | 0 | — |
| Partly tested — backtest only, or run without pre-registration | 0 | — |
| Definition | 2 | P09 price source, Binance spot BTCUSDT minute bars (public REST, interval `source.interval`), closed bars only, no fallback · P13 deposits: none — the display vault holds no asset (its encoding in the contract is a deposit cap of 0; the gate's check of numeric definitions does not apply, the value is not a number) |
| Definition — measurement convention (a number fixed by a published standard; P06 · P12: indirect documents only) | 8 | P01 window 30 days · P02 year of 365 days · P03 daily return interval · P04 mean zero · P05 a day with no bar · P06 day boundary 00:00 UTC · P07 σ × 100 · P12 day close = the latest one-minute bar opened that day |
| Price | 0 | — (nothing is held, so there is no fee) |
| Exposure limit — set from a stated loss tolerance, not by a test | 0 | — |
| Exception — not tested, decided by the owner, disclosed with its reason and expiry (trading-tool track only) | 0 | — |
| Reference — a contract constant set by another document | 1 | P14 the vault's bound of 25% per mark (decision `2026-10-21-testnet-vaults-redeployment`) — inherited not tested: that decision lists it as not tested |
| Not tested — listed in the rule audit | 0 | — |

Operating values, not rows of appendix P: the vault's mark unit, n6 = floor(x × 1,000,000), a truncation to the contract's 1e-6 unit; the vault's mark method, steps within the contract's bound (appendix O of the rulebook, with the test that the record lines do not change); the two decimals the page shows (appendix O: the keeper refuses any value but 2 in the rulebook JSON, and neither the line nor the mark reads it — test O5 in `keeper/test/qvol-operating-values.test.mjs`); the request retries, spacing and time limit, the two fetches of a day and the 300-second receipt limit (appendix O, tests O1–O3, T7 and T-IF24). P08 is not used: the record keeps the value without rounding (owner, 2026-11-02).

Values this decision introduces: every value above except P14 is new. None of them is "not tested" or
"partly tested"; none is an exception. P14 is inherited not tested, and disclosed as such; it is not a new
or changed value — the vault runs the same bytecode as the redeployed vaults — and, with no deposits, it
acts on the display only. Arithmetic, not a row: a complete day has 1,440 one-minute bars (24 × 60).

Numbers fixed by convention (shown in the "not tested" side of the page block): 8 — P01 · P02 · P03 · P04 ·
P05 · P06 · P07 · P12. Each row of appendix P names its outside methodology document and that
file's sha256 — P01 · P02 · P03 · P04 · P05 · P07 cite documents of Volmex Labs, Coin Metrics and Cboe. For the day boundary (P06) and the day close (P12) no direct outside sentence was found; their rows cite indirect documents only (the Binance API document, whose bar requests default to UTC; two documents that define a bar's close as the last trade in the interval). The owner adopted the definition with these two rows as written on 2026-11-02. The gate counts six of the eight as numeric measurement conventions: P03 and P05 hold no number.

Policy values of the decision rule (fixed with the owner before the registration; not rule values; no
keeper or contract reads them):

| Policy value | Value | Owner confirmed | Sensitivity |
| --- | --- | --- | --- |
| Relative difference of the value between the two implementations | ≤ 1e-9 | 2026-11-02 | sensitivity not run |
| Relative difference of the variance | ≤ 1e-9 | 2026-11-02 | sensitivity not run |
| Input sha256 that differ | 0 | 2026-11-02 | sensitivity not run |
| Differences between two or more dry runs | 0 | 2026-11-02 | sensitivity not run |
| Editions allowed before the line does not open | 3 | 2026-11-02 | sensitivity not run |
| Closes that differ (V3: 15-minute file, exchange daily bar, overlap of the two input ranges) | 0 | 2026-11-02 | sensitivity not run |

Disclosures of the trading-tool track: long-run figures — none: nothing is held. Holding period — none is
claimed: nothing is held; a value measures the 30 UTC days before 00:00 UTC of its date. Deposit risk
confirmation — not applicable: no deposits.

The citation gate (report-only) does not pass this decision. Its report reads "fail" with 12 violations, none
on a value of the rule: the page block is not yet in the form the gate reads (C10, 11 — one for each row), and
the keeper JSON's `display.decimals`, an operating value of the page with no row in appendix P since P08 is not
used, is read by the gate as a value without a citation (C7, 1).

Checks not run for this product, and why: holdability of assets on GIWA (R08) — not applicable, nothing is
held; security items R44–R46 — no contract code beyond the redeployment's. Run, with their evidence in
`docs/research/qvol/evidence/`:

- A red-team proof-of-concept pass over the new keeper code, the public verifiers and the workflows (R47),
  2026-11-04, offline — false bars, a mismatch between the two fetches of a day, a bypass of the gap
  acceptance, forged lines, the anchor and the in-force gates (`red-team-2026-11-04.md`, sha256
  `e9a1bcd6276c8863e743016d1b3ef893eb0beb29d7ae4453707ebb59cfccfb90`). Before the fixes it failed: two
  paths inside the stated trust boundary put a wrong value into the record and the vault — bars falsified
  identically on both fetches of a day, and a self-consistent line appended by hand, which the next run
  anchored. Fixed before this anchor, each with tests: the keeper recomputes a line before it anchors it and
  the whole record each run, fetches the last line's day again and compares the daily candle; the verifier
  fetches every line's day again and checks every anchor's sender; the watchdog recomputes the series; and
  lesser items (T-IF17–T-IF27 in `keeper/test/vol-index.test.mjs`, V1 and V2 in
  `keeper/test/qvol-verify.test.mjs`). What remains: if the exchange serves the same false close as a
  one-minute bar and as a daily candle, the line is written and both verifiers accept it — the trust boundary
  (rulebook §9A). A halt on an absurd day return, outside the definition, is the owner's call and is not in
  this decision.
- The whole test suite at commit `fc89e887e6a3d15f1804adf71b1b0f9e5ee8b0c6`, run one file at a time: 420
  tests — 407 pass, 0 fail, 12 skipped, 1 to do, the qBTC2X pins test, an open item
  (`keeper-tests-2026-11-04.txt`, sha256 `8e253e42040fd56dd885b7163d12d952c7dd4c4791f9eb01274b5410d2f67d16`;
  R50, failure paths).
- Dry runs (R49): three runner dry runs of 2026-10-31 to 2026-11-04 (runs 41770565668 and 41770579822 at
  commit 4c077ed under node v22.23.4, run 41772753992 at commit ea9949c under node v22.23.1) wrote the same
  five lines (2026-11-04: 28.47374564801124); the keeper of this decision writes the same record bytes as the
  registered one in four dry-run cases (`dryrun-identity-2026-11-04.txt`, sha256
  `5c697518068965375c0982326fb8c90b9972f972d8ed3ffefb273eeb7e3f8355`).
- The public verifier's recomputation of this series and the check of every record (R56): done before this
  anchor, on 2026-11-04 — `scripts/verify.mjs` over the whole record, 0 failures, and its qVOL tests
  (T-IF13, V1, V2 and the watchdog's recomputation), 4 of 4 (`verify-full-2026-11-04.txt`, sha256
  `6f23fb67660eb5eaaeca4e5152aa7a01cde282f8c5c38f33310670bdeb608e7e`). The check against the website's copy
  of the record needs this series' files on the website, which is the website's deployment.
- A scan of the files and commits this branch adds for words a public record does not carry (R54): none
  (`public-word-scan-2026-11-04.txt`, sha256 `f0b742a407f1c4ed6648a611a574f9411f9690255058a04ba25a6872cf0d080b`).
- Roles on chain (R64): read back after the deployment, recorded in the run record of the deployment day.

Judgments — values that differ from the decision rule's output: none. The decision rule chooses no value.

## Known limits, stated at the start

Thirty returns: under a normal assumption the relative standard error of the value is about 12.9%
(1 ÷ √60), and more when tails are heavy. Only close-to-close moves count; moves within a day do not. The
prices are one exchange's spot bars, with no fallback: if Binance is unreachable no line is written and the
series waits, and the same values are written late from the same closed bars. A 30-day window moves in a
step when a large day enters it and again when it leaves. The source checks compare the exchange with itself
(one-minute bars, daily candles, a second fetch); no second exchange is compared.

Bit-for-bit reproduction holds within one platform build. Across platform builds, 91 of 3,299 lines (2.8%)
differed in the last bit; the verdict and the verifier compare at a relative difference of 1e-9. The daily
run writes lines under node v22.23.1 as built by GitHub's `actions/node-versions`; the verdict ran the
nodejs.org build of node v22.23.1 in Linux containers. Whether the two binaries are the same build was not
measured.

The vault's share price can move at most 25% per mark: when a large day enters or leaves the window, the
value can move by more than that bound in one day, and the vault then reaches the day's value in several
marks within the same run. A share price of 0 cannot be marked: a value below 0.000001 (n6 = 0) cannot be
shown by the vault. Until a person accepts an incomplete day or confirms a source difference, the series has no new line and the vault keeps its last
mark. If the exchange corrects a bar after a line is written, the line's close is the record; the value is
not changed. A wrong line that is already anchored is answered by an anchored correction decision.

If another product uses this value as an input to its weights or triggers, the conventions here are
tested values in that product. No external audit. Testnet only.

## Pinned

The registration pins fifteen files of implementation A, each by sha256: the bytes of commit
`b8769aa5542313e6e7688266dfff0412a117bc3b` of this repository (branch `keeper/qvol-2026-11-02`), with a bundle of
that branch in the site repository (sha256 `2b801e8f68905f0100179471cc68b43cc77b76872512f45ab6865047c61683c3`).
In force, eleven of them are byte-identical to the registered ones (sha256 equal to the registration's). Four
differ, and only as follows. `keeper/vol-index.mjs` adds the wiring — the in-force path, the anchor, the mark,
the command line, the fork rehearsal mode and the source and record checks — and the computation module it
imports, `keeper/vol-realized.mjs`, is unchanged. `keeper/test/vol-index.test.mjs` adds the tests of that wiring
(T-IF1–T-IF27) and changes five registered tests — T14, T15, the configuration refusals, the rulebook shape and
the fetch time-out — to the new command line and to a rulebook JSON that may be in force; none of them
checks a computed value. `docs/vol-index.md`
adds the sections on the line in force, its halts and how it resumes, and its status line.
`keeper/rulebooks/qvol.json` differs only in the fields `inception`, `pendingOwner`, `asOf` and `status`, which
put it in force; every other field, and so every rule value, is the registered one. The registration places
the wiring after the test (its §9); no difference changes how a value is computed, and none is a new
edition of the test: the keeper of this decision writes the same record bytes as the registered one in four
dry-run cases (`dryrun-identity-2026-11-04.txt`, above). Four of the registered files are of the implied line (`keeper/vol-implied.mjs`,
`keeper/rulebooks/volbtc-implied.json`, `keeper/test/vol-implied.test.mjs`,
`keeper/test/fixtures/vol/cboe-sample.json`): that code is inactive and outside this decision; the files are
listed because the registration lists them.

| Registered path | Registered sha256 | In force |
| --- | --- | --- |
| `keeper/vol-realized.mjs` | `640d738b809b9a9c7dbd32c4e8291be3b0b60358237c5f684ce0818775005adc` | = registered |
| `keeper/vol-index.mjs` | `1fe6fc44340fbfdb3e4d2bb2d628d119cd38b25ef067dffb23a428d7ca34b9df` | `4444376588c6bbf6482794e61b9b9d43cb0ea8b074994293cb28d57ea3c8c94f` — the wiring: in-force path, anchor, mark, command line, fork rehearsal mode, source and record checks |
| `keeper/vol-sources.mjs` | `05c829854227bf7a3c90fbfb6d8316f76d844e03cecdeb211d7adf55d2029463` | = registered |
| `keeper/vol-implied.mjs` | `7827d9430e316d6634c47d9f657e51ea4e47290af517aa3bc61c5acfbb2ff57d` | = registered |
| `keeper/vol-index-gaps.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` | = registered |
| `keeper/rulebooks/qvol.json` | `cf2eb766a32913102e00f8d938aa8c44cb304eb3b9c6c63284056fe62b29322e` | `7e4d6e38f346fee0f3deb04935b4ef6c93213f1841d0c44656d722cc888a44e8` — the fields `inception`, `pendingOwner`, `asOf`, `status` only |
| `keeper/rulebooks/volbtc-implied.json` | `bca2b4e7c5d0a1f4bb4221a7c3ec76ede9a4308e45e1181b96f3543d24595c69` | = registered |
| `scripts/verify-vol.mjs` | `c8bee502a19eaec6c1bf01cd6752d7b7a51326a36ad5274f61ba052389b11e2f` | = registered |
| `keeper/test/vol-checks.test.mjs` | `f42e0828c4f9713f55ebde06b5f24ac46e82660a4186dd409c09a13f55a52bc0` | = registered |
| `keeper/test/vol-realized.test.mjs` | `bdf330f6c8b3595e349e1364cbcc0da3e2a8a7f8db583948d1dfd29aa24b7600` | = registered |
| `keeper/test/vol-index.test.mjs` | `c280b8184967f420fdbb96260d055065085b33b1b7a6690d0f4322f38ba6cc2e` | `d13fc356f6f341264c82c10d04df393048d86f81e366ea560f5f4aec9265e504` — the tests of the wiring, T-IF1–T-IF27 |
| `keeper/test/vol-implied.test.mjs` | `998bb8e46050c59fa267327db8e733f60f2ee239259404f6c038815cdcedf897` | = registered |
| `keeper/test/vol-helpers.mjs` | `399879e6c2a98bd19b42fc3775a3607a734938c0d1b1216552aa9e15475de820` | = registered |
| `keeper/test/fixtures/vol/cboe-sample.json` | `29f276b522051ed33e942e072f0d15dd22e18717125faba3f9b98f8a6c5b353d` | = registered |
| `docs/vol-index.md` | `e8c1b3874d2dcd9e4f40dfd7df9cd3ab97fdf81d53464befe981c3a3d198effd` | `57999160cad6e255be4cdabae92fb3dd1c17336d8d6d8148edf09e1e8d18518d` — the line in force, its halts and how it resumes, the status line |

`scripts/verify.mjs`: old sha256 `65f99e7c92194cf5515c2ee8a5358681a7553ee44a5ab36c05f8c77e58d890b1` (at this repository's main) → new
`f6e3c063a74409dd487efe394c66eb3e734061e643fa1d0a13bc7d7c91f9859b`. The changes add the qVOL series: its
recomputation through `scripts/verify-vol.mjs`, its binding to this decision, the second fetch of every line's
day (`--refetch-bars`) and the check of every anchor's sender. The other series are verified as before. The
pins of `scripts/verify.mjs` in earlier decisions stay true of the file at the commits they name.

| Repository | HEAD at pinning |
| --- | --- |
| quadrix-track-record (rulebook, rulebook JSON, keeper with its calculation files and wiring, verifiers, vault registry entry, deployment tool and artifact, publishable test copies and launch evidence, the provenance file, the gate report and the owner-decision extract, each pinned by sha256 above; this decision is added in the next commit, and the merge into main is recorded in a later dated checklist run record) | `8e0be4b8e19adbc165d9eb43640d10e3ebbb7c28` |
| quadrix (site, private — contract source, checklist run record, registration; the commit the gate report was run on) | `f70e71a9a41328fbab5ae619f7d234c02b6e6c07` |
