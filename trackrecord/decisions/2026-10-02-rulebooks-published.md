# Rulebooks published — canonical location and pinned versions, decided 2026-10-02

**Decided:** 2026-10-02 (UTC). **Effective:** when this document is anchored; the ledger's `effectiveFrom` is the date
in the filename. **Series:** none changes. No record line, no keeper file and no rule is altered by this document; it
moves where the rulebooks are kept and pins the published files.

## What changes

Until now the rulebooks were kept in the site repository, which is private, and every decision that pinned a rulebook
pinned a file a reader could not open. From this decision on:

1. **The canonical location of the rulebooks is this repository's `rulebooks/` folder.** The copies in the site
   repository are working notes and are no longer the reference.
2. **The seven files below are the rulebooks in force**, pinned by sha256 at commit `1cf26e81758e0f7118c34869ac4ea995285a70b5` of this repository.
3. **Every rulebook hash pinned by a later decision refers to a file in this repository**, at a commit of this
   repository, so that anyone can check it with `git show` and `shasum`.

| File | Product | sha256 at `1cf26e81758e0f7118c34869ac4ea995285a70b5` |
| --- | --- | --- |
| `rulebooks/qx20.md` | qX20 — Top-20 Index | `258f740420773cd4e5e0d4a142236990aae2c830835da592b85f234475ae4075` |
| `rulebooks/qdefi.md` | qDEFI — DeFi Index | `fdd3d221df014f318d17f50abccdac75883e7ca5897daf79e1a63636b47bf19b` |
| `rulebooks/value-capture.md` | qREV — Revenue Index | `8e7bead52190420bc6ff18fbbaeb3fbcdd48265be3fb1f4be1b925f01f6b9c57` |
| `rulebooks/qai.md` | qAI — AI Index | `4f022540fbe08e714fc6ec901692d5f31d8c7d28d7c9f0af695dd0977cb140de` |
| `rulebooks/barbell.md` | qDUO — Barbell | `d37fcb7bd2f67e866ba144e46277c5fd87c22dfdd486f72fbf172c44d99c92f1` |
| `rulebooks/triens.md` | qTRI — Triens | `37947887237f83418ad4282544cc99791138714d94e5d6378f64bc972e127d6b` |
| `rulebooks/classification-sources.md` | classification-source framework (qDEFI, qAI, qREV, Triens) | `5e4e7b197bb4d7a6824423c0f790a45211019d936b6cc1b875a27b91297b2417` |

`rulebooks/README.md` is an index and is not pinned. `classification-sources.md` had not been pinned by any decision
before this one.

The published files are cleaned copies of the working versions. Removed: internal working notes, references to internal
documents, private file paths (replaced by paths in this repository or by the public copies under
`quadrix.finance/methodology/` where those exist), and the names of other firms' products, which are now described
generically. Status headers were brought up to date with the decisions already anchored here. Each product rulebook
gained a closing appendix, 검정 범위 (test scope), that lists value by value which test was run and which values are
untested (미검정). The corrections are listed in full below.

## What does not change

**No rule changes.** The universe definitions, eligibility thresholds, exclusion lists, weighting, caps, reconstitution
cadence, rank buffers, tolerances, hysteresis, data sources and fallbacks, special-event rules and every effective date
read the same in the published files as in the working versions they were cleaned from, except one sentence on the qX20
rank buffer (`qx20.md` §6), reworded to describe the rule the keeper applies (table D below); the rule itself is unchanged.
The keeper files (`keeper/rulebooks/*.json`, `keeper/paper-index.mjs`, `keeper/update-nav.mjs`) are not touched, and no
record changes.

The earlier decisions stand. This document does not replace their pins; it adds a public pin beside them and says where
the files they pinned can be inspected.

### Corrections of errors

Each row is a sentence or figure that was wrong or out of date in the working version and reads differently in the
published file. Korean is quoted as written; the English is a rendering. This document makes no claim about any test —
it records which sentences changed.

**A. Figures and names**

| File, section | Before | After |
| --- | --- | --- |
| `qdefi.md` §9 | "시총이 **23위** 밖으로 떨어지면 다음 재구성에서 나간다" (exit below rank 23 — the qX20 number) | "시총이 **17위** 밖으로 …" (rank 17, the qDEFI exit line of §6 and of `2026-09-16-qdefi-paper-inception`) |
| `value-capture.md` §8 | "(2026-09-29 결정, 2026-10-01 재구성부터 발효)(2026-09-29 결정, 2026-10-01 재구성부터 발효)" (the parenthesis twice) | the parenthesis once |
| `classification-sources.md`, decisions table | "§7 **qDeFi 20**의 DefiLlama 측 카테고리 범위" (an old working name) | "§7 **qDEFI**의 …" |
| `barbell.md` appendix A | "\| 50/50 \| **3.05** \|" (eight-window mean multiple) | "\| 50/50 \| **3.03** \|" |
| `triens.md` §4 | "30/40/30 비율에서 2021-11→ **2.01 vs 1.60**" (the 40/30/30 rows) | "… **1.98 vs 1.57**" (the 30/40/30 rows) |
| `value-capture.md` §6 | "6창 중 3창 우위, **2024-07→·2025→** 창은 열세" (semiannual behind in two windows named) | "… **2024-01→·2024-07→·2025→** 창은 열세" (three) |
| `qai.md` header | "격자 **49조합 × 6창 = 0/294**" | "격자 **50조합 × 6창 = 0/300**" (as appendix A of the same file already said) |

**B. Sentences about what a test showed**

| File, section | Before | After |
| --- | --- | --- |
| `barbell.md` intro | drawdown range given without its window; no statement on whether the ratio was selected | range labelled as the 2021-11 window; adds "60/40은 검정이 고른 값이 아니다" (the test did not select 60/40) |
| `barbell.md` §0 | "BTC보다 높은 창 4/8(정점에서 시작한 창)" (the four windows ahead "start at a peak") | the four windows are named: 2017-12, 2021-11, 2022-01, 2025-01 |
| `barbell.md` §1 | "ETH를 넣는 판은 Triens 연구에서 전 창 열세였고" (the ETH variant lost in every window) | not run on this product (미검정); in the other configurations where it was run it was behind in four and in five of six windows, not all |
| `barbell.md` §6 | "8창 전부에서 배수가 높았다(회전율도 낮음)" (quarterly also traded least) | multiple highest in all eight windows; turnover was not lowest — the ±10pp band traded less in eight of eight windows, ±5pp in six |
| `barbell.md` §7 | "규칙 13개 … 어느 것도 고정 60/40을 일관되게 이기지 못했고 회전율은 2~3배다" | 14 coded variants; none beat fixed 60/40 consistently (closest: 4 ahead, 2 tied, 2 behind); turnover 12–121% a year against 37% in the 2021-11 window |
| `barbell.md` §7 | "변동성 100% 규칙은 표본에서 한 번도 발동하지 않았고, 낙폭에서 '더 산다'는 '줄인다'보다 전 창 열세였다" | the rule switched 13 and 10 times in the two earliest windows; "buy" was behind "cut" in 7, 7 and 5 of 8 windows and ahead in the 2025 window |
| `barbell.md` D8 | tolerance test described without its limits | adds: run after adoption, gross only, output not saved, the published script cannot be rerun from the public copy alone |
| `triens.md` intro | "중앙값(2.17~2.30)은 재표본 안에서 구분되지 않고" (medians cannot be separated) | medians are ordered by bitcoin share (2.30 · 2.23 · 2.17); whether the gap is significant was not measured |
| `triens.md` §1, D5 | "ETH 포함 판(45/15)은 여섯 창 전부 소폭 열세였고" (behind in all six windows) | not run in this configuration; in the configuration where it was run, behind in four of six windows and ahead in two |
| `triens.md` §2 A-2, D6 | "12개월은 종목 중앙값 1 → 현금 효과" | twelve months returned more than six in all six windows; seat medians by window 1·1·0·4·5·7; not run in this product's configuration |
| `triens.md` §2 A-1 | "0.5는 종목 중앙값 2로 자리를 못 채운다" (stated beside the 2024 figures) | seat medians by window 2·2·3·5·5·6 (5 in the 2024 window); θ 0.5 was highest in that comparison; in this product's configuration θ 1 was above θ 0.5 in all six windows |
| `triens.md` §2 floor, count | "`QQ1-300`은 종목 중앙값 1"; "`QQ1-N15` 자리 못 채움 · `QQ1-N5` 회전율 110%" | seat medians by window and the result of each comparison stated |
| `triens.md` §5 | cap inherited, no test mentioned | adds: not tested in this configuration; in the only comparison (20% against 35%) the 20% cap was higher in all six windows |
| `triens.md` §6 | buffer, hysteresis and tolerance "qREV §6 그대로" | adds: buffer width never varied (미검정); in the only runs, immediate exit and exact reset were each higher in four of six windows |
| `triens.md` §6 | "BTC로 두는 판은 배수가 높지만 … 백테스트 대부분 기간이 BTC 70~80% 상품이 되어" (a 70–80% bitcoin book) | higher in five of six windows, deeper drawdown; bitcoin share at a reset at most 60%; rejected for product definition, not return |
| `triens.md` §7 | "밴드는 qDEFI·qREV와 같은 결론"; overlay turnover "2~3배" | band not tested on this product (미검정), borrowed from Barbell and qDEFI; no band variant was run on qREV; overlay turnover 12–121% a year against 37% |
| `qdefi.md` header | summary of the 2026-09-15 backtest only | adds: that backtest ran with buffer 12/18 and without the floors and the tolerance; the pre-registered test of 2026-09-29 is in appendix C and did not settle cap and band |
| `qdefi.md` §2 floor | "$150M은 2022 바닥에서도 17종, 중앙값 21종" | the counts in the published output (minimum 4, median 21; minimum 19 in the bear window); with every screen in force, fewer than 15 names in 2022-12 and 2023-01 |
| `qdefi.md` §2 count | "백테스트에서 N10~30 수익·MDD 동일" | adds: with the rules in force the 2026-09-29 run could not separate 10, 15 and 20 either, so that run did not select 15; with the 2026-09-15 backtest's settings it ranked 15 first |
| `qdefi.md` §5 | "캡 없음: 상위 1종 중앙값 31%, 최대 58%"; no mention of the 2026-09-29 run | figures attributed to the earlier oracles-out run (83.7% under the settings in force); adds the 2026-09-29 result — 50% and no cap each beat 35% in more than half the paths, the rule's output was "no cap" on the registered universe and 35% on the corrected one; 35% kept, not selected |
| `qdefi.md` §6 | "고정 N 78% vs 하한 방식 98~121%/년" | 78% against 85–88% ($150M floor) and 98–126% ($300M floor); buffer width never varied (미검정) |
| `qdefi.md` §7 | qX20 band "9년간 24회만 발동해 유지"; no mention of the 2026-09-29 run | the qX20 band is headed for removal; the qDEFI band verdict flips between universes and settings — not settled, "no band" kept |
| `qdefi.md` §7 | tolerance and hysteresis figures given as measured | adds: no committed script or output backs them — the 5-point tolerance is 미검정 |
| `value-capture.md` §5, appendix A-4 | trim line "몬테카를로에선 35% 즉시와 소수점 둘째 자리 차이"; "구분 안 됨(B 2.85 vs 2.61)" | shuffled medians equal, as-is median about 9% higher for the trim line; adds: no cap, 50% and both trim lines returned more than 35% in all six windows — 35% is kept to limit one name, not selected on return |
| `value-capture.md` §6 | tolerance: other widths "도 시험" | adds: on the point-in-time universe 7.5 points returned more than 5 in all six windows |
| `value-capture.md` §7 | "qDEFI와 같은 결론: 밴드는 승자를 팔게 한다" | no band variant was run on qREV (미검정); the qDEFI result is borrowed and is itself unsettled |
| `value-capture.md` §9 | "−40%/−50%는 표본에서 0회, LUNA·FTT였다면 첫날 발동" | zero firings in the sample; whether it fires on a dying protocol was not measured — the sample holds none; triggers B and C marked 미검정; the keeper logs a trigger and does not sell |
| `value-capture.md` §11 | "값 25%는 초안" | adds: only on against off was compared; the 25% level was never varied |
| `qai.md` §4 | "수익 방향이 지수마다 반대(qAI 소폭 ↑ …)"; "BTC 우위 확률은 세 지수 모두 시총 ≥ √ ≥ 동일" | adds: under the inception rule square-root and equal weighting returned more than market cap in all six windows and had higher resampled medians; under the amended rule in four of six; the probabilities are given per index (qX20: 50.4 · 50.6 · 42.7%) |
| `qai.md` §2, §6 | thresholds and buffer given without test status | 미검정 markers on the volume floor, the listing-age threshold, cadence and band, the rank buffer (the research engine has none) and the empty-seat rule |
| `qx20.md` §1 | "캡과 재구성 주기·밴드는 검증했지만" | "단일 경로 백테스트로 비교했지만" (compared in single-path backtests) with pointers to §5 and §6 |
| `qx20.md` §1, Q11 | "이 백테스트는 종목 수의 순위를 가르지 못한다" (decision of 2026-09-23) | kept, and adds the 2026-09-29 Monte Carlo: order 10 > 15 > 20 > 30 at every block length, rule output N=10; 20 is kept as product definition, not selected |
| `qx20.md` §1 | the 2026-09-23 N backtest said to run "규칙서 §6의 랭크 버퍼" (the §6 rank buffer) | the buffer that engine ran: incumbents inside the exit line kept first, newcomers inside the entry line added only while seats remain, no fill below N — not the keeper's §6 steps; its figures unchanged |
| `qx20.md` §5 | "체제별 백테스트에서 캡 수준 중 1~2위, 최악 체제 없음" | 60% was first in no window (2nd, 2nd, 4th, 3rd of seven in the July table; 2nd, 3rd, 3rd, 3rd of five in the September rerun), last in none; adds the 2026-09-29 Monte Carlo — rule output 70%, 60% kept on concentration grounds |

**C. Statements that were out of date**

| File, section | Before | After |
| --- | --- | --- |
| all six product rulebooks, header | "이 문서는 초안이다 … 효력이 없다" / "구현은 없다" (draft, not in force, no implementation) | status as anchored: live record since 2026-07-21 (qX20), paper index since 2026-09-16 (qDEFI, qREV) and 2026-09-22 (qAI, Barbell, Triens), with the inception and later decisions named, the keeper files named, and the testnet basket vault named |
| `barbell.md` D7, `triens.md` D20, `value-capture.md` D19 | inception shown as pending ("앵커 전" — before anchoring) | closed, with the inception decision named |
| `value-capture.md` D24 | "결정문 앵커: 대기" | `2026-09-28-qrev-d24-thresholds` |
| `qx20.md` §5, Q8 | "백테스트 스크립트는 리포에 없다 — 재현 불가 상태" | the script is published (`cap-backtest.py`); the July table cannot be regenerated because its input was not kept |
| `qx20.md` §10 box | "qX20 규칙서용으로 연결된 것은 없다" | kept as written for 2026-09-14, with a dated note that three qX20 decisions have since been anchored through that path |
| `qdefi.md` §7 | "키퍼에 … 조건이 필요하다(작은 변경, 미구현)" | the keeper trades only on reconstitution days |
| `qdefi.md` §8 | "교집합 규칙 채택 시 두 번째 출처 추가(§1 열린 결정)" | the second source is the DefiLlama listing (§1, decided 2026-09-15) |
| `value-capture.md` §1 | "연속성 판정은 미구현" | limited to the 2026-09-14 example; the keeper applies the rule |
| `value-capture.md` A-3 item 13, `triens.md` §1 | mapping file "아직 없다" / "예정" | `keeper/rulebooks/qrev-protocol-map.json` |
| `value-capture.md` D18 | "초안: CMC 폴백·표시" | CoinGecko at inception; the larger of CoinGecko and CoinMarketCap from the 2026-10-01 reconstitution (`2026-09-29-source-reconciliation`) |
| `value-capture.md` §2, `qai.md` §2 | column header "초안 값" (draft value) | "값" (value); the headers now say that the keeper files decide what is in force where the text says "초안" |

**D. Wording that did not describe the rule as coded**

| File, section | Before | After |
| --- | --- | --- |
| `qx20.md` §6 | "신규 종목은 순위 17 이내일 때만 들어오고, 기존 종목은 순위 23 밖으로 떨어질 때만 나간다" (newcomers enter only at rank 17 or better; incumbents leave only below rank 23) | the keeper's four steps in words: incumbents ranked 23 or better stay and newcomers ranked 17 or better enter; above 20 names the list is cut to the 20 best ranked, so an incumbent inside 23 can leave; below 20 it is filled in rank order, so a newcomer outside 17 can enter. Marked in the file as a correction of wording, not a rule change, with a correction-record entry dated 2026-10-02: `keeper/update-nav.mjs` (`targetMembership`) has applied these steps since the keeper moved into this repository on 2026-08-21, and at the 2026-10-01 reconstitution HBAR left by the cut while it ranked 22nd on two CoinGecko readings taken later that day. The same omission in `2026-09-23-qx20-exclusion-list` stays as anchored. |

## The earlier pinned versions

Ten decisions anchored before this one pinned twelve earlier versions of these rulebooks, each by a commit of the site
repository and its sha256. The hashes below were recomputed from those commits on 2026-10-02 and match the decisions.
Pins of a keeper parameter file (`keeper/rulebooks/*.json`) are not listed: that file is in this repository already.

| Decision | File at site commit | sha256 |
| --- | --- | --- |
| `2026-09-16-qdefi-paper-inception` | `qdefi.md` @ `ba58017` | `2f66b88d23fb8ffe7f4ebb4b57305bd4157d5095374d4021ef3eb0427dda9053` |
| `2026-09-16-qrev-paper-inception` | `value-capture.md` @ `ba58017` | `2cc7fd1a0ea771cb8c63cdf1d1e90815ffb20c599a9aa5ee7274ce32a1883484` |
| `2026-09-22-barbell-paper-inception` | `barbell.md` @ `e50d157` | `c1a95d093d37d42009064c7cc76bcb1ffc2fe261d9dac53163e35c19b6c98f1f` |
| `2026-09-22-triens-paper-inception` | `triens.md` @ `e50d157` | `cdf8f914eb3c51207fd63d58d0d9186bd9716804b6a075e947efaa8d9c56382c` |
| `2026-09-22-triens-paper-inception` | `value-capture.md` @ `e50d157` | `1fe29f501f3d5cbd62df778da98fbe068a568f07eaba7d875ff389983e274a3e` |
| `2026-09-22-qai-paper-inception` | `qai.md` @ `6719170` | `ef443fb9ea7c7035865713e745c2f222a5debdf68ae081990ee88850aa675a55` |
| `2026-09-22-qai-chain-rule-amendment` | `qai.md` @ `7013a6a` | `d4a6e37d9444284ba46c1643b12801de420ee8eae26aea522625f23289f9943d` |
| `2026-09-28-qx20-toncoin-ticker-note`, `2026-09-28-qx20-xaut-exclusion` | `qx20.md` @ `5544df1` | `70ebf8f2bfcc29fc66c83d698dd1ea11d318c2b0f013184fe362c0f2e8ef8738` |
| `2026-09-28-qrev-d24-thresholds` | `value-capture.md` @ `8f6816d` | `43944d0ff0e6b20670c90788af01359f612cb3162a982385905eaf599041ee05` |
| `2026-09-29-source-reconciliation` | `value-capture.md` @ `f689ffe` | `caa07149f67ff7a9a70b23d8e5b8d5ebd8c1962f0d2deaace5459762441201d9` |
| `2026-09-29-source-reconciliation` | `triens.md` @ `f689ffe` | `11d403b37158e5c8645dc3bbbaab8b308b51c8046cc00ac662cccebd661165c4` |
| `2026-09-29-source-reconciliation` | `qai.md` @ `f689ffe` | `61a5bdeb9a5d001440cd157d382b12752ef794f1d0c6c61ff10f7ea95c5288d7` |

These are working versions kept in a private repository. They contain working notes and are not published. They are
available for inspection on request (support@quadrix.finance), and a copy received that way can be checked against the
sha256 in the decision that pinned it. `2026-09-29-source-reconciliation` printed only the first sixteen hexadecimal
digits of its three hashes; the full values are in the table above.

The published files were cleaned from these working versions (the site commit that last changed each file):

| Published file | Working version | sha256 of the working version |
| --- | --- | --- |
| `rulebooks/qx20.md` | `qx20.md` @ `4ebe1c0` | `055aa5bddb593b4a2bf7bd5de2c861d43071921047eb4f1ac26c77fc9100af3a` |
| `rulebooks/qdefi.md` | `qdefi.md` @ `d3a20a3` | `26a99a1c2543381854459bc6823630298025899eaac5b200bc3694cc036a7414` |
| `rulebooks/value-capture.md` | `value-capture.md` @ `f689ffe` | `caa07149f67ff7a9a70b23d8e5b8d5ebd8c1962f0d2deaace5459762441201d9` |
| `rulebooks/qai.md` | `qai.md` @ `f689ffe` | `61a5bdeb9a5d001440cd157d382b12752ef794f1d0c6c61ff10f7ea95c5288d7` |
| `rulebooks/barbell.md` | `barbell.md` @ `2e045b7` | `a411b61a8c0b9514968e8b6f9e6ec391ce4c160c7eccb25a4106960721d42204` |
| `rulebooks/triens.md` | `triens.md` @ `f689ffe` | `11d403b37158e5c8645dc3bbbaab8b308b51c8046cc00ac662cccebd661165c4` |
| `rulebooks/classification-sources.md` | `classification-sources.md` @ `6da32e7` | `9a4faf121965c4e17600002b6f35cb0343e2e0bcfc659bd64871cb5c0d32baa8` |

For qREV, qAI and Triens the working version is the one `2026-09-29-source-reconciliation` pinned (same sha256). For
qX20, qDEFI and Barbell the working version is later than the last pinned one. What was added between the two, in each
case without a rule change that lacks a decision:

- **qX20** (`5544df1` → `4ebe1c0`): XAUt in the gold-pegged category from the 2026-10 reconstitution, as decided in
  `2026-09-28-qx20-xaut-exclusion`; the correction record of 2026-09-28 (a case-sensitive match in the backtest
  scripts let USDe through; backtest figures restated, the live index unaffected); the note on the rank-buffer and
  band test of 2026-09-29.
- **qDEFI** (`ba58017` → `d3a20a3`): the date line and the vault-fee paragraph recorded on 2026-09-16.
- **Barbell** (`e50d157` → `2e045b7`): the ticker line (qDUO), an open option on the working-capital yield source
  (D3-c) and the note on the tolerance test of 2026-09-22 (D8).

`classification-sources.md` was never pinned before.

## What it is not

It is not a rule change, and it is not a statement that any rule has been validated. The test-scope appendices say
which values were tested and which were not; this document pins the files that say so and adds nothing to them.

It does not make the earlier pinned versions public, and it does not alter any earlier decision.

## What stays

- Every rule, as stated under "What does not change".
- The decisions listed above, each with its own pins.
- `keeper/rulebooks/*.json` still describe the rulebook as a file in the site repository ("site repo, private"). Those
  files are pinned by earlier decisions and are not edited here; the wording is corrected at the next revision of each
  file.

## How to verify

1. The published files:

   ```bash
   git clone https://github.com/sungkuuu/quadrix-track-record && cd quadrix-track-record
   for f in qx20 qdefi value-capture qai barbell triens classification-sources; do
     printf '%s  rulebooks/%s.md\n' "$(git show 1cf26e81758e0f7118c34869ac4ea995285a70b5:rulebooks/$f.md | shasum -a 256 | cut -d' ' -f1)" "$f"
   done
   ```

   The seven lines must equal the table under "What changes".
2. This document: `node scripts/verify.mjs --dir ./trackrecord` re-hashes every decision document against the hash
   committed on chain (`trackrecord/decisions.jsonl`).
3. An earlier pinned version, once received: `shasum -a 256 <file>` must equal the sha256 in the decision that pinned
   it (table under "The earlier pinned versions").

## Pinned

| File | Commit / sha256 |
| --- | --- |
| `rulebooks/qx20.md`, `qdefi.md`, `value-capture.md`, `qai.md`, `barbell.md`, `triens.md`, `classification-sources.md` | commit `1cf26e81758e0f7118c34869ac4ea995285a70b5` — sha256 in the table under "What changes" |
| quadrix-track-record (this file — before this commit) | `1cf26e81758e0f7118c34869ac4ea995285a70b5` |
