# Testnet vaults — redeployment to new addresses, 2026-10-21

**Decided:** 2026-10-19. **Effective on chain:** 2026-10-21 08:04 UTC, the block of the last
deployment below. **Applies to:** the eight testnet vaults listed under "Old and new addresses", on
GIWA Sepolia (chainId 91342). No index rule, weight, threshold or schedule changes. The paper
series and their anchors continue unchanged.

## Why

The vault contracts were changed to close three attack paths found in an internal red-team pass,
and seven earlier findings, and ownership now moves in two steps. The comparison throughout this
document is with the code at the old addresses, not with any intermediate build. A deployed contract cannot be
changed, so each vault is deployed again at a new address. In one sentence each:

- **One lock on every state-changing function.** A call into a vault can no longer re-enter any
  state-changing function of the same vault, including share transfers and approvals.
- **The daily loss budget is fixed at the day's first fill.** The value and the share supply that
  bound a basket's auction losses for a UTC day are read once, at that day's first fill, and losses
  are counted per share. Creating or donating during the day no longer enlarges or refills the
  budget.
- **A guardian that can only stop the keeper.** A separate address can, at once, stop the keeper:
  no new marks, reference prices or auctions, and no fill of any auction opened before that moment.
  It can do nothing else.
- **Ownership moves in two steps.** A new owner must accept before it holds the seat, so a mistyped
  address never becomes the owner. Ownership of every new vault moves to a timelock (below).
- **Seven earlier findings, fixed in the same code**, one line each:
  - The first reference price of an added asset is fixed at the announcement.
  - Creation mints only for what arrived.
  - Every reference post is banded and capped.
  - An asset is admitted only if it answers a token balance read, and the assets added or removed
    in one registry change must be strictly ascending, so none is listed twice.
  - At most 32 assets.
  - A redemption can skip a named asset.
  - The fee is settled before the fee recipient changes.
- **Ownership cannot be renounced.** `renounceOwnership` reverts, so the owner can always replace
  the keeper and the guardian.

## Old and new addresses

| Vault | Old address | New address | Creation tx | Block |
| --- | --- | --- | --- | --- |
| qX20 basket | `0x39f2993f7b21b85d857c9a19de07cdcca7a0a1c9` | `0xF532A8EF63216C6DB40dB0d620535f69364b698b` | `0xcd586046d8f79923668eecbe6804fca79e75c4ba21b97b90267104a017832872` | 39,223,241 |
| qAI basket | `0x75b072e674afad13ff0c2b75a8937656643cbe97` | `0xE65eaD3BBA5aD982B71186A5Dd5B72e12Ad26aF0` | `0xacc0d8ce2fb0fe07e6a62118bf75a86601ff1de2bea6e5102da927a8c0da64bc` | 39,223,563 |
| qDEFI basket | `0x88d3b5f638fe0d331797c612a5496bd8f0491fd4` | `0x62737ed46a5cd950B8e41EC2782833C00aa383A0` | `0xa0216cf59973ff11d6b2849f00250319ed4ed20ad2a5edc0f4f12e2cd4429e52` | 39,223,817 |
| qREV basket | `0xba83462fdfede13dc7eb1d1fd893ae76dcaad975` | `0x6591b7C12c736B9cF49949b44188730660E18Cd0` | `0x31f28cc26d2667c5380f5a1319db4f2c823dbc6070c62ebd1a61bf03d0d26283` | 39,224,100 |
| Triens basket | `0xafd422c43e8a0afd36a9bce01bb20db19e4324a5` | `0xa2cD3CEF22F26E5ad130d1D6Db01ebc0CEaa4F9C` | `0x5e4a13ba2aab5aeb870a07b3d25003b0874e99d41f85a15cfd30b1afa72bdbbb` | 39,224,356 |
| Barbell basket | `0xa9be0cf6f9d0bc95b757b97216b32f6d4de7df04` | `0xa4DBAFfFbcbcFEaF5938640487Ddcb1Eff963162` | `0xf68b4c843af6db421fe50a77b1707c8a3e779b5115f7bdd5f6426c446f998beb` | 39,224,540 |
| qX20 tracking vault | `0x2A165501ddA6e430fF98E82682f53CA8465Bb21f` | `0xFd6180b9D0b2C77A2785E32527f8DB20e3Bc7F9c` | `0x08a88a2fb8880a2fed0319253a197eabb0ddf5e4b89895f8a388149679e98599` | 39,224,689 |
| qBTC2X mark vault | `0x7C10C33aEd202207Bb0C054B32C0708ABAC54070` | `0x8b0200B7e920a7fB06e94890d5Efb6aB7d2C1378` | `0xa2fda8d35a4c2d581080f49675e1b4b710a50129e3b499501ecf8b3ebc67e0d9` | 39,224,755 |

The demo basket and the managed demo vault do not move. Deposits on the managed demo vault and
creation on the demo basket were closed on 2026-10-12; redemption on both stays open.

**This supersedes the vault address stated in decision `2026-10-13-qbtc2x-paper-inception`**
(`trackrecord/decisions.jsonl`; sha256 `3ffc004d025f68b1f955cd1f5ece8ae028cadbc5e500d15dc28bd1e4318177eb`,
anchored in tx `0x822c2aa6f0c16140f24725e2d2fb43121e10f163f4afef26cfb43a2c1177a2cf`). That
decision says the vault "runs the same contract as the qX20 tracking vault" and that no new
contract code was involved; from 2026-10-21 both vaults run the contract pinned below, which is
new code. The qBTC2X series, its rulebook and its keeper code are unchanged; only the vault address in `keeper/leverage-vaults.json` changes (below). Marks posted to the old
vault: 8, the last on 2026-10-21; it took no deposit.

## Order on the day

1. Deploy the eight vaults (one run each). Bidding is open on every new basket from its deployment;
   the guardian is appointed in the same run.
2. The keeper posts the first reference prices and marks at live prices; a person checks them
   against the record before deposits open.
3. Deposits open: the qBTC2X mark vault's deposit cap goes from 0 to 1,000,000 test dollars, the
   cap stated in decision `2026-10-13-qbtc2x-paper-inception` (not a tested value). Basket creation
   is in kind and reads no price, so it follows the old vault's setting from deployment.
4. Ownership of every new vault moves to the timelock: step one on 2026-10-21, before this
   decision is anchored — the owner names the timelock as pending owner, and the timelock's
   proposer schedules the acceptance. The timelock itself accepts no earlier than 72 hours after
   that scheduling transaction (2026-10-24 08:37:05 to 08:41:39 UTC). The acceptance is recorded in the run
   record, not in this decision.
5. The old vaults are retired (next section).

## What stays with the old addresses

The old vaults stay on chain. **Redemption needs no key and is never closed.** From 2026-10-21 09:25 UTC (the last of the twelve closing transactions, block 39,229,612):
creation is closed on the old baskets (creation switch off, per-transaction cap 0), deposits stay
closed on the old index vaults (the qX20 tracking vault is paused, the qBTC2X mark vault's cap is 0),
their marks stop at their last posted navPerShare (qX20 1.070599, qAI 0.865469, qDEFI 1.162022, qREV 1.227967, Triens 0.969953, Barbell 0.975919, the qX20 tracking vault 1.257779, the qBTC2X mark vault 1.026582), and the site shows them as superseded with the redemption path
only. Nothing is moved for holders: a holder redeems in kind from the old basket and, if they
choose, creates in the new one with the same tokens — one new share for each old share, less the
creation fee. Approvals given to an old address do not carry over.

The deployer redeemed its own old shares in kind in each basket to fund the new genesis
(numbers in the table below); no other holder's shares were touched.

## State of each new vault at deployment

- **Baskets**: the registry is the registry in force on the old vault at the block of the deployer's redemption (table below) — its
  composition at deployment and every change since, each announced and executed through the
  seven-day registry delay — in the same order, with the same asset contracts. Genesis: 1,000,000
  shares to the deployer, backed by exactly what 1,000,000 old shares held at that block (each
  asset rounded down), so **one new share holds what one old share held**. `navBase` is unchanged;
  the first mark continues the old vault's navPerShare, in steps of at most 15%. Reference prices are the old vault's at that block and are not stamped: no auction
  can fill until the keeper's first in-band post. No auction, no pending registry change; the fee
  accrues from genesis.

  | Basket | Old shares redeemed by the deployer (tx) | Genesis basis block |
  | --- | --- | --- |
  | qX20 | 998,775.211328329781704760 (`0x93588b5fe09af7ad63c4acc5a0e32b424a63013b5c08a6a36e4a7f6a7035a698`) | 39,223,236 |
  | qAI | 845,081.931109967599337221 (`0x3abb1c99380f7cbd3047f8182f2c108ab39d867d18dc1964fcd5ea8e955d4290`) | 39,223,558 |
  | qDEFI | 973,627.572333270019268434 (`0x355d137b4edf0ee65b8dfb3b64d5a90b3e2257f89d9131add7e12472b442f680`) | 39,223,813 |
  | qREV | 875,339.057340170058750742 (`0x2a246e018c5cbb54e77a864d732934c92f1b84f9ca72f786a8d872829b743cf2`) | 39,224,094 |
  | Triens | 999,075.085705982204689109 (`0x2c434048b978fef43dcd4efdc4d6bed07006e34c7613a0c58e7e56d3baa0e118`) | 39,224,351 |
  | Barbell | 1,000,070.999113222471491927 (`0xabdaffc3686027c7a4ff8c68543c9b54f53d9027a68976d720348cde5f1399a0`) | 39,224,536 |

- **Carried over unchanged from each old vault** (every value re-read at the read-back block:
  qX20 39,223,399, qAI 39,223,658, qDEFI 39,223,936, qREV 39,224,209, Triens 39,224,437, Barbell
  39,224,591): management fee qX20 0.50%, qAI 1.00%, qDEFI 1.00%, qREV 1.00%, Triens 1.00%, Barbell 0.50% a
  year (a ceiling: it can only go down; a price, not a tested value); per-transaction creation cap
  10,000 shares (not a tested value); creation open to any address (testnet); creation fee 0.10% (a
  price, not a tested value); per-fill loss limit 1%, daily loss budget 3%, reference age limit
  3,600 s (none of the three a tested value). Both fee recipients are the keeper key, as on the old
  vaults.
- **qX20 tracking vault**: starts at par 1.000000; the model index continues; the first marks step
  to the model level within the contract's 25% per-transaction bound (as on 2026-09-14). Deposits
  stay paused as on the old vault; deposit cap 1,000,000 test dollars (not a tested value).
- **qBTC2X mark vault**: starts at par 1.000000; deposit cap 0 until the first mark has been checked
  by a person (step 3).

## Roles

| Role | Address | Who holds it | What it can do |
| --- | --- | --- | --- |
| Owner | the deployer key (the keeper key) until the timelock accepts; then timelock `0xC387f483A4a38C58c746b476340Be7F52b69090A` (deployed 2026-10-20, tx `0xba8b7fa1b452a544c3702b9cdd9db7d11368f889151712fbe1aecfa075f3b52c`; transfer tx and scheduling tx on 2026-10-21, and acceptance executable 72 hours after the scheduling tx, per vault in the table below) | `TimelockController`, delay 72 hours, proposer `0xBd5AE28E60Cb8023c8F27546823b0b41eC4263e2` (a hardware key held by the owner, distinct from the keeper key and from the guardian key), execution open to anyone, no admin other than the timelock itself; any role change passes the same 72-hour delay | every setter, registry announcements, keeper and guardian appointment |
| Keeper | `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` | the keeper key (as on the old vaults) | marks, reference prices, auctions |
| Guardian | `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3` | a hardware key held by the owner | `disableKeeper` only |
| Fee recipient | `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` (carried over from the old vault, for both the management fee and the creation fee) | the keeper key | receives fee shares |
| Bidder | any address (one address, `0x3E54DC59A8fBC35983adAf273851dc2EdedD2439`, is also on the whitelist; the whitelist has no effect once bidding is open) | anyone | fills auctions (bidding open from deployment) |

| Vault | Transfer tx (`transferOwnership`) | Block | Scheduling tx | Block | Acceptance executable from (UTC) |
| --- | --- | --- | --- | --- | --- |
| qX20 basket | `0xc77239086da91da6c606a8fcbd95ac3dd3f23575ae307b58ad98c9bdd015fcba` | 39,226,276 | `0xb46658a1715ef5cf693ec91425651076ff436b66102fed6d565b05d6505dc903` | 39,226,709 | 2026-10-24 08:37:05 |
| qAI basket | `0xf188fd6b45e68c78a4bfbea91fcebd4191f41b6d8001ff2856838f7b0f85a51d` | 39,226,289 | `0x02b087c02be9300a24ccadb92f70f1c6e24ef844167f16c2bbb59a8209ba7a16` | 39,226,742 | 2026-10-24 08:37:38 |
| qDEFI basket | `0x0aa36f28001fed1edbf288c5f02384b4acac6ff16db5552d1d24a204b5d87bd7` | 39,226,305 | `0xf993fc344d4bcb21f80505fb3a3bc3eaf52ad5b3645a435df1850f94b5c3cbd6` | 39,226,773 | 2026-10-24 08:38:09 |
| qREV basket | `0x087dd744cf631236ce7b9d0c7facd5d7de16c91614fb19d01e5e8cbed8cbb099` | 39,226,324 | `0xee47768b79f29d4c57ad71c45ca9e0a768c6d81be37c7d397670ccee5506d619` | 39,226,841 | 2026-10-24 08:39:17 |
| Triens basket | `0x58ca7cf6cdc0d1b12b02403e15575820d334a5fc6332d8cc4f070929de623b1f` | 39,226,336 | `0x956ba225c38b8c86e8b1b9d8e928d16f731bb84b94442b7e730ac4a58dbf4d8b` | 39,226,887 | 2026-10-24 08:40:03 |
| Barbell basket | `0x8e0ccacd08fd3036001148903f7d36991f216a454ba4770d824c9d35449caefb` | 39,226,346 | `0x089eeb7041145bb60b76e1f78fddb508ebb61b8a0b28d900fc4e297a85549767` | 39,226,918 | 2026-10-24 08:40:34 |
| qX20 tracking vault | `0x36d85a4de08fa99667e33c15224163360b360a00c8fc25acb18833c060467792` | 39,226,356 | `0x8eb5870ad07efdf79466780ee314955700e1ca315e04ea225ea524b3fe28f0cd` | 39,226,950 | 2026-10-24 08:41:06 |
| qBTC2X mark vault | `0xc793376b5d8088ec67bf60be0a2c109b1ed1d8af16ebbfe444df9b739a677ecd` | 39,226,445 | `0xe0cd2e78c1300144bf956ba8320d01faa9610c627f75bef96e33406db44fa479` | 39,226,983 | 2026-10-24 08:41:39 |

**The timelock delay, 72 hours, is an owner decision, not a tested value.** Reason: there is no
alert on queued owner actions yet, and 72 hours is long enough to cover a weekend (Friday 17:00 to
Monday 17:00 KST), which is the case the value was chosen for. This first handover runs from Wednesday
to Saturday. Until step 4 completes the owner is the deployer key; step 4 completes only when the
timelock itself executes the acceptance.

Read back after deployment at block 39,223,399 (qX20), 39,223,658 (qAI), 39,223,936 (qDEFI),
39,224,209 (qREV), 39,224,437 (Triens), 39,224,591 (Barbell), 39,224,698 (qX20 tracking vault) and
39,224,760 (qBTC2X): `owner()`, `pendingOwner()`, `keeper()`, `guardian()`
(≠ 0, ≠ keeper, ≠ owner, no role on the timelock), `getMinDelay()` = 259,200, caps,
`biddingOpen()` true on every basket, registry length and order, reference prices.

## What behaves differently

1. **The owner's `setKeeper` closes every open auction**, also when it re-appoints the same keeper.
   Reconstitution tools do not change the keeper in the middle of a round.
2. **Index vaults (qX20 tracking, qBTC2X) refuse deposits while the keeper address is 0**
   (`KeeperDisabled`). Redemption continues at the last mark. The keeper address becomes 0 only
   through the guardian.
3. **`renounceOwnership` reverts** (`RenounceDisabled`).
4. **`setFeeRecipient` settles the fee owed to the current recipient first.**
5. **Daily loss budget**: fixed at the day's first fill; `lossToday` now means the day's loss per
   share × the supply fixed that day (USD × 1e18), not the sum of losses. With an unchanged supply
   the daily cap is now exactly the stated 3% of the day's starting value.
6. **After large redemptions within a day, fills below fair value can be refused for the rest of
   that UTC day**, because losses are counted per share. Fills at or above fair value pass. This
   protects the remaining holders.
7. Every state-changing call pays more gas for the lock.
8. **Bidding is open from deployment.** On every new basket vault `biddingOpen()` is true: any
   address can fill an auction, on the same price curve, floor and daily loss budget. The old
   vaults accept fills only from whitelisted bidders. Opening cannot be undone: the contract has no
   function that closes bidding.
9. **Ownership transfer takes two steps** (`transferOwnership`, then `acceptOwnership` by the new
   owner); a pending transfer can be overwritten by the owner before it is accepted.

## Public interface changes

- Basket: new `budgetValue()`, `budgetSupply()`, `lossDay()`, `lossToday()`, `guardian()`,
  `deadBelow()`, `setGuardian(address)`, `disableKeeper()`; events `LossBudgetFixed`, `KeeperSet`,
  `GuardianSet`; errors `NotGuardian`, `RenounceDisabled`. `renounceOwnership()` is now `view`
  (same selector).
- Index vault: `guardian()`, `setGuardian(address)`, `disableKeeper()`; event `GuardianSet`;
  errors `KeeperDisabled`, `RenounceDisabled`; `renounceOwnership()` `view`.
- Both: `pendingOwner()`, `acceptOwnership()`; event `OwnershipTransferStarted`.
- Basket, changed against the old deployed code: `announceRegistryChange` now takes the first
  reference prices of the added assets — `(address[] adds, uint256[] addRefPrices,
  address[] removes, bytes32 decisionSha256)`; the old three-argument selector is gone. Event
  `RegistryChangeAnnounced` carries the same new field. Also new since the old deployed code:
  `redeemSkipping(uint256,address,address[])`, `MAX_ASSETS()`, `MAX_REF_PRICE()`; errors
  `NotAscending`, `PriceOutOfRange`, `RegistryTooLarge`. The constructor now takes `refPrices_` (see the constructor arguments file).
- One function signature changed (above); nothing else removed. The `auctions()` tuple keeps its
  positions. Full ABI diff against the old deployed code: `docs/abi-diff-3a70038-vs-e3ccb611.md` in the record
  repository, sha256 `27d9fcb36654223d75b22aca3a093ec713243fbfcd9a8be90d1cc00ba921ec15`, as committed with this document. The contract sources, libraries and build settings at `e3ccb611` are identical to those at `85c37fc4`, the commit the vaults were built from (same source sha256 as below).

## Build

Source: site repository (private), commit `85c37fc415bad6c856fdeae4a8a87bc1b1c763ec`, files
`contracts/src/QuadrixBasketVault.sol`, `contracts/src/QuadrixIndexVault.sol` (sha256
`c566e8c5c9112a65f9dd1f149dd13feb7e6564d9a26d9cb689209ac57437ee8c`,
`c859e42dd3dedca881aec0c5882261c38cfb32a02d48dd582cceb8daad7af553` each). Compiler solc 0.8.24,
OpenZeppelin Contracts 5.6.1, optimizer 200 runs, EVM cancun. Runtime size: basket 16,522 B, index
vault 6,135 B. Deployed runtime code hash per vault: the six baskets
`0x7b8a1bc7afbfbd883f9f0469bf00592816821826c7d3d6b0a27d412690d92656`, the two index vaults
`0x4d17aa8972b680808e9d371b4e3caba9603145bca7017278f6186bfe392b3b17` (equal to the build byte for byte, immutables included).
Constructor arguments: `docs/constructor-args-2026-10-21.md` in the record repository, sha256
`4e88fdff2e27aeee97f9bb79ac50e22d097883115022c7609bd75da13a37cfec`. Deployment script: `contracts/script/RedeployVaults.s.sol`,
sha256 `ee3fea41eb344f977bc37016193598493b4112df45f633d70a8c51521b0e793f`; it reads
each old vault and asserts the new one in simulation, before anything is sent; each transaction is
sent only after the previous one succeeded, and the chain state is read back after each run.

## Rulebooks and verifier

The vault address is part of five basket rulebooks and the qX20 rulebook, so their files change;
nothing else in them does.

| File | sha256 before this change (record repository HEAD `f60087861fbd6043cbb6e497d69d11f2edcea438`) | New sha256 (commit `7e7e3c012f276ac1fd29fb7217212f1ccf4ca87c`) | Keys changed |
| --- | --- | --- | --- |
| `keeper/rulebooks/qx20.json` | `bcdae70e1c548463ea5d1bfd89a21f8309a14c14a879fea7a2d897375736e06f` | `ad805c9828eb8e05b15a8a37bac8783c6b575f90a266f09052a27d6ff870e988` | `basket.vault`, `marking.navTracker.vault` |
| `keeper/rulebooks/qai.json` | `c3e9f08116a6dea019dd379a10edc9ad63244d53dbda1497e23c6a85d3bf86e7` | `9ffde9c0bd0a6d8136e134740ea8ffefe5236f01536aae5cded5e02e8634d809` | `basket.vault` |
| `keeper/rulebooks/qdefi.json` | `d7c676dba509a60464114675575cdc4eeb54976a26b25b4ace3c61c232029838` | `eb5431c3595f8ac22dd7cd65c6b10f708151668b648e9ed6a3ea5259f9d4ae06` | `basket.vault` |
| `keeper/rulebooks/qrev.json` | `eb4c7c16684db13b4bf27dbbaa4452d701cd26fa1fa52217c0fc76cbde0754da` | `3a4a785c9b3300307781e41cc204cbd57f357f6d2cbc42845f6fc56aff971a21` | `basket.vault` |
| `keeper/rulebooks/triens.json` | `3d97e28e357fe9ff014f6fe217c7a243ce5bf8bc6e28a3c9712cb1ace4562cf1` | `78af0c79b71d12166d7f89a91ec0caac908c38ecdcabb5ef37d40459d7b81877` | `basket.vault` |
| `keeper/rulebooks/barbell.json` | `a2bd7316d49c3e3634735d60096aad55219b05d50f8c649db86ce58b55e64f77` | `725fb195e940767473984343948d7d74ed8fdff87285e4d2969d78d4936ff203` | `basket.vault` |
| `keeper/update-nav.mjs` | `cbee002f75dd706a9c52f5bbd63554f868084015597724ac46a7b81edcc2c72d` | `a4560c16c016bfc872658b027972747dd747b8f8e743ffc6b7366f30871d56e5` | `VAULT` |
| `scripts/qx20-marks-from-chain.mjs` | `823485d0ddd96b31eb31cd17c3e4fbfa08cbcebcc4ffd00dcf25e7716acaa539` | `d5978c58a66d18095911018dc5fe19e49d4d6378583e5d5b1f7f38196509ae61` | `VAULTS` |

The new values are those of commit `7e7e3c012f276ac1fd29fb7217212f1ccf4ca87c` on the record repository's working branch, made after the
deployments were read back; that commit was merged to the main branch unchanged (merge commit
`eb0761d`, 2026-10-21 08:50 UTC) before this decision was anchored.

`basket.navBase` does not change (one new share holds what one old share held). The qBTC2X mark
vault's address is kept in `keeper/leverage-vaults.json`, outside the rulebook; `qbtc2x.json` does
not change.

`scripts/verify.mjs`: old sha256 `a346b0f51378638c5edba8d7b9f89588f0d1f2501a662b2ef30fecf9c5df8114` (at the same record repository HEAD) → new `65f99e7c92194cf5515c2ee8a5358681a7553ee44a5ab36c05f8c77e58d890b1`.
The only changed line adds the new qX20 tracking vault address to the list of published qX20
contracts. The pins in decisions
`2026-10-13-qbtc2x-paper-inception` and `2026-10-16-qeth15-paper-inception` stay true of the file at the commits they name.

## Tested, and not tested

- Tests: 477 run, 0 failed, at the commit above, including 24 tests of the deployment script
  itself: it rebuilds an old basket's registry, prices, policy and book on a new address and
  refuses a pending registry change, an open auction, an asset in removal, a creation cap that
  would reopen genesis, and a guardian or bidder that is also the keeper or the owner; its
  read-back fails when a setting or a holding differs.
- Rehearsals of this deployment on local forks of GIWA Sepolia: 2026-10-14, at block 38,602,851,
  inside the deployment workflow — the eight deployments and their read-backs; the handover, the
  first mark and the deposit opening were not rehearsed on that fork. 2026-10-20, at block 39,126,810,
  the same eight deployments with the timelock already deployed on chain; and, on a separate
  fork, one basket's handover with the owner key and the proposer key kept apart, through the
  72-hour wait to the timelock's acceptance.
- Not tested, in force before this document and unchanged by it: the per-fill loss limit of 1% and
  the daily loss budget of 3% (how the budget is counted changes, above; its value does not), the
  reference age limit of 3,600 s, the per-post band of 15% on basket marks and reference prices,
  the index vaults' bound of 25% per mark, the seven-day registry delay, the per-transaction
  creation cap of 10,000 shares, the qX20 tracking vault's deposit cap of 1,000,000 test dollars
  and the qBTC2X mark vault's deposit cap of 1,000,000 test dollars. They have not been tested.
  New in this code and not tested: the limit of 32 assets per registry and the ceiling on any
  reference price, 10^30 (USD × 1e18 per base unit). The management fees and the 0.10% creation
  fee are prices, not tested values; the 72-hour timelock delay is an owner decision (above).
- **Not closed by this change** (stated so that nobody relies on it):
  - A UTC midnight lets two daily budgets be spent about two seconds apart (at most about twice
    the daily budget in total). A rolling budget has no code specification yet.
  - The daily budget measures losses at the keeper's reference prices. A keeper that walks its
    reference prices within the per-post band is bounded by the band, the reference age limit and
    the guardian, not by the budget.
  - Read-only re-entrancy: value views can show intermediate state inside a callback. The vaults do
    not consume these values; a third-party integration reading them inside a callback could.
  - Index vaults: after the guardian stops the keeper, redemptions continue at the stopped mark; after
    the owner re-appoints a keeper, deposits reopen at that mark until the new keeper's first post; a
    keeper that simply stops posting leaves deposits open at the last mark.
  - The guardian is not forced by the contract to differ from the keeper; the deployment asserts it.
  - Creator side, now that creation is open to any address: `create` takes no minimum of shares
    out, no deadline and no registry hash, so a creator's only bound is the amounts it sends and
    approves.
  - Bidder side, now that any address can fill:
    - `fill` takes no maximum payment and no deadline, so a bidder's only bound is the allowance it
      gives; give an allowance equal to the quote for each fill.
    - A quote is not frozen while an auction is open: a keeper reference post or an owner policy
      change moves the price of an open auction.
    - An auction opened before an asset's removal that buys that asset stays fillable: paying one
      base unit of it into the vault keeps the balance above zero and delays finalization until the
      keeper cancels that auction; a drain auction does not finalize the asset in the same call.
    - An auction that outlives a removal and a re-addition of the same asset becomes fillable again,
      on its old curve.
    - After a sequencer halt, a re-mark held back by the per-post band is fresh but wrong, and a
      bidder can take the gap to the market price.
  - Reference price unit: unchanged (USD × 1e18 per base unit).
- No external audit. Testnet only; the vaults hold test assets.

## Pinned

| Repository | Commit pinned |
| --- | --- |
| quadrix-track-record (keeper settings for the new addresses) | `7e7e3c012f276ac1fd29fb7217212f1ccf4ca87c` |
| quadrix (site, private — contract source, deployment script and tests) | `85c37fc415bad6c856fdeae4a8a87bc1b1c763ec` |
