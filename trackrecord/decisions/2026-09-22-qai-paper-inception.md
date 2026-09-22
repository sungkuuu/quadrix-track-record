# qAI paper index — inception, 2026-09-22

**Effective:** 2026-09-22 (UTC). **Series:** `trackrecord/record-qai.jsonl`, anchors `trackrecord/anchors-qai.jsonl`, calldata prefix `qxpi-qai:`.

## What starts today

A daily, rules-only index level for the AI Index (qAI). Genesis level 100 on 2026-09-22. No vault,
no capital, no shares: the record is the index itself, computed by the keeper
`keeper/paper-index.mjs --index qai` from public sources and appended one line per day, hash-chained
and anchored on GIWA Sepolia (chainId 91342) as a zero-value self-send, the same mechanism as the
other paper indices and the N1Q live record. Append-only; a missed day is a permanent gap.

The universe is the full one: names native to other chains (TAO, AKT and others) are in the record.
Whether a name can be held on GIWA is carried on every member as a column and is not a screen. No
vault can follow this record while fewer than five eligible names can be held on GIWA.

## The rules in force (pinned)

The rulebook is `docs/methodology/qai.md` in the site repository at commit `6719170`
(sha256 `ef443fb9ea7c7035865713e745c2f222a5debdf68ae081990ee88850aa675a55`), as implemented in
`keeper/rulebooks/qai.json` (sha256 `a0ef50096c9d4982cf4804e44d69af5dbc08d04e3b31981f3ecb72ed69411f5d`)
and `keeper/rulebooks/qai-exclusions.json` (sha256 `6c0d3fa01880efad6a70e92d37b5385fed150b540a04a8f5de1c7a4b1fcc1f87`),
the disclosure bucket table `docs/research/ai/ai-bucket-map.csv` (site repo, sha256
`7d452d69baab3b211b5a269d2322ca89fb987e198ed01e5fb170053c7dad9a38`), and `keeper/paper-index.mjs` at
record-repo commit `077e60d`. In one paragraph:

Universe: tokens that CoinMarketCap tags in its AI family (ai-big-data, generative-ai, ai-agents,
ai-agent-launchpad, ai-applications, defai) AND CoinGecko lists in its artificial-intelligence or
ai-agents category on the run day — both sources must agree. Out: stablecoins, wrapped or bridged
representations, staking derivatives and subnet tokens, memecoins, and general-purpose chain tokens
(a CoinMarketCap `layer-1` tag) unless the chain itself is an AI network (it also carries
generative-ai or ai-agents). Eligibility: circulating market cap ≥ $150M, 24h volume ≥ $10M, listed
≥ 365 days on CoinMarketCap's listing date. Ten names by market cap, market-cap weighted, single-name
cap 35% cut at every reconstitution; fewer than ten eligible renormalises across the names present,
and only weight the caps cannot place is held as cash. Quarterly reconstitution on the first run
after 00:00 UTC on 1 Jan / Apr / Jul / Oct with the qDEFI rank buffer; no trading in between. Sub-sector
buckets are disclosed on every member and never used as a rule.

## What this record does and does not show

From day one it shows that the rule runs as written, without discretion, on sources anyone can
re-pull. It shows nothing about returns until it is long. The point-in-time backtest behind these
rules lost to bitcoin in every window it was run on (six windows, fifty parameter combinations, none
ahead) with drawdowns of 84–92%; the parameters were chosen for consistency with the other index
rulebooks, not for an outcome. The category is thin: the seats were fully filled in three of twenty
backtest quarters, and one quarter had no eligible name at all. Levels are gross of any fee or cost.
A vault, if one is ever built on this index, is a separate anchored decision.

## Known limits, stated at the start

CoinMarketCap tags are read from a public listing endpoint without a key; if either source is
unreachable on a day, no line is written for that day and nothing is backfilled. CoinGecko keeps no
category history, so the backtest used CoinMarketCap tags alone; the two-source rule binds the
record from today forward. Where the two sources disagree on a market cap by more than two to one,
the record carries both figures and a flag; the gate reads CoinGecko.

## Pinned

| Repository | HEAD at pinning |
| --- | --- |
| quadrix (site, rulebook, research, bucket table) | `6719170` |
| quadrix-track-record (keeper, this file) | `077e60d` |
