# Vault design checklist

Working version. The name is provisional.

The order in which a vault is to be built. Run it once, top to bottom; each step calls items from the robustness
catalogue ([`robustness-tests.md`](robustness-tests.md)). The result goes into one run record per vault or amendment.
The rule from 2026-10-01 is that a new vault or a rule amendment is not anchored or deployed without that record; it
is a rule, not a mechanism (§5). No run record has been completed yet, and the vaults that exist today were built
before this checklist (see the column "Where it has been run").

## 1. How to use it

- Every new vault, new index and rule amendment runs from D01. A rule amendment may start at D04, but D06–D11 and D16
  cannot be skipped.
- **Who decides.** *Data*: the output of a decision rule registered before the run. *The operator*: Quadrix decides.
  *Definition*: not subject to testing, and labelled as such (universe, data source, excluded asset classes). Prices
  (fees) are decided by the operator.
- A step's output stops at "applying the decision rule gives …". It is an input to a decision, not the decision.
- **Where it has been run.** *Standard*: done the same way in more than one product or study. *Partial*: only part of it
  has been done (the missing part is named). *Once*: done in one place only. *Not yet*: the step has never been done at
  that point in the process.

## 2. Steps

| ID | Step | What it produces | Pass criterion | Who decides | Robustness items called | Where it has been run |
|---|---|---|---|---|---|---|
| D01 | Product hypothesis and question | One paragraph at the head of the rulebook: what exposure; the one question this vault answers; benchmarks (BTC, ETH, the closest existing product); the conditions under which it will not be built | The question is written so that numbers can refute it. The rulebook states whether the product's standard is "beat the market" or "track the category". If a similar product exists, R03 is measured | The operator | R03 | Standard for the conditions under which a product will not be built (every rulebook has them). Whether the general standard is "beat the market" or "track the category" is not yet settled |
| D02 | Holdability on GIWA | A holdability table per candidate asset: GIWA-native / canonical bridge / not holdable; issuer powers; reserves and redemption (C1, C2) | Zero third-party-bridge or privately wrapped assets. A vault can hold at least the rulebook's minimum number of names (five so far). A paper index carries an information column plus a count of unconfirmed items | Definition (GIWA-native and canonical bridge only); exceptions: the operator | R08 | Partial: one full census of BTC representations; sector indexes carry an information column only |
| D03 | Universe definition | The source pair in one line, the rule for excluded asset classes, the mapping table, and a check of the five conditions for an eligible source | Both sources are independent, public, machine-readable, have history, and publish how they edit. Today's basket is the intersection. If only one source can be used for the backtest, that is disclosed and R61 is run | Definition (adopted by the operator) | R05 · R10 · R61 | Standard — qDEFI, qREV, qAI. Keeping the raw source responses is not implemented (U02) |
| D04 | Full parameter inventory and classification | The skeleton of the citation table: a P-ID for each value, its class (to be tested / definition / price), and whether a point-in-time input exists | Every value that will go into the rule is one row. Definition and price rows carry the operator's decision source. A numeric value is never classed as a definition | Definitions and prices: the operator; the rest: data | R01 · R02 · R36 | Not yet as a step before launch; so far only as an audit after launch |
| D05 | Data | Committed input snapshots, `MANIFEST.json` (sha256, endpoint and fetch date per file), the fetch scripts, an integrity table, and the eligible count on each reconstitution date | A re-run without network gives the same output. Names that later died are included (point in time). If the data is too large to commit: sha256, the refetch command, and the result of a byte comparison | Data | R04 · R06 · R07 · R09 · R10 · R11 · R59 · R61 | Partial — qX20 snapshots and the qBTC2X / qETH2X hourly bars only; not yet for the other index studies |
| D06 | Pre-registration | The registration section of the study README (the 15 fields in §3), committed and pushed; the registration commit hash; the list of P-IDs this study decides | The registration commit is an ancestor of every result commit. Policy values and the decision rule are fixed after the operator confirms them. After registration nothing is edited; changes are appended as a list | The operator confirms the design | R12 · R13 · R34 · R35 · R37 · R51 · R55 | Standard (since 2026-09-29) |
| D07 | Checks and smoke run | A checks section: reproduction of the previous version, closed forms, sanity bounds, random-number comparison. Smoke runs use throwaway seeds only | If any required check fails, the main run does not happen | Data | R13 · R19 · R38 · R39 | Standard for leverage; partial for indexes |
| D08 | Run | Grid and Monte Carlo result files, shards, `MANIFEST.sha256`, `DONE` | A `DONE` commit exists. Two runs are byte-identical. Every ● item for the product type is "run", or "not applicable" with a reason. Heavy runs go to cloud sessions | Data | R04 · R06 · R07 · R14–R18 · R20–R33 · R40 · R51 · R60 · R62 | Standard |
| D09 | Independent verification | An independent verification report made from a clean checkout by a verifier other than the author; a comparison with an independent reimplementation; the review record (number of corrections) | Registration precedence confirmed; deterministic steps re-run and match; recombined results byte-identical. The final review is by a reviewer other than the author | Data (the verifier) | R39 · R40 · R41 · R42 | Partial — an independent re-run has been done for one leverage study; not yet required for every study |
| D10 | Selection | A selection table per parameter: the decision rule's output, P, median, firing count, standard errors to the threshold, the value to enter | Only the decision rule's output goes into the rule. If the result is "indistinguishable", the value first in the registered Occam order. If the fallback picks a dominated variant, it is not a pass → a new pre-registration. A value that fired zero times does not count as tested | Data → adopted by the operator. If the operator picks a value other than the output: R36 label and a decision document (whether this route is permitted is not yet settled) | R24 · R34 · R35 · R36 · R37 · R60 | Standard. One fallback issue in a leverage study is open (U18) |
| D11 | Rulebook | The rulebook, its appendix "parameter citation table", the keeper rule JSON, and the provenance file | The citation check passes: every value has a citation or a definition / price label. Rulebook = keeper JSON = harness. A limitations section. The public-wording rules are met | The citation check (designed, not implemented — U25) | R01 · R02 · R36 · R54 · R55 · R58 | Rulebook: standard. Citation table: not yet |
| D12 | Page block and CSVs | Data for the "How far these rules were tested" block (what was tested, what was not, files); CSVs under `/methodology/<product>/`; the list of what is not published | The block equals the run record. Every file behind a button exists and is byte-identical to the research folder. Sentences are checked line by line. Staging → preview → operator confirmation | The operator (it is published) | R53 · R54 · R56 · R63 | Not yet: the block is being built. CSV publication: partial |
| D13 | Paper index first | The keeper leg, `keeper/rulebooks/<index>.json`, dry-run logs, the record chain | Zero mismatches over at least two dry runs. Research ↔ keeper equivalence. Fails closed on every failure path. Vault and third-party money only after the record | The operator confirms (the inception anchor is D16) | R02 · R05 · R48 · R49 · R50 | Standard — qDEFI, qREV, qAI, qDUO, qTRI |
| D14 | Keeper and operating assumptions | A table of operating assumptions: (a) the execution interval the rule assumes, against the measured interval; (b) missed-run and delay alerts; (c) behaviour when degraded; (d) keys and permissions per role, read from chain | The run environment guarantees the assumed interval, or the rulebook states what happens when it is exceeded. An alert catches "did not run at all". Addresses and policy values per role equal the design table | Data (measured); key structure: the operator | R28 · R49 · R50 · R64 · U03 · U24 | Failing closed on degraded data: standard. The interval and the roles: measured once, after deployment. Not yet as a step before launch |
| D15 | Security gate | Verdicts from the invariant register; incident-pattern replay and adversarial proof-of-concept results for new code and new external dependencies; an audit plan (tooling, external) | Zero regressions against the baseline. An action for every "contrary to the document" and "not implemented". An action and a schedule for every confirmed break. No new code → "not applicable" with a reason. Before mainnet: external audit, bug bounty, formal verification of the core invariants | Data (tests); acceptance of residual risk: the operator | R08 · R44 · R45 · R46 · R47 · R64 · U01 · U08 · U19 | Once, after deployment. Not yet as a gate before launch |
| D16 | Inception decision and anchor | A decision document: effective date; pins (rulebook commit and sha256, keeper JSON sha256, keeper commit); a "Tested, and not tested" section; limitations | Two independent reviews, a rehearsal, and the operator's confirmation of the text. The files are on main. Anchored one at a time. The gate report passes. Zero untested values among the values introduced or changed | The operator (the text) | R49 · R52 · R57 | Two reviews, rehearsal and hash pinning: standard. "Tested, and not tested" section and gate report: not yet |
| D17 | Deployment and site | Testnet deployment (chain operation), page cards and badges, headline numbers | Chain operations: two reviews and a rehearsal. Staging → preview → local write-API test at least twice → main → production recheck. No operator wallet address in the site's client bundle. Zero verifier failures | The operator confirms | R53 · R56 | Standard |
| D18 | Post-launch rule audit | An audit record: citation table re-checked, firing counts updated, the register of untested values, corrections | Every untested value and every mismatch has a test order or an action. A rule that is not best under test is removed at the next amendment | Data → the operator | R01 · R02 · R57 · R60 | Once as a full audit, once as a scope review. Proposed cadence: before every rule amendment, once per reconstitution quarter, and immediately when a mismatch is found |

Public files that show some of these steps done: the qX20 committed monthly snapshots and their manifest (D05) —
<https://quadrix.finance/methodology/qx20/snapshots/MANIFEST.json>; a decision rule fixed and committed before the
results, with its checks and selection (D06, D07, D10) — <https://quadrix.finance/methodology/qx20/cap-mc/README.md>
(Korean); paper-index inception decisions (D13, D16) —
[qDEFI](../trackrecord/decisions/2026-09-16-qdefi-paper-inception.md),
[qREV](../trackrecord/decisions/2026-09-16-qrev-paper-inception.md),
[qAI](../trackrecord/decisions/2026-09-22-qai-paper-inception.md),
[qDUO](../trackrecord/decisions/2026-09-22-barbell-paper-inception.md),
[qTRI](../trackrecord/decisions/2026-09-22-triens-paper-inception.md).

## 3. Required fields of a pre-registration (D06)

| # | Field |
|---|---|
| 1 | Hypothesis and question (the P-IDs this study decides) |
| 2 | Inventory: values in force, their source, whether a point-in-time input exists |
| 3 | Data and sha256; what is point in time and what is a proxy |
| 4 | Everything run before the registration |
| 5 | Engine and settings (current settings / previous harness settings) |
| 6 | Grid (combinations left out, and why) |
| 7 | Windows and benchmarks (BTC, ETH) |
| 8 | Cost scenarios and the headline scenario |
| 9 | Monte Carlo specification: sampling unit, block length, number of paths, seeds and overlap check, common random numbers, seam rule |
| 10 | Checks (if any fails, no run) |
| 11 | Decision rule: the conditions for "best", the headline scenario |
| 12 | Occam order and guard: simplicity order per parameter, definition of dominance, a dominated fallback is not a pass |
| 13 | Selection-effect disclosure (a target chosen after seeing results; a rule chosen on the same sample) |
| 14 | Limitations (written before the results, not edited after) |
| 15 | Run plan: shards, expected time, cloud, wording rule ("applying the decision rule gives …") |

## 4. Differences by product type

| Type | Steps that change |
|---|---|
| Index | D03 required (sector indexes). In D08, at least one of R21 and R23, plus R17, R18, R32 |
| Allocation | D03 is the definition of the sleeve assets. The ratios also go through D06–D10. In D08, R23 |
| Leverage | D02 covers collateral and borrowed assets. D05 includes R59. In D08, R20, R22, R25–R29, R33. D13 starts at stage A (paper level plus a marked vault). The interval guarantee in D14 is a launch condition |
| Discretionary | D04, D11, D12 and D14–D18 apply. How D05–D10 apply is not yet defined |

## 5. Where the process stops

| Point | What stops it when missing | How it is meant to stop | In place? |
|---|---|---|---|
| D06 → D08 | The pre-registration commit | A check that the registration commit is an ancestor of the first commit of each result file | No — designed (U25) |
| D09 → D10 | The independent verification report | The selection table cannot be cited while the run record names no verifier and no report | No — designed (U25) |
| D11 | A value without a citation | The citation check fails and the commit is refused | No — designed (U25) |
| D12 | A file behind a page button | The first step of the site build fails | Yes, for the download files on candidate pages |
| D16 | The gate report or the run record | The anchoring workflow refuses the decision | No — designed (U25) |

## 6. The citation table

Each rulebook is to carry an appendix, "Parameter citation table", with one row per value; the value in the rulebook
text carries its P-ID (for example `[P07]`). P-IDs are unique within a rulebook and are not reused after an amendment.

| Column | Content | Required for |
|---|---|---|
| P-ID | Unique within the rulebook | every row |
| Parameter and value | Name and value in force, with units | every row |
| Basis | One word from the vocabulary below | every row |
| Tests | The R-IDs run, and the study folder | tested, partly tested |
| Result file and sha256 | The result file that set the value, with its full sha256 | tested, partly tested |
| Pre-registration | The registration commit hash | tested |
| Selection | "Rule output", or "operator decision (differs from the output)" | tested |
| Decision source | The decision document ID or date | definition, price, operator decision |
| Run record | The checklist run record | tested, partly tested |
| Keeper location | The keeper JSON path, or the code constant | when the keeper uses the value |

**Basis vocabulary**

| Basis | Meaning |
|---|---|
| tested | Set by the decision rule of a pre-registered backtest and Monte Carlo (registration committed before the results) |
| partly tested | A backtest only, or run without pre-registration. Cannot be used for a new or changed value |
| definition | Universe, data source, excluded asset classes. Cannot be used for a numeric value |
| price | Fees |
| absent | The rule does not exist (no band, no hysteresis). Not a value, so nothing to cite. Whether this exemption stands is not yet settled |
| not tested | Never tested. Allowed only for values in force before 2026-10-01 |

A provenance file per index (`keeper/rulebooks/<index>.provenance.json`), carrying the same rows for the keeper JSON, is
planned; it does not exist yet. The keeper JSON files already pinned by anchored decisions are not changed.
