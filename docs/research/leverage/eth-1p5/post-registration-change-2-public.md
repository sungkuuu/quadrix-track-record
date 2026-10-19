# eth-1p5 등록 뒤 고침 2 — 독립 검증 스크립트의 표기 셋 · 합치기 보고 칸 하나 (목표 1.5)

작성 2026-10-13 · **최종 갱신 2026-10-13**

작업자 결정(2026-10-12)을 실행한 기록이다. 2026-10-13 문구 고침: 출처 파일 이름 · 확인 단계 라벨을 중립 표현으로, 중앙값을 전 정밀도로 — 고침의 내용 · 순서는 바뀌지 않았다. 판정 아님 · 권고 없음. 등록 문서 `README.md`(sha256 `eb58aea9…6f67`) ·
`REGISTRATION` · 등록 엔진 `leverage-eth15.mjs`(sha256 `63157268…d596`) · 고침 1의 사본 `leverage-eth15-p1.mjs`(sha256 `d1f27e5b…faf5`) ·
검증 스크립트 `verify-1.5.py`(sha256 `d72eae95…9c87`, 커밋 `f9a6ed6`)는 **한 바이트도 고치지 않았다.** 고친 것은 새 사본 둘이다:
`leverage-eth15-p2.mjs`(p1의 사본) · `verify-1.5-p2.py`(검증 스크립트의 사본). 조각 10개는 그대로 쓴다.

## 1. 날짜

| 사건 | 시각 |
|---|---|
| 검증 (가) 첫 실행 — 33행 중 4행 FAIL, 멈춤 | 2026-10-07(커밋 `af073b9`, 출력 `verify-1.5-run-ga.txt` · `verify-1.5-out/report.csv`) |
| 작성자가 아닌 확인자가 네 행을 조각에서 다시 세어 판정 밖임을 확인, 처리 = 등록 뒤 고침 2 | 2026-10-12(내부 기록) |
| 작업자 결정 기록 | 2026-10-12 |
| **이 고침의 커밋** — p2 사본 둘 + 이 파일, 합치기 3 · 검증 (가) 재실행 · 검증 (나)보다 먼저 | 2026-10-13 |

## 2. 무엇을 · 왜 — 결과를 본 뒤의 변경이다

**이 고침은 결과를 본 뒤에 정했다.** 검증 (가)의 첫 실행 출력(네 행이 어디서 왜 다른지)과 합친 결과 파일 `results-1.5.csv.gz`의 해당 행을 보고 정했다.
그래서 「결과를 본 뒤의 변경」으로 공시한다. 네 행은 모두 **판정 밖**(보고 칸 · 표기)이고, 고침은 판정 산술(규칙 A · B, 세 트랙, X · F · G · P, 동치류, 산출)에 닿지 않는다.

| FAIL 행 | 원인 | 고친 곳 |
|---|---|---|
| `merge_check` 정보 행 6 | 스크립트가 틀림. 엔진은 정보 행의 `pass` 칸에 `information`을 쓴다 — 등록 전 스모크 기록(README 「사전 등록 전에 한 것」 4)의 「55 true + 6 information」이 이미 그 형식. 여섯 행의 값은 전부 `same` | 스크립트 (a1) |
| `trk_outcome_seed`의 A2 칸(`class_with_p_G_above_half_at_every_L`) 36 | 엔진이 맞음. 6차 A4′ 「\|X_H\| ≥ 2이고 \|G_H\| = 1이면 그 류의 대표(… A2는 적용하지 않는다)」. 36행 모두 \|G\| = 1인데 스크립트는 유일한 류를 적었다 — 문장 밖의 해석 | 스크립트 (a2) |
| `trk_near_threshold` (a)의 `near` 빈칸 8 | 표기 차이. 지배자가 없으면 값이 없고 「근처」 표시도 정의되지 않는다. 엔진은 빈칸, 스크립트는 `0`을 기대했다 | 스크립트 (a3) |
| `mc_cost` L = 6 · 90분 · 1.9 · 30bp · 6%의 `net_p50` | 엔진 보고 칸의 이중 반올림. 엔진은 `mc_end`가 6자리로 찍은 중앙값을 다시 4자리로 찍었다(0.5563). `mc_path`(10자리) 3,333값의 중앙값은 0.5562498269(`mc_end`가 6자리로 0.556250이라 찍음) → 네 자리 0.5562 | 엔진 사본 (b) |

### (a) 검증 스크립트 `verify-1.5-p2.py` — 표기 셋과 따라오는 것

- (a1) `merge_check`: `pass`가 `information`이고 검사 문장에 `information`이 들어 있는 행은 정보 행으로 센다(그 밖의 값은 그대로 실패).
- (a2) `trk_outcome_seed`의 A2 칸: \|G\| ≥ 2일 때만 「모든 L에서 P_G > 0.5인 류」를 기대하고, \|G\| ≤ 1이면 빈칸을 기대한다.
- (a3) `trk_near_threshold` (a): 지배자가 없으면 값과 `near` 모두 빈칸을 기대한다(지배자가 있을 때의 0.03 기준은 그대로).
- (r) 합치기 엔진의 기대 sha256을 p2 사본의 값 `17ad7a04cf5d68866ef88cebae9c6f87b955923de49e632d7a8665f46e8b1292`로 바꿨다(p1 값은 `patched_engine_sha256_p1`로 남김).
  조각을 받는 기준(등록 엔진 sha256)은 그대로다.
- (c) `--jobs-dir`: 검증 (나)가 경로 작업 40개의 결과를 작업마다 파일로 남기고, 이미 있는 작업은 다시 돌리지 않는다. VM이 회수돼도 이어 돌리기 위한 것이다
  (내부 클라우드 실행 규칙 2 · 3). 작업 함수와 그 산술은 바뀌지 않았다.
- 자체 시험의 합성 파일도 (a1) ~ (a3)의 형식을 따르게 했다(정보 행 하나 추가, A2 칸 · `near` 칸의 같은 규칙).
- 머리글에서 원 스크립트 작성자의 모델 이름을 뺐다(규칙서 · 결정문이 고정할 파일에 모델 이름 · 검토 라벨 0건).
- **허용 오차 · 판정 규칙 재계산 · 다른 검사는 한 글자도 바뀌지 않았다.** `diff verify-1.5.py verify-1.5-p2.py`가 전부다(§4).

### (b) 엔진 사본 `leverage-eth15-p2.mjs` — 보고 칸 하나

- `mc_cost` 절에서 L = 6이고 두 경로 행이 다 있을 때(`ok`) `net0_p50` · `net_p50`(그리고 그 둘에서 나오는 `pre_cost_profit_p50` · `cost_diff_of_medians` · 몫)를
  `mc_end`의 6자리 값 대신 `mc_path`(10자리) 3,333값의 중앙값(같은 `quantile(·, 0.5)`, 홀수 N이라 가운데 값)으로 읽는다. 다른 L은 그대로 `mc_end`에서 읽는다.
- `merge_param`의 `post_registration_change` 문장에 이 파일을 더했다(보고 문장).
- 등록 엔진 해시 상수(`REGISTERED_ENGINE_SHA256 = 63157268…d596`)는 그대로다 — 조각 10개를 그대로 받는다.
- 이 사본은 고침 1처럼 `--merge` 전용이다.

## 3. 결과에 미친 영향

- **판정 산술에는 영향이 없다.** 바뀐 엔진 줄은 `mc_cost` 절 안에 있고, 그 절은 판정 절(`trk_outcome` · `trk_asset_outcome` 등)을 쓴 뒤에 쓰인다. 판정 집합 ·
  몬테카를로 경로 · Q · q · P는 조각에서 읽은 값 그대로다.
- **보고 숫자에 미치는 영향**: L = 6의 `mc_cost` 행에서 `net0_p50` · `net_p50` 등이 이중 반올림 없이 찍힌다. 첫 검증 (가)가 짚은 칸은 90분 · 1.9 · 30bp · 6%의
  `net_p50` 하나(0.5563 → 0.5562)다. 산출 변형(15분 · 2.4 · 2.3)의 공시 숫자 칸은 작성자가 아닌 확인자가 `mc_path`에서 다시 세어 엔진 값과 같았다(내부 기록).
  합치기 3과 합치기 2의 차이 전수는 결과 문서 `results-1.5.md` 「등록 뒤 바뀐 것」에 적는다.
- **검증 (가)의 판정**: 표기 셋은 스크립트 쪽 고침이라 그 행들이 PASS로 바뀌는 것은 「검증 기준을 엔진 형식에 맞춘 것」이다. 이 셋에서 판정 산술이 맞는지는
  스크립트의 다른 행들(`trk_outcome` 84행 · `trk_asset_outcome` 12행 등 — 첫 실행에서 이미 0 차이)이 따로 보여 준다.
- **이 고침 뒤 합치기 3 · 검증 (가) · 검증 (나) 가운데 무엇이든 또 실패하면 그 자리에서 멈추고 오너에게 돌아간다**(오너 10/7, 오너 결정 기록(비공개)) —
  세 번째 고침을 작업자가 하지 않는다.

## 4. diff (전부)

### 엔진 `leverage-eth15-p1.mjs` → `leverage-eth15-p2.mjs`

```diff
@@ -2609,7 +2609,7 @@
   for (const { p, sec } of parts) for (const l of sec.get('part_param').rows) { const f = parseCsvLine(l); w(['part_param', p.id, f[1], f.slice(2).join(',')]); }
   sect(['name', 'value']); // post-registration change 1 (b): the engine that merged and the engine whose parts it accepted
   for (const [k, v] of [['merge_engine_sha256', engineSha], ['part_engine_sha256_accepted', REGISTERED_ENGINE_SHA256],
-    ['post_registration_change', 'post-registration-change-1.md (owner 2026-10-07 path 1): (a) E14 (i) relative 1e-9 or absolute 1e-12; (b) parts accepted at the registered engine sha256']]) w(['merge_param', k, v]);
+    ['post_registration_change', 'post-registration-change-1.md (owner 2026-10-07 path 1): (a) E14 (i) relative 1e-9 or absolute 1e-12; (b) parts accepted at the registered engine sha256; post-registration-change-2.md: (b) mc_cost medians at L = 6 from mc_path']]) w(['merge_param', k, v]);
@@ -3038,7 +3038,8 @@
           for (const L of BLOCK_LENS) {
-            const m0 = med.get(`${L}|${k5}|${sc3(STUDY[0]).join('|')}`), mc0 = med.get(`${L}|${k5}|${scc.join('|')}`), pre = m0 - 1;
+            // post-registration change 2 (b): at L = 6 with both path rows present, the medians come from mc_path (10 significant digits), not from mc_end's printed 6-digit net_p50
+            const m0 = L === HEADLINE_L && ok ? quantile(x0, 0.5) : med.get(`${L}|${k5}|${sc3(STUDY[0]).join('|')}`), mc0 = L === HEADLINE_L && ok ? quantile(xc, 0.5) : med.get(`${L}|${k5}|${scc.join('|')}`), pre = m0 - 1;
```

### 검증 스크립트 `verify-1.5.py` → `verify-1.5-p2.py`

`git diff --no-index verify-1.5.py verify-1.5-p2.py`로 본다. 바뀐 곳: 머리글(이름 · 작성 문단 → 고침 2 목록), `REG`의 합치기 엔진 sha256(p1 값은 다른 키로 남김),
`merge_param` 검사의 이름, (a1) `merge_check` 한 줄, (a2) A2 칸 한 줄(검사)과 한 줄(자체 시험 합성 파일), (a3) `near` 한 줄(검사)과 한 줄(자체 시험 합성 파일),
자체 시험 합성 파일의 정보 행 한 줄, (c) `run_na`의 작업 실행 덩어리 · `import pickle` · `--jobs-dir` 인자 · `_W['jobs_dir']` 한 줄.

## 5. 확인 — 커밋 전(이 VM, 결과를 새로 읽지 않고)

- `node --check leverage-eth15-p2.mjs` 통과.
- `python3 verify-1.5-p2.py --selftest` → `RESULT: PASS`(65초; 합성 세계 · 돌연변이 · 합성 엔진 전 흐름 workers 1 · 2 포함).
- sha256: `leverage-eth15-p2.mjs` `17ad7a04cf5d68866ef88cebae9c6f87b955923de49e632d7a8665f46e8b1292`. `verify-1.5-p2.py`의 값은 이 커밋에서 잰다(`sha256sum`).

## 6. 이 뒤의 순서

1. 이 커밋(고침 2 공시).
2. 합치기 3: `node leverage-eth15-p2.mjs --target 1.5 --merge --out results-1.5-p2.csv.gz` → 출력 `merge-1.5-attempt3.txt`. `results-1.5.csv.gz`(합치기 2)는 그대로 둔다.
3. 검증 (가): `python3 verify-1.5-p2.py --merged results-1.5-p2.csv.gz --out verify-1.5-p2-out-ga` — 33/33(FAIL 0).
4. 검증 (나): `python3 verify-1.5-p2.py --merged results-1.5-p2.csv.gz --simulate --workers 4 --jobs-dir verify-1.5-p2-jobs --out verify-1.5-p2-out-na` — 작업마다 커밋 · 푸시.
5. 결과 문서 `results-1.5.md`(초안) · 깨끗한 사본 · 오너용 요약.

되돌리기: 결과 문서 · 앵커 전이면 이 파일 · p2 사본 둘 · 재실행 산출을 지우는 커밋 하나. 등록 엔진 해시 상수는 그대로다.
