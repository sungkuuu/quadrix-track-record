# rest-daily-check (2026-11-03)

작성 2026-11-03 · E = 2026-11-02 · node v22.23.1

## 1. 두 번째 받기 (README 4단계)
- 명령: `node fetch-snapshot.mjs --end 2026-11-02 --out <scratchpad>/snapshot-second/` — 종료 코드 0, 소요 83초(스크립트 안 82,362ms), 호출 194, restDays 94, restRows 135,360, 1일봉 3,365행.
- 첫 번째(커밋본) 대비 sha256: `rest-1m/*.json.gz` 94개 + `daily-1d/*.json.gz` 1개 = 95개 중 같음 95 · 다름 0.
- `canonical-1m.sha256` 같음 · `MANIFEST.sha256` 같음(meta를 뺐으므로 예상대로 바이트 동일). 두 번째 받기의 `shasum -a 256 -c MANIFEST.sha256` 불일치 0.
- `snapshot-meta.json`은 시각이 달라 비교에서 제외(README 규칙).

## 2. REST 일 파일 (§4-1 형태)
- 도구: `../rest-to-daily.mjs` (59줄, 의존성 없음). 출력: `rest-daily/btcusdt-1m-YYYY-MM-DD.csv` 94개 + `rest-daily-manifest.sha256` 94줄.
- 거부 조건 검사: 같은 연 시각 중복 · 날 밖 행 · 행 수 ≠ `canonical-1m.sha256` · 정규 글 해시 불일치 — 위반 0.
- 정규 글 재계산(`${t},${S(o)},${S(h)},${S(l)},${S(c)}\n`, S = String(Number(x))) 해시 = `canonical-1m.sha256`: 94/94 일치.
- 두 디렉터리에 두 번 변환: `diff -r` 동일, 매니페스트 바이트 동일.
- `shasum -a 256 -c rest-daily-manifest.sha256`(rest-daily/ 안에서) 불일치 0.
- `rest-daily-manifest.sha256`의 sha256 = `1ab69d0451f3d26a719b7b8e4b345fa77f1da74909b58c6acfc586f552e54460`
- 변환 소요: 두 번 합쳐 1초 안.
