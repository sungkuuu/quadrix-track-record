# eth-1p5 등록 뒤 고침 1 — 검산 E14 (i) 비교식 · 합치기의 조각 출처 검사 (목표 1.5)

작성 2026-10-07 · **최종 갱신 2026-10-07**

오너 결정(길 1)을 실행한 기록이다. 판정 아님 · 권고 없음. 등록 문서 `README.md`(sha256 `eb58aea9…6f67`)와 `REGISTRATION`은
고치지 않았고, 등록 엔진 `leverage-eth15.mjs`(sha256 `63157268…d596`)도 그대로다. 고친 것은 그 사본 `leverage-eth15-p1.mjs` 하나다.

**이 고침은 결과를 읽기 전에 정했다.** 이 파일이 들어간 커밋까지 몬테카를로 결과 값은 아무도 읽지 않았고, 고친 사본으로 합치기(`--merge`)를 돌리지 않았다.
조각에서 읽은 것은 `part_param`의 출처 필드(아래 「확인」 3)뿐이다.

## 1. 멈춘 것

README 「실행 계획」의 합치기 `node leverage-eth15.mjs --target 1.5 --merge`(등록 엔진)가 필수 검산 **E14에서 104/108**로 `sanity: all checks pass = false`가 되어
몬테카를로 합치기 · 판정 · 결과 파일 쓰기 전에 종료 1로 멈췄다(출력 `merge-1.5-attempt1.txt`, 기록 `results-1.5.md`). 다른 검산은 전부 통과했다.

## 2. 진단

- 틀린 넷은 E14 (i) 「1일 구간 RMS = `simulate`의 RMS(`trkQ`), 상대 10⁻⁹」 하나만 틀렸다((ii) ~ (iv)는 통과). 넷은 0bp · 0%의
  `ETH|1.5|daily|L>=2.5|15` · `L>=2.2|45` · `L>=2.1|60` · `L>=2|120` — 2020-03 창에서 **트리거가 한 번도 발동하지 않는** 넷이다.
- 발동이 없고 비용이 0이면 일간 추적 차이 δ_d는 반올림 잡음뿐이다. 두 값은 1.032807741737043e-15 와 1.0349709942818401e-15, 절대 차 2.16e-18, 상대 차 2.09e-3.
  계산 순서가 다른 두 잡음 값에 상대 허용오차를 건 검사 설계의 결함이고, 계산이 틀렸다는 증거는 없다(작성자 진단 `results-1.5.md` 「E14 진단」(커밋 `5b2fe8e`의 판), 작성자가 아닌 확인자가
  엔진을 돌리지 않는 독립 재계산으로 확인 — 발동 없는 변형이 정확히 이 넷이고 두 값이 비트까지 같음).
- 확인에서 찾은 둘째 자리: 합치기는 조각의 `part_param` `engine_sha256`이 **합치기를 돌리는 엔진 파일의 sha256**과 같아야 조각을 받는다(등록 엔진 2580 · 2584 · 2589행).
  엔진을 고치면 sha256이 바뀌어 조각 10개가 모두 `merge refused`된다. 그래서 고치는 곳이 둘이다.

## 3. 오너 결정 — 길 1 (2026-10-07)

오너 2026-10-07: 「길 1로 결정」. 길 1 = 등록 뒤 엔진의 그 두 곳을 고치고, 공시하고, 클라우드 조각 10개를 그대로 쓰고, 로컬에서 합친다
(길 2 = 새 판 등록 · 클라우드 재실행은 택하지 않음). README 9행 「결함 있는 규칙은 새 판을 등록해서만 고친다」를 검산 고침에 어떻게 읽을지가 이 결정이다.

## 4. 고친 것 — 둘뿐이다

### (a) E14 (i)의 비교식

- 등록: `Math.abs(hz.rms[0] / trkQ(o) - 1) <= 1e-9`
- 고침: `rel14 || Math.abs(hz.rms[0] - trkQ(o)) <= 1e-12`, `rel14`는 등록 식 그대로. 즉 b = `trkQ(o)` > 0에서 **|a − b| ≤ max(10⁻⁹ · b, 10⁻¹²)**.
- **atol = 10⁻¹²를 고른 근거** — 비교하는 양은 하루 추적 차이 δ_d(일 수익의 차, 무차원)의 31일 RMS다.
  - 잡음보다 훨씬 위: 부동소수 잡음은 이 넷에서 값 자체가 약 1.03 × 10⁻¹⁵, 두 계산의 차가 2.16 × 10⁻¹⁸이다. 10⁻¹²는 값의 약 1,000배, 차의 약 4.6 × 10⁵배다.
  - 의미 있는 차이보다 훨씬 아래: 10⁻¹²는 하루 10⁻⁸bp다. 31일 가운데 하루만 0.01bp(10⁻⁶) 어긋나도 RMS로 10⁻⁶/√31 ≈ 1.8 × 10⁻⁷ — 10⁻¹²보다 다섯 자리 위다.
  - 새 값을 지어내지 않았다: 등록 엔진은 **같은 δ_d의 평균**을 E12에서 이미 절대 10⁻¹²로 비교한다(등록 엔진 1291행 `Math.abs(bm - mm) <= 1e-12`). 그 등록 허용오차를 RMS에 쓴다.
- **바뀔 수 있는 판정의 범위**: (ii) ~ (iv)와 rtol은 그대로이고 (i)에 「또는」 하나를 더했을 뿐이라, 통과 → 실패는 생길 수 없고, 실패 → 통과는 **절대 차가 10⁻¹² 이하인
  쌍에서만** 생긴다. 틀린 넷은 절대 차 2.16 × 10⁻¹⁸이라 통과한다. 고친 사본은 절대 바닥으로만 통과한 쌍을 정보 행으로 적는다(아래 「확인」 2 — 정확히 그 넷).
- 지시문 식과 다른 점(작성자 선택, 공시): 지시문은 |a − b| ≤ max(rtol · max(|a|, |b|), atol)이었다. 분모를 max(|a|, |b|)로 바꾸면 상대 띠도 조금 넓어져(|a − b|가
  rtol · b 초과 rtol · a 이하인 쌍) 「절대 차가 atol 이하인 쌍만 바뀔 수 있다」가 정확히 성립하지 않는다. 그래서 등록 상대 식을 글자 그대로 두고 절대 바닥만 「또는」으로 더했다.

### (b) 합치기의 조각 출처 검사

- 등록: 조각의 `engine_sha256` = 합치기를 돌리는 엔진 파일의 sha256(`want.engine_sha256: engineSha`).
- 고침: 조각의 `engine_sha256` = **등록 엔진 sha256** `63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596`(`REGISTRATION`의 값, 상수로 박음) —
  고친 사본 자신의 sha256이 아니다. 나머지 출처 조건(`part` · `profile` · `sanity_all_pass` · `input_sha256` · `mc_set_sha256` · `seed_main` · `paths_per_L`,
  `part_check` 전부 true)은 그대로다.
- 두 해시를 합치기 출력에 남긴다: 기존대로 머리의 `engine_sha256`(돌린 엔진 = 고친 사본)과 조각마다의 `part_param,<id>,engine_sha256`(등록 엔진)에 더해,
  새 절 `merge_param`에 `merge_engine_sha256`(고친 사본) · `part_engine_sha256_accepted`(등록 엔진) · `post_registration_change`(이 파일)를 쓴다.
- 따라서 고친 사본은 `--merge` 전용이다. 고친 사본으로 `--part` · `--smoke`를 돌리면 그 조각에는 고친 사본의 해시가 적혀 고친 사본의 합치기가 거부한다(의도된 동작).

### 그 밖에는 바뀌지 않는다

- 위 둘 말고 다른 검산(E4 ~ E21, 합치기 검사, 공시 숫자 합치기 검사)과 **판정 규칙(규칙 A · B, 세 트랙, 동치류, 오너 제약)은 한 글자도 바뀌지 않았다.** 아래 diff가 전부다.
- **고친 사본의 합치기에서 무엇이든 또 실패하면 그 자리에서 멈추고 오너에게 돌아간다** — 세 번째 고침을 작업자가 하지 않는다.

## 5. 엔진 파일

| 파일 | sha256 | 비고 |
|---|---|---|
| `leverage-eth15.mjs` | `63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596` | 등록 엔진 = `REGISTRATION`, 바뀌지 않음. 조각 10개를 만든 엔진 |
| `leverage-eth15-p1.mjs` | `d1f27e5be78acd36aa779780a4511a83c24db72fb2d8b25a8447120d1196faf5` | 등록 엔진의 사본 + 아래 diff. 합치기 전용 |

E19(6차와 글자 동일해야 하는 선언 88개)는 고친 사본에서도 88 identical이다 — 고친 두 함수(`deterministic` · `mergeLines`)는 E19 목록에 없다.

```diff
--- leverage-eth15.mjs
+++ leverage-eth15-p1.mjs
@@ -1270,7 +1270,7 @@
     S.check(`E17 decision variants without a trigger fire in a window are bit-identical there (net multiple, sum and sum of squares of delta; groups = asset x window x scenario with >= 2 such runs, ${runs17} runs)`, `${same17}/${g17}`, `${g17}/${g17}`, same17 === g17 && g17 > 0);
     // (8) E12 / E14 on the small window 2020-03-01 .. 2020-03-31 (base = last bar of 2020-02-29): the Monte Carlo set x {headline, 0bp·0%}
     let n12 = 0, ok12 = 0, n14 = 0, ok14 = 0;
-    const bad14 = [];
+    const bad14 = [], floor14 = []; // floor14: post-registration change 1 (a) -- the pairs that pass (i) only by the absolute floor
     for (const a of ASSETS) {
       const A = DATA[a], sp = spanOf(A, SMALL_WIN[0], SMALL_WIN[1]), D = spanDays(A, sp.off, sp.n);
       const tEnd = A.t[sp.b0 + sp.n] + STEP_MS;
@@ -1296,13 +1296,18 @@
           let g2 = 0, m7 = 0;
           for (let s0 = 0; s0 + 7 <= D.N; s0++) { const g = Eat(s0 + 7) / Eat(s0) - 1 - V.lam * (Cat(s0 + 7) / Cat(s0) - 1); g2 += g * g; m7++; }
           const st7 = shDayStats(navBuf, D, V.lam, 7, true, false), bar = shBarStats(A, sp.b0, sp.n, rec.rows, V.lam);
-          const c = [Math.abs(hz.rms[0] / trkQ(o) - 1) <= 1e-9, Math.abs(Math.sqrt(g2 / m7) / hz.rms[1] - 1) <= 1e-9, st7.nonoverlapStarts === 4, bar.starts === nBar];
+          // post-registration change 1 (a), owner 2026-10-07 path 1: (i) keeps the registered relative test verbatim and adds an absolute floor of 1e-12
+          // (the registered E12 tolerance for the mean of the same daily difference): a fail can become a pass only if |difference| <= 1e-12
+          const rel14 = Math.abs(hz.rms[0] / trkQ(o) - 1) <= 1e-9;
+          const c = [rel14 || Math.abs(hz.rms[0] - trkQ(o)) <= 1e-12, Math.abs(Math.sqrt(g2 / m7) / hz.rms[1] - 1) <= 1e-9, st7.nonoverlapStarts === 4, bar.starts === nBar];
+          if (!rel14 && c[0]) floor14.push(`${vKey(V)} ${scenIdS(s)}: ${hz.rms[0]} vs ${trkQ(o)}`);
           if (c.every(Boolean)) ok14++; else if (bad14.length < 5) bad14.push(`${vKey(V)} ${scenIdS(s)}: ${c.map((x) => (x ? 1 : 0)).join('')}`);
         }
       }
     }
     S.check(`E12 daily tracking measure by brute force on 2020-03 (31 UTC days; traced equity and the file's closes): days, RMS (rel 1e-9), mean (abs 1e-12) = simulate's sums (Monte Carlo set x headline, 0bp·0%)`, `${ok12}/${n12}`, `${2 * vlistAll.length}/${2 * vlistAll.length}`, ok12 === n12 && n12 === 2 * vlistAll.length);
-    S.check(`E14 short-horizon table on 2020-03: (i) h = 1 RMS = E12's (rel 1e-9), (ii) h = 7 G from traced equity and closes (rel 1e-9), (iii) non-overlapping starts at offset 0 = 4, (iv) bar starts = count from the time array${bad14.length ? ` -- ${bad14.join(' ; ')}` : ''}`, `${ok14}/${n14}`, `${n14}/${n14}`, ok14 === n14 && n14 > 0);
+    S.check(`E14 short-horizon table on 2020-03: (i) h = 1 RMS = E12's (rel 1e-9, or abs 1e-12: post-registration change 1), (ii) h = 7 G from traced equity and closes (rel 1e-9), (iii) non-overlapping starts at offset 0 = 4, (iv) bar starts = count from the time array${bad14.length ? ` -- ${bad14.join(' ; ')}` : ''}`, `${ok14}/${n14}`, `${n14}/${n14}`, ok14 === n14 && n14 > 0);
+    S.rows.push([`E14 (i) pairs that pass only by the absolute floor 1e-12 (post-registration change 1; information): h = 1 RMS vs simulate's RMS`, `${floor14.length}${floor14.length ? ` -- ${floor14.join(' ; ')}` : ''}`, '', '']);
     // (9) the short-horizon tables, start set (가): the Monte Carlo set and each asset's daily reset without a trigger (target 2.0), spans R and the three windows
     const noTrig = ASSETS.map((a) => all.find((v) => VARIANTS[v].asset === a && T2(v) && VARIANTS[v].base.daily && VARIANTS[v].trig === Infinity));
     const shVars = [...vlistAll, ...noTrig], fullS = new Set([...FULL_J.map((j) => STUDY[j]), REF_S]);
@@ -2577,11 +2582,14 @@
   });
   const partOf = (id) => parts.find((x) => x.p.id === id);
   // provenance: every part ran this engine on the same inputs, passed its checks, simulated the Monte Carlo set the merge recomputes
+  // post-registration change 1 (b), owner 2026-10-07 path 1: the parts were computed by the registered engine (REGISTRATION engine_sha256); this patched
+  // copy accepts a part whose recorded engine_sha256 is that registered value, not this file's own sha256 -- both are written below (merge_param)
+  const REGISTERED_ENGINE_SHA256 = '63157268d03014703dc4ac073ed9f3204827dcf63b81e56f9c3a0e7cb569d596';
   const engineSha = sha256Of(fs.readFileSync(ENGINE_FILE)), inputSha = inputShaOf(DATA, det);
   const problems = [];
   for (const { p, sec } of parts) {
     const param = Object.fromEntries((sec.get('part_param')?.rows ?? []).map((l) => { const f = parseCsvLine(l); return [f[1], f.slice(2).join(',')]; }));
-    const want = { part: p.id, profile: PROFILE, sanity_all_pass: 'true', engine_sha256: engineSha, input_sha256: inputSha, mc_set_sha256: det.mcSetSha, seed_main: expect.seedMain, paths_per_L: expect.paths };
+    const want = { part: p.id, profile: PROFILE, sanity_all_pass: 'true', engine_sha256: REGISTERED_ENGINE_SHA256, input_sha256: inputSha, mc_set_sha256: det.mcSetSha, seed_main: expect.seedMain, paths_per_L: expect.paths };
     for (const [k, v] of Object.entries(want)) if (param[k] !== v) problems.push(`${p.id}: ${k} = ${param[k]} (merge expects ${v})`);
     for (const l of sec.get('part_check')?.rows ?? []) if (!l.endsWith(',true')) problems.push(`${p.id}: ${l}`);
     if (!(sec.get('part_check')?.rows.length > 0)) problems.push(`${p.id}: no part_check rows`);
@@ -2599,6 +2607,9 @@
   lines.push('');
   w(['section', 'part', 'name', 'value']);
   for (const { p, sec } of parts) for (const l of sec.get('part_param').rows) { const f = parseCsvLine(l); w(['part_param', p.id, f[1], f.slice(2).join(',')]); }
+  sect(['name', 'value']); // post-registration change 1 (b): the engine that merged and the engine whose parts it accepted
+  for (const [k, v] of [['merge_engine_sha256', engineSha], ['part_engine_sha256_accepted', REGISTERED_ENGINE_SHA256],
+    ['post_registration_change', 'post-registration-change-1.md (owner 2026-10-07 path 1): (a) E14 (i) relative 1e-9 or absolute 1e-12; (b) parts accepted at the registered engine sha256']]) w(['merge_param', k, v]);
 
   // ---- rebuild the per-scenario results and decide (v5 rule, README 판정 규칙) ----
   const vIndex = new Map(VARIANTS.map((V, v) => [vKey(V), v]));
```

## 6. 고친 사본의 확인 — 몬테카를로 결과를 읽지 않고 (로컬, node v22.23.1)

1. **README가 이름 붙인 자체 시험**: `node leverage-eth15-p1.mjs --target 1.5 --selftest-split` → `selftest-split: PASS`(0.5초, 출력이 등록 엔진의 같은 시험과 글자 동일),
   `node ../params-v6/leverage-params-v6.mjs --selftest-trk` → `selftest-trk: PASS`(6차 파일, 고치지 않음). 문법 검사 `node --check` 통과.
2. **결정적 단계만(몬테카를로 없음)**: `nice -n 10 node leverage-eth15-p1.mjs --target 1.5 --no-mc` — 66.6초, 종료 0, `sanity: all checks pass = true`.
   - E14 **108/108**, 새 정보 행 「절대 바닥으로만 통과한 쌍」 = **4, 정확히 위의 넷**(0bp · 0%, 값 1.032807741737043e-15 vs 1.0349709942818401e-15). 다른 쌍은 등록 상대 식으로 통과.
   - sanity 행 전부를 `merge-1.5-attempt1.txt`와 대조: **E14 행(문구 · 결과)과 새 정보 행 말고는 글자 동일**(E19 88 identical, E12 108/108, E17 21/21, MC 집합 sha256 `c54c3e9d…7b7e` 포함).
   - 이 모드가 쓰는 결정적 결과 파일(과거 창 표)은 작업 폴더 밖 임시 경로에 쓰였고 **열지 않고 지웠다.** 합치기가 아니므로 조각을 읽지 않는다.
3. **조각 출처(합치기 검사 (b)의 입력만)**: 조각 10개의 `part_param` 줄 가운데 출처 필드만 읽었다 — `engine_sha256`이 10/10 등록 값 `63157268…d596`,
   `mc_set_sha256` 10/10 `c54c3e9d…7b7e`, `profile` v6, `sanity_all_pass` true, `seed_main` `20261605 + L`, `paths_per_L` `L1=20000 L3=6667 L6=3333 L12=1667`,
   `input_sha256`이 sanity의 입력 sha256(BTC `86ff9e24…`, ETH `323831dd…`, depth `dde89502…`)과 같다. 결과 열은 열지 않았다.
   (b)가 실제로 조각을 받는지는 합치기를 돌려야 확인된다 — **미확인**.

## 7. 다음 · 열린 것

- 순서(README대로): 고친 사본으로 합치기 → 독립 검증(D09, 이 판의 P2 스크립트 — **아직 없다**, 결과를 읽기 전에 등록 문장만으로 쓰고 커밋) → 결과 문서 → 최종 확인.
  몬테카를로 결과는 D09 스크립트가 커밋될 때까지 읽지 않는다.
- 합치기 전체 시간은 **미확인**(검산까지 61.8초, 조각 읽기 · 판정은 잰 적 없음). 로컬 2분을 넘을 것 같으면 클라우드(내부 클라우드 실행 규칙).
- 결과 문서는 README 9행대로 「등록 뒤 바뀐 것」에 이 파일 · 고친 사본 · 위 diff를 싣는다. `results-1.5.md` 「다음 — 열린 결정」은 아직 결정 전 문구다(이 커밋에서 고치지 않음).
- 이 고침의 1차 확인(작성자가 아닌 확인자)와 최종 확인은 아직이다(이 파일을 쓴 때).
