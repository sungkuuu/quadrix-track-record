# Rulebooks

The methodology rulebooks of the Quadrix indices. Each one answers the same
questions for one product: what the universe is, who classifies it, what is
excluded, how names are weighted and capped, when the index reconstitutes, which
data sources it reads and what happens when a source or a constituent fails, and
under which conditions the index should not exist at all.

This folder is the canonical location of the rulebooks. The files are public
copies, cleaned on 2026-10-01 from the working rulebooks. No rule, threshold,
formula or effective date was changed. What was changed:

- internal process notes, internal document references and private file paths
  were removed, and paths were pointed at this repository or at the public
  copies under quadrix.finance/methodology/ where those exist;
- stale status headers were brought up to date with the anchored decisions;
- known errors were corrected, and sentences about what a backtest or a Monte
  Carlo run showed were brought in line with the result files — including
  results that did not favour the value in force;
- each product rulebook now ends with a test-scope appendix (검정 범위) that
  says, value by value, which test was run and which values are untested
  (미검정).

Every correction is listed, before and after, in the decision document that
pins these files (see "Pinned versions" below).

| File | Product | Status |
| --- | --- | --- |
| [`qx20.md`](qx20.md) | qX20 — Top-20 Index | Live record. NAV published since 2026-07-21 to the NAV-tracker vault on GIWA Sepolia by `keeper/update-nav.mjs`. No inception decision; later decisions `2026-09-23-qx20-exclusion-list`, `2026-09-28-qx20-toncoin-ticker-note`, `2026-09-28-qx20-xaut-exclusion`. |
| [`qdefi.md`](qdefi.md) | qDEFI — DeFi Index | Paper index since 2026-09-16 (`2026-09-16-qdefi-paper-inception`). Candidate vault. |
| [`value-capture.md`](value-capture.md) | qREV — Revenue Index | Paper index since 2026-09-16 (`2026-09-16-qrev-paper-inception`; later decisions `2026-09-21-qrev-fifteen-names`, `2026-09-28-qrev-d24-thresholds`, `2026-09-29-source-reconciliation`). Candidate vault. |
| [`qai.md`](qai.md) | qAI — AI Index | Paper index since 2026-09-22 (`2026-09-22-qai-paper-inception`; chain-token rule amended from the 2026-10-01 reconstitution, `2026-09-22-qai-chain-rule-amendment`; listing-age source, `2026-09-29-source-reconciliation`). Candidate vault. |
| [`barbell.md`](barbell.md) | qDUO — Barbell (BTC 60 / working capital 40) | Paper index since 2026-09-22 (`2026-09-22-barbell-paper-inception`). Candidate vault. |
| [`triens.md`](triens.md) | qTRI — Triens (BTC 30 / working capital 40 / Quality 30) | Paper index since 2026-09-22 (`2026-09-22-triens-paper-inception`; listing-age and issuance sources, `2026-09-29-source-reconciliation`). Candidate vault. |
| [`classification-sources.md`](classification-sources.md) | Classification-source framework used by qDEFI, qAI, qREV and Triens | Adopted 2026-09-14. Not a product. |
| [`qbtc2x.md`](qbtc2x.md) | qBTC2X — BTC 2x (daily reset) | Not in force. Stage A (a rules-only synthetic level from Binance spot bars and a testnet mark vault holding test dollars; nothing borrowed) opens on 2026-10-08 when `2026-10-08-qbtc2x-paper-inception` is anchored. |
| [`qeth2x.md`](qeth2x.md) | qETH2X — ETH 2x (daily reset) | Not in force. Held (owner, 2026-10-06): not opened on 2026-10-08; opening it later is its own inception decision. |

A paper index is a daily, rules-only index level with no vault and no capital
behind it, hash-chained and anchored like the rest of this repository. A candidate
vault is a product the site lists as a candidate; no third-party deposits are open.
Separately from the records, each of the six indices has a basket vault on the
GIWA Sepolia testnet that holds test assets (`keeper/rulebooks/*.json`, field
`basket`).

## Language

The rulebooks are written in Korean. The decision documents in
[`../trackrecord/decisions/`](../trackrecord/decisions/) are written in English and
carry the binding text: which rulebook version and which keeper files are in force,
and from when. Each decision's sha256 is committed on chain
(`trackrecord/decisions.jsonl`).

## Where the rules run

- `keeper/rulebooks/*.json` — every parameter as data, one file per index. Where a
  rulebook labels a value "초안" (draft), the value the keeper reads from these
  files is the one in force.
- `keeper/paper-index.mjs` — the paper-index keeper (qDEFI, qREV, qAI, Barbell, Triens).
- `keeper/update-nav.mjs` — the qX20 keeper.
- `keeper/leverage-index.mjs` with `keeper/leverage-step.mjs` — the leverage stage A keeper (qBTC2X, qETH2X); `scripts/verify.mjs` recomputes every line.
- `keeper/supply/registry.json` — the on-chain supply registry used for issuance (qREV, Triens).

## Where the results are

Backtests, Monte Carlo runs, the scripts that produced them and the CSVs are
published on the site under
[quadrix.finance/methodology/](https://quadrix.finance/methodology/README.md):
`qx20/`, `qdefi/`, `qrev/`, `ai/`, `barbell/` and `triens/`, plus `cap-backtest.py`,
`qx20-band.py` with its weekly input `cmc-weekly.json`, and the committed monthly
snapshots in `qx20/snapshots/`.

Not every result a rulebook cites is published. Published on 2026-10-01 and
cited by path: the qDEFI parameter test of 2026-09-29 (`qdefi/params/`), the qX20
rank-buffer, band and name-count Monte Carlo of 2026-09-29 (`qx20/rank-buffer/`)
and the outputs of the Quality-sleeve screen study behind `triens.md` §2 (`triens/`,
the `QQ…` codes). Not public today: the qX20 breadth study, the Quality-sleeve
research engine, and several input caches, among them the qDEFI parameter test's.
The rulebooks say so where they cite them.

## Pinned versions

The seven files above are pinned by sha256 in an anchored decision document,
"Rulebooks published — canonical location and pinned versions"
(`../trackrecord/decisions/`, id ending `-rulebooks-published`). From that decision
on, every rulebook hash pinned by a decision refers to a file in this folder, at a
commit of this repository.

Ten earlier decisions pinned twelve earlier rulebook versions by commit and sha256
(for example `2026-09-16-qdefi-paper-inception` pins `qdefi.md` at `ba58017`).
Those are working versions kept in a private repository; they contain working
notes and are not published here. They are available for inspection on request
(support@quadrix.finance), and a copy received that way can be checked against
the sha256 in the decision that pinned it.
