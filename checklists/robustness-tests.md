# Robustness test checklist

Confirmed on 2026-10-02. The name is provisional.

The catalogue of tests that the steps of the vault design checklist ([`vault-design.md`](vault-design.md), D01–D18)
call. The two checklists always run together. Each run record marks every item as run, not run, or not applicable,
with the result file. No run record has been completed yet (see the [README](README.md)).

The catalogue holds 46 test items (§3-1). Seventeen former items were procedures rather than tests; on 2026-10-01 they
were merged into the design steps that do the same thing, and their IDs remain only as aliases (§3-2). IDs are not
reused.

## 1. Scope

- For every new vault, new index and rule amendment, the D steps call the R items below (column "Called by").
- **This table lists only methods that have actually been run at least once.** Methods never run are in §5 (U01–U25)
  and are not required.
- Existing vaults are brought under the table retroactively by the rule audit (D18).
- Discretionary vault (N1Q): how the parameter tests (R03–R33, R59–R62) and the design steps that run them (D05–D08,
  D10) apply is **not yet defined**; it is to be revisited. The definition, security, operations and disclosure items
  apply; independent verification applies through the staged review of design step D09.

## 2. Principles

1. Every parameter value cites the result file of a pre-registered test (backtest plus Monte Carlo) and the run record
   of both checklists. A value without a citation is not written into a rulebook. The only exceptions are definitions
   (universe, data source, excluded asset classes) and prices (fees), labelled as such. This applies to values
   introduced or changed from 2026-10-01; older values that were never tested are handled as the [README](README.md)
   describes.
2. Rule parameters are decided by data. A backtest is the default; when the history is short, at least a Monte Carlo;
   both when possible.
3. A rule that does not come out best under test is not included (Occam).
4. The decision rule's output is the default. A value that differs from it is allowed only when the test was ambiguous
   (no variant met the pre-registered "best" condition, or the output came from the fallback order). Such a judgment
   must be reasonable, and its reason is always published, in the rulebook and in the anchored decision
   ([`vault-design.md`](vault-design.md) §1, §6).
5. An absent rule ("no band", "no buffer") is decided by data too: it goes in when a test shows absence is best, and it
   is cited like any other value.
6. "Verified" and similar words are used only for tests that were actually run.
7. Results are written only as "applying the decision rule gives …". They are an input to a decision, not a decision
   or a recommendation.
8. Irreversible actions (anchored documents, chain operations) get two independent reviews and a rehearsal.
9. Numbers are re-measured from chain, API or git at the time of writing, from primary sources only. What could not be
   measured is marked "unconfirmed". This applies to every design step (formerly R58).

## 3. The checklist

**How to read it**

- **Types.** Index = a basket whose names are picked by rule (qX20, qDEFI, qREV, qAI, candidate indexes). Allocation =
  fixed sleeves (qDUO, qTRI). Leverage = borrowed leverage (qBTC2X, qETH2X). Discretionary = N1Q. A *selection sleeve* is
  an allocation sleeve whose assets are picked by rule.
- **● required · ○ when applicable · – not applicable · ? how it applies is not yet defined (§1).**
- **Where it has been run.** Standard = the same method in two or more products or studies. Partial = only part of it
  (the missing part is named). Once = in one place only. The leverage parameter study has been run in four versions;
  "from the third version" means the item was first used there.

**3-1. Test items (46)**

| ID | Stage | What is checked | Pass criterion | Index | Allocation | Leverage | Discretionary | Where it has been run | Called by |
|---|---|---|---|---|---|---|---|---|---|
| R02 | Definition | Rulebook ↔ keeper ↔ research harness: do the three compute the same rule? | Zero mismatches, or an action for every numbered mismatch | ● | ● | ● | ○ | Standard — qDEFI, qREV, qAI, qDUO, qTRI | D04 · D11 · D13 · D18 |
| R03 | Definition | Product distinctness: monthly mean weight overlap Σmin(w1, w2), R² of monthly returns, tracking difference, with the BTC↔ETH R² as a baseline | No threshold. Measured and disclosed only | ○ when a similar product exists | ○ | ○ | – | Standard — qX20 and a candidate index | D01 |
| R04 | Data | Point-in-time universe (no survivorship bias): on each reconstitution date only what could be known that day, including names that later died | Today's survivors are never used as the candidate list. The treatment of vanished names (−95%, or 0 after the last price) and the remaining bias are written down | ● | ● selection sleeve | – | ? | Standard — qX20, qREV, qTRI | D05 · D08 |
| R05 | Data | Two-source classification. Sector membership is the intersection of two independent sources, decided only on reconstitution dates. A failed fetch is retried three times, then the composition is frozen | Today's basket is computed as the intersection. A change of source is a decision document. If a backtest uses one source only, that is disclosed | ○ sector index | ○ sector sleeve | – | – | Partial — qDEFI, qAI: only today's basket uses the intersection; the backtests used one source; keeping the raw responses with their sha256, which the rulebooks require, is not implemented (U02) | D03 · D13 |
| R06 | Data | Eligibility floors (market cap, 24-hour volume, listing age): how many names each floor removes at each reconstitution, and whether the largest-weight name lies inside the backtest window | Each floor has rows run with other values. If the largest-weight name is outside the window, R21 or R23 is required | ● | ○ selection sleeve | – | ? | Partial — qREV (market-cap floor $150M against $300M), qAI (names removed); volume-floor alternatives not run (U06) | D05 · D08 |
| R07 | Data | Universe depth: eligible names and N on each reconstitution date | The results table has an eligible-count column. Stretches below N are marked "thin sample", and the rulebook states what happens below N | ● | ○ | – | ? | Standard — qREV, qAI | D05 · D08 |
| R08 | Data | Holdability on GIWA: whether an asset is a canonical bridge token (L2 factory creation event; read `REMOTE_TOKEN()` and `BRIDGE()`). For wrappers, C1 (reserve verification), C2 (direct 1:1 redemption, no pause power) and the issuer's powers, read from primary sources | C1 and C2 results are written for every asset. A paper index carries an information column plus a count of unconfirmed items | ○; ● at the real-asset stage | ○; ● at the real-asset stage | ● collateral and borrowed assets | ? | Partial — one full census of BTC representations; sector indexes carry an information column only | D02 · D15 |
| R09 | Data | Committed input snapshots: inputs and their sha256 (`MANIFEST.json`) are committed, and the scripts read only local files by default (network only with `--refetch`) | The README carries the input sha256, and a re-run without network gives the same output | ● | ● | ● | ? | Partial — qX20 monthly snapshots and the qBTC2X / qETH2X hourly bars only; inputs for qREV, qDEFI, qAI, qDUO and qTRI not committed | D05 |
| R10 | Data | Symbol and price-pair hygiene: case normalisation, ticker migrations neutralised, a month dropped when the price pair is outside ±10% (log) of the snapshot price, duplicate tickers flagged | A case-mixing scan of every snapshot is kept | ● | ○ selection sleeve | ○ when a proxy index is used | ? | Standard — qX20, qREV | D03 · D05 |
| R11 | Data | On-chain issuance registry: total supply minus protocol-controlled addresses, weekly from archive RPC. A gap of more than 10% to an aggregator is classified by cause | Every gap has a recorded cause. Fallbacks and mismatches above 5% are recorded | ○ when issuance is in the rule | ○ | – | ? | Once — qREV (qTRI's quality sleeve uses the same registry) | D05 |
| R14 | Backtest | Multiple windows against BTC and ETH: multiple and maximum drawdown for each fixed-start window. Robustness score = windows that beat BTC + windows with a shallower drawdown | Every window is published, including the ones lost. If the score cannot rank, that is said | ● | ● | ● | ? | Standard — qREV, qDUO, qTRI | D08 |
| R15 | Backtest | Parameter grid: single-axis and full-factorial grids, interactions between axes | Every value classed "to be tested" has rows run with other values | ● | ● | ● | ? | Standard — qDEFI, qREV, qBTC2X, qETH2X | D08 |
| R16 | Backtest | Overfitting accounting: number of variants tried and number of independent quarters. Windows that share an end date are not independent | Both numbers (hypotheses, independent samples) are in the results ("10 of 12 or more = overfitting flag" was used in one candidate study only) | ● | ● | ○ | ? | Standard — qAI, qDUO, qTRI | D08 |
| R17 | Backtest | Attribution test: 2,000 shuffles (constituent returns reassigned within the real quarterly path), screen on and off, a fully invested row | To claim that weighting or selection carries information, the real result must sit above the shuffle distribution. Otherwise "indistinguishable from random" | ● | ● | – | ? | Standard — qAI, qTRI | D08 |
| R18 | Backtest | Rebalancing cadence, drift band and tolerance, with costs | A trading trigger between reconstitutions stays only if it is still best after costs | ● | ● | – (R25–R28) | ? (cadence and band have been run) | Standard — qX20, qDUO, qTRI, N1Q | D08 |
| R19 | Backtest | Engine sanity bound: each week's basket return lies between the lowest and highest return of its holdings (cash included) | Zero violations | ● | ● | – | ? | Once — qAI | D07 |
| R20 | Backtest | Daily-reset decay: path-dependent loss against the naive λ × return; an engine liquidation column beside the paper series | Every leverage result has a decay column and a liquidation column | – | – | ● | – | Standard — qBTC2X, qETH2X | D08 |
| R21 | Monte Carlo | Monthly-transition block bootstrap: non-circular moving blocks, L = 3, 6 (headline), 12; 2,000 paths per L; common random numbers; seam rule and diagnostics; tiered costs | Input to the decision rule (design D06 field 11, applied in D10; formerly R34). Seam diagnostics are published with it. Absolute turnover is not read; only comparisons | ●¹ | ○¹ | – | ? | Standard — qX20, qDEFI | D08 |
| R22 | Monte Carlo | Calendar-month block bootstrap (leverage): calendar months of hourly bars, paths of 2,100 days, L = 1, 3, 6, 12, round(20,000 / L) paths = 20,000 · 6,667 · 3,333 · 1,667 (in the fourth version; the third used round(5,000 / L), the first L = 3, 6, 12 × 2,000 paths). Assets with the same sample range (BTC, ETH) and all variants and scenarios share paths; an asset with a different range gets different paths even with the same seed | Input to R25 and to the decision rule (design D06 field 11, applied in D10; formerly R34). Values split by whether March 2020 is included are reported as information | – | – | ● | – | Standard — qBTC2X, qETH2X | D08 |
| R23 | Monte Carlo | Quarter resampling (short history): realised quarters drawn with replacement into 10,000–20,000 paths of 12 and 40 quarters, pools B (2023 on) and C (2024-07 on), BTC on the same quarters; "as is" and "shuffled" | Loss probability, P(beat BTC) and the 5th percentile are published. The dependence on the pool's start and the optimism of a rule chosen on the same sample are written down | ●¹ | ●¹ | – | ? | Standard — qREV, qDUO, qTRI | D08 |
| R24 | Monte Carlo | Resolution and stability: more paths, three seeds per L, an L sweep, re-judging under cost and rate scenarios, standard error near the threshold | The axes on which the verdict changes are published as a table. Within 1 SE of the threshold, that is said | ● | ○ | ● | ? | Standard — qX20, qBTC2X, qETH2X | D08 · D10 |
| R25 | Stress | Zero-liquidation gate: loan-to-value at each bar's low (2x) or high (inverse) against a placeholder liquidation threshold of 86%, over three historical windows and every Monte Carlo path | Eligible only with zero liquidations. The highest loan-to-value reached and the margin (percentage points) are reported | – | – | ● | – | Standard — qBTC2X, qETH2X | D08 |
| R26 | Stress | Depth stress: in the historical windows, the close, low and high returns of bars whose absolute return exceeds 10% are multiplied by k ∈ {1.15, 1.25, 1.5}. Not applied to Monte Carlo. k = 1 must equal the original window | Liquidation and the highest loan-to-value reached at k = 1.25 are reported. Rule A takes eligibility from R25 alone; rule B also requires zero liquidations at k = 1.25. Which of the two governs is an operator policy | – | – | ● | – | Standard (from the third version) — qBTC2X, qETH2X | D08 |
| R27 | Stress | Static margin: at the highest leverage Λ0 right after a check, stretching the deepest h-hour drop D_h by k still gives (1 − 1/Λ0) / (1 + k·D_h) < 0.86 | Must hold at k = 1.25 to be eligible; k = 1.0 is for reference | – | – | ● 2x long; – inverse (no formula yet, U22) | – | Standard (from the fourth version) — qBTC2X, qETH2X; the corrected formula awaits final review | D08 |
| R28 | Stress | Check-interval axis: a check interval n ∈ {1, 2, 3, 4, 6, 8, 12, 24} hours run as a grid axis | The chosen n comes from the grid results. Whether the run environment guarantees that interval is U03 (a launch condition, not built) | – | – | ● | – | Once — qBTC2X, qETH2X | D08 · D14 |
| R29 | Stress | Extreme-day hourly trace: the 48 bars of 2020-03-12, 2021-05-19 and 2025-10-10, the chosen variant beside the same rule without a trigger | A sentence on why the chosen variant survived (and whether it was path luck) | – | – | ● | – | Standard — qBTC2X, qETH2X | D08 |
| R30 | Stress | Special-situation trigger event study: number of events and +7, +30, +90-day outcomes per threshold (24-hour −20, −25, −40% against BTC; TVL −30, −50%), with two price sources agreeing | It does not fire on survivable incidents (recovery after an exploit). If the sample has no fatal event, write "0 events" and make no claim about firing | ○ when a special-situation rule exists | ○ | – | ? | Partial — qREV, trigger A only; trigger B is U05 | D08 |
| R31 | Stress | Single-name shock arithmetic: the index loss when the capped name falls 50% or 80% | One line in the rulebook | ○ when there is a cap | ○ | – | ? | Once — qREV | D08 |
| R32 | Cost | Trading-cost scenarios: uniform 10, 30, 50, 100bp and tiered (headline), bisection break-even, turnover, a net row at fee + 30bp | Whether the difference between rules survives costs is used in the verdict. That market impact and assets under management are not modelled is disclosed (U12) | ● | ● | – (R33) | ? | Standard — qX20, qREV, qDEFI | D08 |
| R33 | Cost | Leverage funding cost: cost {10, 30, 60}bp × rate {3, 6, 12}%, cost tripled on bars whose absolute return exceeds 5%. The realised friction of an alternative 2x product (futures-based) compared with our loop | Measured whether our friction is below the alternative's. Placeholder values are marked | – | – | ● | – | Partial — cost grid standard (qBTC2X, qETH2X); comparison with the alternative once | D08 |
| R38 | Independent verification | Cross-version reproduction gate: a new engine must reproduce the previous configuration bit for bit, or to printed precision, before it runs | Rows reproduced and the maximum error are recorded. On a mismatch, stop | ● | ○ | ● | ? | Standard — qX20, qBTC2X, qETH2X | D07 |
| R39 | Independent verification | Independent reimplementation and closed form: row-by-row comparison with a second implementation, and with closed forms (zero-cost daily reset = Π(1 + λr)) | Zero mismatches, or every mismatch explained before results are written | ● | ○ | ● | ? | Standard — qX20, qDEFI, qBTC2X, qETH2X | D07 · D09 |
| R40 | Independent verification | Deterministic, byte-identical reproduction: sha256 of two runs, independent of worker count, across machines (local and cloud) | A sha256 match is recorded | ● | ● | ● | ? | Standard — qX20, qBTC2X, qETH2X | D08 · D09 |
| R44 | Security | Invariant fuzzing: handlers call deposit, redemption, fee, profit and loss, pause and cap changes in random order; 128 sequences × 64 calls per invariant; any revert fails the run | Every invariant passes; zero regressions against the baseline | ● | ● | ● | ● when moved to Quadrix's own contracts | Standard — the vault contracts | D15 |
| R45 | Security | Invariant register review: for every invariant in the security specification, the code line, the test, and a verdict (enforced, partial, not implemented, contrary to the document, stale); deployed state read with `eth_call` | An action item for every "contrary" and every "not implemented" | ● | ● | ● | ● | Once | D15 |
| R46 | Security | Incident-pattern replay: incidents in a public database are screened for applicability, grouped into patterns, the code is read per pattern, and a proof-of-concept test is written per pattern | Every pattern ends as blocked (an existing test asserts it) or broken (a proof of concept) | ● when there is a new contract or new external dependency | ● | ● | ● | Once (final review pending) | D15 |
| R47 | Security | Adversarial proof-of-concept gate: a finding counts only if it reproduces as a test from a clean checkout. Each break faces two rebuttal reviewers; each block gets a vacuity check. A block is not proof of absence | An action and a schedule for every confirmed break. Unresolved items have a retry record | ● | ● | ● | ● | Once (final review pending) | D15 |
| R49 | Operations | Keeper dry run and research ↔ keeper equivalence: a manually triggered CI dry run with no signing key and read-only access applies the next rule to current data and compares it with main; equivalence fuzzing between keeper functions and backtest blocks; basket reconstitution rehearsed on a local chain | Zero mismatches | ● | ● | ● | ○ | Standard — qDEFI, qREV, qAI, qDUO, qTRI. The qX20 NAV keeper has no dry-run mode (U17) | D13 · D14 · D16 |
| R50 | Operations | Failing closed on degraded data: classification fetch fails → composition frozen. Price source degraded → reconstitution frozen and deferred. A constituent price missing → the mark is deferred. Both sources down → no NAV published. A three-day freshness gate on build inputs | Every failure path is confirmed by a test or a dry run | ● | ● | ● | ● | Standard; not yet applied in every keeper | D13 · D14 |
| R54 | Disclosure | "Verified" only for tests actually run; neutral verdict wording. A desk check is "verified" only when an existing test asserts it. An unsupported page sentence is replaced by a measured one | Every test claim on a page or in a rulebook carries an ID from this table and a result path | ● | ● | ● | ● | Standard | D11 · D12 |
| R56 | Disclosure | Public-surface reconciliation and the anchor verifier: site and public-repository sentences checked line by line against code, chain and live queries; the public `scripts/verify.mjs` checks the records and the anchors | Every new page sentence reconciled; zero verifier failures | ● | ● | ● | ● | Once — a full audit of the site copy. The verifier's default run covers every published record and the qX20 closes | D12 · D17 |
| R59 | Data | Price-data integrity: whether gap counts and times match across assets, opening jumps around gaps, zero-volume bars, the first listing bar excluded, hourly bars aggregated to days = daily bars | A gap table and the daily-aggregation match are in the README | ○ when price series are used directly | ○ | ● | ? | Standard (leverage, from the second version) — qBTC2X, qETH2X | D05 |
| R60 | Selection | Parameter firing count: how many times the value was hit in the sample | If zero, it is disclosed as "no power in this sample" and the value does not count as tested | ● | ● | ● | ? | Standard — qX20, qREV | D08 · D10 · D18 |
| R61 | Data | Retroactive tag edits: whether the tags attached to past snapshots were the tags of that day | The share of retroactive tags is disclosed; if it cannot be measured, "unconfirmed" | ○ backtests built on tags | ○ | – | – | Once — qAI (185 of 395 tags, 47%). Unmeasured for qDEFI | D03 · D05 |
| R62 | Backtest | Reconstitution ranking window, persistence and seat filling: changing only the ranking data, measure flash entries, entry delay and entries plus exits per year, with approximation noise as a control | The primary metric is churn; return is for reference | ○ when setting or changing the base date, notice or seat rules | – | – | – | Once — qX20 | D08 |
| R64 | Security | Key and permission separation, read from chain: the address of every privileged role and of the fee recipient, and the contract policy values, read with `eth_call` | Addresses per role and policy values equal the design table. Otherwise an action item | ● when there is an on-chain vault | ● | ● | ● | Once | D14 · D15 |

¹ Index and allocation vaults run at least one of R21 and R23, whichever fits the data. In qREV, qDEFI, qTRI and qAI the
largest-weight name is absent from a 2021–23 backtest window, so the Monte Carlo is required alongside the backtest.
**Item count**: definition 2 · data 10 · backtest 8 · Monte Carlo 4 · stress 7 · cost 2 · selection 1 · independent
verification 3 · security 5 · operations 2 · disclosure 2 = **46**. By where it has been run: standard 29 · partial 6 ·
once 11. R43 is retired; its content is U01.

**3-2. Aliases — former procedure items now in the design steps**

Documents written before 2026-10-02 (decisions, study READMEs, rulebooks, page blocks) may cite these IDs. Read each as
the design step on the right; what it does, its pass criterion and where it has been run are written there. New run
records use the D-ID instead.

| Former ID | What it was | Where it is now |
|---|---|---|
| R01 | Full parameter inventory, classed as "to be tested", "definition" or "price" | D04 (D11 and D18 pull the inventory again) |
| R12 | Pre-registration: design, grid, decision rule, simplicity order and limitations committed and pushed before any run | D06; field 4 of its registration |
| R13 | Seed hygiene | D06, field 9 (D07 follows its throwaway-seed rule) |
| R34 | Pre-registered decision rule | D06, field 11 (fixed); D10 (applied) |
| R35 | Occam fallback and its guard | D06, field 12 (fixed); D10 (applied) |
| R36 | Definition and price labels; the label for a value that differs from the decision rule's output (a judgment since 2026-10-02) | D04 and §1 of the design checklist (D10 uses the label) |
| R37 | Selection-effect disclosure | D06, field 13; D10 (one paragraph) |
| R41 | Staged review | D09 |
| R42 | Independent re-verification from a clean checkout | D09 |
| R48 | Paper index first | D13 |
| R51 | Long-run discipline | D08 (the plan is D06 field 15) |
| R52 | Irreversible actions: two reviews and a rehearsal | D16 (chain operations: D17) |
| R53 | Deployment discipline | D17 (D12 is deployed the same way) |
| R55 | The limitations section, written before the results | D06, field 14 |
| R57 | Corrections recorded, nothing filled in | D18 (standing) |
| R58 | Re-measured at the time of writing; "unconfirmed" otherwise | §2 principle 9; §1 of the design checklist (every step) |
| R63 | Publishing test outputs | D12 |

**Public files for some items** (Korean where noted):

| Items | File |
|---|---|
| R04 · R09 | <https://quadrix.finance/methodology/cap-backtest.py>, <https://quadrix.finance/methodology/qx20/snapshots/MANIFEST.json> |
| R11 | <https://quadrix.finance/methodology/qrev/supply/README.md> |
| R15 | <https://quadrix.finance/methodology/qrev/qrev-parameter-grid.csv>, <https://quadrix.finance/methodology/qdefi/qdefi-variants.csv> |
| R17 | <https://quadrix.finance/methodology/ai/ai-shuffle.csv>, <https://quadrix.finance/methodology/barbell/barbell-shuffle.csv> |
| R18 | <https://quadrix.finance/methodology/rebalance-frequency.py>, <https://quadrix.finance/methodology/qx20-band.py>, <https://quadrix.finance/methodology/rebalance-band.py>, decision [2026-09-01-rebalancing-band-removed](../trackrecord/decisions/2026-09-01-rebalancing-band-removed.md) |
| R19 | <https://quadrix.finance/methodology/ai/sanity-check.py> |
| R21 · R24 · R38 · R39 · R40 · R60, with design D06 and D10 | <https://quadrix.finance/methodology/qx20/cap-mc/README.md> (Korean), <https://quadrix.finance/methodology/qx20/cap-mc/results.csv> |
| R23 | <https://quadrix.finance/methodology/qrev/qrev-montecarlo.csv>, <https://quadrix.finance/methodology/barbell/barbell-montecarlo.csv> |
| R30 | <https://quadrix.finance/methodology/qrev/qrev-event-trigger.csv> |
| Design D13 (formerly R48) | the paper-index inception decisions in [`trackrecord/decisions/`](../trackrecord/decisions/) |
| R56 | [`scripts/verify.mjs`](../scripts/verify.mjs) |
| Design D18 (formerly R57) | decision [2026-09-28-qx20-toncoin-ticker-note](../trackrecord/decisions/2026-09-28-qx20-toncoin-ticker-note.md) |

## 4. Link to the vault pages

- Each vault page is to carry a block, "How far these rules were tested", with the IDs from this table that were run,
  the ones that were not, notes, and the result files. The block is being built and is not live yet.
- The block publishes the run record as it is, including the IDs not run.

## 5. Not yet run (not required)

| ID | What | Status |
|---|---|---|
| U01 | Occam pass on contracts: count external calls, roles, public functions and admin powers, and require no more than the previous version | Proposed |
| U02 | Keeping each classification source's raw response with its sha256 | Required by the rulebooks; not implemented |
| U03 | A guaranteed keeper execution interval, delay alerts, and "de-leverage first when the interval is exceeded" | Written as a launch condition for leverage; not built |
| U04 | Re-verification by models from other vendors and by external AI audit products | Planned only |
| U05 | Testing special-situation trigger B (supply released from controlled addresses) | Not done |
| U06 | Alternative values for the volume floor ($5M, $20M) | Not run |
| U07 | Walk-forward and holdout splits | In no vault study. The only out-of-sample evidence is the paper record |
| U08 | Formal verification | A gate before mainnet; not run |
| U09 | Mutation testing to measure the strength of the invariant suite | Partly, inside the adversarial tests only |
| U10 | N-version differential verification of the keeper's publishing path | In research only |
| U11 | Quantifying blast radius and attack economics; fault injection; a cap ladder; a bug bounty | Listed only |
| U12 | A cost model with market impact and assets under management | Costs are linear |
| U13 | Depth stress on Monte Carlo paths | Not done, by design |
| U14 | Bars shorter than one hour | A check interval that is not a whole number of hours cannot be judged |
| U15 | Liquidation tested at the oracle price | Bars come from one exchange only |
| U16 | Item-by-item match check of the exclusion lists, with identifier cross-checks | Open |
| U17 | A dry-run mode for the qX20 NAV keeper | None |
| U18 | A fallback that removes dominated variants first | Candidate for the next leverage pre-registration |
| U19 | Static analysis of the contracts | Not set up |
| U20 | Market-path Monte Carlo for the contracts' economic parameters (mark band, fill-loss limit, daily loss budget, per-transaction creation cap, reference-price age) | A harness exists only |
| U21 | Combination fuzzing: known attack primitives combined in random order and size | None |
| U22 | A static-margin formula for inverse products | None |
| U23 | Public proof of pre-registration: the registration's hash recorded in a public repository or a timestamp before the run | Proposed. Registration commits are in a private repository today, so an outside reader cannot check the order |
| U24 | Key and permission separation (multisig, timelock, guardian) | Design drafted; not yet decided |
| U25 | The citation-check script (refuses uncited values at commit, in CI and before an anchor) | Implemented; runs as a report only and is not wired into commits, CI or anchoring. To be wired in once the existing rulebooks carry their citation tables; none does yet |
