# Checklists

Confirmed on 2026-10-02. The names of the two documents are provisional.

This folder holds the two checklists that Quadrix vault rules are built and tested against. They are here so that a
vault page or a decision document can cite an item by its ID — `D06`, `R21`, `U03` — and a reader can look up what
that ID means and what passing it requires.

| File | What it is |
| --- | --- |
| [`vault-design.md`](vault-design.md) | **The order of steps.** D01–D18: from the product question to the post-launch rule audit. Each step says what it produces, what passing means, who decides, which robustness items it calls, and which former robustness items it absorbed. |
| [`robustness-tests.md`](robustness-tests.md) | **The catalogue of tests.** 46 test items (R02–R64; the numbers in between that are missing are aliases or retired): what each test checks, its pass criterion, which product types it applies to, where it has been run, and which design steps call it. An alias table maps the 17 former procedure IDs to the design steps that now hold them. U01–U25 list methods that have not been run yet. |

## How the two relate

The two checklists always run together. The design checklist is run once per new vault, new index or rule amendment,
top to bottom; each step calls items from the robustness catalogue, which is looked up by product type (index,
allocation, leverage, discretionary).

Seventeen items of the earlier catalogue were procedures rather than tests. On 2026-10-01 each was merged into the design
step that does the same thing. The design step is now the only definition; the old R-ID is kept as an alias so that
documents citing it can still be read (`robustness-tests.md` §3-2). IDs are not reused.

One run record per vault or amendment covers both documents: every D step as done or not applicable (with a reason), and
every R item as run, not run, or not applicable (with a reason), together with the result file and its sha256. The
run-record format is designed; no run record in this format has been completed yet.

## How the IDs are cited

- **Vault pages.** Each vault page is to carry a block, "How far these rules were tested", listing the IDs that were run
  and the ones that were not, with links to the result files. The block is being built and is not yet live.
- **Decision documents.** An inception or amendment decision is to carry a section, "Tested, and not tested", that pins
  the rulebook's parameter citation table, counts the parameters by basis (tested, partly tested, definition, price,
  absent, not tested), names the values the decision introduces or changes, lists the checks not run for that product
  with the reason, and lists every judgment — a value that differs from the decision rule's output — with its reason. No
  decision anchored so far contains this section.
- **Rulebooks.** Each rulebook is to carry a parameter citation table (see "The citation table" in `vault-design.md`)
  whose rows name the R-IDs run for each value, and a judgment record when any value is a judgment.

## The rules these documents serve

No parameter value enters a rulebook without a pre-registered test result and a checklist run record. Definitions
(universe, data source, excluded asset classes) and prices (fees) are the only exceptions, and they are labelled as such.

Two further rules were fixed on 2026-10-02:

- **The decision rule's output is the default.** A value that differs from it is allowed only when the test was
  ambiguous — no variant met the pre-registered "best" condition, or the output came from the fallback (simplicity)
  order. Such a value is a judgment: it must be reasonable, and its reason is always published, in the rulebook and in
  the anchored decision.
- **An absent rule is decided by data too.** "No band" or "no buffer" goes in only when a test showed that absence is
  best, and it is cited like any other value.

What is and is not in place:

- The vaults and paper indexes that exist today were built before these checklists. Steps marked "not yet" in
  `vault-design.md` have never been run at their place in the order, and no vault has been taken through the whole order.
- The rule applies to values introduced or changed from 2026-10-01. Values that were in force before then and were never
  tested stay in force. They are to be labelled "not tested" in the rulebook and on the vault page and listed for
  testing; that labelling is in progress and is not published yet. They leave the list only by being tested or by being
  removed, each through a rule-amendment decision.
- The citation check (U25) is implemented and runs as a report only: it lists uncited values and refuses nothing. It is
  to be wired into commits, CI and anchoring once the existing rulebooks carry their citation tables; none does yet.
  Apart from the site build check on download files (`vault-design.md` §5, D12), nothing in this folder is enforced by
  code today.
- Pre-registration commits are kept in a private repository, so an outside reader cannot yet check that a registration
  preceded its results (U23).
