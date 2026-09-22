# qAI — general-purpose chain tokens admitted from the 2026-10-01 reconstitution, decided 2026-09-22

**Decided:** 2026-09-22, night (owner). **Effective:** at the first reconstitution on or after 2026-10-01 — the
scheduled quarterly run. **Series:** `trackrecord/record-qai.jsonl`, unchanged until that run. The ledger's
`effectiveFrom` for this file is 2026-09-22, the date the decision was made and written; the rule it changes takes
effect on 2026-10-01, and the record between the two dates is the inception rule as anchored on 2026-09-22
(`2026-09-22-qai-paper-inception`).

## What changes

| Rule | Until the 2026-10-01 reconstitution | From it |
| --- | --- | --- |
| General-purpose chain tokens (CoinMarketCap `layer-1` tag) | out, unless also tagged `generative-ai` or `ai-agents` (TAO in; NEAR, ICP out) | **admitted on the same terms as any other name** — two-source agreement, the floors, the listing age; no chain clause |

Nothing else moves: CoinMarketCap AI-family tags ∩ CoinGecko AI categories, circulating market cap ≥ $150M, 24h volume
≥ $10M, listed ≥ 365 days by CoinMarketCap's `date_added`, ten names by market cap, market-cap weights, single-name cap
35% cut at every reconstitution, no bucket cap, quarterly cadence with the rank buffer, the exclusion list (stablecoins,
wrappers, staking derivatives and subnet tokens, memecoins).

## Why

The inception rule carried qDEFI's "chains out" principle into a sector where it does not hold the same way: a chain is
not a DeFi protocol, but several chains present themselves as AI networks, and both classification sources this rulebook
is built on — and the institutional AI products in the market — treat NEAR as a core AI name. The owner's judgment is
that an index sold as "the AI sector as the two sources define it" should not remove such names by a lineup rule.
The backtest does not discriminate: with the chain rule, without it, and with all chains out, the rule lost to bitcoin
in every one of six windows (rulebook appendix A-2; `docs/research/ai/ai-backtests.csv` rows `chainIN`, `chainOUT`).
The decision is therefore a definition of the sector, not a return argument. The known cost, taken knowingly: on the
2026-09-22 dry run without the chain clause the top two seats are two chains (NEAR 35% at the cap, ICP about 10%), and
GRT and AKT fall to the buffer (appendix D). The 2026-10-01 basket is computed on that day's numbers, not on this preview.

## Disclosure correction (not a rule)

The disclosure table's ICP row read "ethereum · holdable on GIWA: yes"; it is corrected to "ICP 자체 체인 · no". The
column is disclosure only and never a screen.

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `docs/methodology/qai.md` (site repo) | commit `7013a6a`, sha256 `d4a6e37d9444284ba46c1643b12801de420ee8eae26aea522625f23289f9943d` |
| `keeper/rulebooks/qai.json` | sha256 `dcb417988f31fcb6bbd54ed4307dea40a183b92b6b264973e2493860c89a2e40` (`universe.chainRule.effectiveUntil = 2026-09-30`) |
| `keeper/paper-index.mjs` | the commit that carries this file |
