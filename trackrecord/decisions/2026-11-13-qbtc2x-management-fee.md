# qBTC2X — the management fee is 1% a year, a price set on 2026-10-13; recorded 2026-11-13

> DRAFT · NOT ANCHORED. The date in the file name must be the UTC day of the anchor. Values in ⟨ ⟩ are filled after the final commits.

**Decided:** 2026-10-13 (owner). **Written:** 2026-11-13. **Effective:** 2026-11-13 — the ledger's `effectiveFrom`
is the date in the file name; the fee has been the owner's decision since 2026-10-13, and nothing in the series
changes on either date. **Series:** `trackrecord/record-qbtc2x.jsonl` — unchanged. All dates are UTC unless marked.

## What this document does

It records one decision: the management fee of BTC 2x (ticker qBTC2X) is 1% a year. It replaces the two
sentences of the anchored decision `2026-10-13-qbtc2x-paper-inception` that say no management fee has been set,
and the lines of the rulebook that say the same. It changes no rule of the level, no record line and no value
of the vault.

Anchored documents are not edited. The file `trackrecord/decisions/2026-10-13-qbtc2x-paper-inception.md` is
unchanged (sha256 `3ffc004d025f68b1f955cd1f5ece8ae028cadbc5e500d15dc28bd1e4318177eb`). This document is anchored
beside it.

## The fee

- The management fee of qBTC2X is 1% a year.
- It is a price, set by the owner on 2026-10-13. It is not a tested value and no test chose it.
- It can only be lowered. 1% a year is the ceiling; a contract that charges the fee will allow a lower rate
  and no higher one.
- It is not collected. The stage A level has no fee term, so the published level is before the fee. The testnet
  mark vault `0x8b0200B7e920a7fB06e94890d5Efb6aB7d2C1378` (GIWA Sepolia, chainId 91342) runs a contract with no
  fee function: `keeper/artifacts/QuadrixIndexVault.json` (sha256
  `c32bb1b1ff3ec7858cce1a6ababc073290b58ede04c17292a9b2fff56666edeb`) lists no function or event that charges,
  accrues or pays a fee.
- No date is set for collecting it. A contract that charges it is a later decision.

## What it replaces

In `2026-10-13-qbtc2x-paper-inception`:

1. "What the level assumes in place of a market", line 145: "**Fees.** No management fee is applied; none has been set."
2. "Tested, and not tested (pinned)", line 216: "P18 management fee — none in stage A (recorded as
   fees.managementBps 0 in the rulebook JSON)".

The statement that replaces both: the management fee is 1% a year (a price set by the owner on 2026-10-13; it
can only be lowered). It is not collected: it is not applied to the stage A level, so the published level is
before the fee, and the mark vault has no fee function.

"No management fee is applied" stays true of the level. "None has been set" was true when that decision was
anchored (2026-10-12T03:38:50Z) and stopped being true on 2026-10-13, when the owner set the fee.

In `rulebooks/qbtc2x.md`, the same change in five places: section 2 (row P18), section 11, appendix B (row D15),
appendix C (the fee row) and appendix P (row P18). The rulebook's multiples carry no management fee, before and
after; that sentence stays.

## Why it is recorded now

The owner set the fee on 2026-10-13, the day after the inception decision was anchored. The site has stated
the fee since that day: its production deploy of 2026-10-13T08:14Z carried the fee statement. This repository was not
updated: for 31 days the anchored decision and the rulebook said that no fee had been set, and the keeper JSON
recorded none in stage A, while the site said 1% a year. The difference was found on 2026-11-12. This document
records the fee. The keeper JSON stays as written, for the reason given below. The same fee was recorded for qETH1.5X at its inception
(`2026-10-16-qeth15-paper-inception`); qBTC2X was missed.

## What does not change

- **The level and the record.** No line of `trackrecord/record-qbtc2x.jsonl` changes, and no later line is
  computed differently. `keeper/leverage-step.mjs` and `keeper/leverage-index.mjs` read no fee value. The 31
  lines dated 2026-10-13 to 2026-11-12 verify as before:
  `node scripts/verify.mjs --dir ./trackrecord --series qbtc2x --recompute-only` reports 0 failures.
- **The vault.** No transaction is sent because of this document. The share price is still marked to the level
  (level ÷ 100); nothing is deducted from it.
- **The tests.** Every multiple and drawdown in the rulebook and in the inception decision was computed without
  a management fee and is stated that way. A holder who paid 1% a year would have had less than those figures.
- **Every other value** of `2026-10-13-qbtc2x-paper-inception`, including its table of tested and untested
  values, except row P18.

## The rules in force (pinned)

The rulebook is `rulebooks/qbtc2x.md` at commit `⟨rulebook commit⟩` of this repository (sha256
`⟨rulebook sha256⟩`). This decision amends it only in the five places named above, in appendix R (a line that names this amendment's
checklist run record) and in its date line. The
inception decision's pin of the rulebook (commit `bada86dd70bff5b3b6890e2dea4fec759731c13a`, sha256
`219987e23ae7cf398b5e2419b91b22eb9686c126c8ad5c75174e702fd02a42ae`) stays true of the file at the commit it
names.

`keeper/rulebooks/qbtc2x.json` does not change (sha256
`ae8db495ba8bb9336aa598d8ef4ff36d51c7335cfe77de702ce74c525235ce88`). The keeper and `scripts/verify.mjs` bind
every line of this series to that file through the inception decision, so one changed byte would stop the
series. Its key `fees.managementBps` stays 0 and its note "no management fee in stage A" stays as written: they
are the record of the owner's decision of 2026-10-05. The owner's decision of 2026-10-13 replaced that decision.
This document records the decision of 2026-10-13. The key drives nothing.
The fee in force is the one stated here.

`keeper/rulebooks/qbtc2x.provenance.json` is rewritten with this amendment (sha256 `⟨provenance sha256⟩`): it
names the amended rulebook and this decision's checklist run record, and its row P18 names this decision. The inception decision's pin of the provenance
file (sha256 `fd88061d162feb868717dd9ce2d298be60ed86ae9756faef796af129cc161f17`) stays true of the file at the
commit it names. The gate report `rulebooks/qbtc2x.gate.json` is written again for the amended rulebook
(below); the inception decision's pin of that report stays true of the file at the commit it names.

## Tested, and not tested (pinned)

Parameter citation table: appendix P of `rulebooks/qbtc2x.md` (pinned above); keeper provenance
`keeper/rulebooks/qbtc2x.provenance.json` (pinned above). Checklist run record:
`docs/methodology/checklist-runs/qbtc2x/2026-11-12.json` (site repository, private; sha256 `⟨run record sha256⟩`).
Every evidence file it pins can be published: the keeper tests, the two dry runs, the verifier output, the word
scan and the two review summaries written for this decision are in `docs/methodology/checklist-runs/qbtc2x/evidence/`
of the site repository, each with its sha256 in the run record; the rows of the level's tested values carry the
result files of the inception's tests, unchanged. The run record names no internal file. The inception's run record of 2026-10-12 stays as the inception decision
pinned it; this record names it only as the source of the rows it carries, and does not pin that record by sha256.
The inception decision said that before the next anchored decision the run record would pin only evidence that
can be published; five decisions have been anchored since then, and that run record was not changed.
This record keeps that promise late: the record of 2026-10-12 is not edited, and this new record carries the
evidence instead. Gate report:
`rulebooks/qbtc2x.gate.json` (sha256 `⟨gate report sha256⟩`).

| Basis | Count | Parameters |
| --- | --- | --- |
| Tested — pre-registered backtest and Monte Carlo | 1 | P06, unchanged |
| Partly tested — backtest only, or run without pre-registration | 0 | — |
| Definition | 4 | P01, P02, P03, P22, unchanged |
| Price | 1 | P18 management fee 1% a year (owner, 2026-10-13; can only be lowered; not applied to the stage A level, not collected) |
| Not tested | 18 | unchanged — the 18 values listed in `2026-10-13-qbtc2x-paper-inception`, with the reasons given there |

Values this decision introduces or changes: one, P18. It is a price. None is "not tested" or "partly tested".
A price is not a tested value: a lower fee is better for the holder at any level, so no test chooses it.

The citation gate (report-only) does not pass this decision. Its report for the amended rulebook reads
"fail" with ⟨20⟩ violations. ⟨19⟩ are the ones the report carried before this decision: the checklist run
record of 2026-10-12, which the rows of the inherited tested values cite, is in an earlier form than the gate
now reads (C4). One is new (C5): row P18 states 1% a
year and the keeper JSON key it points to holds 0, for the reason given above. The report counts P18 as the one
changed value and counts no untested value among the changed.
This decision's run record leaves the public block and the public copies of the result files not done (D12),
and carries the product hypothesis (D01) as the inception's run record left it (C4, three); the report above does
not count that record, and this decision is anchored with these stated, on the path of
`2026-10-22-qeth15-mark-vault`.

Checks not run for this product, and why: no new test — P18 is a price (D05 to D10 not applicable); holdability
of collateral and debt on GIWA (R08) — not applicable, stage A holds none; security items R44–R47 — not
applicable, no code changes. Steps of this decision's run record that close after the anchor, in a later dated
follow-up run record of this product: the gate report for the amended rulebook (D11), the anchor of this document
after its two reviews and its rehearsal (D16), the one site sentence that quotes the rulebook's "none in stage A"
(D17), and the check that this decision, the rulebook, the site and the keeper JSON state P18 alike (D18).

Judgments: none.

## How to verify

1. The inception decision's two sentences: `trackrecord/decisions/2026-10-13-qbtc2x-paper-inception.md` at its
   anchored hash, lines 145 and 216.
2. The keeper JSON is unchanged: `shasum -a 256 keeper/rulebooks/qbtc2x.json` returns the value above, and
   every line of `trackrecord/record-qbtc2x.jsonl` carries it as `rule.rulebookSha256`.
3. No fee in the level: at the commit pinned below, `grep -ci fee keeper/leverage-step.mjs keeper/leverage-index.mjs`
   returns 0 for both.
4. No fee function in the vault: at the commit pinned below, the `abi` of `keeper/artifacts/QuadrixIndexVault.json`
   (sha256 `c32bb1b1ff3ec7858cce1a6ababc073290b58ede04c17292a9b2fff56666edeb`) has no function or event whose name
   contains "fee" (31 functions, 11 events); the vault's code is compared with that artifact by `keeper/deploy-mark-vault.mjs`.
5. The series: `node scripts/verify.mjs --dir ./trackrecord --series qbtc2x --recompute-only`.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `2026-10-13-qbtc2x-paper-inception` (`trackrecord/decisions.jsonl`) | sha256 `3ffc004d025f68b1f955cd1f5ece8ae028cadbc5e500d15dc28bd1e4318177eb`, tx `0x822c2aa6f0c16140f24725e2d2fb43121e10f163f4afef26cfb43a2c1177a2cf`, anchored 2026-10-12T03:38:50Z |
| `rulebooks/qbtc2x.md` | commit `⟨rulebook commit⟩`, sha256 `⟨rulebook sha256⟩` |
| `keeper/rulebooks/qbtc2x.json` | sha256 `ae8db495ba8bb9336aa598d8ef4ff36d51c7335cfe77de702ce74c525235ce88` (unchanged) |
| `keeper/rulebooks/qbtc2x.provenance.json` | sha256 `⟨provenance sha256⟩` |
| `rulebooks/qbtc2x.gate.json` | sha256 `⟨gate report sha256⟩` |
| `docs/methodology/checklist-runs/qbtc2x/2026-11-12.json` (site, private) | sha256 `⟨run record sha256⟩` |
| quadrix-track-record, HEAD at pinning | `⟨record commit⟩` |
| quadrix (site, private — the commit the gate report was run on) | `⟨site commit⟩` |
