# qVOL prereg inputs — converter run report (2026-11-02)

Role: third-party converter (registration-draft.md §4-1). Read: registration-draft §4 / §4-1 / §2-2 / §2-3; v6 `README-data.md` §2 · §5, `read-1m.mjs`, `data-1m/index-1m.json`; for S2 also v6 `README.md` (15m bullets), `build-check.csv`, the `--build` part of `leverage-params-v6.mjs`. Not read: keeper code, verify-vol.mjs, vol-index-2026-10-05/.

## Environment
- Cloud container, Linux; **node v22.23.4**. No network calls to any exchange.
- Input: `origin/research/leverage-params-v6` = `c9bd7a2b…` (see `INVOCATION.txt`), `read-1m.mjs` + `data-1m/` extracted with `git archive` to `/tmp/v6src`. `loadPair` checked every file sha256 against `index-1m.json` (it throws on mismatch); the 10 BTC year files and the patch matched (sha256s echoed in the run's stdout summary).
- Output: `/tmp/qvol-daily/run1`, `/tmp/qvol-daily/run2` (not committed; 3,331 files, 350,298,424 bytes each).

## Run times
| run | start (UTC) | wall time | exit |
|---|---|---:|---:|
| run1 | 2026-11-02T05:42:19Z | 8.9 s | 0 |
| run2 | 2026-11-02T05:42:27Z | 7.6 s | 0 |

Twice-check: byte-identical (`conversion-twice-check.txt`); `daily-manifest.sha256` sha256 `bd3a834f9191a8ddb67b67aca08651b27845a3cc40a3973a7da12d91f3c6b97a`.

## Rows per year (daily files) vs v6 year files (archive, before patch)
| year | days | rows (patched daily files) | rows (v6 archive file) | difference |
|---|---:|---:|---:|---:|
| 2017 | 137 | 196,496 | 196,543 | −47 (−48 archive_only 12-04, +1 api_only 09-06T16:00) |
| 2018 | 365 | 521,623 | 521,624 | −1 (archive_only 02-09T09:59) |
| 2019 | 365 | 523,836 | 523,836 | 0 |
| 2020 | 366 | 525,766 | 525,788 | −22 (archive_only 12-21 13:48–14:09) |
| 2021 | 365 | 524,607 | 524,607 | 0 |
| 2022 | 365 | 525,600 | 525,600 | 0 |
| 2023 | 365 | 525,520 | 525,520 | 0 |
| 2024 | 366 | 527,040 | 527,040 | 0 |
| 2025 | 365 | 525,600 | 525,600 | 0 |
| 2026 | 272 | 391,680 | 391,680 | 0 |
| **all** | **3,331** | **4,787,768** | 4,787,838 | −70 (= −71 + 1) |

4,787,768 = `index-1m.json` `api_patch.api_rows` (REST row count). Bars of the dense array outside 2017-08-17 .. 2026-09-29: 0.

## Other files
- `accepted-gaps.json` / `gaps-report.md`: 35 days < 1,440 rows, 8,872 missing minutes on those days (incl. 240 before the first bar on 2017-08-17); the three patch-made gaps present.
- `fifteen-min-source.md` / `fifteen-min-check.json`: the 15m file is the patched build (independent rebuild byte-identical; archive-only rebuild not); 30/30 sampled days (and 3,331/3,331) last 15m close = last 1m close.

## Things noted (facts, no judgment)
1. **File names differ from §4-1.** §4-1 writes `<dir>/BTCUSDT-1m-<YYYY-MM-DD>.csv` (upper case) and `b-input/MANIFEST.sha256`; this run used the names in the task brief: `btcusdt-1m-YYYY-MM-DD.csv` and `daily-manifest.sha256`. Contents per §4-1; only names differ.
2. **2017-08-17 is a partial day** (first bar 04:00, 1,200 rows) and so appears in `accepted-gaps.json` with missing `00:00-03:59`; those 240 minutes are before the data start, not a gap in `index-1m.json`.
3. **2018-02-09 is inside an archive gap run.** §4 says the 34-run list "has 2018-02-10 · 2020-12-21 and not 2017-12-04 · 2018-02-09"; the list's run `2018-02-08T00:29 – 2018-02-09T09:58` (2,010 min) is filed under 2018-02-08 but covers 2018-02-09 00:00–09:58. With the patch the run ends 09:59. So 2017-12-04 is the only gap day that the patch adds; 2018-02-08 (latest bar 00:28) and 2018-02-09 (first bar 10:00) are the only days whose gap touches 23:59 / 00:00 (apart from 2017-08-17's start).
4. Patched data: 35 gap runs · 8,632 minutes (unpatched 34 · 8,562 = index). Same 35 / 8,632 as v6 `build-check.csv` (patched).
5. No day with 0 rows; no day with more than 1,440 rows.
6. 2018-12-04T14:13 (the one 3-decimal BTC minute, README-data §2) converts to open `4000.15100000`, low `3998.03100000` — integer path exact.

## DONE

2026-11-02T05:45:40Z UTC. Branch `cloud/qvol-prereg-inputs-2026-11-02`, commits (oldest first): 799f042 · 721c484 · 0e1451b · 9f82d2d · 0c706d0 · this one.
