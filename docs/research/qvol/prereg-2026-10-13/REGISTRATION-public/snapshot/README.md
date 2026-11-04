# 등록 스냅샷 도구 (W8)

`registration-draft.md` §2-2 · §4-2의 입력 스냅샷(REST 1분봉 2026-08-01 ~ E · 거래소 1일봉 2017-08-17 ~ E)을 받는 스크립트. 의존성 없음(node).

## 실행 명령

```
node fetch-snapshot.mjs --end YYYY-MM-DD --out <dir>
```

## 출력 형식

- `rest-1m/btcusdt-1m-YYYY-MM-DD.json.gz` — 원응답 두 개를 배열로 담은 JSON의 gzip: `[<1번 응답(1000행)>,<2번 응답(그 날 나머지)>]`. 응답 본문 바이트를 그대로 `[` `,` `]` 사이에 넣는다. 2번 호출의 startTime = 1번 마지막 봉 연 시각 + 60,000ms.
- `daily-1d/btcusdt-1d-2017-08-17-to-E.json.gz` — 호출별 원응답을 이어 붙이지 않고 `[<호출1>,<호출2>,…]` 배열로 담은 JSON의 gzip(limit 1000씩).
- `canonical-1m.sha256` — 날마다 `날짜 행수 sha256`. 정규 글은 §2-2대로 `${openTimeMs},${S(o)},${S(h)},${S(l)},${S(c)}\n`(S = `String(Number(x))`), 연 시각 오름차순, UTF-8 sha256.
- `snapshot-meta.json` — E · 시작/끝 serverTime · 호출 수 · 행 수 · 걸린 시간 · node 버전.
- `MANIFEST.sha256` — 위 모든 파일(자기 자신 제외)의 sha256, 경로 오름차순. `shasum -a 256 -c MANIFEST.sha256`로 검사.
- 결정성: gzip 레벨 9 · 헤더 mtime 0. 같은 응답이면 같은 바이트. `snapshot-meta.json`(시각 · 걸린 시간)은 실행마다 다르므로 `MANIFEST.sha256`에서 뺐다(11/2 세션 수정) — 매니페스트는 날 파일 · 1일봉 · `canonical-1m.sha256`만 덮고, 같은 응답이면 매니페스트도 같은 바이트다.
- 중단 조건(종료 1): E일이 아직 안 닫힘(`E 23:59:59.999 >= serverTime`) · 봉이 닫히지 않음 · 날 안에 없는 봉 · 같은 연 시각 중복 · 4xx 오류 또는 재시도(최대 3회) 뒤 실패. 하루가 1,440행이 아니어도 저장하고 행 수를 `canonical-1m.sha256`에 적는다(판정은 §2-3 몫).

## 드라이런 (2026-11-02 14:3x KST, E = 2026-11-01)

명령: `node fetch-snapshot.mjs --end 2026-11-01 --out <scratchpad>/snapshot-dry/`

| 항목 | 값 |
|---|---|
| 소요 시간 | 75초(스크립트 안 74.8초) |
| 호출 수 | 192 (시간 2 · 1분봉 186 · 1일봉 4) |
| 파일 수 | 97 (날 파일 93 · 1일봉 1 · canonical · meta · MANIFEST) |
| 총 크기 | 6,759,718바이트 = 6.45MB (날 파일 gz 합 + 1일봉 gz 220,580바이트) |
| 1분봉 행 | 133,920 = 93일 × 1,440 (93일 모두 1,440행) |
| 1일봉 행 | 3,364 (호출 4회: 1000 · 1000 · 1000 · 364), 첫 봉 2017-08-17, 끝 봉 2026-11-01 |
| serverTime | 시작 1793597921885 · 끝 1793597996770 |
| MANIFEST 재검사 | 불일치 0 |

리포에 넣을 크기: 6.45MB(10MB 이하). 드라이런 산출은 리포에 넣지 않았다.

## 11/3 본 실행 절차

1. KST 09:10 뒤에 시작한다(UTC 00:10 뒤 — E = 2026-11-02의 마지막 봉이 닫힌 뒤).
2. `node fetch-snapshot.mjs --end 2026-11-02 --out <빈 디렉터리>` (약 75초, 호출 약 194).
3. 종료 코드 0과 `snapshot-meta.json`의 `restDays` = 94 · `restRows` = 94 × 1,440 = 135,360(다르면 행 수 확인)을 본다. `shasum -a 256 -c MANIFEST.sha256` 불일치 0.
4. 같은 E로 한 번 더 받아 날 파일 · 1일봉의 sha256이 같은지 본다(`MANIFEST.sha256`은 meta 때문에 다르다).
5. 결과를 등록 커밋에 넣는다(`registration-draft.md` §4-2).
