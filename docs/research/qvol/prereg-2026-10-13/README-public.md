# qVOL realized line — reproducibility test: registration and results (public copy)

Series id `qvol`. Written 2026-11-04. The test was registered before the main runs; the only earlier output inside the judged range is the 400 lines computed on 2026-10-06, which are judged and counted apart (registration §6-1 and §6-2; see Result). This folder holds the registration text, the files it fixes, the files added before the main run, and the results.

## What was tested
- The line: the 30-day realized volatility of Binance spot BTCUSDT, one value per UTC day. The daily close is the close of the last 1-minute bar of the UTC day. 30 log returns from 31 closes, zero mean, 365-day year, value not rounded (registration §2).
- The question (§1, §6): do two independent implementations give the same line from the same inputs? Four checks, and all four must pass:
  - V1: value and variance agree on every line, relative difference at most 1e-9.
  - V2: the input hashes agree on every day; REST-range days also match the registered exchange snapshot.
  - V3: each day's close from the 1-minute bars equals the close in the exchange daily candle and, in the file range, the close in the 15-minute file; the REST-range and file-range lines agree on the 29 days both cover.
  - V4: the same input run twice, in two environments, gives identical bytes in the compared fields.
- The test chooses no parameter. It shows that the number can be reproduced. It does not show that the number is useful (registration §11).

## Registration and what was fixed before the main run
- Registration commit `0649c4b495fa3729587c581d82489ee8ef9f6ca0`, 2026-11-03T07:45:42Z, edition 1 (site repository, private). Registration text: `REGISTRATION-public/registration.md`, byte for byte, sha256 `891497d5d3e96b367d5f1b2a8937ac22ba3495fa9cdd6b9c9d7aa1cf444e5c92`. Lines 5-6 of that text still say "draft, not fixed" and that the commit holding the text is not the registration commit. They are the text as registered on 2026-11-03 (commit `0649c4b4`), written before that commit; the commit, not the wording of the head, is what fixes the file.
- Fix commit `0af158e485ccec21bd4e7b0cdfbc99da0b734e51`, 2026-11-03T08:01:12Z, before any main run: the comparison script (`compare/`, V1-V4 as written, 7-case self-test), implementation B (`impl-b/`), the accepted-gap list in implementation A's file shape, and `fix-2026-11-03.md` (how the points the registration left open were read). The registration text was not changed.
- Implementation A: the keeper module, commit `b8769aa5542313e6e7688266dfff0412a117bc3b`, branch `keeper/qvol-2026-11-02` of this repository. Implementation B: Python standard library, written from §2, §4-1 and §5 of the registration only.
- Inputs: `REGISTRATION-public/inputs-2026-11-02/` and `snapshot/` hold the conversion and download scripts, the accepted-gap lists and the sha256 lists of the data (not the data).

## Result
- Applying the decision rule (§6-4), the line is reproduced. `results-public/DONE`: `2026-11-04T02:46:58.959Z V1=pass V2=pass V3=pass V4=pass`. `results-public/verdict.json` sha256 `849905b829435af3c08ff0ce733dc4ae2586da40d01fde0f3afcc03a33d792f8`.
- Judgement run (the second): node v22.23.1, the version the registration fixes. Implementation A over the file range ran in two separate containers (`file-section/a-run4`, `a-run5`), over the REST range on macOS; B ran in Python. Both judgement runs used the same registration commit.
- The first judgement run (2026-11-03, node v22.23.4, both A runs in one container) has the same result and is kept in `results-public/verdict-1-node-v22.23.4/`. The second was run to meet the registration's wording on the node version and on different environments. `d09-independent-verification.md` calls the two judgement runs `1판` and `2판`: they are run 1 and run 2 of edition 1 of the registration (see the `판 번호` line of `results-public/RUN.md`).
- V1: 3,362 lines compared (file range 3,299 lines, 2017-09-18 to 2026-09-29; REST range 63 lines, 2026-09-01 to 2026-11-02), 0 mismatches. Largest relative difference: 3.7137324887372116e-16 in value, 3.802507002870737e-16 in variance.
- V2: 3,422 days of input hashes, A against B, 0 mismatches; 93 REST-range days against the registered snapshot, 0 mismatches.
- V3: 6,658 closes against the 15-minute file, 6,844 against the exchange daily candles, 58 overlap lines; 0 mismatches. V4: 2 runs, 3,299 lines, 0 mismatches.
- The 400 lines computed on 2026-10-06, before registration, lie inside the judged range and are counted apart (393 file range, 36 REST range, 29 days in both): 0 V1 mismatches.

## Platform note (outside the verdict)
- Value and variance are bit-identical across five Linux runs of A (node v22.23.4 three times, v22.23.1 twice): 13,196 line comparisons, 0 mismatches (`results-public/supplement-cross-build/`).
- Recomputing the variance check (C12, §6-3) on macOS with the same node v22.23.1 against the Linux records, 91 of 3,299 lines (2.8%) differ in the last bit of the variance, and 51 of them also in the value. The largest relative difference is 3.8e-16, far inside the 1e-9 limit. Hand calculation on three days showed `Math.log` differing by one unit in the last place between platform builds. Inside each of the two Linux containers (node v22.23.1) the check suite passed 12 of 12, C12 included, bit for bit (`results-public/file-section/a-run4/checks-a-run4.txt`, `results-public/file-section/a-run5/checks-a-run5.txt`).
- So bit-exact reproduction holds within one platform build; across platforms the check is the relative limit. Some run notes first said 182 lines; that double-counted a printed list and `d09-independent-verification.md` corrected it to 91. Source: `results-public/RUN.md` §3.

## Left out
- Raw market data: the 1-minute bars as daily files, the REST responses, the exchange daily-candle file. Reason: size. The 3,331 daily 1-minute files alone are 350,298,424 bytes (`REGISTRATION-public/inputs-2026-11-02/inputs-run-report.md`); the converter under `REGISTRATION-public/inputs-2026-11-02/` rebuilds them from a private research data branch. The day closes a reader needs are already in `results-public/realized-close-check.csv` and in the `window` field of every record line. Their sha256 lists are included, so anyone who downloads the same data can check it. The 15-minute file used by V3 (a) is not here either; its sha256 is in `results-public/verdict.json`.
- Internal working notes, the execution record, a command log, two git bundles and a Python bytecode cache. The two git bundles of implementation A are left out because their commit messages carry text this public copy excludes; the code itself is commit `b8769aa5542313e6e7688266dfff0412a117bc3b` on branch `keeper/qvol-2026-11-02` of this repository. `MANIFEST-notes.md` names each file and the reason.
- Ten large result files are gzip-compressed. `MANIFEST-notes.md` gives the sha256 of each original.

## Verify
- In this folder: `shasum -a 256 -c MANIFEST.sha256` (every line OK). `MANIFEST-notes.md` explains the manifests inside the folders.
