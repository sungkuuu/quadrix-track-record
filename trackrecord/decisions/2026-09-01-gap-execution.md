# Gap execution — HYPE and AERO sleeves, 2026-09-01

**Effective:** 2026-09-01 (UTC). Owner decision.

## What this closes

The inception document of the same date recorded a 20pp gap: HYPE (15%) and
AERO (5%) unexecuted because they are not reachable from an Arbitrum vault
without bridging. That document requires the gap to be closed by its own
decision document. This is that document.

## The decision

Execute both sleeves today, at inception scale:

| Sleeve | Amount | Route |
| --- | --- | --- |
| AERO | ~$25 | Arbitrum USDC → Base (native USDC transfer) → Aerodrome swap |
| HYPE | ~$75 | Arbitrum USDC → Hyperliquid native bridge → spot buy → transfer to HyperEVM |

Both routes end in **native assets on their home chains**, held by the same
management wallet address. No wrapped position remains after execution, so
bridge exposure is limited to the crossing itself.

## Why now, when inception said the friction was not worth it

The inception text weighed friction against the position. What it did not
price is that the first crossing buys the **runbook**: these amounts are small
enough to be the rehearsal that larger, later tranches will reuse. Absolute
downside is capped at the sleeve sizes; the endpoints are native; and
executing now removes the one open question ("how will the gap actually
close?") that disclosure alone cannot answer.

## Rules that outlive this execution

1. **Tranche cap.** No single cross-chain move exceeds $500 or 25% of the
   sleeve being moved, whichever is smaller, once sleeves grow past
   rehearsal scale. One failed move must never be able to take a sleeve out.
2. **Dwell time.** Funds in bridge-custodied form (e.g. USDC on the
   Hyperliquid bridge before the spot buy) are moved on to their native
   endpoint in the same session, not parked.
3. **Agent keys.** Any trading agent key approved for an execution session is
   revoked in the same session.
4. **Structural exit.** When third-party deposits begin or scale justifies
   it, per-chain vaults with fee netting at the top layer replace bridging
   entirely (Enzyme feeder or own rail — inquiry sent to Enzyme 2026-09-01).

## Book and price sources (record layer)

The daily record's onchain-sum reader adds two chain entries:

- **Base**: AERO (ERC-20 `0x940181a94A35A4569E4529A3CDfB74e38FD98631`),
  priced from Binance daily close (AEROUSDT) — same source as the benchmarks.
- **HyperEVM** (chain id 999): HYPE held **natively** (gas asset, not ERC-20),
  priced from Hyperliquid's public daily candle close — its primary market.
  Binance does not list HYPE; the home-market close is the most liquid and
  most reproducible print available.

Executed quantities are whatever the chain shows; this document records the
decision and the routes, and the daily record carries the results.
