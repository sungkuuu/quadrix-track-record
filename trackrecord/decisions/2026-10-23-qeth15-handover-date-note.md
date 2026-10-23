# qETH1.5X mark vault — the ownership handover began on 2026-10-23, not on the day deposits opened; a correction to the record, 2026-10-23

**Written:** 2026-10-23. **Effective:** 2026-10-23 — the ledger's `effectiveFrom` is the date in the filename; nothing in
the vault changes on that date or because of this document. **Series:** `trackrecord/record-qeth15.jsonl` — unchanged.
All dates and times are UTC.

## What this document does

It records that two sentences of the anchored decision `2026-10-22-qeth15-mark-vault` are not true of what happened:
deposits opened on 2026-10-22, as stated, but the ownership handover to the timelock began on 2026-10-23, not on the
same day. It corrects those two sentences and nothing else.

Anchored documents are not edited: `scripts/anchor-decision.mjs` refuses a changed hash under an existing id and says
to publish a new dated decision instead. The file `trackrecord/decisions/2026-10-22-qeth15-mark-vault.md` is unchanged
(sha256 `86dcad7cc30cf5e8d3c3ed5e8083b6eeb90069906a385c714e5b6f1e90da05e3`). This document is the correction, anchored
beside it.

## What was wrong in `2026-10-22-qeth15-mark-vault`

1. "What starts today", lines 17–18: "On the day deposits open, ownership starts passing to the timelock of the
   redeployed vaults, which can accept it 72 hours after the scheduling transaction."
2. "Order", step 6, lines 86–88: "The same day, after (5): the keeper key proposes the timelock of the redeployed
   vaults, `0xC387f483A4a38C58c746b476340Be7F52b69090A`, as the vault's owner, and the timelock's proposer — a hardware
   key held by the owner — schedules the acceptance."

The corrected statement, for both: deposits opened on 2026-10-22; on 2026-10-23, the next day, the keeper key proposed
the timelock of the redeployed vaults, `0xC387f483A4a38C58c746b476340Be7F52b69090A`, as the vault's owner, and the
timelock's proposer — a hardware key held by the owner — scheduled the acceptance. The timelock can accept from
2026-10-26T02:44:41Z, 72 hours after the scheduling transaction.

## The facts

1. **Deposits opened on 2026-10-22.** The keeper key, the vault's owner, called `setDepositCap(1000000000000)` —
   1,000,000 test dollars at six decimals — in `0x263749911bc09f3d51ab2b7b473991424ec2cd3ceb5978ec36f6e70588252ba6`
   (block 39338713, 2026-10-22T15:43:49Z), after the decision's anchor (block 39316309, 2026-10-22T09:30:25Z).
2. **The proposal was sent on 2026-10-23.** The keeper key called `transferOwnership(0xC387f483A4a38C58c746b476340Be7F52b69090A)`
   on the vault in `0x67e18448e41a8724be5c9c99d9f27e646e9cc77c7a3ddbc980d1abd42e0b2ff5` (block 39378065,
   2026-10-23T02:39:41Z). At the time of writing (block 39378601), the vault's pending owner is the timelock and its owner is the keeper key.
3. **The acceptance was scheduled on 2026-10-23.** The timelock's proposer called `schedule` on the timelock for
   `acceptOwnership()` on the vault (value 0, predecessor 0, delay 259200 seconds) in
   `0x34a6205cec152183bda4570df1311f512897e30ab3c0cd841fe3e247f9cd8061` (block 39378365, 2026-10-23T02:44:41Z).
   The operation id is `0x767f69baa8a1a0efbe650101f1321c58619b8b043f8c190d4b915f721c033760`; `getTimestamp` returns
   1792982681 (2026-10-26T02:44:41Z), which is the scheduling block's time plus 72 hours.
4. **Dates.** At 2026-10-22T15:12:45Z, site commit `042e95ac` recorded as closed the deposit-screen check that the
   decision's checklist run record states as pending, in a follow-up checklist run record of this product,
   `docs/methodology/checklist-runs/qeth15/2026-10-23.json` (site repository, private; sha256
   `c8694e8b071084a4dd5f4a3a5f79ea4f4fbcba007f7ddb4421847c63930f2884`; its file name carries the date in Korea time).
   That record closes the deposit-screen check and records none of the transactions of steps (5) and (6); those are
   for the later dated checklist run record that the decision names. Deposits opened at 2026-10-22T15:43:49Z. The two
   handover transactions were sent at 2026-10-23T02:39:41Z and 2026-10-23T02:44:41Z.

## What it is not

Not a change to the vault, its rule, its level or its record lines; not a change to any value of the decision. The
order of the decision holds: deposits opened before the handover began, and both came after the anchor.

## What stays

- The deposit cap, 1,000,000 test dollars, set on 2026-10-22 as the decision states.
- The guardian, `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3`; the keeper, the keeper key
  `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902`; deposits not paused.
- The timelock `0xC387f483A4a38C58c746b476340Be7F52b69090A` and its delay of 72 hours (`getMinDelay` 259200).
- The roles table: the keeper key is the owner until the timelock accepts; then the timelock.

## How to verify

With `cast` against `https://sepolia-rpc.giwa.io` (GIWA Sepolia, chainId 91342), vault
`0x5F1FE9E18a2beeE8Bb4Ec6f15571d6ba4BbC19F6`, timelock `0xC387f483A4a38C58c746b476340Be7F52b69090A`:

1. The three transactions: `cast receipt <tx>` (status 1, block as above) and `cast tx <tx> input`, decoded with
   `cast calldata-decode` against `setDepositCap(uint256)`, `transferOwnership(address)` and
   `schedule(address,uint256,bytes,bytes32,bytes32,uint256)`.
2. The times: `cast block <block> --field timestamp` for blocks 39338713, 39378065 and 39378365.
3. The operation: `cast call <timelock> "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" <vault> 0 0x79ba5097 0x0000000000000000000000000000000000000000000000000000000000000000 0x27e421bbf07cd6862e53ade1a0068b7d67a328e398d608de5f20a6534674160d`
   returns the operation id above; `getTimestamp(bytes32)` on it returns 1792982681.
4. The vault: `owner()` returns the keeper key `0x8c23D05Ea268a9c183Ee033Cf07cFEc38d0f7902` until the timelock accepts,
   `pendingOwner()` the timelock, `keeper()` the keeper key, `guardian()` `0xE20FcC34cA4d20F6aD1b7dcbf4229eF5C36634A3`,
   `depositCap()` 1000000000000, `depositsPaused()` false.
5. The 2026-10-22 sentences: the file below at its anchored hash, lines 17–18 and 86–88.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `2026-10-22-qeth15-mark-vault` (`trackrecord/decisions.jsonl`) | sha256 `86dcad7cc30cf5e8d3c3ed5e8083b6eeb90069906a385c714e5b6f1e90da05e3`, tx `0xd41930982a4080a5866e15dc0dc612a8b36f7c19b435ffd450e846e476af278e`, block 39316309, anchored 2026-10-22T09:30:25Z |
| site `docs/methodology/checklist-runs/qeth15/2026-10-23.json` (follow-up run record) | commit `042e95ac230f6b7f793d4eb74f7d2430fcfc76cf` (2026-10-22T15:12:45Z), sha256 `c8694e8b071084a4dd5f4a3a5f79ea4f4fbcba007f7ddb4421847c63930f2884` |
| quadrix-track-record, written against main | `662c4cb` |
