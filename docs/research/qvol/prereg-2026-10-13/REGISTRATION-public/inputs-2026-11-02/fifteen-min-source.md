# qVOL prereg inputs — 15-minute file source (S2)

File: `docs/research/leverage/params-v6/btcusdt-15m.csv.gz` on `origin/research/leverage-params-v6` (.gz sha256 `86ff9e24…ed375`, = `DATA-MANIFEST.sha256` line 1; uncompressed sha256 `3d0fb4d35d061eb349aecc3aad653fdc27e93a7a71fc542f619207697bf345bd`). Only BTC and ETH 15m files exist in the folder (`btcusdt-15m.csv.gz`, `ethusdt-15m.csv.gz`); added in commit `bd0cae5` (2026-10-01).

## Finding: built from the patched 1m data, not from the archive only

What the v6 folder says:
- `leverage-params-v6.mjs --build [--source patched|archive]` builds the 15m bars; default `--source patched` → `loadPair(…, { patch: source === 'patched' })` (engine lines ~2954–2971).
- `build-check.csv`: `build_param,source,patched`; BTC 1m bars present / gaps / missing = 4,787,768 / 35 / 8,632 (the patched counts); 15m bars 319,195, uncompressed sha256 `3d0fb4d3…f345bd`.
- `README.md` (입력 파일 bullet): "`--build` 출처 `patched`"; 15m rule in the README 데이터 section (UTC slots :00/:15/:30/:45, bars that open in the slot, o first / h max / l min / c last, 3-decimal ticks, header `time_utc,open,high,low,close,n1m`).

Measured here (`fifteen-min-check.mjs`, output `fifteen-min-check.json`): the 15m text was rebuilt independently from `read-1m.mjs` with that rule —
- from `patch: true`: 319,195 bars, sha256 `3d0fb4d35d061eb349aecc3aad653fdc27e93a7a71fc542f619207697bf345bd` → **byte-identical to the committed file: True**.
- from `patch: false` (archive only): 319,198 bars, sha256 `71d145c7051056c4896ea1aa570c4f9dfda6f7b8f7d57860b1c66f34f9f06b77` → identical: False (3 more bars; line-by-line positional compare differs on 317,231 lines because of the shift).

## 30 random days — last 15m bar close vs last 1m bar close of that day

Days drawn from the 3,331 daily files with a seeded LCG (seed 20261102). 1m close is the daily file's 8-decimal string; 15m close is the 3-decimal string; equal = `close1m === close15m + "00000"`.

Result: **30/30 equal.** Same check on all days (information): 3,331/3,331 equal.

| day | last 1m bar | 1m close | last 15m bar | 15m close | equal |
|---|---|---|---|---|---|
| 2017-08-20 | 23:59 | 4086.29000000 | 23:45 | 4086.290 | yes |
| 2017-11-17 | 23:59 | 7699.19000000 | 23:45 | 7699.190 | yes |
| 2017-12-20 | 23:59 | 16488.98000000 | 23:45 | 16488.980 | yes |
| 2017-12-31 | 23:59 | 13716.36000000 | 23:45 | 13716.360 | yes |
| 2018-05-24 | 23:59 | 7575.01000000 | 23:45 | 7575.010 | yes |
| 2018-08-31 | 23:59 | 7011.21000000 | 23:45 | 7011.210 | yes |
| 2018-12-18 | 23:59 | 3652.98000000 | 23:45 | 3652.980 | yes |
| 2019-04-17 | 23:59 | 5202.82000000 | 23:45 | 5202.820 | yes |
| 2019-05-28 | 23:59 | 8715.64000000 | 23:45 | 8715.640 | yes |
| 2019-07-09 | 23:59 | 12543.41000000 | 23:45 | 12543.410 | yes |
| 2019-11-13 | 23:59 | 8777.12000000 | 23:45 | 8777.120 | yes |
| 2020-02-06 | 23:59 | 9772.00000000 | 23:45 | 9772.000 | yes |
| 2020-02-26 | 23:59 | 8785.25000000 | 23:45 | 8785.250 | yes |
| 2020-05-02 | 23:59 | 8972.05000000 | 23:45 | 8972.050 | yes |
| 2020-08-12 | 23:59 | 11564.33000000 | 23:45 | 11564.330 | yes |
| 2020-10-12 | 23:59 | 11528.25000000 | 23:45 | 11528.250 | yes |
| 2020-12-16 | 23:59 | 21335.52000000 | 23:45 | 21335.520 | yes |
| 2021-03-03 | 23:59 | 50349.37000000 | 23:45 | 50349.370 | yes |
| 2021-03-23 | 23:59 | 54340.89000000 | 23:45 | 54340.890 | yes |
| 2021-04-06 | 23:59 | 57991.15000000 | 23:45 | 57991.150 | yes |
| 2021-05-08 | 23:59 | 58862.05000000 | 23:45 | 58862.050 | yes |
| 2021-06-25 | 23:59 | 31584.45000000 | 23:45 | 31584.450 | yes |
| 2022-01-19 | 23:59 | 41660.01000000 | 23:45 | 41660.010 | yes |
| 2022-02-11 | 23:59 | 42373.73000000 | 23:45 | 42373.730 | yes |
| 2023-01-20 | 23:59 | 22667.21000000 | 23:45 | 22667.210 | yes |
| 2023-06-12 | 23:59 | 25905.19000000 | 23:45 | 25905.190 | yes |
| 2023-10-27 | 23:59 | 33892.02000000 | 23:45 | 33892.020 | yes |
| 2025-03-15 | 23:59 | 84338.44000000 | 23:45 | 84338.440 | yes |
| 2026-01-19 | 23:59 | 92631.00000000 | 23:45 | 92631.000 | yes |
| 2026-09-06 | 23:59 | 80341.83000000 | 23:45 | 80341.830 | yes |
