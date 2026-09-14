# Quadrix track record

The daily operating record of the Quadrix vaults, published so it can be checked
without trusting us.

One record per closed UTC day. Each record embeds the SHA-256 hash of the
previous record, and each day's head hash is committed to GIWA Sepolia as
transaction calldata. A retroactive edit breaks the chain, and the break is
detectable by anyone — that is the entire point of this repository.

GIWA Sepolia is a testnet. The anchors rule out one party, Quadrix, rewriting
or backdating a record; they do not outlive that chain. The time proof lasts as
long as GIWA Sepolia's history does, and a testnet reset would erase it.
Mainnet anchoring: not yet.

## Verify it

No dependencies, Node 18+:

```bash
node scripts/verify.mjs --dir ./trackrecord
```

It walks **both** published series from their own genesis — the closed DRY_RUN
rehearsal (`record.jsonl`, 2026-08-13 → 08-30) and the LIVE series with real
capital behind it (`record-live.jsonl`, from 2026-09-01) — recomputing every
record hash, checking each anchor transaction on GIWA Sepolia, and re-hashing
every decision document against the hash committed on chain. Exit code 0 means
every check passed. `--series live` or `--series dry` restricts it to one.

To check the copy served by the site instead of this one:

```bash
node scripts/verify.mjs --base https://quadrix.finance
```

Both should agree. If they ever disagree, this repository and the chain are the
authority — the site is a mirror.

## Second time proof — OpenTimestamps

GIWA Sepolia is a testnet, so the anchors above prove *what* existed but their
*when* lasts only as long as that chain's history. Since 2026-09-14 every record
head hash and every decision hash is also stamped with
[OpenTimestamps](https://opentimestamps.org) — Bitcoin calendar servers, no fee —
and the proofs are committed under `trackrecord/ots/` (one `.ots` per hash,
append-only). A fresh proof is *pending* until the calendar folds it into a
Bitcoin block, usually within hours; the daily `ots` workflow upgrades them.

```bash
node scripts/ots-stamp.mjs --verify      # bitcoin-attested / pending, per hash
```

Any OpenTimestamps client can verify a `.ots` file against the hash it covers
without trusting this repository.

## What is in here

| Path | What it is |
| --- | --- |
| `trackrecord/record.jsonl` | the DRY_RUN series (2026-08-13 → 08-30, closed): hash-chained daily records, append-only |
| `trackrecord/anchors.jsonl` | which transaction anchors each DRY_RUN head hash |
| `trackrecord/record-live.jsonl` | the LIVE series (from 2026-09-01, real own capital): hash-chained daily records, append-only |
| `trackrecord/anchors-live.jsonl` | which transaction anchors each LIVE head hash |
| `trackrecord/decisions.jsonl` | anchored manager decisions, by id |
| `trackrecord/decisions/` | the decision documents those hashes commit to |
| `scripts/track-record.mjs` | writes and anchors one day (scheduled daily in CI; see Timing) |
| `scripts/anchor-decision.mjs` | anchors a decision document |
| `scripts/verify.mjs` | the verifier above |
| `trackrecord/ots/*.ots` | OpenTimestamps proofs, one per record/decision hash (Bitcoin time proof) |
| `scripts/ots-stamp.mjs` | stamps new hashes, upgrades pending proofs (runs daily in CI) |
| `scripts/watchdog.mjs` | checks the published outputs for staleness, missing anchors and gas (scheduled every six hours in CI) |
| `docs/track-record-spec.md` | the rules the record is meant to follow; the status table at its top says which sections are implemented here |
| `keeper/nav-marks.jsonl` | append-only ledger of every qX20 NAV mark posted since the keeper moved here on 2026-08-21; earlier marks exist only as on-chain events |
| `keeper/update-nav.mjs` | the qX20 index keeper (scheduled every six hours in CI; see Timing) |
| `keeper/state.json` | the keeper's working file — overwritten each run, **not** a record |
| `keeper/RUNBOOK.md` | what to do when the keeper fails |

## Rules that make this worth reading

- **Append-only.** Corrections are new records; nothing is edited in place.
- **No backfilling.** A day the pipeline missed stays missing, and a missing
  benchmark price is recorded as missing. Gaps are part of the record.
- **The series never concatenate.** There are two: the closed `DRY_RUN`
  rehearsal (`record.jsonl`, 2026-08-13 → 08-30, empty book — its only content
  is proof that the recording infrastructure predates the capital) and the
  `LIVE` series (`record-live.jsonl`, from 2026-09-01, real own capital). Each
  has its own genesis and its own hash chain; they were never joined.
  2026-08-31 belongs to neither and was never recorded (see History).
- **Anchored decisions cannot be edited without detection.** A decision
  document's hash is committed on chain when the decision is made; the verifier
  re-hashes every document against that commitment, and the anchoring script
  refuses to re-anchor an existing id. Changing a decision means publishing a
  new dated document, which leaves a trace.

## The keeper, and why a mutable file lives here

`keeper/` runs the qX20 index: on a six-hour schedule it marks the model book
to market and posts the resulting NAV to the index vault on GIWA Sepolia. It
moved here on 2026-08-21 for the same reason the record did — a public
repository's CI cannot be starved by an unrelated project's quota. Marks posted
before that date exist only as on-chain events; the ledger here starts with
the first mark posted from this repository.

`keeper/state.json` is the one file in this repository that is **overwritten**
rather than appended: it carries the model units forward so the index level is
continuous across runs. It is a working file, not evidence. What was actually
posted is recorded in `keeper/nav-marks.jsonl`, one line per on-chain
transaction, appended and never rewritten — so the NAV of any past mark can be
checked against the chain without trusting the current contents of
`state.json`. The composition behind a mark is a different matter: a ledger
line carries the NAV and the index level, not the members, the units or
whether the book was re-weighted. The model book at any past mark lives only
in the git history of `state.json`.

qX20's current keeper reconstitutes membership at the first run of each
calendar month, with no notice period; the 2026-09-01 run swapped one
constituent and the only trace is that run's log and the `state.json` diff.
The seven-day announcement rule applies to the basket-vault registry, not to
this index vault yet.

## Timing

The schedules in `.github/workflows/` are cron times, not run times. GitHub
starts scheduled jobs late, by hours on a busy day:

- The daily record is scheduled at 00:10 UTC. Observed `observedAt` times run
  01:48–11:20 UTC in the DRY_RUN series and 01:54–04:43 UTC so far in the LIVE
  series.
- The keeper is scheduled every six hours. Over its first 90 marks here the
  gaps ran 0.1–13.8 h (median 6.1 h), three of them longer than 12 h, and two
  days received two marks each.
- The watchdog is scheduled every six hours and is subject to the same delay.

A record's quantities are what the chain reports at the moment the run happens
— the following morning, at block `latest` — while its prices are the record
day's 24:00 UTC close. A deposit, withdrawal or trade inside that window is
dated to the record day, not to the day it happened.

## What this does and does not prove

It proves *when* a record or a document existed, and that neither has been
altered since. It does not prove that the reasoning inside a decision was
sincere, or that a strategy is any good — nothing can. It removes one specific
move: writing history afterwards and presenting it as contemporaneous.

## History

The record began on 2026-08-13 and ran inside the private Quadrix application
repository until 2026-08-21, when it was moved here so that the record does not
depend on that repository's CI quota or on its being published. The data is
carried over byte for byte — the verifier proves that, since every hash and
anchor still checks out. Note that git history was never the evidence here: the
on-chain anchors are, and they are unaffected by the move.

The DRY_RUN series was closed on 2026-08-30 and the LIVE series opened on
2026-09-01. 2026-08-31 belongs to neither and was never recorded: the switch to
LIVE landed on 09-01 before that day's scheduled run, and the run — which would
have recorded 08-31 — found the date before the LIVE inception and wrote
nothing. It is a gap, not a join, and it stays.

The LIVE inception document
(`trackrecord/decisions/2026-09-01-n1q-live-inception.md`) was anchored on
2026-09-01 at 02:17 UTC, about two hours after the first deposit and on the
same UTC day — after the deposit, not before it as spec §5 asks. Its "NOT YET
ANCHORED" banner is part of the hashed text and stays there; editing it would
break the anchor.
