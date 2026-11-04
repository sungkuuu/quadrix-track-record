# 판정 실행 기록 — 2026-11-03 등록 · 2026-11-04 판정 실행 2

**판 번호**: 등록 §6-4 「고친 뒤의 실행은 새 판」 기준으로 이 검정은 **1판** 그대로다 — 고친 것이 없고 등록 커밋은 0649c4b4 하나다. 아래 「판정 실행 1 · 2」는 같은 판 안에서 비교 스크립트를 돌린 두 번이다. D09 보고 · 장부 W-20261104-41의 「2판」은 「판정 실행 2」를 뜻한다.

등록 0649c4b4 · 비교 스크립트 고정 0af158e4(바뀌지 않음) · REST 구간 8deca8e4(맥, 11/3) · 파일 구간 `file-section/RUN.md`(클라우드, 11/3 실행 1 · 2, 11/4 실행 3 · 4 · 5).

## 1. 판정(판정 실행 2) — 등록 런타임 node v22.23.1, 서로 다른 컨테이너 둘

- A 파일 구간 = `file-section/a-run4/`(컨테이너 X, 02:38:47Z 시작, 147.5 s) · V4 두 번째 = `file-section/a-run5/`(컨테이너 Y, 02:40:10Z 시작, 157.9 s). 둘 다 node v22.23.1(nodejs.org 공식 tarball), 기록 리포 b8769aa, 입력 매니페스트 3,331/3,331 일치, 검산 12/12 · 건너뜀 0(각자 컨테이너 안에서).
- A REST 구간 = `rest-section/a-rest/`(맥, node v22.23.1, 11/3). B = `file-section/b-run1/` · `rest-section/b-rest/`.
- 명령(맥, 11/4 02:44Z): `node compare/compare.mjs --a-file file-section/a-run4/record-qvol.jsonl --a2 file-section/a-run5/record-qvol.jsonl --a-rest rest-section/a-rest/record-qvol.jsonl --b-file file-section/b-run1/record.jsonl --b-rest rest-section/b-rest/record.jsonl --snapshot ../snapshot/E-2026-11-02 --close15 btcusdt-15m.csv.gz(sha256 86ff9e24…, 리포에 두지 않음) --out results-2026-11-03/` (prereg 폴더에서) → real 0.46 · user 0.53 · sys 0.05 · compare exit 0.
- **DONE: `2026-11-04T02:46:58.959Z V1=pass V2=pass V3=pass V4=pass`. 판정 규칙을 적용하면 재현됨.** V1 불일치 0(대조 3362줄, 값 상대차 최대 3.7137324887372116e-16, 분산 상대차 최대 3.802507002870737e-16) · V2 불일치 0 · V3 불일치 0 · V4 불일치 0.
- verdict.json(sha256 849905b829435af3c08ff0ce733dc4ae2586da40d01fde0f3afcc03a33d792f8) 그대로:

```json
{
  "registration": "0649c4b4",
  "reproduced": true,
  "note": "판정 규칙을 적용하면 — four lines must all pass for 「재현됨」 (§6-4)",
  "ranges": {
    "file": [
      "2017-09-18",
      "2026-09-29"
    ],
    "rest": [
      "2026-09-01",
      "2026-11-02"
    ],
    "overlap": [
      "2026-09-01",
      "2026-09-29"
    ],
    "preFile": [
      "2025-09-02",
      "2026-09-29"
    ],
    "preRest": [
      "2026-09-01",
      "2026-10-06"
    ]
  },
  "scope": {
    "A file range": {
      "lines": 3299,
      "inScope": 3299,
      "outOfScope": 0,
      "first": "2017-09-18"
    },
    "A REST range": {
      "lines": 63,
      "inScope": 63,
      "outOfScope": 0,
      "first": "2026-09-01"
    },
    "B file range": {
      "lines": 3299,
      "inScope": 3299,
      "outOfScope": 0,
      "first": "2017-09-18"
    },
    "B REST range": {
      "lines": 63,
      "inScope": 63,
      "outOfScope": 0,
      "first": "2026-09-01"
    },
    "A file range run 2": {
      "lines": 3299,
      "inScope": 3299,
      "outOfScope": 0,
      "first": "2017-09-18"
    }
  },
  "gapDays": [
    "2017-09-06",
    "2017-12-04",
    "2017-12-18",
    "2018-01-04",
    "2018-02-08",
    "2018-02-09",
    "2018-02-10",
    "2018-02-11",
    "2018-06-26",
    "2018-06-27",
    "2018-07-04",
    "2018-10-19",
    "2018-11-14",
    "2019-03-12",
    "2019-05-15",
    "2019-06-07",
    "2019-08-15",
    "2019-11-13",
    "2019-11-25",
    "2020-02-09",
    "2020-02-19",
    "2020-03-04",
    "2020-04-25",
    "2020-06-28",
    "2020-11-30",
    "2020-12-21",
    "2020-12-25",
    "2021-02-11",
    "2021-03-06",
    "2021-04-20",
    "2021-04-25",
    "2021-08-13",
    "2021-09-29",
    "2023-03-24"
  ],
  "tests": [
    {
      "id": "V1",
      "pass": true,
      "mismatches": 0,
      "evidence": "realized-ab.csv",
      "compared": 3362,
      "missingLines": 0,
      "maxValueRelDiff": 3.7137324887372116e-16,
      "maxVarianceRelDiff": 3.802507002870737e-16,
      "pre1006": {
        "file": {
          "lines": 393,
          "mismatches": 0
        },
        "rest": {
          "lines": 36,
          "mismatches": 0
        }
      },
      "threshold": {
        "valueRelDiffMax": 1e-9,
        "varianceRelDiffMax": 1e-9,
        "relDiff": "|a - b| / max(|a|, |b|); both 0 -> 0; only one 0 -> 1"
      }
    },
    {
      "id": "V2",
      "pass": true,
      "mismatches": 0,
      "evidence": "realized-ab.csv",
      "daysCompared": 3422,
      "snapshotDaysCompared": 93,
      "aVsB": 0,
      "aRestVsSnapshot": 0,
      "list": [],
      "threshold": {
        "mismatchesMax": 0
      }
    },
    {
      "id": "V3",
      "pass": true,
      "mismatches": 0,
      "evidence": "realized-close-check.csv, rest-vs-file.csv",
      "ga": {
        "compared": 6658,
        "mismatches": 0,
        "nullSkipped": 0
      },
      "na": {
        "compared": 6844,
        "mismatches": 0,
        "nullSkipped": 0,
        "list": []
      },
      "da": {
        "linesCompared": 58,
        "mismatches": 0,
        "expectedLines": 58
      },
      "threshold": {
        "mismatchesMax": 0,
        "parts": [
          "(가) 1m close = last 15m bar close (file-range windows)",
          "(나) 1m close = exchange 1d close (file + REST windows, registration snapshot only)",
          "(다) K fields, REST-range line vs file-range line, overlap days"
        ]
      }
    },
    {
      "id": "V4",
      "pass": true,
      "mismatches": 0,
      "evidence": "determinism.txt",
      "runs": 2,
      "linesCompared": 3299,
      "threshold": {
        "mismatchesMax": 0,
        "minRuns": 2,
        "fields": "K + seq + sources, JSON.stringify bytes"
      }
    }
  ],
  "inputs": [
    {
      "role": "A file range",
      "path": "results-2026-11-03/file-section/a-run4/record-qvol.jsonl",
      "sha256": "6242ce98b6ef6efd86d2504c043836a912e3a21c74c5993779048ab8c80873cb"
    },
    {
      "role": "A REST range",
      "path": "results-2026-11-03/rest-section/a-rest/record-qvol.jsonl",
      "sha256": "2427cd0f14523d4805e6129ef73a781b315245df6e52e564b4eead7ad33beed8"
    },
    {
      "role": "B file range",
      "path": "results-2026-11-03/file-section/b-run1/record.jsonl",
      "sha256": "cf064f1b961fc5e03a3fc2412e850df680fd8a0388c5e2d351e5714c7e150476"
    },
    {
      "role": "B REST range",
      "path": "results-2026-11-03/rest-section/b-rest/record.jsonl",
      "sha256": "6b3c698ff6ab1c07489a9b39170d7825ba08027b107f491834679c99785646e2"
    },
    {
      "role": "A file range run 2",
      "path": "results-2026-11-03/file-section/a-run5/record-qvol.jsonl",
      "sha256": "a760428b60395d957b1c586ac2efedda17831cb708ce41647af24b16d55fe649"
    },
    {
      "role": "snapshot canonical-1m.sha256",
      "path": "snapshot/E-2026-11-02/canonical-1m.sha256",
      "sha256": "23270baf09306ae0320d75e8b0f742fa8dd8ada6ec295bcc97d2a71672c36183",
      "days": 94
    },
    {
      "role": "snapshot 1d",
      "path": "snapshot/E-2026-11-02/daily-1d/btcusdt-1d-2017-08-17-to-2026-11-02.json.gz",
      "sha256": "96ec4af8e88bc4f26ad37ae3eb1c3bedd9c3329eefb1d751fbf09081b191c4c0",
      "days": 3365
    },
    {
      "role": "15m file",
      "path": "btcusdt-15m.csv.gz",
      "sha256": "86ff9e2449172dc2155be980b05040e4d67ff936797e7afa01c5a96e075ed375",
      "days": 3331
    }
  ]
}
```

## 2. 판정 실행 1(11/3 08:26:59Z, 클라우드 node v22.23.4, 실행 1 · 2 같은 컨테이너)

`verdict-1-node-v22.23.4/`에 그대로 둔다(verdict.json · 네 결과 파일 · MANIFEST · DONE). 결과는 같다: V1~V4 pass. 실행 2를 쓰는 이유는 §6-3 C12의 런타임 「v22.23.1」과 §6-4 V4의 「서로 다른 실행 환경」을 글자대로 채우기 위해서다(작업자 결정 W-20261104-41).

## 3. 발견 — 플랫폼 사이 마지막 비트 차이(판정 밖, 기록)

- 리눅스 컨테이너의 A 실행 1 · 2 · 3(v22.23.4) · 4 · 5(v22.23.1) 다섯은 `value` · `variance`가 전부 비트 동일하다(`supplement-cross-build/determinism.txt`: 다섯 실행 13,196줄 불일치 0). 즉 node 패치 버전(22.23.4 대 22.23.1)은 비트에 영향이 없다.
- 그러나 같은 v22.23.1이라도 **macOS(iMac)에서 C12(분산 재계산)를 돌리면 리눅스에서 만든 기록 3,299줄 중 91줄이 마지막 비트에서 다르다**(값까지 다른 줄 51; 검산 파일의 TAP 출력은 실패 목록을 두 번 찍어 처음에 182로 잘못 셌다 — 커밋 a8da1684 메시지의 182는 그 오류다. D09가 바로잡음)(`file-section/a-run4/checks-a-run4-mac-node-v22.23.1.txt` · a-run5 같음 · a-run1에 대해서도 `file-section/checks-a-node-v22.23.1.txt`). 손 계산 세 날: `Math.log`가 플랫폼 빌드에 따라 1 ulp 다른 날이 드물게 있다(파이썬의 libm도 플랫폼마다 다르다). 상대차는 최대 3.8e-16으로 V1 한도 1e-9 안이고, 공개 검증기도 상대차 1e-9로 본다.
- 적어 둘 것(규칙서 · 페이지 알려진 한계 한 줄): 「비트 단위 재현은 같은 플랫폼 빌드 안에서 성립한다. 플랫폼이 다르면 3,299줄 중 91줄(2.8%)이 마지막 비트에서 달랐다. 판정과 검증기는 상대차 1e-9로 본다.」 REST 구간(맥)과 파일 구간(리눅스)이 겹치는 29일(V3 다)은 불일치 0이었다.

## 4. 이 폴더

`verdict.json` · `realized-ab.csv` · `realized-close-check.csv` · `rest-vs-file.csv` · `determinism.txt` · `MANIFEST.sha256`(비교 스크립트가 쓴 다섯 파일) · `DONE` · `compare.time` · `verdict-1-node-v22.23.4/` · `supplement-cross-build/`(다섯 실행 V4, 정보용) · `file-section/` · `rest-section/` · `MANIFEST-folder.sha256`(이 폴더 전체) · `d09-independent-verification.md` · `d09/`(검증자 스크립트 둘 verify.py · c12-mac.mjs — D09 보고 머리의 「리포 밖」을 리포 안으로 옮긴 것; verify.py는 둘째 줄의 절대 경로를 인자로 바꾼 것 말고 그대로)(독립 검증, §13 6 — 판정 확인, 모순 둘: 182 → 91 정정 · `rest-section/a-rest.log` 강제 추가, 둘 다 11/4 반영).
