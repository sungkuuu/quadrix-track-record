# 구현 B — qVOL 실현 변동성 줄 (정의 §2 · §4-1 · §5만 읽고 작성)

파이썬 3 표준 라이브러리만. `python3 realized_b.py --daily <dir> --from YYYY-MM-DD --to YYYY-MM-DD --out <record.jsonl> [--accepted-gaps <json>]`
시험: `python3 selftest.py` (약 20초). 닫힌 형태(±ln2 일정 수익, 불규칙 종가의 Decimal ln), 두 번 실행 바이트 동일, 해시 사슬, 빠진 봉 중단 · 수락 이어가기를 확인한다.

동작: 줄 D마다 `btcusdt-1m-<날짜>.csv` D−31 … D−1(31일)을 읽는다. 1,440행이 아닌 날은 수락 목록에 정규 글 sha256이 없으면 그 줄을 쓰지 않고 종료 1(사유는 stderr, 앞 줄은 남김).
D 00:00 이후 첫 봉이 든 파일이 없으면(하루 안 끝남) 종료 0. 필요한 파일이 없거나 행이 깨졌으면 종료 1. 수 계산은 §2-1 순서 그대로(`math.log`, `365/30`, `math.sqrt`).
출력 수 표기는 ECMAScript 최단 왕복(`js_num`), 줄 해시 = sha256(hash 뺀 줄의 `JSON.stringify` 꼴, 공백 없음).

## 정의가 정하지 않은 것 (문자 그대로 읽고 고른 값)
1. 수락 목록 파일 꼴: §2는 파일을 안 정한다. `[sha256 문자열 | {"id":…,"sha256":…}]` 목록, 또는 `{"accepted":[…]}`, 또는 `{id: sha256}`를 받는다. 날짜는 보지 않고 정규 글 sha256만 맞춘다.
2. `observedAt`: 벽시계를 쓰면 결정성이 깨진다. D 00:00 이후 첫 봉의 연 시각 + 60,000ms(그 봉이 닫힌 시각)로 정한다. 그래서 `late`는 그 봉이 D의 다음 날에 열렸을 때만 `true`.
3. `rulebookSha256` · `keeper.lagSeconds` · `keeper.run`은 입력에서 알 수 없어 `null`. `inception` · `shadow`는 쓰지 않는다. `seq` · `prevHash`는 이 출력 파일 안에서 0 · null부터 시작한다(앞 실행을 이어 붙이지 않음).
4. `source.finalBy`: 「D 00:00 이후 첫 봉」의 `openTimeMs` 정수로 정했다. `host`는 §2-2 URL의 `data-api.binance.vision`, `fetchedAt: null` + `via: "offline"`. `lastBar`는 D−1 마지막 봉의 UTC `HH:MM`(빈 날이면 `null`). `closeTime < serverTime`은 파일에 서버 시각이 없어 시험하지 않는다(파일의 봉은 닫힌 봉으로 본다).
5. `gaps` 꼴: D−1의 빠진 분을 `[["HH:MM","HH:MM"],…]`(양끝 포함 연속 구간). `gapAccepted`: 수락 id가 있으면 그것, 없으면 그 날 정규 글 sha256.
6. `carriedFrom`: 「첫 줄」을 출력의 첫 기록 줄로 읽었다(그 줄만 `[날짜,종가,rows,sha256(,id)]`, 이후 줄은 `[날짜,종가]`). 거슬러 찾는 날들도 1,440행이거나 수락돼야 한다. `sources`의 수락 id는 있을 때만 붙인다.
7. 입력 검증(정의에 없음): 열 5개 · 숫자 꼴 · 그 UTC일 안의 연 시각 · 엄격한 오름차순이 아니면 종료 1. 종가 ≤ 0도 종료 1. 1,440행이면 분 간격은 보지 않는다(행 수만 본다).
8. 필요한 파일이 아예 없는 날(범위 앞쪽 등)은 「출처 불통」으로 읽어 그 줄부터 종료 1. 건너뛰지 않는다.
9. `math.log`는 시스템 libm이라 V8의 `Math.log`와 마지막 비트가 다를 수 있다(정의는 ln만 정함). V1 비교에서 값이 1ulp 어긋나면 이 때문일 수 있다.
