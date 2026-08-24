# QuadrixBasketVault v2 — Design Specification

2026-08-24 · for GASOK Phase 3 (private mainnet deployment) · **signed off by
the owner 2026-08-24** and anchored as a dated decision document. Edits after
anchoring are new dated documents, never revisions of this one.

## What this is

A multi-asset basket vault whose shares are a freely transferable ERC-20,
designed so that the mechanisms of an exchange-traded fund — priced creation,
in-kind redemption, an arbitrage loop that pins the market price to NAV — exist
on chain with the trust assumptions enforced by code rather than by the
manager's word. It generalises the two contracts already deployed and verified
on GIWA Sepolia: `QuadrixVault` (single-asset 4626, 0/20 HWM) and
`QuadrixIndexVault` (keeper-marked NAV with an on-contract movement bound).

It deliberately contains no crypto-specific assumption: any basket of standard,
freely transferable ERC-20s works, which is what lets the same machinery carry
tokenized-equity baskets later without a redesign.

## The one sentence that organises the whole design

**Redemption consumes no price.** A redeemer burns shares and receives their
pro-rata slice of every asset the vault holds — `balance × sharesBurned /
totalShares`, per asset. Because no oracle enters that computation, an oracle
attack cannot be converted into an over-withdrawal, which is what makes it safe
to leave redemption permissionless and ungated while creation stays behind an
AP whitelist. Every other module is arranged around protecting the two places
prices *are* consumed: mint pricing and fee crystallisation.

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Share holder | transfer, redeem in kind at any time | — |
| AP (whitelisted) | create shares at oracle NAV, subject to caps | anything else |
| Keeper | post NAV marks within the movement bound | move assets, mint, gate |
| Manager (via adapter) | swap between whitelisted assets on whitelisted venues | withdraw, mint, price |
| Owner (timelocked) | change parameters after a public delay | gate redemption — no such code path exists |

## Invariants

Carried over from `contracts/SECURITY.md`, with two additions. All are enforced
in code and covered by the Foundry invariant suite (randomised call sequences,
currently 8,192 per property).

- **I1a — No exfiltration, unconditional.** No code path sends assets to any
  address that is not (i) a share-burning redeemer or (ii) a whitelisted,
  delta-verified venue inside a swap operation.
- **I1b — Bounded operation loss, conditional.** A completed swap's net asset
  change is ≥ −(policy slippage). Conditional on venue honesty; stated as the
  adapter layer's trust assumption, not hidden.
- **I2 — Dilution only by formula.** Share supply changes only via AP creation
  at the formula price or redemption burns. No admin mint exists.
- **I3 / I5 — Exits never gated, and price-free.** No code path restricts
  redemption — not a pause, not a cap, not a whitelist — and the redemption
  computation reads no oracle. (I5 strengthens I3: it is not merely ungated,
  it is *unpriceable*, so it cannot be gamed through the price.)
- **I4 — Bounded NAV movement, halting at the bound.** Posted marks move at
  most ±X% per update; a larger move reverts and surfaces to the operator.
- **I6 — Creation only through the gate.** Mint is reachable only by
  whitelisted APs, priced by TWAP, deviation-guarded, and per-transaction
  capped. AP-set changes sit behind the owner timelock.

## Modules

### 1. Custody core
Holds N ERC-20 assets in an explicit registry. Registry admission requirements
(enforced socially now, checked at listing): standard ERC-20 semantics, no
fee-on-transfer, no rebasing, no transfer hooks (ERC-777), **freely
transferable** — the last because in-kind redemption sends components directly
to redeemers, and a component that can refuse transfer breaks I5. This
requirement is also what future tokenized-equity issuers will be selected on.

### 2. In-kind redemption (permissionless)
`redeem(shares, receiver)`: burn first, then loop the registry transferring
`assetBalance × shares / totalSupplyBefore` of each asset, rounding down.
Checks-effects-interactions, reentrancy-guarded. No oracle, no gate, no owner
involvement. Partial redemptions are just smaller `shares`.

### 3. AP creation module
`create(assets[], amounts[], receiver)` — deposit the current basket
proportions (in-kind creation), receive shares at the TWAP share price. Caller
must be on the AP whitelist. Guards: TWAP window over keeper marks, deviation
guard vs the last accepted mark, per-transaction and per-epoch creation caps,
inflation-attack protection via virtual-offset shares (OZ 4626 pattern) plus a
burned seed deposit at genesis. AP whitelist changes execute only after the
owner timelock delay, publicly visible while queued.

### 4. Swap adapter
The only path by which the manager touches assets. Whitelisted venues,
whitelisted assets, per-operation delta verification (I1b): the operation
reverts if the post-swap portfolio value at reference prices dropped more than
the slippage policy allows. The manager never holds custody mid-operation.

### 5. Fees
0% management. 20% performance against a **share-price high-water mark**
(per-investor equalisation is impossible for a freely traded token; the
free-rider effect below the HWM is the industry-accepted trade-off).
Crystallisation only at fixed period ends on the TWAP price — the fee rate is
0 between period ends, which kills the March timing-option incident
structurally: a mark posted mid-period has nothing to crystallise against.

Fees are paid by minting shares to the fee recipient, never by selling assets,
so fee payment cannot force liquidations or touch I1. The mint is
dilution-corrected: to transfer fee value F from a vault of value V and supply
S, mint `m = F·S / (V − F)` shares — the naive `F / price` under-collects
because the mint itself dilutes the price the recipient receives. Worked check:
100 shares, HWM 1.00, book at 130 → fee 6; mint 4.8387 shares → post-fee price
1.2400, recipient holds exactly 6.00, holders hold exactly 124.00 — identical
to a cash fee to the cent, with nothing sold. **The HWM then updates to the
post-fee share price** (1.24, not 1.30); leaving it at the pre-fee price would
re-charge the recovery of the fee gap next period. This is the standard
on-chain fee mechanism (Enzyme v4 mints fee shares the same way).

### 6. NAV keeper
Reuses the qX20 keeper pattern: compute NAV from on-chain balances × prices,
post within the ±bound, halt above the sanity threshold and page the operator
rather than clamp. Marks feed the TWAP used by creation and fees. The keeper
key can post marks and nothing else (I4 bounds the damage of a stolen key).

### 7. Owner timelock
Owner is a timelocked contract, not an EOA. Every parameter change (AP set,
asset registry, slippage policy, fee recipient, keeper) queues publicly for a
fixed delay before execution. Because redemption is ungated and price-free, a
holder who dislikes a queued change can always exit at full pro-rata value
before it executes — the timelock plus I5 together are what make "watch me"
a real protection rather than a slogan.

## Attack → mitigation map

| Attack | Path | Mitigation |
| --- | --- | --- |
| Oracle pump → redeem rich | redemption | **Nullified: redemption reads no price** |
| Oracle suppress → mint cheap | creation | AP whitelist + TWAP + deviation guard + caps |
| Mark pump → crystallise fee (March incident) | fees | rate 0 between period ends; TWAP at fixed windows |
| First-depositor share inflation | creation | virtual-offset shares + burned genesis seed |
| Flash-loan sandwich on a mark | creation/fees | TWAP window spans marks; single mark can't move price |
| Donation to skew accounting | any | pro-rata math is donation-tolerant (donations accrue to all holders); creation prices off marked NAV, not spot balance |
| Malicious component token | custody | registry requirements: standard, no FoT/rebase/hooks, freely transferable |
| Reentrancy through component transfer | redemption | burn-before-transfer, CEI, reentrancy guard, no-hook tokens only |
| Manager exfiltration | adapter | I1a: no path; venues whitelisted; delta-verified |
| Owner rug via parameter change | governance | timelock with public queue + ungated price-free exit |
| Keeper key theft | NAV | I4 bound caps damage; halt-and-page above threshold |
| Redemption run | liquidity | in-kind needs no liquidity; nothing to run on |

## What this does not solve

- **Venue honesty during swaps (I1b).** The vault trusts whitelisted venues to
  deliver; the delta check bounds but does not eliminate this.
- **Strategy quality.** Nothing here makes the portfolio good.
- **Peg quality under the selective-AP model.** With few APs, the arbitrage
  loop is only as active as the APs are; peg quality is an operational SLA,
  managed by the published AP policy (tight spreads in normal conditions,
  profit on demand spikes only) — a policy document to be anchored alongside
  this one.
- **Secondary-market listing itself.** This spec makes shares listable; when
  and where to list is a business decision with its own (reflexivity,
  regulatory) considerations, deliberately out of scope here.

## Delivery plan (GASOK Phase 3, Demoday October KBW)

| Week | Deliverable |
| --- | --- |
| W1 (8/24–30) | This spec reviewed and anchored; invariant harness extended to I5/I6 (red first); Enzyme form submitted; name decision |
| W2 (8/31–9/6) | Custody core + in-kind redemption green against the suite |
| W3 (9/7–13) | AP creation module + fee module + timelock |
| W4 (9/14–20) | Swap adapter; GIWA Sepolia deploy + source verify; keeper wired |
| W5 (9/21–27) | Private mainnet deploy (pending GASOK onboarding); site /testnet flow on the new vault |
| W6 (9/28–10/4) | Demo polish; AP policy doc anchored; testnet user-metric push (Phase 3 KPI) |
| Demoday | Live loop on stage: create → trade → in-kind redeem, invariants cited from chain |

Parallel, unchanged: the Enzyme N1DV live track record (form → deposit → LIVE
genesis) keeps running on Arbitrum. The two tracks reinforce each other: the
Demoday story is "we measured where the leading platform's trust model ends
(their own documentation says so), and built the thing that closes the gap."
