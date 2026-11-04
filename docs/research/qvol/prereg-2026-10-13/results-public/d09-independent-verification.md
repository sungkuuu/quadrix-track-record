# D09 독립 검증 — qVOL 실현 줄 재현성 검정(등록 0649c4b4 · 판정 2판 2026-11-04)

검증자: 구현 A 작성자 · 등록문 작성자와 다른 모델(§13 6). A · B · 비교 스크립트의 코드를 계산에 쓰지 않고 검증자가 쓴 스크립트 둘(verify.py · c12-mac.mjs, 리포 밖)로 다시 셌다. 읽은 것: 등록문 §2-1 · §4-2 · §6-2 ~ §6-4 · §13, fix-2026-11-03.md, compare/README.md, impl-b/README.md, 결과 폴더 전부.

## 1. 판정

**「판정 규칙을 적용하면 재현됨」 — 확인됨.** V1 · V2 · V4를 따로 다시 세어 불일치 0, V3는 결과 파일의 불일치 행 0과 verdict.json의 수가 맞음. 아래 3의 모순 둘은 판정 밖의 수(기록 오류 하나 · 빠진 파일 하나)이고 네 검정의 결과를 바꾸지 않는다.

## 2. 다시 센 것과 수

- 매니페스트: `MANIFEST.sha256` 5/5 OK · `MANIFEST-folder.sha256` 69/69 OK · `rest-section/MANIFEST.sha256` 8/9 OK(`a-rest.log` 없음, 3 참조). `DONE`(`V1=pass V2=pass V3=pass V4=pass`) · `verdict.json`(sha256 849905b8…) · RUN.md 안의 JSON 블록은 서로 같다(파싱 뒤 동일). RUN.md의 비교 명령이 가리키는 다섯 파일(a-run4 · a-run5 · a-rest · b-run1 · b-rest)은 verdict.json `inputs` · `scope`와 같다. 비교 스크립트 · impl-b · 등록문은 고정 커밋 0af158e4 이후 바뀌지 않았다(`git diff 0af158e4 HEAD -- compare impl-b registration-draft.md` 빈 출력).
- V1(등록식 |a−b|/max(|a|,|b|)): 파일 구간 a-run4 대 b-run1 3,299줄 전부 대조, 한쪽에만 있는 날 0, 값 상대차 최대 3.7137324887372116e-16 · 분산 3.802507002870737e-16, 1e-9 초과 0 · 0. REST 구간 a-rest 대 b-rest 63줄, 한쪽에만 있는 날 0, 상대차 최대 0 · 0. 따로 세는 줄: 파일 393 · REST 36(§6-2와 같음). verdict.json의 V1 수(3,362 · 0 · 두 최대값)와 일치.
- V2: `source.sha256` 줄마다 — 파일 3,299 불일치 0 · REST 63 불일치 0. 첫 줄 `sources` 31개(날짜 · 행수 · sha256) A = B, 두 구간 모두. REST: A의 `source.sha256` 63일 · 첫 줄 `sources` 31일 대 `snapshot/E-2026-11-02/canonical-1m.sha256` 3열 — 불일치 0, 스냅샷에 없는 날 0(스냅샷 94일; 파일 sha256 23270baf… = 등록문 §4-2 · 등록 커밋 blob). verdict.json 3,422일 = 파일 3,329 + REST 93(겹치는 날 제외)으로 맞음.
- V4: a-run4 대 a-run5(둘 다 node v22.23.1, 컨테이너 X · Y — env.txt의 uptime으로 역산한 부팅 시각이 02:34:39Z · 02:35:44Z로 다름) 3,299줄, K 14칸 + `seq` + `sources`의 JSON 직렬화 비교 — 불일치 0. 정보용: a-run1(v22.23.4) 대 a-run4(v22.23.1) 같은 비교 불일치 0 — node 패치 버전은 비트에 영향 없음(RUN.md §3 첫 문장과 일치; 브리프의 「몇 줄은 다를 것」 예상은 성립하지 않음).
- V3(완전 재계산 아님): `realized-close-check.csv` 6,844행 — (가) ok 6,658 · n/a(REST 구간) 186, (나) ok 6,844, 불일치 행 0; `rest-vs-file.csv` 58행(A 29 · B 29) 전부 ok, 불일치 칸 0. verdict.json V3(6,658 · 6,844 · 58, nullSkipped 0)과 일치. `realized-ab.csv` 3,362행: V1 ok 3,362 · sourceShaMatch ok 3,362 · snapshotMatch ok 63.
- 검산: TAP 파일 — `file-section/checks-a.txt`(실행 1, 클라우드 v22.23.4) 12/0/0 · `a-run4/checks-a-run4.txt` · `a-run5/checks-a-run5.txt`(각자 컨테이너, env.txt의 node v22.23.1) 12/0/0 · `rest-section/checks-a.txt`(맥 v22.23.1) 12/0/0 — 모두 12번 시험(C7 · C11 · C12 · C13, 실제 기록)이 「ok」, skipped 0. 검산 파일 자체에는 node 버전이 없고 env.txt · RUN.md가 말한다. `checks-b.txt`(파일 · REST): selftest OK(C1 · C9) · C11 위반 0/3,299 · 0/63 · C10 일치 · b-run1 = b-run2 바이트 동일. 맥에서 리눅스 기록에 돌린 세 파일(`checks-a-node-v22.23.1.txt` · `a-run4/…mac…` · `a-run5/…mac…`)은 11/1/0 — C12만 실패(3 참조).
- 검증자의 C12 재계산(맥, node v22.23.1, darwin arm64, §2-1 순서대로 직접 씀): a-run4 3,299줄 중 분산 비트 불일치 **91줄**(그중 값까지 다른 줄 51), 날짜 91개; a-run1도 91 · 51; a-rest(맥에서 만든 기록) 0. 모두 상대차 ≤ 3.8e-16.

## 3. 모순(등록 규칙 · RUN.md와 맞지 않는 것)

1. **수가 맞지 않음**: RUN.md §3 · file-section/RUN.md 11/4 추가 · 커밋 a8da1684 메시지의 「3,299줄 중 182줄(5.5%)」. 실제는 **91줄(2.8%)**이다. TAP 출력이 실패 목록을 두 번 찍고(`+ actual` 블록과 인덱스 배열, 검산 파일 80행 · 229행), 그 둘을 합쳐 세면 분산 항이 182가 된다. 고유 항은 142(분산 91 + 값 51), 날짜 91. 검증자 재계산도 91. 결론(한도 1e-9 안, 판정 밖)은 그대로다. RUN.md §3 · 규칙서 · 페이지에 적을 문장의 수를 91 · 2.8%로 고쳐야 한다.
2. **빠진 파일**: `rest-section/MANIFEST.sha256`가 적은 `a-rest.log`가 이 브랜치에 없다(리포 `.gitignore`의 `*.log`에 걸림; 파일 구간의 세 로그는 강제 추가됐고 이것은 안 됐다). 주 작업본의 미추적 사본은 매니페스트 sha256(6661fca2…)과 같다. 강제 추가하거나 매니페스트에서 빼고 그 사실을 적어야 한다.
3. (경계) §6-3 C12는 런타임을 node 버전으로만 고정하고 OS · CPU 빌드는 정하지 않았다. 같은 v22.23.1이라도 맥에서 돌린 C12는 리눅스 기록에 대해 실패(91줄)하고, 컨테이너 안의 C12는 통과한다. 「컨테이너 안의 C12가 판정의 검산」이라는 읽기는 결과를 본 뒤 RUN.md §3에 적혔다. 등록문의 글자만으로는 어느 쪽 C12가 §6-3의 「하나라도 틀리면」에 드는지 정해지지 않는다 — 기록된 읽기로 두되, 다음 판 등록문에 플랫폼을 적는 것이 맞다.

## 4. 기록된 일탈(모순 아님)

- 1판(11/3)은 node v22.23.4 · A 두 번이 같은 컨테이너 — 2판(a-run4 · a-run5, v22.23.1, 컨테이너 둘)으로 대체, 1판은 `verdict-1-node-v22.23.4/`에 보존(RUN.md §2, W-20261104-41). 다섯 실행 V4 13,196줄 불일치 0(`supplement-cross-build/`).
- 파일 구간 3,299줄(「약 3,300」, file-section/RUN.md). 버리는 창(2019-02 ~ 03)의 날짜는 빼지 않음(fix §2 1 · compare/README 1).
- 비교 스크립트 인자 이름이 §13 계획과 다름 · `--b-inputs` 없음 · V2는 B가 제 기록에 쓴 sha256을 대조(fix §2 2 · README 4). 결과 파일 `checks.txt` 대신 구간별 `checks-a*.txt` · `checks-b.txt`(README).
- 수락 목록을 A 꼴로 옮긴 `accepted-gaps-keeper.json`(fix §2 3). A · B 칸 꼴 차이(`gaps` · `rule.rulebookSha256` · `source.finalBy` 문자열/정수)는 어느 판정에도 들지 않음(fix §2 4; K 밖 또는 A 대 B에서 안 봄).
- 플랫폼 빌드 사이 마지막 비트 차이(RUN.md §3; 수는 3-1로 정정).

## 5. 실행한 명령(prereg 폴더 기준)

- `git show 0649c4b4:docs/research/qvol/prereg-2026-10-13/registration-draft.md | sed -n '240,280p;400,430p'`(및 §2-1 · §4-2 · §6-2 절) · `git diff 0af158e4 HEAD --stat -- compare impl-b registration-draft.md`
- `cd results-2026-11-03 && shasum -a 256 -c MANIFEST.sha256 && shasum -a 256 -c MANIFEST-folder.sha256 && (cd rest-section && shasum -a 256 -c MANIFEST.sha256)` · `shasum -a 256 verdict.json snapshot/E-2026-11-02/canonical-1m.sha256 snapshot/E-2026-11-02/daily-1d/*`
- `python3 -I verify.py` — 검증자 작성(표준 라이브러리; jsonl 읽기 → 날짜별 V1 상대차 · V2 sha256 · V4 K+seq+sources 직렬화 비교 · 범위 밖 줄 수), 1.3 s
- `node c12-mac.mjs <record.jsonl>` — 검증자 작성(§2-1 순서: 나눗셈 → `Math.log` → 오름차순 누적 → `(365/30)×S` → `100×sqrt`, 비트 비교), a-run4 · a-run1 · a-rest · b-run1 각 1 s 안
- `python3 -I`(csv 모듈)로 realized-ab.csv · realized-close-check.csv · rest-vs-file.csv의 결과 열 집계 · verdict.json과 대조; `grep -oE "'[0-9]{4}-…: (variance|value)"`로 맥 검산 파일의 항 · 날짜 수
- `git log -1 b8769aa`(기록 리포) · `git ls-files` · `git check-ignore -v rest-section/a-rest.log`

## 6. 독립성 — 파일이 말하는 것만

- 구현 A: 기록 리포 b8769aa(git 작성자 「Quadrix」, 2026-11-03 16:37 +0900); 등록문 §6-1 「10/5 키퍼 구현 담당」.
- 구현 B: impl-b/README 「정의 §2 · §4-1 · §5만 읽고 작성」; fix §1 「A 작성자와 다른 모델. §2 · §4-1 · §5만 읽었다」.
- 비교 스크립트: fix §1 「A · B 작성자와 다른 에이전트. §5 · §6-2 · §6-4 · §6-5 · §13만 읽었다」; compare/README에는 작성자 표기 없음. `accepted-gaps-keeper.json`: 세션(스크립트 변환).
- 검증자(이 문서): A 작성자 · 등록문 작성자와 다른 모델(브리프의 진술); A · B · 비교 스크립트의 코드를 읽지 않고 출력 파일 · README · 등록문만 읽었다.
