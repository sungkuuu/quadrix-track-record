# qVOL realized line — comparison script (registration 0649c4b4, §13 3-1)

`compare.mjs` — plain Node ≥ 18, no dependencies. Implements V1–V4 of §6-4 as written. It does not compute the line.

**Usage**
```
node compare.mjs --a-file A-file.jsonl --a-rest A-rest.jsonl --a2 A-file-run2.jsonl [--a2 …] \
  --b-file B-file.jsonl --b-rest B-rest.jsonl --snapshot ../snapshot/E-2026-11-02 \
  --close15 btcusdt-15m.csv.gz --out ../results
```
- Ranges (defaults = §6-2): `--file-range 2017-09-18:2026-09-29` · `--rest-range 2026-09-01:2026-11-02` (end = E) · counted-apart 10/6 lines `--pre-file 2025-09-02:2026-09-29` · `--pre-rest 2026-09-01:2026-10-06`. `--a`/`--b` are aliases of `--a-file`/`--b-file`. Lines outside a range are left out and counted in `verdict.json` `scope`.
- `--snapshot`: reads `canonical-1m.sha256` (V2 REST) and the one file in `daily-1d/` (V3 나). `--close15`: the 15m file (V3 가), `git show origin/research/leverage-params-v6:docs/research/leverage/params-v6/btcusdt-15m.csv.gz > btcusdt-15m.csv.gz` (.gz sha256 `86ff9e24…5ed375`; every input sha256 is written to `verdict.json` `inputs`).

**Outputs** (`--out`): `realized-ab.csv` (V1 + V2 per line: values, variances, rel diffs, source sha256 A/B/snapshot, first-line `sources` counts, A/B `hash` for information, `pre1006`, `gapInWindow`) · `realized-close-check.csv` (V3 가 · 나, one row per run × day × close) · `rest-vs-file.csv` (V3 다) · `determinism.txt` (V4) · `verdict.json` (V1–V4: pass, mismatches, evidence file, thresholds as written, V3 나 list of days with both values) · `MANIFEST.sha256` (the five files) · `DONE` or `FAILED`. `checks.txt` of §13 comes from the C checks, not from this script.

**Exit codes**: 0 = completed, V1–V4 all pass · 1 = completed, at least one fails (`DONE` written) · 2 = input or usage error (`FAILED` written with the reason, no verdict).

**Self-test**: `bash fixtures/self-test.sh` (synthetic records from `fixtures/gen-fixtures.mjs`; 7 cases: base all pass, V1 value ×(1+1e-8), V2 sha256, V3 swapped closes, V3 다 `returns`, V4 second run `lastBar`, duplicate date → exit 2).

## 애매한 곳 (literal reading implemented; decide before the A main run)
1. Discard window: §6-2 puts every line 2017-09-18 ~ 2026-09-29 in V1/V4; §6-5 · §13 3-1 exclude the *pre-registration smoke outputs*, not dates. So no date is dropped; main-run lines dated 2019-02-01 ~ 2019-03-31 are judged.
2. V3 다 does not name an implementation: both A (file run vs REST run) and B are checked; each mismatch counts.
3. V3 가 · 나: closes from both A's and B's `window`s. A `null` close is skipped and counted (`nullSkipped`), not a mismatch. Equality is numeric (`Number(ref) === Number(close)`), not text. A missing 15m/1d day for a non-null close is a mismatch.
4. V2 compares B's sha256 as B wrote it in its record; the script does not rehash daily files (that needs the §2 text), so there is no `--b-inputs`. A day in `source` (every line) or first-line `sources` with two different sha256 in one run is a mismatch. REST: A's sha256 vs `canonical-1m.sha256` column 3 (rows not judged); this assumes both hash the same canonical text.
5. 「JSON.stringify 바이트」 = stringify of the parsed value: two spellings of one number in the raw files are not told apart.
6. 「첫 줄」 = the first line of each run file.
7. `DONE`/`FAILED` = the comparison completed / could not complete. The other reading (FAILED = not reproduced) is not used; the verdict is in `verdict.json` and the exit code.
8. A date twice in one run is an input error (exit 2), not a counted mismatch.
9. V1: a date present on one side only is a mismatch; a date missing on both sides is not counted (coverage is a C check).
10. V4 「드라이런 2회 이상」 = run 1 (`--a-file`) + at least one `--a2`; fewer is a FAIL.
