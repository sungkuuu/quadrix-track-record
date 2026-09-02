# Simulation provenance — pinning the histories, 2026-09-02

**Effective:** 2026-09-02 (UTC).

## What this pins

The published simulations predate the anchoring infrastructure (first anchor
2026-08-13). Their configuration history therefore rests on public git
history, not on chain — until now. A git commit hash is itself a hash chain
over the entire history behind it, so pinning today's heads makes both
repositories tamper-evident from this date forward.

| Repository | HEAD at pinning |
| --- | --- |
| github.com/sungkuuu/n1dv (original site & engine) | `bcf77dcdf5e05a63c26b5c328d8470aa7effc0c6` |
| github.com/sungkuuu/quadrix (current site & sim engine) | `eec3ec1300bb0b9760e1a78a45a04e00828a8a52` |

Inside the pinned n1dv history: commit `35bf90f130ed20712993100e076543fd6e6b16fc`
(2026-02-25) introduces the original simulation weights — USDT 40 / BTC 20 /
ETH 20 / HYPE 10 / PENDLE 5 / AERO 5 — which remained in force until the
allocation decision anchored on-chain on 2026-08-21
(`2026-08-21-n1dv-allocation`). The quadrix head pins the current simulation
methodology: daily rebalance to weights in force per day, revisions applied
forward only, and the qX20 rules (point-in-time monthly top-20, 60% cap,
Binance closes).

## What this proves — and does not

- **Proves, permanently:** these histories and this methodology existed in
  exactly this form on 2026-09-02. Rewriting either history after today
  (force-push, re-tuned weights, recomputed curves) breaks the pinned hashes.
- **Does not prove:** that the 2026-02-25 timestamps are authentic. Git dates
  are author-set. For the pre-anchor era the evidence is circumstantial —
  months of interleaved public commits, deploys, and dated posts — and we
  present it as circumstantial, never as proof.

The line we can defend: **after 2026-08-21, changes are proven by chain;
before it, they are supported by public history; from today, even that
history can no longer be quietly rewritten.**

## Verifying

```
git ls-remote https://github.com/sungkuuu/n1dv HEAD
git log 35bf90f130ed20712993100e076543fd6e6b16fc -1 --format=%ad -- # weight introduction
shasum -a 256 2026-09-02-simulation-provenance.md
```

Compare the document hash against the anchor transaction this file's entry
in /trackrecord/decisions.jsonl names.
