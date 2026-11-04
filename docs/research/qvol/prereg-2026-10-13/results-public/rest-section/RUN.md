# REST 구간 실행 기록 — 2026-11-03 (맥)

등록 커밋 0649c4b4 · 비교 스크립트 고정 커밋 0af158e4 뒤. REST 구간 = 줄 2026-09-01 ~ 2026-11-02(63줄), §6-2.

- 기계: iMac, Apple M1, 8 GB RAM. node v22.23.1 · python 3.14.6.
- 구현 A: 기록 리포 브랜치 keeper/qvol-2026-11-02 커밋 b8769aa(워크트리 <record-repo b8769aa>).
  명령: `node keeper/vol-index.mjs --line realized --dry-run --replay 2026-09-01..2026-11-02 --gaps <quadrix>/docs/research/qvol/prereg-2026-10-13/inputs-2026-11-02/accepted-gaps-keeper.json --out <여기>/a-rest`
  시작 2026-11-03T08:02:22Z · 끝 2026-11-03T08:04:12Z · real 109.87 s · 종료 0 · 63줄(a-rest/record-qvol.jsonl sha256 2427cd0f14523d4805e6129ef73a781b315245df6e52e564b4eead7ad33beed8). 네트워크: Binance REST(실행 때 받음; 스냅샷 대조는 V2).
- A 검산(C7 · C11 · C12 · C13, VOL_CHECK_DIR=a-rest): `node --test keeper/test/vol-checks.test.mjs` → checks-a.txt: tests 12 · pass 12 · fail 0 · skipped 0.
- 구현 B: `python3 -I impl-b/realized_b.py --daily snapshot/E-2026-11-02/rest-daily --from 2026-09-01 --to 2026-11-02 --out <여기>/b-rest/record.jsonl --accepted-gaps inputs-2026-11-02/accepted-gaps.json`
  real 0.77 s · 종료 0 · 63줄(b-rest/record.jsonl sha256 6b3c698ff6ab1c07489a9b39170d7825ba08027b107f491834679c99785646e2). 입력 = 등록 스냅샷의 일별 파일 94개(rest-daily-manifest.sha256 1ab69d04…).
- B 검산 → checks-b.txt: C11(모든 value ≥ 0) 위반 0 · C10(자릿수 표기 둘 → 같은 sha256, 합성) 일치. C1 · C9는 impl-b/selftest.py(고정 커밋에서 통과).
- 판정(V1~V4)은 여기서 하지 않는다: 비교 스크립트는 파일 구간 결과까지 받아야 돈다(fix-2026-11-03.md §2 6). 파일 구간과 판정은 클라우드 루틴이 돌리고 results-2026-11-03/ 아래에 쓴다.
- 이 폴더의 파일: a-rest/record-qvol.jsonl · a-rest.log · a-rest.time · a-rest-start.txt · checks-a.txt · b-rest/record.jsonl · b-rest.time · checks-b.txt · RUN.md.
