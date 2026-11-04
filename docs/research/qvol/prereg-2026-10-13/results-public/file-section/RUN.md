# 파일 구간 실행 기록 — 2026-11-03 (클라우드)

등록 커밋 0649c4b4 · 비교 스크립트 고정 0af158e4 · REST 구간 결과 8deca8e4 뒤. 파일 구간 = 줄 2017-09-18 ~ 2026-09-29.

- 기계: 클라우드 세션 컨테이너, Intel Xeon @ 2.10GHz × 4 코어(/proc/cpuinfo), MemTotal 16,477,348 kB. node **v22.23.4**(등록 버전 v22.23.1과 패치 숫자 다름, v22.x 조건은 충족) · python 3.11.18.
- 입력: `git archive origin/research/leverage-params-v6`(c9bd7a2b) read-1m.mjs + data-1m → `node inputs-2026-11-02/convert-daily-1m.mjs /tmp/v6src/docs/research/leverage/params-v6 /tmp/qvol-daily`(11.0 s, 3,331일 · 4,787,768행 · patched 21,613) → `shasum -a 256 -c inputs-2026-11-02/daily-manifest.sha256` 3,331 OK · 불일치 0(daily-manifest-check.txt). 15분 파일 `git show origin/research/leverage-params-v6:…/btcusdt-15m.csv.gz` sha256 86ff9e24…5ed375.
- 구현 A: 기록 리포 keeper/qvol-2026-11-02 클론, `git checkout b8769aa5…` → HEAD b8769aa5542313e6e7688266dfff0412a117bc3b. `node --test keeper/test/vol-*.test.mjs` → tests 71 · pass 68 · fail 0 · skipped 3(tests-a.txt).
- A 실행 1 · 2(/tmp/qtr에서): `node keeper/vol-index.mjs --line realized --dry-run --offline /tmp/qvol-daily --replay 2017-09-18..2026-09-29 --gaps <quadrix>/…/inputs-2026-11-02/accepted-gaps-keeper.json --out /tmp/a-run{1,2}`
  - 실행 1: 시작 08:17:32Z · wall 186.3 s · 종료 0 · 3,299줄(sha256 0e33ebfe…4c10)
  - 실행 2: 시작 08:20:38Z · wall 185.3 s · 종료 0 · 3,299줄(sha256 ee69bc6e…a76d). 두 파일 바이트는 다르다(K 밖 칸) — 판정은 V4.
  - 줄 수: 브리프의 「3,300줄 예상」과 다르다. 2017-09-18 ~ 2026-09-29는 양끝 포함 3,299일이고 A · B 모두 빠진 날 없이 3,299줄을 썼다(산수 차이, 실패 아님).
- A 검산: `VOL_CHECK_DIR=/tmp/a-run1 node --test keeper/test/vol-checks.test.mjs` → checks-a.txt: tests 12 · pass 12 · fail 0 · skipped 0(C7 · C11 · C12 · C13 실제 기록 시험 12번 실행됨).
- 구현 B 실행 1 · 2: `python3 -I impl-b/realized_b.py --daily /tmp/qvol-daily --from 2017-09-18 --to 2026-09-29 --out /tmp/b-run{1,2}/record.jsonl --accepted-gaps inputs-2026-11-02/accepted-gaps.json`
  - 실행 1: wall 53.0 s · 종료 0 · 3,299줄 · 실행 2: wall 47.6 s · 종료 0 · 3,299줄. `cmp` 종료 0(바이트 동일, 둘 다 sha256 cf064f1b…0476).
- B 검산 → checks-b.txt: `python3 -I impl-b/selftest.py`(C1 · C9) 「selftest OK」 종료 0 · 47 s; C11(b-run1의 value < 0 또는 null) 위반 0 / 3,299줄.
- 판정: `node compare/compare.mjs --a-file results-2026-11-03/file-section/a-run1/record-qvol.jsonl --a2 …/a-run2/record-qvol.jsonl --a-rest results-2026-11-03/rest-section/a-rest/record-qvol.jsonl --b-file …/b-run1/record.jsonl --b-rest results-2026-11-03/rest-section/b-rest/record.jsonl --snapshot snapshot/E-2026-11-02 --close15 /tmp/btcusdt-15m.csv.gz --out results-2026-11-03/`(prereg 폴더에서) → wall 1.2 s · **종료 0** · V1~V4 pass · DONE(compare.log).
- 적어 둘 것: §6-4 V4는 두 번을 「서로 다른 실행 환경」에서 돌린다고 예를 든다. 이번 A 실행 1 · 2는 같은 클라우드 컨테이너에서 차례로 돌았다(같은 환경). 판정 스크립트는 이를 보지 않는다 — D09에서 볼 것.
- 이 폴더: a-run{1,2}/(record-qvol.jsonl · .log · .time · .start) · b-run{1,2}/(record.jsonl · .log · .time) · tests-a.txt · checks-a.txt · checks-b.txt · daily-manifest-check.txt · RUN.md. 소스 파일은 고치지 않았다.

## 11/4 추가 — 실행 3 · 4 · 5(세션이 클라우드 루틴 셋을 띄움)

- 실행 3(`a-run3/`, 클라우드 루틴, 다른 컨테이너, node v22.23.4): 02:32:56Z 시작 · 146.7 s · 종료 0 · 3,299줄 · sha256 917d4650…. 1 · 2와 `value` · `variance` 비트 동일.
- 실행 4(`a-run4/`, 클라우드 루틴, 컨테이너 X, **node v22.23.1** nodejs.org tarball): 02:38:47Z · 147.5 s · 종료 0 · 3,299줄 · sha256 6242ce98…; 시험 68/0/3 · 검산 12/12 · 건너뜀 0(`checks-a-run4.txt`); 입력 매니페스트 3,331/3,331.
- 실행 5(`a-run5/`, 클라우드 루틴, 컨테이너 Y, **node v22.23.1**): 02:40:10Z · 157.9 s · 종료 0 · 3,299줄 · sha256 a760428b…; 시험 68/0/3 · 검산 12/12 · 건너뜀 0(`checks-a-run5.txt`).
- 다섯 실행의 `value` · `variance`는 전부 비트 동일(`../supplement-cross-build/`). 기록 파일 sha256이 다른 것은 K 밖 칸(`observedAt` 등) 때문.
- 맥(iMac, macOS, node v22.23.1)에서 같은 검산을 리눅스 기록에 돌리면 C12만 실패한다 — 91줄 마지막 비트(값까지 51; TAP 실패 목록이 두 번 찍혀 처음 182로 잘못 셌음, D09 정정)(`checks-a-node-v22.23.1.txt`(실행 1) · `a-run4/checks-a-run4-mac-node-v22.23.1.txt` · `a-run5/…`). 플랫폼 빌드 차이; 판정 밖. 정본 설명 `../RUN.md` §3.
- 로그 보존: a-run1 · a-run2 · b-run1 · b-run2의 로그 파일은 `*.log` 무시 규칙 때문에 커밋되지 않았고 컨테이너와 함께 사라졌다; compare.log도 저장소에 없다(비교 출력은 터미널로 나갔고 실행 시간은 compare.time에 있다); a-run3 · a-run4 · a-run5 · a-rest의 로그는 강제로 더해 남아 있다.
