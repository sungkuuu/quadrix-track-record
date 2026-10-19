# Basket sessions — plans, auctions and fills

One file per vault per day the keeper ran a basket session. The file is the keeper's own output, written as it went: the plan it announced, the auctions it opened, every fill, and the final read-back of the vault.

| folder | vault | executed session (read this file) | earlier files in the folder |
|---|---|---|---|
| `qdefi/` | qDEFI | `2026-10-09.json` — 15 auctions, 15 fills | `2026-10-02.json` — the 7-day notice (announce only) |
| `qai/` | qAI | `2026-10-09.json` — 11 planned, 5 filled before the session stopped; `2026-10-12.json` — the remaining 9, all filled | `2026-10-02.json` — notice |
| `qrev/` | qREV | `2026-10-12.json` — 14 auctions, 14 fills | `2026-10-02.json` — notice; `2026-10-09.json` — plan, not run that day |
| `triens/` | qTRI | `2026-10-12.json` — 8 auctions, 8 fills | `2026-10-02.json` — notice; `2026-10-09.json` — plan, not run that day |
| `qx20/` | qX20 | `2026-10-13.json` — 22 auctions, 22 fills | `2026-10-02.json` — notice; `2026-10-09.json` — plan, not run that day |

Note on qAI, Oct 9: one fill (AKT → ICP) is on chain but missing from `2026-10-09.json`; the keeper's push lost it. The chain is the record; the file will be corrected with a note, not rewritten silently.

## How to read a file

- `adds` / `removes` — names entering and leaving the basket; `targets` — the book weights every name is traded to.
- `announce` — the on-chain notice: tx, block, time. A session can execute only after the 7-day delay.
- `execute` — the registry change tx that starts the session.
- `trades` — the auctions the keeper planned, in order.
- `fills` — one entry per filled auction: `seq`, `sell` → `buy`, `sellTaken` / `buyPaid` (raw token units), `factorBps` (fill price vs the reference price: 10001 = 0.01% above), `lossAtRef` (0 means no loss at the reference price), `elapsed` (seconds from opening to fill), `openTx`, `fillTx`, `at`.
- `finalize` — removal of a name that reached zero, with tx and time.
- `verify` — the vault read back from the chain after the session: asset count and order, block, time.

Every `openTx` and `fillTx` is a GIWA Sepolia transaction. Recount any session from those.
