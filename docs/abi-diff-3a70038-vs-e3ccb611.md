Vault ABI and source diff: old deployed code against the redeployment code
==========================================================================

**Old:** site repository (private), commit `3a70038` (`3a700385e34bfc3849ea6c9537faafd0d523e87f`), the code at
the eight old vault addresses. Each of the eight old vaults was compared with a build of this commit on
2026-10-19 (GIWA Sepolia, from block 39,033,443): the same instructions and immutables; only the
compiler metadata tail differs.
**New:** site repository (private), commit `e3ccb611` (`e3ccb61151d78093b411c02e0792bcdcfe6b96bd`).

| Source file | sha256 at `3a70038` | sha256 at `e3ccb611` |
| --- | --- | --- |
| `contracts/src/QuadrixBasketVault.sol` | `3c5a3677fb9a6e3ca6228a2b882338352c4afe005a8f4c00f2cd036816706756` | `c566e8c5c9112a65f9dd1f149dd13feb7e6564d9a26d9cb689209ac57437ee8c` |
| `contracts/src/QuadrixIndexVault.sol` | `3025209796adbf53ae9b3ec9183e7fb453012acf78ce6e21985f3597161ed700` | `c859e42dd3dedca881aec0c5882261c38cfb32a02d48dd582cceb8daad7af553` |

Method: `forge build` (forge 1.8.3, solc 0.8.24, optimizer 200 runs) of `contracts/` at each commit;
the `abi` array of `out/QuadrixBasketVault.sol/QuadrixBasketVault.json` and
`out/QuadrixIndexVault.sol/QuadrixIndexVault.json` compared entry by entry, by name. A signature is the
name and the input types; for functions the state mutability and output types are compared as well,
and a change there is listed with the signature changes. Neither ABI has an overloaded name. Parameter
names are not part of a signature; where a signature changed, both are given with names.

## Basket (`QuadrixBasketVault`)

Counts, old → new: functions 69 → 82, events 18 → 22, errors 36 → 41.

**Removed:** none (no function, event or error).

**Changed (signature, or state mutability):**

- function `announceRegistryChange(address[] adds, address[] removes, bytes32 decisionSha256)` →
  `announceRegistryChange(address[] adds, uint256[] addRefPrices, address[] removes, bytes32 decisionSha256)`.
  The old selector is gone.
- function `renounceOwnership()`: `nonpayable` → `view`; signature and selector unchanged (it always
  reverts with `RenounceDisabled`).
- event `RegistryChangeAnnounced(address[] adds, address[] removes, bytes32 decisionSha256, uint256 eta)` →
  `RegistryChangeAnnounced(address[] adds, uint256[] addRefPrices, address[] removes, bytes32 decisionSha256, uint256 eta)`.
- constructor `(address[] assets_, address owner_, address keeper_, string name_, string symbol_)` →
  `(address[] assets_, uint256[] refPrices_, address owner_, address keeper_, string name_, string symbol_)`.

**Added functions (13):**

- `MAX_ASSETS() view returns (uint256)`
- `MAX_REF_PRICE() view returns (uint256)`
- `acceptOwnership() nonpayable`
- `budgetSupply() view returns (uint256)`
- `budgetValue() view returns (uint256)`
- `deadBelow() view returns (uint256)`
- `disableKeeper() nonpayable`
- `guardian() view returns (address)`
- `lossDay() view returns (uint256)`
- `lossToday() view returns (uint256)`
- `pendingOwner() view returns (address)`
- `redeemSkipping(uint256,address,address[]) nonpayable returns (uint256[])`
- `setGuardian(address) nonpayable`

`lossDay` and `lossToday` were internal storage before and are now public; `lossToday` now
means the day's loss per share times the supply fixed that day.

**Added events (4):** `GuardianSet(address indexed)`, `KeeperSet(address indexed)`,
`LossBudgetFixed(uint256 indexed,uint256,uint256)`, `OwnershipTransferStarted(address indexed,address indexed)`.

**Added errors (5):** `NotAscending()`, `NotGuardian()`, `PriceOutOfRange()`, `RegistryTooLarge()`,
`RenounceDisabled()`.

All other functions, events and errors keep their signatures. The `auctions()` getter's output tuple is
unchanged.

## Index vault (`QuadrixIndexVault`)

Counts, old → new: functions 26 → 31, events 9 → 11, errors 10 → 12. Constructor unchanged.

**Removed:** none.

**Changed (state mutability):** function `renounceOwnership()`: `nonpayable` → `view`; signature and
selector unchanged (it always reverts with `RenounceDisabled`).

**Added functions (5):** `acceptOwnership() nonpayable`, `disableKeeper() nonpayable`,
`guardian() view returns (address)`, `pendingOwner() view returns (address)`, `setGuardian(address) nonpayable`.

**Added events (2):** `GuardianSet(address)`, `OwnershipTransferStarted(address indexed,address indexed)`.

**Added errors (2):** `KeeperDisabled()`, `RenounceDisabled()`. The index vault's `disableKeeper()`
refuses a caller other than the guardian with the revert string `not guardian`, not with an error.

## Source changes behind the diff

Diff of the two source files between the commits: basket 432 lines added or removed, index vault 99.
Every code change belongs to one of the following.

Basket:

1. One lock on every state-changing function, including `transfer`, `transferFrom` and `approve`.
2. Daily loss budget fixed at the day's first fill (`budgetValue`, `budgetSupply`, `lossDay`,
   `lossToday`, `LossBudgetFixed`).
3. Guardian with one power (`guardian`, `setGuardian`, `disableKeeper`, `NotGuardian`, `GuardianSet`);
   every keeper change, including the owner's `setKeeper`, closes every auction opened before it
   (`deadBelow`, `KeeperSet`).
4. Ownership in two steps (`pendingOwner`, `acceptOwnership`, `OwnershipTransferStarted`).
5. `renounceOwnership` reverts (`RenounceDisabled`).
6. The first reference price of an added asset is fixed at the announcement (constructor
   `refPrices_`, `announceRegistryChange` `addRefPrices`, `RegistryChangeAnnounced`).
7. Creation mints only for what arrived: each asset's arrival is measured after every pull, and the
   share count is the smallest proportion that arrived.
8. Every reference post is banded, the first one included, and every reference price must lie in
   (0, `MAX_REF_PRICE`] (`PriceOutOfRange`).
9. An asset is admitted (at construction, announcement and execution) only if it answers a token
   balance read, and the assets added or removed in one registry change must be strictly ascending,
   so none is listed twice (`NotAscending`).
10. At most 32 assets in the registry (`MAX_ASSETS`, `RegistryTooLarge`).
11. A redemption can skip named assets (`redeemSkipping`); `redeem` keeps its signature and behaviour.
12. `setFeeRecipient` settles the management fee owed to the current recipient first.

Index vault: items 1, 3 (without `deadBelow` and `KeeperSet`), 4 and 5, and deposits refuse while
the keeper address is 0 (`KeeperDisabled`).
