# qREV token-supply pipeline

On-chain measurement of circulating token supply for the qREV (Revenue Index)
universe, at weekly checkpoints (every Sunday 00:00 UTC, 2023-01-01 to
2026-09-13, 194 points) wherever the chain allows historical `eth_call`, plus
a current snapshot for every symbol including chains with no free archive
access. Built so "new issuance over the trailing 12 months" can be computed
without CoinMarketCap. All figures in this document were measured on
2026-09-15; re-run the scripts for a fresh read.

No promises, no marketing framing below -- this is a measurement log,
including the places the measurement is incomplete or disagrees with
CoinGecko.

## Issuance definition (owner decision 2026-09-15)

The owner fixed the definition this pipeline implements: **circulating =
on-chain total supply (or, for SKY, the SKY-equivalent composite total --
see "SKY: a composite supply model" below) minus balances held by
PROTOCOL-CONTROLLED addresses only** -- foundation/treasury wallets, team &
investor vesting contracts, unminted-equivalent reserves, and dead/burn
addresses. **Voluntary lockups are NOT excluded** -- a holder who locks
tokens they already fully own into a vote-escrow or staking contract
(veAERO, veCRV, vePENDLE, veVELO, vlCVX-style locks, or plain PoS staking)
still counts as circulating/issued, even though the tokens are not liquid.
This is deliberately narrower than CoinGecko's own `circulating_supply`,
which nets out both categories indiscriminately; the two numbers answer
different questions on purpose (see "What circulating means here" below for
why this matters for qREV's own issuance math).

Per symbol, what is excluded as protocol-controlled vs. deliberately left in
as a voluntary lock (Group A only; `--` = neither applies):

| Symbol | Excluded (protocol-controlled) | Deliberately included (voluntary lock) |
|---|---|---|
| AAVE | Aave Ecosystem Reserve | -- |
| AERO | -- | veAERO (ve(3,3) vote-escrow) |
| CAKE | dead-burn address | -- |
| CRV | -- | vote-escrow (veCRV) |
| CVX | -- | vlCVX |
| DYDX | community_treasury + rewards_treasury module accounts | bonded_tokens_pool + not_bonded_tokens_pool (staked/unbonding DYDX) |
| ETHFI | ether.fi Ecosystem Fund (4 wallets) | -- |
| EUL | Euler DAO Treasury | -- |
| GMX | -- | GMX staking |
| INJ | auction module account (weekly burn-auction basket) | bonded_tokens_pool + not_bonded_tokens_pool (staked/unbonding INJ) |
| LDO | Lido Agent | -- |
| LINK | Chainlink Reserve | Chainlink staking contract (identified, not excluded) |
| PENDLE | -- | vePENDLE |
| RAY | Raydium Buyback Treasury | -- |
| SKY | MCD Pause Proxy (burned periodically via governance spells) | -- (no vote-escrow product found for SKY) |
| SYRUP | -- | Syrup staking |
| UNI | UNI Timelock + dead-burn address | -- |
| VELO | -- | veVELO (ve(3,3) vote-escrow) |
| XVS | dead-burn address | Venus vault/staking custody (identified as a residual gap, not excluded -- no specific address found, see notes) |
| ENA, JUP, ONDO, PUMP, ZRO | none found (incomplete) | -- |
| VVV | none found -- `mint` model, `census_status: not_applicable` (no vesting concept modeled for it) | -- |

This table is also why the "Vote-escrow / staking lockups not modeled as
exclusions" divergence group below (AERO, CRV, PENDLE, VELO, VVV, CVX, GMX,
SYRUP, and now also DYDX's and INJ's staked amounts) is large and
*intentional*, not a gap: the owner's rule says count them as circulating.

## What "circulating" means here

```
circulating = totalSupply() - sum(balanceOf(excluded_address) for excluded_address in registry)
```

`excluded_addresses` are treasury / vesting / foundation / burn-sink wallets
found in `registry.json`, each with a `source_url` citation. Two different
things get excluded for two different reasons:

1. **Vesting/treasury custody** (e.g. Uniswap's governance Timelock, Aave's
   Ecosystem Reserve, Lido's Agent, Euler's DAO Treasury) -- tokens that exist
   on-chain but have not been distributed.
2. **Non-decrementing burns** -- some older tokens (found here: UNI, CAKE,
   XVS) burn by transferring to `0x000000000000000000000000000000000000dEaD`
   instead of calling a supply-reducing `burn()`, so raw `totalSupply()`
   overstates real supply by whatever sits at that address. This was not
   something the brief anticipated; it was found empirically (see "Notable
   findings" below) and is now treated as an exclusion like any other.

**Where `excluded_addresses` is empty and the token is `premint`**, our
`circulating` number equals `total` -- i.e. it is an **upper bound**, not a
true circulating figure, because we did not find a citable treasury/vesting
address. `census_status: "incomplete"` flags exactly this. Do not read
`circulating` for an incomplete premint token as more accurate than
CoinGecko's own circulating_supply.

**Where the token is `mint`** (emission-based, no fixed cap, e.g. AERO, CRV,
PENDLE, VELO, CVX, GMX, SYRUP, SKY, VVV), `circulating` is likewise set equal
to `total` unless a burn-sink was found. This is the single biggest source of
disagreement with CoinGecko in the table below: several of these protocols
let holders lock tokens into a vote-escrow contract (veAERO, vlCVX, vePENDLE,
ve(3,3) for VELO, etc.). Locked-but-minted tokens are, by our definition,
circulating (they exist as a real balance somewhere, just not a spendable
one); CoinGecko's circulating_supply nets vote-escrow lockups out. Neither
number is "wrong" -- they answer different questions. This pipeline was built
to measure gross new issuance (mint), which is what "circulating = total" is
for.

## Supply model classification -- how it was decided

Per the brief: **measured, not guessed.** For every EVM entry we called
`totalSupply()` live and at the 2024-06-02 block (via archive `eth_call`) and
compared:

- Exactly flat -> `premint` (UNI, AAVE, LDO, LINK, EUL, ENA, ONDO all landed
  exactly on their genesis figure, confirming the brief's own examples).
- Grew -> `mint` (AERO +84%, CRV +14%, PENDLE +9%, VELO +55%, CVX +0.4%
  toward its 100M cap, GMX +9.5% toward its 13.25M cap over that window; SKY
  and SYRUP weren't deployed yet at that block so later checkpoints were used
  instead and also show growth).
- Fell -> classified `premint` (fixed-then-burning) rather than `mint`: ZRO's
  totalSupply() fell 4.9% over the same window, i.e. tokens were burned, not
  minted.

Non-EVM tokens (JUP, RAY, PUMP, HYPE, TRX, INJ, DYDX, SOL, AVAX, BNB, ETH)
were classified from each project's own published tokenomics rather than a
historical archive call, since none of the free non-EVM APIs used here expose
historical supply. This is noted per-entry in `registry.json`.

**SKY is the one exception**, reclassified 2026-09-15 from `mint` to a new
`composite` model -- see the next section.

## SKY: a composite supply model (owner decision 2026-09-15)

SKY's raw `totalSupply()` jumps from 1.67B (2024-12) to 27.0B (2025-06)
because of the MakerDAO->Sky rebrand's MKR->SKY migration (1 MKR = 24,000
SKY, one-way, run through a dedicated converter contract), not because of
new issuance. Since qREV's issuance math should not register a unit
conversion as a 16x supply spike, SKY is now measured in **SKY-equivalent
units**:

```
composite_total = (SKY.totalSupply() - SKY held by the converter contracts)
                 + 24000 * (MKR.totalSupply() - MKR held by the converter contracts)
```

- **MKR contract**: `0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2`
- **SKY contract**: `0x56072C95FAA701256059aa122697B133aDEd9279`
- **Converter V1** (used Sep-2024 to May-2025, now deprecated):
  `0xBDcFCA946b6CDd965f99a839e4435Bcdc1bc470B`
- **Converter V2** (live since May-2025):
  `0xA1Ea1bA18E88C381C724a75F23a130420C403f9a`

**MKR held by the converters is empirically ~0** -- confirmed two ways: (a)
the [sky-ecosystem/sky GitHub README](https://github.com/makerdao/sky)
states `mkrToSky` "receives Mkr, burns it and sends the equivalent amount in
Sky" (i.e. the converter calls `mkr.burn()`, it does not custody MKR), and
(b) a live `balanceOf` check on 2026-09-15 found Converter V2 holding 0.1366
MKR and Converter V1 holding 0 MKR -- both dust. So `MKR.totalSupply()`
itself is already "MKR outstanding, not yet converted" to a very close
approximation.

**Subtracting SKY held by the converters is NOT optional, and finding out
why was the actual work here.** [Sky's own docs](https://developers.skyeco.com/guides/sky/token-governance-upgrade/codebase-change-analysis/)
state that Converter V2 "no longer has permission to mint new SKY tokens.
Instead, the full SKY token balance needed to convert all outstanding MKR is
pre-minted and deposited into Converter V2" -- a single lump-sum pre-mint at
V2's May-2025 launch, sized to cover every MKR holder's *eventual* future
conversion, sitting unclaimed until each holder individually converts. That
pre-minted reserve is already counted in `SKY.totalSupply()` from the moment
it's minted, long before any given holder actually converts. Live-checked on
2026-09-15: Converter V2 held 2,073,825,993.78 SKY (a live, unclaimed
reserve) against 84,852.75 MKR still outstanding (84,852.75 x 24,000 =
2,036,469,240 SKY-equivalent -- the two track closely, confirming the
reserve is sized to match remaining unconverted MKR, not something else).
Naively computing `SKY.totalSupply() + 24000*MKR.totalSupply()` therefore
**double-counts every MKR holder who hasn't converted yet**: once as SKY
already sitting unclaimed in the converter, again as the MKR-side credit.
Measured impact: at 2025-06-01 the naive formula gives 41.2B vs. the
corrected 23.88B SKY-equivalent (+72.7% overstatement, shrinking over time
as the reserve gets drawn down to 25.5B naive vs. 23.43B corrected by
2026-09-13, +8.9%). Converter V1 did NOT pre-fund a reserve (it minted SKY
on demand instead -- its balance was 0 SKY at every checkpoint tested), so
the correction is a no-op for the Sep-2024-to-May-2025 era and only matters
from the V2 launch onward.

**Excluded on top of the composite**: `MCD Pause Proxy`
(`0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB`, [Etherscan-labeled](https://etherscan.io/address/0xbe8e3e3618f7474f8cb1d074a26affef007e98fb),
33,496,059.68 SKY live on 2026-09-15) -- Sky's own governance-execution
contract, which accumulates SKY between "Monthly Settlement Cycle" executive
spells that periodically burn it (per an Aug-2026 Sky governance proposal).
This is the standard treasury exclusion, applied on top of the composite.

**The corrected series is smooth**, consistent with Sky Farms emission and
Smart Burn Engine burns moving supply gradually rather than in a step at the
V2 launch date:

| Checkpoint | MKR outstanding | SKY raw totalSupply() | Composite total (SKY-eq.) | Composite circulating (ex. Pause Proxy) |
|---|---:|---:|---:|---:|
| 2024-12-01 | 914,583 | 1,666,173,111 | 23,616,174,883 | 23,610,184,089 |
| 2025-06-01 | 594,607 | 26,956,039,962 | 23,882,597,446 | 21,956,701,142 |
| 2025-12-07 | 140,996 | 23,462,665,147 | 23,455,285,138 | 22,896,785,651 |
| 2026-09-13 | 85,280 | 23,462,665,147 | 23,425,817,117 | 23,386,793,599 |

(2025-12-07 is this pipeline's nearest weekly Sunday checkpoint to
2025-12-01; the Pause Proxy's own SKY balance moves week to week as
governance spells burn it, so "circulating" here is noisier week-to-week
than "total.") Current (2026-09-15): composite total 23,422,444,190,
circulating 23,388,948,130 -- **-0.16% vs. CoinGecko's stated
circulating_supply (23,426,517,315)**, well inside the 10% band, hence
`census_status: complete`. Implemented in `fetch-supply.py` as
`fetch_sky_composite_weekly` / `fetch_sky_composite_current`, driven by the
`composite` block in `registry.json`'s SKY entry (`build_registry.py` passes
that block through from `cache/manual_overlay.json` verbatim).

## Chains: history vs current-only

| Chain | History (194 wk) | RPC endpoints that actually worked | Endpoints that failed, and why |
|---|---|---|---|
| Ethereum | Yes, full | `eth.drpc.org` (used for essentially everything; fast, never rate-limited enough to matter) | not tested exhaustively -- drpc.org handled the whole 194-week x 14-token job |
| Base | Yes, full (from each token's actual deployment date) | `mainnet.base.org` (official) | frequently returned `{"code":-32016,"message":"over rate limit"}` on individual calls -- see "Notable findings"; retried and succeeded on retry every time, no dead ends |
| Optimism | Yes, full (VELO's own history starts 2023-06-25, matching the Velodrome **V2** token launch -- the 25 weeks before that are absence-of-contract, not a measurement gap) | `mainnet.optimism.io` | occasionally `{"code":27,"message":"Unknown state. First available state is 1"}` on a handful of blocks; retried and succeeded |
| Arbitrum | **Yes, full** -- this contradicts the brief's assumption that no free Arbitrum archive RPC exists | `arb1.arbitrum.io/rpc` (official), `arbitrum.meowrpc.com`, `rpc.arb1.arbitrum.gateway.fm`, `arbitrum.drpc.org` **all four** served historical `eth_call` correctly in testing | `arbitrum.blockpi.network/v1/rpc/public` returned HTTP 521 (origin down) every time it was tried |
| BSC | **No** -- current-only for CAKE, XVS, BNB | none | `bsc.blockpi.network/v1/rpc/public` -> HTTP 521; `bsc.meowrpc.com` -> `{"code":-32000,"message":"The method eth_call is not supported."}`; `bsc-dataseed.binance.org` -> `{"code":-32000,"message":"missing trie node"}` (i.e. a pruned/full node, not archive); `1rpc.io/bnb` -> `{"code":-32000,"message":"header not found"}`; `bsc.publicnode.com` -> HTTP 403 `"Archive requests require a personal token"`. All five confirmed non-archive for historical `eth_call`; **current-state** calls (`"latest"`) work fine on `bsc-dataseed.binance.org` and were used for the current snapshot. |
| Solana, Tron, Hyperliquid, Cosmos (Injective, dYdX) | No (by design, per brief) | see below | no free historical supply API integrated in this pass |

## Non-EVM current-value sources

- **Solana** (JUP, RAY, PUMP): `getTokenSupply` JSON-RPC on
  `https://api.mainnet-beta.solana.com`, by SPL mint address. Worked cleanly
  for all three. For RAY, `excluded_addresses` are additionally measured via
  `getTokenAccountsByOwner(owner, {mint})` -- the owner's *total* SPL balance
  of that specific mint, summed across every associated token account it
  holds (Raydium's Buyback Treasury turned out to hold RAY across 5 separate
  token accounts under one owner).
- **Injective** (INJ): Cosmos LCD `GET /cosmos/bank/v1beta1/supply/by_denom?denom=inj`
  on `https://sentry.lcd.injective.network` (and `injective-rest.publicnode.com`
  as a working mirror). The plain `/supply/{denom}` path returned HTTP 501 on
  every LCD tried; `/supply/by_denom?denom=...` is the route that actually
  works on current Cosmos SDK LCDs. Module-account addresses (for
  `excluded_addresses`) come from `/cosmos/auth/v1beta1/module_accounts`
  (returns every named module account's bech32 address) and their balances
  from `/cosmos/bank/v1beta1/balances/{addr}/by_denom?denom=inj`.
- **dYdX** (DYDX): same `by_denom`-style route on
  `https://dydx-rest.publicnode.com` (`/cosmos/bank/v1beta1/supply`, denom
  `adydx`, paginated -- `by_denom` on this particular LCD still 501'd, so the
  full paginated list was fetched and filtered). Same
  `module_accounts` + per-address `by_denom` balance approach as INJ for
  `excluded_addresses` (`community_treasury`, `rewards_treasury`).
- **Hyperliquid** (HYPE): `POST https://api.hyperliquid.xyz/info {"type":"spotMeta"}`
  identifies the HYPE spot asset (`tokenId 0x0d01dc56dcaaca66ad901c959b4011ec`,
  8 decimals) but does not return a supply figure in this endpoint; HYPE's
  current circulating/total/max in `supply-current.json` come from the
  CoinGecko snapshot instead.
- **Tron** (TRX): the free TronScan endpoints reachable from this session
  (`apilist.tronscanapi.com/api/system/status` etc.) did not expose a simple
  current-supply field; TRX's figure is CoinGecko's.
- **ETH, BNB, SOL, AVAX** (native coins, no ERC-20 contract to query):
  current-only, from the CoinGecko snapshot. No ultrasound.money /
  beaconcha.in historical-issuance integration was done in this pass for ETH.

## Notable findings (things that surprised the pipeline while building it)

1. **Arbitrum has working free archive RPC.** The brief assumed otherwise.
   Four different free endpoints served correct historical `totalSupply()`
   reads for GMX across the full 194-week range.
2. **UNI's dead-burn address holds 11.14% of supply.**
   `0x000000000000000000000000000000000000dEaD` holds 111,419,581 UNI that
   was not in the original exclusion list (only the governance Timelock was).
   Adding it moved our circulating figure from clearly wrong to within 0.3%
   of CoinGecko's own circulating_supply -- strong evidence the correction is
   right. Applied to the full 194-week history, not just the current
   snapshot.
3. **CAKE's raw `totalSupply()` is ~16x CoinGecko's stated total_supply**
   (5,328,111,960 vs 331,093,394) because PancakeSwap burns CAKE by sending
   it to the same dead address rather than decrementing supply --
   4,991,087,157 CAKE (93.7% of raw supply) sits there. Excluding it brings
   our figure to 337,024,803, within 1.8% of CoinGecko's total_supply. No
   archive access exists for BSC, so this correction is applied to the
   current snapshot only.
4. **XVS shows the same pattern at smaller scale**: 254,892 XVS (0.85% of the
   30,000,000 cap) sits at the dead address; excluding it makes our
   total_supply match CoinGecko's almost exactly (29,745,108 vs 29,745,108).
   Circulating still doesn't match (see the >10% table below) -- Venus
   evidently also nets out tokens locked in its staking/vault contracts,
   which we did not identify a specific address for.
5. **INJ's on-chain supply (122,892,207) is 22.9% above CoinGecko's stated
   figure (100,000,000).** This looks like a stale CoinGecko field, not a
   pipeline error -- 100M was INJ's 2018 genesis supply, and INJ 3.0 (2024)
   introduced net-inflationary staking rewards (offset by a weekly burn
   auction) that have visibly grown supply since. Measured directly against
   the Injective LCD, not inferred.
6. **A `eth_call` batching bug produced false negatives** during
   development: any single JSON-RPC error inside a batch that didn't match a
   narrow "archive unsupported" string list got cached as a permanent `None`
   instead of being retried on the next endpoint. Transient `"over rate
   limit"` responses from `mainnet.base.org` were the main victim, silently
   truncating AERO/VVV/GMX/VELO weekly coverage on the first pass. Fixed in
   `lib_rpc.py` (any per-call error now triggers endpoint rotation; only
   giving up on every endpoint produces an uncached `None`, so a rerun always
   retries it) and the corrupted cache entries were deleted and
   re-fetched -- see `git`-free change history in the code comments, since
   this repo is not being committed to as part of this task.
7. **The Base/BSC/Arbitrum "does this chain even have archive access"
   self-test had its own bug**: it originally probed a block from
   2023-03-12 (derived from the pipeline's own `WEEK_START`), which predates
   Base's mainnet launch (Aug 2023) entirely, so `coins.llama.fi` returned no
   block and the self-test wrongly concluded "Base has no archive RPC." Fixed
   by probing a fixed, chain-agnostic 2024-06-01 timestamp instead.
8. **SKY's naive `totalSupply() + 24000*MKR.totalSupply()` composite
   double-counts unconverted MKR** by up to +72.7% (at 2025-06-01) because
   the MKR->SKY Converter V2 pre-mints its entire SKY reserve in one lump sum
   rather than minting on demand. See "SKY: a composite supply model" above
   for the full derivation and the fix (subtract SKY held by the converter
   contracts before adding the MKR-side credit).
9. **dYdX chain's `community_treasury` + `rewards_treasury` module accounts
   are real, live-queryable, and closed most of DYDX's gap to CoinGecko**:
   excluding them (112,248,746 DYDX combined, found by enumerating all 16
   dYdX module accounts via the chain's own LCD) moved the diff from +18.2%
   to +4.9%, moving `census_status` from `incomplete` to `complete`. The much
   larger `bonded_tokens_pool` (301.9M DYDX, staked) was deliberately left in
   as a voluntary lockup, not excluded, per the owner's definition.
10. **ether.fi's own governance docs list 4 "Ecosystem Fund" addresses
    holding 187.8M ETHFI (18.8% of supply) live** -- but excluding them moves
    ETHFI from +3.4% (no exclusion applied) to **-16.0%** vs. CoinGecko, i.e.
    CoinGecko's own `circulating_supply` field for ETHFI (965,350,000) is
    numerically identical to its own `total_supply` field, meaning CoinGecko
    is not netting this treasury out at all -- and CoinGecko's `total_supply`
    is itself 3.4% below the directly-measured on-chain `totalSupply()`
    (998,535,999) even before any exclusion. This looks like a CoinGecko
    data-quality/methodology gap (the same kind of issue as INJ below), not a
    sign the exclusion is wrong -- but per the >10%-band rule this keeps
    `census_status: incomplete` (the rule's voluntary-lock carve-out is for
    us running deliberately *above* CoinGecko, not for CoinGecko apparently
    understating non-circulating supply).
11. **Raydium's own "Buyback treasury" wallet** (disclosed in Raydium's
    Dec-2022 exploit-compensation transparency post, not a generic tokenomics
    page) holds 86.3M RAY (15.6% of supply) across 5 associated token
    accounts under one owner -- found via Solana's `getTokenAccountsByOwner`
    filtered by mint. Excluding it moves RAY's diff from +105.8% to +73.7% --
    real progress, but the ~144M RAY team/investor vesting allocation (25.9%
    of supply per Raydium's own schedule) remains unlocated as a single
    address, so `census_status` stays `incomplete`.
12. **INJ's gap is confirmed, not just asserted, to be a CoinGecko
    data-quality issue**: enumerating all 20 Injective module accounts and
    checking each one's INJ balance found nothing close to the ~22.9M INJ
    (22.9%) gap -- the largest candidate (the weekly burn-auction basket,
    `auction`) holds only 32,692 INJ. There is no undiscovered ~23M INJ pool
    hiding in an obvious protocol account; CoinGecko's 100,000,000 figure is
    INJ's 2018 genesis supply and appears never updated for INJ 3.0's (2024)
    net-inflationary staking/burn-auction mechanics.

## Files

- `registry.json` -- one entry per symbol: chain, contract/mint/denom,
  decimals, `supply_model`, `excluded_addresses` (with citations),
  `census_status`, `notes`, and the CoinGecko market-data snapshot used for
  the sanity check. 31 Group A entries fully researched; 55 Group B entries
  are registry stubs only (symbol + "not researched," per the brief's
  time-boxing allowance) -- see `GROUP_B` in `build_registry.py`.
- `build_registry.py` -- regenerates `registry.json` from
  `cache/coingecko/*.json` (CoinGecko `/coins/{id}` responses) and
  `cache/manual_overlay.json` (the hand-researched classification,
  exclusions, and notes above). Re-run any time to reproduce `registry.json`
  from the cached CoinGecko data plus the overlay.
- `fetch-supply.py` -- the main pipeline. For each EVM registry entry, gets a
  block height per week from `coins.llama.fi/block/{chain}/{ts}` and batches
  `totalSupply()` + `balanceOf(excluded)` calls via JSON-RPC (`lib_rpc.py`).
  SKY (`supply_model: "composite"`) is handled separately by
  `fetch_sky_composite_weekly` / `fetch_sky_composite_current` (see "SKY: a
  composite supply model" above). For non-EVM entries, fetches current supply
  via each chain's own API (see above); Solana and Cosmos entries with
  `excluded_addresses` now also subtract each excluded address's own balance
  (`getTokenAccountsByOwner` filtered by mint for Solana, per-address
  `/balances/{addr}/by_denom` for Cosmos) -- added 2026-09-15 for RAY, DYDX,
  and INJ. Idempotent and safe to re-run -- every RPC/API result is cached
  under `cache/`, so a rerun only fills gaps. Writes `supply-weekly.json` and
  `supply-current.json`.
- `lib_rpc.py` -- shared JSON-RPC / caching helpers (see finding #6 for the
  one real bug found and fixed in it).
- `cache/` -- all raw CoinGecko, block-height, and RPC responses, so the
  whole pipeline reruns without re-hitting any API from scratch.

## How to run

```
cd docs/research/qrev/supply
python3 build_registry.py      # rebuild registry.json from cache + overlay
python3 fetch-supply.py        # full run: weekly history + current snapshot
python3 fetch-supply.py --current-only   # skip the (slow) weekly loop
```

Both scripts are stdlib-only (`urllib`, `json`, `subprocess` for the
`ruby -e 'sleep N'` CoinGecko rate-limit pacing used when re-fetching
`cache/fetch_cg.py`'s CoinGecko data -- CoinGecko's free tier throttled
around 429 fairly aggressively even at one call per ~7-30s).

## Per-symbol table (Group A, measured 2026-09-15)

`hist` = weekly history available. `census` = `complete` (verified
exclusion(s) found and balance-checked live) / `incomplete` (premint or an
unresolved gap; no citable exclusion found, or the exclusion found doesn't
fully close the gap to CoinGecko) / `not_applicable` (mint model, no vesting
concept). `diff%` = (our circulating − CoinGecko circulating) / CoinGecko
circulating.

| Symbol | Chain | Model | Census | Hist | Our circulating | CoinGecko circulating | Diff % |
|---|---|---|---|---|---:|---:|---:|
| AAVE | ethereum | premint | complete | Yes | 15,427,716 | 15,427,716 | +0.0% |
| AERO | base | mint | not_applicable | Yes | 1,978,450,301 | 988,729,345 | **+100.1%** |
| AVAX | avalanche | mint | not_applicable | No | 442,515,957 | 442,515,957 | +0.0% |
| BNB | bsc | other | not_applicable | No | 133,160,793 | 133,160,793 | +0.0% |
| CAKE | bsc | mint | complete | No | 337,024,803 | 319,428,978 | +5.5% |
| CRV | ethereum | mint | not_applicable | Yes | 2,418,255,121 | 1,557,379,888 | **+55.3%** |
| CVX | ethereum | mint | not_applicable | Yes | 99,990,325 | 93,194,518 | +7.3% |
| DYDX | cosmos | premint | **complete** | No | 887,751,254 | 846,094,216 | +4.9% |
| ENA | ethereum | premint | incomplete | Yes | 15,000,000,000 | 10,095,312,500 | **+48.6%** |
| ETH | ethereum | mint | not_applicable | No | 122,050,161 | 122,050,161 | +0.0% |
| ETHFI | ethereum | premint | incomplete | Yes | 810,705,353 | 965,350,000 | **-16.0%** |
| EUL | ethereum | premint | complete | Yes | 23,277,203 | 24,025,172 | -3.1% |
| GMX | arbitrum | mint | not_applicable | Yes | 10,985,596 | 10,457,512 | +5.0% |
| HYPE | hyperliquid | mint | not_applicable | No | 222,445,714 | 222,445,714 | +0.0% |
| INJ | cosmos | mint | incomplete | No | 122,859,515 | 100,000,000 | **+22.9%** |
| JUP | solana | premint | incomplete | No | 6,861,487,028 | 3,319,369,204 | **+106.7%** |
| LDO | ethereum | premint | complete | Yes | 883,086,013 | 834,151,323 | +5.9% |
| LINK | ethereum | premint | incomplete | Yes | 994,138,066 | 748,099,970 | **+32.9%** |
| ONDO | ethereum | premint | incomplete | Yes | 10,000,000,000 | 4,869,330,647 | **+105.4%** |
| PENDLE | ethereum | mint | not_applicable | Yes | 281,527,448 | 173,481,161 | **+62.3%** |
| PUMP | solana | premint | incomplete | No | 834,008,818,698 | 468,506,740,494 | **+78.0%** |
| RAY | solana | premint | incomplete | No | 468,668,578 | 269,738,730 | **+73.7%** |
| SKY | ethereum | **composite** | **complete** | Yes | 23,388,948,130 | 23,426,517,315 | -0.2% |
| SOL | solana | mint | not_applicable | No | 587,028,182 | 587,028,182 | +0.0% |
| SYRUP | ethereum | mint | not_applicable | Yes | 1,244,677,493 | 1,167,271,959 | +6.6% |
| TRX | tron | other | not_applicable | No | 94,950,365,063 | 94,950,365,063 | +0.0% |
| UNI | ethereum | premint | complete | Yes | 621,332,423 | 623,212,424 | -0.3% |
| VELO | optimism | mint | not_applicable | Yes | 2,607,646,868 | 1,314,933,412 | **+98.3%** |
| VVV | base | mint | not_applicable | Yes | 114,855,705 | 47,973,768 | **+139.4%** |
| XVS | bsc | mint | incomplete | No | 29,745,108 | 16,864,546 | **+76.4%** |
| ZRO | ethereum | premint | incomplete | Yes | 951,073,953 | 353,313,326 | **+169.2%** |

Changed since the 2026-09-15 (earlier same-day) pass, per the owner's
issuance-definition decision: **SKY** (`mint` -> `composite`, `not_applicable`
-> `complete`), **DYDX** (`incomplete` -> `complete`, +18.2% -> +4.9%),
**ETHFI** (found and applied a real exclusion, but the diff moved from +3.4%
to **-16.0%** -- stays `incomplete`, see Notable Findings #10), **INJ**,
**LINK**, **RAY** (all still `incomplete`, but with a small, cited exclusion
now applied instead of none -- see Notable Findings #9-#12 and each entry's
`notes` in `registry.json`).

Full data (weekly time series, exact decimals, block heights) is in
`supply-weekly.json` and `supply-current.json`, including the raw `our_total`
figure alongside `our_circulating` for every symbol.

### On the >10% divergences

Grouped by cause, because they are not all the same kind of gap:

- **Vote-escrow / staking lockups not modeled as exclusions** (the largest
  group): AERO, CRV, PENDLE, VELO, VVV, and to a lesser extent CVX, GMX,
  SYRUP. These are `mint` models where `circulating = total` by this
  pipeline's definition (see "What circulating means" above); CoinGecko nets
  out tokens locked in veAERO / vlCVX / vePENDLE / ve(3,3) / staking
  contracts. Not a data error -- a different, equally valid definition. If
  qREV's revenue-per-holder or new-issuance math wants CoinGecko's narrower
  definition, these numbers need a second exclusion pass identifying each
  protocol's vote-escrow contract address.
- **Premint tokens with no verified exclusion address, or only a small one**:
  ONDO (+105.4%), JUP (+106.7%), PUMP (+78.0%), ENA (+48.6%), ZRO (+169.2%)
  have none at all; LINK (+32.9%, Chainlink Reserve excluded but it's only
  0.6% of supply) and RAY (+73.7%, Raydium's Buyback Treasury excluded but
  the larger team/investor vesting allocation is still unlocated) have a
  real, cited exclusion applied that just isn't big enough to close the gap.
  `census_status: incomplete` on all seven; our `circulating` should be read
  as an upper bound, not a measurement, until the remaining treasury/vesting
  addresses are found.
- **CoinGecko data-quality issue**: INJ (+22.9%) -- our figure comes directly
  from the Injective chain's own LCD, and CoinGecko's stated 100,000,000
  looks like it was never updated past INJ's 2018 genesis figure; confirmed
  by enumerating all 20 Injective module accounts and finding nothing close
  to the gap size (see Notable Findings #12). ETHFI (-16.0%) is the same kind
  of issue in the opposite direction: CoinGecko's `circulating_supply` for
  ETHFI equals its own `total_supply`, meaning it isn't netting out ether.fi's
  own documented 187.8M-ETHFI Ecosystem Fund at all (see Notable Findings
  #10) -- our number is the one backed by a live, cited, on-chain balance.
- **BSC dead-burn-address correction, still partial**: XVS (+76.4%) --
  total_supply now matches CoinGecko almost exactly once the dead address is
  excluded, but circulating does not, implying Venus nets out additional
  vault/staking custody we did not identify an address for.

Two symbols moved out of the >10% table entirely this pass: **DYDX**
(+18.2% -> +4.9%, dYdX chain's own `community_treasury` + `rewards_treasury`
module accounts excluded, see Notable Findings #9) and **SKY** (now a
`composite` model, -0.2% -- see "SKY: a composite supply model" above).

## What could not be measured, and why

- **BSC weekly history** (CAKE, XVS, BNB): no free archive RPC found after
  trying five candidates; see the chain table above for the exact error from
  each. Current-state-only for these three.
- **ETH historical issuance**: not integrated in this pass (would need
  ultrasound.money or beaconcha.in); ETH is current-only here.
- **Hyperliquid historical or even a direct current supply figure for HYPE**:
  `spotMeta` identifies the asset but does not return supply; current HYPE
  figures come from CoinGecko.
- **Exclusion addresses still not found (2026-09-15, second pass)**: JUP
  (Jupiter's team/investor tokens vest on-chain via the generic "Jupiter
  Lock" product across many per-recipient accounts, not one treasury
  address), PUMP (57.28B PUMP unlocked across 121 separate team/investor
  wallets in Jul-2026, no single canonical address), ONDO (checked Ondo's
  Management Multisig, Deployer, and a Merkle-claim contract -- all hold 0
  ONDO), ENA (checked all 4 addresses on Ethena's own official "Key
  Addresses" docs page plus a separately-surfaced "Protocol Treasury"
  address -- all hold 0 ENA), ZRO (the two previously-found candidate
  addresses both still hold 0 ZRO; no new candidate found). See each
  symbol's `notes` in `registry.json` for exactly what was tried and ruled
  out.
- **Exclusion addresses found this pass that fully closed the gap**: DYDX
  (`community_treasury` + `rewards_treasury` module accounts, +18.2% ->
  +4.9%, now `complete`).
- **Exclusion addresses found this pass, but not large enough (or too large
  in the other direction) to close the gap to CoinGecko**: LINK (Chainlink
  Reserve, 0.6% of supply, barely moves the +33.7% starting gap), RAY
  (Buyback Treasury, closes +105.8% to +73.7%), ETHFI (ether.fi's own
  4-address Ecosystem Fund, moves the diff to -16.0% -- see Notable Findings
  #10 for why this is likely a CoinGecko issue, not ours), INJ (module-account
  survey found nothing near the gap size, strengthening rather than closing
  the "CoinGecko stale data" explanation). See "Issuance definition" above
  for the exact addresses.
- **Group B** (55 symbols: BAL, DBR, FLUID, GNS, LIT, ASTER, MET, ORCA, THE,
  SPK, NXM, SSV, QUICK, RSUP, PNP, FLIP, HNT, FIL, GRAM, NEAR, CC, MON, BERA,
  KITTEN, KNTQ, REX, SHADOW, PHAR, RAM, PLSX, NEST, ABX, BLACK, HYDX, EDGE,
  BONK, ORE, GEOD, OVER, RAIL, REZ, THOR, YB, ZINC, MPLX, INDEX, GODL, STONK,
  SLVR, TREE, FWA, DUST, BEAN, PEA, PONS): registry stubs only, per the
  brief's own time-boxing allowance ("Group B can be registry-only ... if
  time is short"). Group A (31 symbols) was completed in full, including
  weekly on-chain history everywhere the chain allows it.
