# Quadrix track record

The daily operating record of the Quadrix vaults, published so it can be checked
without trusting us.

One record per closed UTC day. Each record embeds the SHA-256 hash of the
previous record, and each day's head hash is committed to GIWA Sepolia as
transaction calldata. A retroactive edit breaks the chain, and the break is
detectable by anyone — that is the entire point of this repository.

## Verify it

No dependencies, Node 18+:

```bash
node scripts/verify.mjs --dir ./trackrecord
```

It recomputes every record hash, walks the chain, checks each anchor
transaction on GIWA Sepolia, and re-hashes every decision document against the
hash committed on chain. Exit code 0 means every check passed.

To check the copy served by the site instead of this one:

```bash
node scripts/verify.mjs --base https://quadrix.finance
```

Both should agree. If they ever disagree, this repository and the chain are the
authority — the site is a mirror.

## What is in here

| Path | What it is |
| --- | --- |
| `trackrecord/record.jsonl` | the hash-chained daily record, append-only |
| `trackrecord/anchors.jsonl` | which transaction anchors each day's head hash |
| `trackrecord/decisions.jsonl` | anchored manager decisions, by id |
| `trackrecord/decisions/` | the decision documents those hashes commit to |
| `scripts/track-record.mjs` | writes and anchors one day (runs daily in CI) |
| `scripts/anchor-decision.mjs` | anchors a decision document |
| `scripts/verify.mjs` | the verifier above |
| `docs/track-record-spec.md` | the rules the record follows |

## Rules that make this worth reading

- **Append-only.** Corrections are new records; nothing is edited in place.
- **No backfilling.** A day the pipeline missed stays missing, and a missing
  benchmark price is recorded as missing. Gaps are part of the record.
- **The series never concatenate.** The current record is a `DRY_RUN`: the book
  is empty and what accrues is proof that the recording infrastructure predates
  the capital. A live series, if it starts, begins at its own genesis and is
  never joined to this one.
- **Anchored decisions cannot be edited.** A decision document's hash is
  committed on chain when the decision is made; changing it means publishing a
  new dated document, which leaves a trace.

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
