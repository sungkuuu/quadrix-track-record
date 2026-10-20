# qETH1.5X testnet mark vault, 2026-10-22

**Effective:** 2026-10-22 (UTC). **Series:** `trackrecord/record-qeth15.jsonl` (unchanged). **Vault registry:** `keeper/leverage-vaults.json`, entry `qeth15`.

## What starts today

A testnet vault on GIWA Sepolia (chainId 91342), ⟨address⟩, created on 2026-10-21 in ⟨deploy tx⟩ (block ⟨…⟩)
with deposit cap 0, has its share price marked to the qETH1.5X level (level ÷ 100) once a day, after the day's
line is anchored, by the keeper's daily run. Its first mark, to line ⟨6⟩ (dated 2026-10-22), was sent on
2026-10-22 in ⟨tx⟩ and checked by a person against that line. It holds test dollars only — no ether and no
debt — and issues and redeems at the marked price. It displays the level; it is not the book. It runs the
contract of the testnet vaults redeployed on 2026-10-21 (decision ⟨redeployment decision id⟩), the same code as
the redeployed qBTC2X mark vault; that contract's comments describe qX20. Owner and keeper at deployment: the
keeper key; guardian: `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3`, the guardian of the redeployed vaults.
Deposits open on 2026-10-22, after this decision is anchored, up to 1,000,000 test dollars — an exposure limit,
set from a stated loss tolerance, not by a test. On the day deposits open, ownership starts passing to the
timelock of the redeployed vaults, which can accept it 72 hours after the scheduling transaction.

Decision `2026-10-16-qeth15-paper-inception` stated that no testnet vault follows this level yet and that a
later decision sets the vault, its deposit cap and its mark gate. This is that decision. The rule, the level,
the record lines and the pinned keeper files of that decision do not change.

## The rules in force (pinned)

The rulebook is `rulebooks/qeth15.md` at commit ⟨…⟩ of this repository (sha256 ⟨…⟩). This decision amends it
only where it said that no vault exists — the status line, sections 2, 9B, 9C, 10, 11, 12 and 13, and appendices
B, C, P and R: the vault, its deposit cap (P19) and its mark gate (P24) are stated there now. The rule of the
level does not change. The inception decision's pin of the rulebook (commit
`3b355eaf3a8d55856b979fda706a40d3bf986a89`, sha256 `c48aaec5595a2ee4423f13597e8aaf441bde5f47d2f2e2af319e7b3ecdb27409`)
stays true of the file at the commit it names.

`keeper/rulebooks/qeth15.json` does not change (sha256
`b417ca3d96f897cf8ce926642d06ca0712d5122455ed3f54fcb1bd8e9e384fde`). The keeper and `scripts/verify.mjs` bind
every line of this series to that file through the inception decision, so one changed byte would stop the
series. Its two sentences that no vault follows the level and that there is no vault to charge the fee stay as
written; this decision states the fact. Neither value this decision sets is read from that file: the mark gate
is in the vault registry and the deposit cap is on chain. `keeper/rulebooks/qeth15.provenance.json` is rewritten
with this amendment (sha256 ⟨…⟩): it now names the amended rulebook and this decision's checklist run record and
holds the rows of P19 and P24; the keeper JSON does not change. The inception decision's pin of the provenance
file (sha256 `49d7b93ae7991857e95756bd30c613f7c9df480539c9dac750f912025a2f2543`) stays true of the file at the
commit it names. The gate report
`rulebooks/qeth15.gate.json` is written again for the amended rulebook (below); the inception decision's pin of
that report stays true of the file at the commit it names.

## The vault at deployment

- Contract: `QuadrixIndexVault`, built from the site repository (private) at commit ⟨…⟩ — the build the
  redeployment decision pins. Runtime code 6,135 bytes; its code hash, ⟨…⟩, equals that of the redeployed
  qBTC2X mark vault ⟨address⟩ (its one immutable value, the test dollar, is the same).
- Deployed by `keeper/deploy-mark-vault.mjs` (sha256 `94263084aff6afad3c89e2382a3f7bd893d1076499e66fc594cf9b1682db87fb`) through the workflow `mark-vault-setup`, from the
  artifact `keeper/artifacts/QuadrixIndexVault.json` (sha256 `c32bb1b1ff3ec7858cce1a6ababc073290b58ede04c17292a9b2fff56666edeb`). The tool refuses unless the artifact has the
  code shape of the qBTC2X mark vault named in the registry, whose symbol is qBTC2X and whose guardian is not 0.
- Constructor: test dollar `0xf70B2b744eE604728D661b7D07460843DBD1be76`, name "Quadrix ETH 1.5x Vault",
  symbol `qETH1.5X` (the rulebook JSON's ticker; the keeper refuses to mark a vault whose symbol differs),
  deposit cap 0, manager the keeper key `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` (owner and keeper).
- Then, in a second transaction, `setGuardian(0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3)` (tx ⟨…⟩). The tool
  writes the address into the registry only after both transactions are read back.
- Read back at block ⟨…⟩: share price 1.000000, supply 0, deposit cap 0, deposits not paused, owner = keeper =
  the keeper key, pending owner 0, guardian `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3` (≠ 0, ≠ keeper,
  ≠ owner, no role on the timelock).

## Order

1. 2026-10-21, after the redeployment of the eight vaults, its read-back and the retirement of the old vaults:
   a dry run, then the deployment above and its read-back. Before it, on a GIWA Sepolia fork taken after the
   redeployment, the keeper's rehearsal deployed the three mark vaults with their guardian and checked the
   qETH1.5X vault's symbol and guardian; on that fork the qETH1.5X vault itself then had one mark, deposits
   opened, a deposit and a redemption (⟨rehearsal record⟩).
2. The deploying workflow writes the address, transaction and block into `keeper/leverage-vaults.json`, entry
   `qeth15`, with the mark gate below; from then on the daily run marks the vault after it writes and anchors
   the day's line.
3. 2026-10-22, the daily run of 00:25 UTC: line ⟨6⟩ is written and anchored, then the first mark moves the
   share price from 1.000000 to that line's level ÷ 100, ⟨in n step(s)⟩ (tx ⟨…⟩). A person compared the
   vault's share price with that line before this decision was anchored.
4. This decision is anchored, and the vault page shows the deposit screen below.
5. Deposits open on 2026-10-22, after (4): the keeper key, still the vault's owner, raises the deposit cap from
   0 to 1,000,000 test dollars.
6. The same day, after (5): the keeper key proposes the timelock of the redeployed vaults, ⟨timelock address⟩,
   as the vault's owner, and the timelock's proposer — a hardware key held by the owner — schedules the
   acceptance. The timelock can accept 72 hours after the scheduling transaction. Deposits open before the
   handover because, once the timelock owns the vault, a change of the deposit cap waits 72 hours. The
   transactions of (5) and (6) and the acceptance come after this anchor; they are recorded in a later dated
   checklist run record of this product.

## The deposit screen

Every deposit first opens a confirmation that shows the rulebook's two head disclosures — the facts to read
first, and the holding period and costs — and the deposit stays disabled until the depositor ticks the
acknowledgement. Nothing is remembered between deposits. The wording is the vault page's, as published before
deposits open.

## Marks

The mark gate (P24), `{"mode":"step"}` in the registry: marks in steps within the contract's 25% bound per
transaction, never stopping on size — the gate of the qBTC2X mark vault. It is an exception decided by the
owner on 2026-10-19 for the testnet stage, not a tested value (below). A 15% stop failed the pre-registered
stress study for the ether book it measured (re-levered to 2.2 every 60 minutes: 1.25 × its worst 14-hour move
is 211%); this rule's book was not measured, and no test chose "no stop".

After an accepted model liquidation the keeper's marks step the vault down to the contract's floor. Until the
timelock owns the vault, the keeper key also closes it to deposits at once. Once the timelock owns it, the one
way to stop deposits at once is the guardian's `disableKeeper`, which also stops the marks; a change of the
cap or of the pause waits 72 hours.

## Roles

| Role | Address | Who holds it | What it can do |
| --- | --- | --- | --- |
| Owner | the keeper key until the timelock accepts; then the timelock of the redeployed vaults, ⟨address⟩ | the timelock: delay 72 hours, proposer a hardware key held by the owner (as stated in the redeployment decision) | deposit cap, pause, keeper and guardian appointment |
| Keeper | `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` | the keeper key | marks |
| Guardian | `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3` | a hardware key held by the owner | `disableKeeper` only |

The vault refuses deposits while the keeper address is 0; redemption continues at the last mark. The timelock
delay of 72 hours is the redeployment decision's owner decision; this decision does not set it.

## Tested, and not tested (pinned)

Parameter citation table: appendix P of `rulebooks/qeth15.md` (pinned above); keeper provenance
`keeper/rulebooks/qeth15.provenance.json` (sha256 ⟨…⟩). Checklist run record: `docs/methodology/checklist-runs/qeth15/2026-10-22.json` (site repository, private;
sha256 ⟨…⟩). Every evidence file it pins can be published: the role read-back after deployment, the fork
rehearsal, the deposit-screen check and the two pre-launch reviews are in
`docs/methodology/checklist-runs/qeth15/evidence/` of the site repository, each with its sha256 in the run
record; the two measurements below are in this repository. The run record names no internal file. Track:
trading tool, as in the inception decision. The owner decisions this decision cites are quoted in this
repository at `docs/owner/qeth15-decisions-2026-10-19.md` (sha256 `b670d3b21bd38489d70718b337fbe4274645ddcb386ba19bd344a3d0d46e941d`).

Values this decision introduces: two, P19 and P24. Values not tested among them: none. Every other value of the
rule is unchanged from the inception decision; the table below counts the whole amended rulebook (appendix P).

| Basis | Count | Parameters |
| --- | --- | --- |
| Tested — pre-registered backtest and Monte Carlo | 2 | P06 trigger λ ≥ 2.3 · P07 check interval 15 minutes (unchanged) |
| Partly tested — backtest only, or run without pre-registration | 0 | — |
| Definition | 4 | P01 · P02 · P03 · P22 (unchanged) |
| Price | 1 | P18 management fee 1% a year (unchanged; the testnet mark vault has no fee mechanism) |
| Exposure limit — set from a stated loss tolerance, not by a test | 1 | P19 deposit cap 1,000,000 test dollars (new) |
| Exception — not tested, decided by the owner, disclosed with its reason and expiry (trading-tool track only) | 11 | product definition 5: P04 · P05 · P12 · P13 · P14 — model assumption 5: P09 · P11 · P15 · P16 · P17 (unchanged) — stage only 1: P24 mark gate (new) |
| Not tested — listed in the rule audit register | 1 | P25 15-minute bars (unchanged) |

Exposure limit:

| Parameter | Value | Loss tolerance | Worst-case loss | Why it is not tested | Owner decision | Cost in normal times |
| --- | --- | --- | --- | --- | --- | --- |
| P19 | 1,000,000 test dollars (deposit cap 1e12 in the test dollar's 6-decimal units) | 1,000,000 test dollars | 100% — a total loss assumed | it limits the loss from an event — a fault of the vault contract or of a key that marks or runs it — not a price path; the cap the qBTC2X rulebook states for its mark vault and for the qX20 tracking vault. Such events so far: 0, on the three criteria of `docs/research/leverage/eth-1p5/evidence/p19-incidents-2026-10-20.md` (sha256 `e5ae24a8dd7d830c3075afeb519721228a2ec0d4f02829e35c360d4751faeee1`) | 2026-10-19 (both inputs) | none so far: the two vaults whose rulebooks state this cap, the qX20 tracking vault (cap 1,000,000 test dollars on chain) and the qBTC2X mark vault of 2026-10-12 (cap still 0 on chain), never held a deposit (largest 0 test dollars), so the cap has turned no deposit away — `docs/research/leverage/eth-1p5/evidence/p19-usual-cost-2026-10-20.md` (sha256 `91fc28dbaf5abc472d8fd6978a7d847d6a583240dc318f04a750df92d4579b5b`) |

Exceptions:

| Parameter | Value | Why it is not tested | Owner decision | Tested again when | Measured effect |
| --- | --- | --- | --- | --- | --- |
| P04 · P05 · P12 · P13 · P14 · P09 · P11 · P15 · P16 · P17 | as in decision `2026-10-16-qeth15-paper-inception`, unchanged | as stated there | 2026-10-13 | as stated there | as stated there |
| P24 | steps within the 25% bound, never stopping on size | stage only — a value for the testnet mark vault, which holds test dollars, in the same form as the qBTC2X mark vault, before any real borrowing. No stop rule passed the stress study, and "no stop" was not compared with other values | 2026-10-19 | before the stage-B decision (real borrowing), by the stress test of the real book's marks registered at 251121cb72e4b5fc526d2f067d7d555a03e4d757 (site repository, private: `docs/research/leverage/eth-1p5/stage-b-mark-gate/README.md`, sha256 `f6d1b30d1fb5ab921d421e36d6fcd6f0eaad8a5206d82ce1802a1abbee23aad0`) | 23 of the 3,316 days of 2017-09-01 … 2026-09-29 on which the daily level moved outside ±25%; the largest, 2020-03-12 at −65.66%, needs 4 marks — `docs/research/leverage/eth-1p5/evidence/p24-daily-moves-2026-10-20.md` (sha256 `147feef0f3477b981d61af64d60d4c86a8eae68015fe2db103cbb271c79bf941`) |

The new exception (P24) is entered in the rule audit register (site repository, private) with its expiry; an
exposure limit is not entered there. Contract constants this decision does not set (the redeployment decision
states them): the 25% bound per mark, the share-price floor, the test-dollar faucet drawn on redemption.

The citation gate (report-only) does not pass this decision. Its report for the amended
rulebook, `rulebooks/qeth15.gate.json` (sha256 ⟨…⟩), reads "fail" with ⟨n⟩ violations: the checklist run record of 2026-10-13, which the rows of the inherited values
still cite and which is pinned, has one open step, the public block, and does not pin the launch checks (C4,
three); the page block is not yet in the form the gate reads (C10, ⟨22⟩)⟨; any other check, as the report lists it⟩. No value this decision introduces is among them as untested.

Checks not run for this product, and why: holdability of collateral and debt on GIWA (R08) — not applicable,
the vault holds test dollars only; security items R44–R46 — no contract code beyond the redeployment's, whose
tests and rehearsal that decision states. Run: roles on chain (R64), read back after deployment (above). A
red-team proof-of-concept pass over the new deployment tool (R47): ran on 2026-10-20 — two breaks reproduced (owner actions did not check which vault the registry line names; a send whose answer is lost left no line on disk) and fixed the same day with regression tests, three rebutted items kept as hardening; result pass after the fixes — `docs/research/leverage/eth-1p5/evidence/red-team-deploy-tool-2026-10-20.md` (sha256 `100dae83b71abf67661c8721f55d30a63ca40283d427ae2a24ceb17d3bdddac8`).

## Known limits, stated at the start

The vault's price can move at most 25% per transaction and cannot be set to zero: a large move is marked in
steps within that bound. Deposits and redemptions between marks settle at the last marked price, so a vault
user's profit or loss is not a performance figure. Until a person decides on a halted day, the series has no new
line and the vault keeps its last marked price, at which deposits and redemptions still settle; a person who
accepts a wrong low ends the series, and the vault is then stepped down to the contract's floor, from which no
key can raise it. A keeper that stops posting leaves deposits open at the last mark; once the timelock owns the
vault, the one way to stop deposits at once is the guardian's `disableKeeper`. A redemption draws test dollars
from the faucet when the vault's balance is short; one redemption draws at most 200,000 test dollars (20 draws
of 10,000, in the contract code), so a larger redemption may need to be split. No external audit. Testnet only.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix-track-record (rulebook amendment, keeper provenance file, gate report, owner decisions extract, vault registry entry, deployment tool and artifact) | ⟨…⟩ |
| quadrix (site, private — contract source, checklist run record) | ⟨…⟩ |
