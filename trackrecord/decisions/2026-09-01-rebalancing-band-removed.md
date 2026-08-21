# Rebalancing decision — N1DV, drift band removed, 2026-09-01

**Effective:** 2026-09-01 (UTC), forward only.

## What changed

| | Before | After |
| --- | --- | --- |
| Calendar rebalance | quarter ends | quarter ends |
| Drift trigger | rebalance whenever any sleeve is 5pp from target | none |

The book is rebalanced to target at quarter ends and at no other time. Between
quarter ends the sleeves drift with their prices, however far they drift.

## Why

**The band was never validated.** `docs/research/cap-backtest.py`, the study
behind the published methodology, tested the 60% single-asset cap and nothing
else — it runs at monthly granularity and contains no band parameter anywhere.
The 5-percentage-point figure reached `/methodology` as an assumption. It was
recalled here as a tested choice; it was not one.

**It contradicted the sentence next to it.** `/methodology` says *"Winners are
allowed to run inside the band."* A drift band is precisely the mechanism that
stops a winner running — at 5pp, every time. The rule and its stated
justification could not both be true.

**Tested, it destroys value at every configuration we could construct.** Three
baskets and a range of stable-sleeve weights, all quarterly, band on versus
band off:

| Book | No band | 5pp band | Cost |
| --- | --- | --- | --- |
| 7 majors equal-weight, 40% stable, 2019-2026 | +1849.9% | +1462.7% | −387pp |
| BTC ETH BNB SOL LINK ZEC, N1DV shape, 30% stable | +1386.2% | +938.0% | −448pp |
| BTC ETH SOL BNB LINK ZEC, 20% stable, 2020-2026 | +1925.0% | +1308.7% | −616pp |

The proportion is stable across stable-sleeve weights from 0% to 80% — the band
costs 30–41% of the return regardless — so this is not an artefact of how much
cash the book holds. It also *raises* turnover (43% → 62% annually on the third
book), which is the part that settles it: paying more to do worse is not a
trade-off between return and risk. Maximum drawdown was flat to slightly worse
with the band in every test.

**The damage is on the upside specifically.** Under a symmetric 5pp band the
upper side fired 30 times against the lower side's 9. Loosening only the upper
bound improves the result monotonically (symmetric +1308.7%, up-7 +1389.0%,
up-10 +1361.6%, no upper bound +1450.6%), which is what a rule that cuts winners
would look like. Asymmetry recovers roughly a fifth of the cost; removing the
band recovers all of it, so the asymmetric version was tested and rejected in
favour of no band at all.

## What was tested and deliberately NOT adopted

Rebalancing less often than quarterly looked dramatically better — annual
rebalancing returned +5505% against quarterly's +1925% on the same book. It was
rejected as luck. Moving the annual rebalance date by one month, changing
nothing else, swings the result between +1450.8% and +5505.5%: a 4,055
percentage-point spread from the choice of anchor month alone. The January
result caught Solana near its November 2021 peak. Quarterly, given the same
test, moves only 268 percentage points across its three possible anchors.

A rule whose result depends that heavily on which day it fires is not a rule,
it is a bet on a date. Quarterly stays.

Rebalancing itself is not in question: quarterly returned +1925.0% against
+901.4% for never rebalancing, with maximum drawdown of −67.7% against −81.9%.
The calendar rebalance earns its place; the drift trigger did not.

## What this decision is not

This is a change to the strategy definition, not an executed trade. N1DV holds
no third-party capital at this time, nothing was bought or sold on the strength
of this decision, and no performance is claimed from it.

It is also not a claim about the correct stable-sleeve weight. That question was
looked at in the same pass and the answer is regime-dependent — 0% was optimal
in the two bull windows tested, 40–60% in the two bear windows — which means it
cannot be reduced to a rule. It stays a dated judgement, recorded when made.

## Limits of the evidence

**None of this was tested on N1DV's own book, and it cannot be.** HYPE listed in
November 2024 and AERO in August 2023; the vault's constituents do not have the
history. Every table above uses a proxy basket weighted in N1DV's shape.

**The one window N1DV can be tested on points the other way.** Over
2026-02-01 → 2026-08-21, the band returned +17.00% against +15.35% without it.
Six months settles nothing and the sample is far too short to weigh against six
years, but it is the only direct evidence about this book and it does not
support this decision. It is recorded here rather than left out.

Further limits of the studies: no survivorship correction, so absolute levels
are optimistic; one venue; one cost assumption applied across all assets and
years; daily closes with no execution model. The ordering is the finding. The
levels are indicative.

## Effect on the published record

The revision applies forward from its effective date. Every day before
2026-09-01 remains simulated under the previous rule and is not recomputed —
the curve behind the revision is left as it was, in the same way the allocation
revision of 2026-08-21 was.

## Verifying this document

This file's SHA-256 is committed to GIWA Sepolia as transaction calldata
(`qxdec:<hash>`) and is carried in the daily track record from its effective
date onward, so the date of this decision does not rest on our word. The
studies it cites are published at `docs/research/rebalance-frequency.py` and
`docs/research/rebalance-band.py` in the Quadrix repository and can be re-run
against the same public price source.
