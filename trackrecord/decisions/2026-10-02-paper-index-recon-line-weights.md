# qREV, qDEFI, qAI — the 2026-10-01 reconstitution lines show target weights in `weight`; a correction to the record, decided 2026-10-02

**Decided:** 2026-10-02 (UTC), to record this correction as an anchored document. **Effective:** 2026-10-02 — the
ledger's `effectiveFrom` is the date in the filename; nothing in any book changes on that date or because of this
document. **Applies to:** the three 2026-10-01 lines below. **Series:** `trackrecord/record-qrev.jsonl`,
`record-qdefi.jsonl`, `record-qai.jsonl`. No line is rewritten; levels, hashes and anchors are unchanged.

## What this document does

It records that on a reconstitution day the paper-index keeper wrote each member's rule target weight into the
member's `weight` field, while the line's `level` is the book's value: units × price after the tolerance step
and the normalisation that keeps the book's value equal to the pre-trade level. A mark-to-market line writes the book
weight. As a result, the lines below show weights that the book did not hold, while a mark-to-market line of the same
book shows the book's weights. This document gives the book weights for those lines.

## The facts

1. **Affected lines.** Only reconstitution lines that followed a prior book. The inception lines (qREV and qDEFI seq 0,
   2026-09-16; qAI seq 0, 2026-09-22) bought straight into target, so their `weight` equals the book weight to four
   decimals.

   | Index | Date | seq | Line hash | Anchor tx |
   | --- | --- | --- | --- | --- |
   | qREV | 2026-10-01 | 13 | `fad09f996ae0032a14ae35ce3c7708d4f4a7bf486dcb7f99853b2db9453f4b4d` | `0x3e2fed5ab79269a8e84cec6d7567647dc236326d465ecc97111301cc92c7fe41` |
   | qDEFI | 2026-10-01 | 13 | `8991a809424270e9613ce91d1ff8d3cd3ff93fa279fae4e802cf142a6189ad22` | `0x32f90a1b959e78f3a5f06a04847a049b423e2f3a8f11f3b22ddbe80ace5c9899` |
   | qAI | 2026-10-01 | 9 | `f3ec61d5789a32f70e6cc29eba88ee237788b3c71c02ab70934a067369b8eb5f` | `0xe34c59e99c7ab28cfa13d547f85233b06cea82f0e05a42a4f0bfa9d44520cc66` |

2. **Book weights.** Units from `keeper/state-{index}.json` as written by the same run (commit `165ccef`; each state's
   `updatedAt` equals the line's `observedAt`), times the `price` on the line, over the sum of that product. The sum
   equals the line's `level` to six decimals on all three lines.

   **qREV seq 13** (level 129.222959) — recorded / book, %

   | HYPE | TRX | SKY | CAKE | ZRO | AERO | RAY | JUP | CRV | PENDLE | UNI | SYRUP | LINK | NEAR | BNB |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | 35.00 / 28.18 | 26.42 / 23.80 | 6.45 / 5.81 | 5.94 / 5.35 | 2.38 / 5.25 | 2.38 / 4.76 | 2.38 / 4.65 | 2.38 / 4.57 | 2.38 / 3.67 | 2.38 / 3.23 | 2.38 / 2.15 | 2.38 / 2.15 | 2.38 / 2.15 | 2.38 / 2.15 | 2.38 / 2.15 |

   **qDEFI seq 13** (level 131.328376) — recorded / book, %

   | HYPE | LINK | UNI | ENA | AAVE | ONDO | ASTER | SKY | MORPHO | JUP | JST | CAKE | AERO | ETHFI | PYTH |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | 35.00 / 30.00 | 19.99 / 21.68 | 10.25 / 11.19 | 5.13 / 5.58 | 4.78 / 5.18 | 4.57 / 4.96 | 3.84 / 3.74 | 3.44 / 3.72 | 3.27 / 3.50 | 2.02 / 2.19 | 2.02 / 2.18 | 1.59 / 1.66 | 1.56 / 1.67 | 1.39 / 1.50 | 1.14 / 1.25 |

   **qAI seq 9** (level 95.707081; `cashWeight` 0, book cash 0) — recorded / book, %

   | NEAR | TAO | ICP | VVV | RENDER | AKE | FET | VIRTUAL | GRASS | UB |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | 35.00 / 30.56 | 21.91 / 19.13 | 11.67 / 10.19 | 8.46 / 7.39 | 6.27 / 5.47 | 4.54 / 7.45 | 3.45 / 5.68 | 3.39 / 5.58 | 3.09 / 4.90 | 2.23 / 3.66 |

3. **The recorded figures are the rule's targets.** They are the weighting step's output (qREV: net revenue with a
   floor of 2% of the positive net-revenue sum and a 35% cap; qDEFI and qAI: market cap with a 35% cap) before the
   tolerance step. Replaying the step from the 2026-09-30 book (`keeper/state-{index}.json` at commit `6e82e4e`) with
   the line's prices and these targets, and the line's `level` as that book's value at the day's prices (the line has
   no price for the names that left: CRV from qDEFI, GRT and AKT from qAI), reproduces the book weights above to
   within 0.01 point.

## Levels and hashes

The level on each line is the book's value and is correct as written. Each line's hash covers the line as it was
written, and the anchors above commit to those hashes; `node scripts/verify.mjs --dir ./trackrecord` returns VERIFIED.
Anchored lines are not edited; this document is the correction.

## From the next reconstitution

The keeper writes the book weight in `weight` on every line, a reconstitution line included (`keeper/paper-index.mjs`,
`bookWeight`, commit `2e8b04a` on main; the record fields are described in `docs/paper-index.md` from commit
`b9ea7ab`). A reconstitution line also carries the rule's target as a separate field, `targetWeight` on each member
and, for qAI, `cashTargetWeight`. Mark-to-market lines are unchanged. qTRI and qDUO lines already showed book weights
and are not affected.

## What it is not

Not a change to any book, unit count, level or membership; not a change to any rule.

## How to verify

For each line above: take `units` from `git show 165ccef:keeper/state-{index}.json`, multiply each by the member's
`price` on the line, and divide by the sum of the products. The first mark-to-market line after each of these lines
values the same units at that day's prices.

From the root of the record repository:

```
node -e '
const { execSync } = require("child_process");
const fs = require("fs");
for (const [ix, seq] of [["qrev", 13], ["qdefi", 13], ["qai", 9]]) {
  const st = JSON.parse(execSync("git show 165ccef:keeper/state-" + ix + ".json"));
  const line = fs.readFileSync("trackrecord/record-" + ix + ".jsonl", "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.seq === seq);
  const v = line.members.map((m) => [m.symbol, m.weight, st.units[m.symbol] * m.price]);
  const sum = v.reduce((t, x) => t + x[2], 0);
  console.log(ix, "seq", line.seq, line.date, "sum", sum.toFixed(6), "level", line.level);
  for (const [s, w, x] of v) console.log("  " + s, (100 * w).toFixed(2), (100 * x / sum).toFixed(2));
}'
```

It selects each line by `seq` and prints, per member, the recorded weight and the book weight in percent.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `keeper/state-qrev.json` at `165ccef` | sha256 `47189868db73391a447b59ed795b56b362960368430d745cc2fd95baeabaef53` |
| `keeper/state-qdefi.json` at `165ccef` | sha256 `302e9e8c3f69ccceaf9e2d50bc96fe044b68d34a8bf1032cb28e88453eaac68b` |
| `keeper/state-qai.json` at `165ccef` | sha256 `3667213be875cd9ec2c4dd62759817d397a7a85d4d97a13de0149b8a74714e40` |
| `keeper/paper-index.mjs` that wrote the lines, at `165ccef` | sha256 `49fec2d96da86b25f3aac4b243114a690b9e7ada54f828728681ab65ec70695f` |
| `keeper/state-qrev.json` at `6e82e4e` (the 2026-09-30 book) | sha256 `745ba4635ac8678979f81be77857bb2888a262a508542602835cc84c295a1960` |
| `keeper/state-qdefi.json` at `6e82e4e` (the 2026-09-30 book) | sha256 `4034b90ba763c1642a6150f692b370677acc81d3cbce3331b8dd5f20e86389c8` |
| `keeper/state-qai.json` at `6e82e4e` (the 2026-09-30 book) | sha256 `ab92b9d91b7e06c5ffb825383b16e9e6b40fe0ce28c553f3359ecd2963244a9f` |
| `keeper/paper-index.mjs` that writes book weights, at `2e8b04a` | sha256 `c33f845180dbf43fc46cf0f759d23f3d380190e50e203e35798268e2adc82f09` |
| quadrix-track-record, main when this file was written | `9ee440d` |
