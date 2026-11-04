# qVOL prereg inputs — gaps in the patched daily 1-minute files

Source: `/tmp/qvol-daily/run1` (= run2, byte-identical), built by `convert-daily-1m.mjs` from `loadPair('BTCUSDT', { patch: true })`. Lists made by `gaps-daily-1m.mjs` (run on run1 and run2: identical output).

- `accepted-gaps.json`: 35 days with fewer than 1,440 rows, sha256 `eb3c0ffc030883dcd8d908fa780477a30e67b2151899e1ee1bb0d572c585327a`. Each entry: day, rows, missingMinutes (UTC HH:MM ranges), sha256 of the §2-2 canonical text, firstBar, latestBar.
- **Gap days: 35. Missing minutes on those days: 8,872** (= 1,440 × 35 − rows).
  - Of these, 240 minutes are 2017-08-17 00:00–03:59, before the first bar of the data (2017-08-17T04:00); not a gap run in `index-1m.json`.
  - Excluding them: 8,632 missing minutes in 35 runs inside the data range (counted on the dense array: `patch:false` → 34 runs · 8,562 min, equal to `index-1m.json`; `patch:true` → 35 runs · 8,632 min = 8,562 + 71 `archive_only` − 1 `api_only` (2017-09-06T16:00)).
- Days with 0 rows: none. Days with more than 1,440 rows: none.

## Patch-made gaps (registration-draft §4)

| patch gap | present in patched files | how it appears |
|---|---|---|
| 2017-12-04 06:01–06:48 (48) | yes | 2017-12-04: 1,392 rows, missing `06:01-06:48` only (a new gap day; not in the 34-run list) |
| 2018-02-09 09:59 (1) | yes | joins the archive run 2018-02-08T00:29–2018-02-09T09:58 (2,010 min); 2018-02-09 missing `00:00-09:59`, 840 rows |
| 2020-12-21 13:48–14:09 (22) | yes | joins the archive run 2020-12-21T14:10–17:59 (230 min); 2020-12-21 missing `13:48-17:59` (252 min), 1,188 rows |

Also from the patch: 2017-09-06T16:00 (`api_only`) now has a bar, so 2017-09-06 is missing `16:01-22:59` (419 min) instead of 16:00–22:59.

Fact noted: the 34-run list in `index-1m.json` records the run 2018-02-08T00:29–2018-02-09T09:58 under `first_missing` 2018-02-08; that run also covers 2018-02-09 00:00–09:58 in the unpatched data.

## Gap days — rows, first and latest bar (RV12 check)

| day | rows | missing (UTC) | first bar | latest bar |
|---|---:|---|---|---|
| 2017-08-17 | 1,200 | 00:00-03:59 | 04:00 | 23:59 |
| 2017-09-06 | 1,021 | 16:01-22:59 | 00:00 | 23:59 |
| 2017-12-04 | 1,392 | 06:01-06:48 | 00:00 | 23:59 |
| 2017-12-18 | 1,363 | 10:01-10:13 12:30-13:33 | 00:00 | 23:59 |
| 2018-01-04 | 1,315 | 03:01-05:05 | 00:00 | 23:59 |
| 2018-02-08 | 29 | 00:29-23:59 | 00:00 | 00:28 |
| 2018-02-09 | 840 | 00:00-09:59 | 10:00 | 23:59 |
| 2018-02-10 | 1,425 | 06:00-06:14 | 00:00 | 23:59 |
| 2018-02-11 | 1,406 | 04:01-04:34 | 00:00 | 23:59 |
| 2018-06-26 | 840 | 02:00-11:59 | 00:00 | 23:59 |
| 2018-06-27 | 1,335 | 13:00-14:44 | 00:00 | 23:59 |
| 2018-07-04 | 983 | 00:23-07:59 | 00:00 | 23:59 |
| 2018-10-19 | 1,230 | 06:00-09:29 | 00:00 | 23:59 |
| 2018-11-14 | 1,020 | 02:00-08:59 | 00:00 | 23:59 |
| 2019-03-12 | 1,080 | 02:00-07:59 | 00:00 | 23:59 |
| 2019-05-15 | 840 | 03:00-12:59 | 00:00 | 23:59 |
| 2019-06-07 | 1,379 | 21:14-22:14 | 00:00 | 23:59 |
| 2019-08-15 | 960 | 02:00-09:59 | 00:00 | 23:59 |
| 2019-11-13 | 1,297 | 02:00-04:19 05:30-05:32 | 00:00 | 23:59 |
| 2019-11-25 | 1,320 | 02:00-03:59 | 00:00 | 23:59 |
| 2020-02-09 | 1,380 | 02:00-02:59 | 00:00 | 23:59 |
| 2020-02-19 | 1,086 | 11:36-17:29 | 00:00 | 23:59 |
| 2020-03-04 | 1,312 | 09:22-11:29 | 00:00 | 23:59 |
| 2020-04-25 | 1,290 | 02:00-04:29 | 00:00 | 23:59 |
| 2020-06-28 | 1,230 | 02:00-05:29 | 00:00 | 23:59 |
| 2020-11-30 | 1,380 | 06:00-06:59 | 00:00 | 23:59 |
| 2020-12-21 | 1,188 | 13:48-17:59 | 00:00 | 23:59 |
| 2020-12-25 | 1,380 | 02:00-02:59 | 00:00 | 23:59 |
| 2021-02-11 | 1,361 | 03:41-04:59 | 00:00 | 23:59 |
| 2021-03-06 | 1,350 | 02:00-03:29 | 00:00 | 23:59 |
| 2021-04-20 | 1,290 | 02:00-04:29 | 00:00 | 23:59 |
| 2021-04-25 | 1,156 | 04:01-08:44 | 00:00 | 23:59 |
| 2021-08-13 | 1,170 | 02:00-06:29 | 00:00 | 23:59 |
| 2021-09-29 | 1,320 | 07:00-08:59 | 00:00 | 23:59 |
| 2023-03-24 | 1,360 | 12:40-13:59 | 00:00 | 23:59 |

**Gaps touching 23:59** (latest bar of the day is not 23:59): 2018-02-08 (latest bar 00:28).
**Gaps touching 00:00** (first bar of the day is not 00:00): 2017-08-17 (first bar 04:00), 2018-02-09 (first bar 10:00).
All other 32 gap days have bars at both 00:00 and 23:59.
