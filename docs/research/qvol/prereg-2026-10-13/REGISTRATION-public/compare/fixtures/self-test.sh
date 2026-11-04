#!/usr/bin/env bash
# Self-test for compare.mjs on synthetic fixtures. Exit 0 when every expectation holds.
# Rebuild fixtures with: node gen-fixtures.mjs (output is deterministic).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CMP="$HERE/../compare.mjs"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/qvol-compare-selftest.XXXXXX")"
fail=0
pick() { if [ -f "$HERE/$1/$2" ]; then echo "$HERE/$1/$2"; else echo "$HERE/base/$2"; fi; }
check() { # case expected-exit expected-verdict
  local c="$1" want_exit="$2" want="$3" out="$TMP/$1"
  node "$CMP" --a-file "$(pick "$c" a-file.jsonl)" --a-rest "$(pick "$c" a-rest.jsonl)" --a2 "$(pick "$c" a2-file.jsonl)" \
    --b-file "$(pick "$c" b-file.jsonl)" --b-rest "$(pick "$c" b-rest.jsonl)" \
    --snapshot "$HERE/common/snapshot" --close15 "$HERE/common/btcusdt-15m.csv" --out "$out" \
    --file-range 2020-03-01:2020-03-10 --rest-range 2020-03-05:2020-03-14 \
    --pre-file 2020-03-08:2020-03-10 --pre-rest 2020-03-05:2020-03-06 >"$TMP/$c.log" 2>&1
  local got_exit=$?
  local got="exit=$got_exit"
  if [ -f "$out/verdict.json" ]; then
    got="$got $(node -e 'const v=require(process.argv[1]);console.log(v.tests.map(t=>t.id+"="+(t.pass?"pass":"FAIL")).join(" "))' "$out/verdict.json")"
  fi
  [ -f "$out/DONE" ] && got="$got DONE"; [ -f "$out/FAILED" ] && got="$got FAILED"
  local expect="exit=$want_exit${want:+ $want}"
  if [ "$got" = "$expect" ]; then echo "ok   $c: $got"; else echo "FAIL $c: got [$got] want [$expect]"; cat "$TMP/$c.log"; fail=1; fi
}
check base            0 "V1=pass V2=pass V3=pass V4=pass DONE"
check v1-value        1 "V1=FAIL V2=pass V3=pass V4=pass DONE"
check v2-hash         1 "V1=pass V2=FAIL V3=pass V4=pass DONE"
check v3-close        1 "V1=pass V2=pass V3=FAIL V4=pass DONE"
check v3-rest-vs-file 1 "V1=pass V2=pass V3=FAIL V4=pass DONE"
check v4-a2           1 "V1=pass V2=pass V3=pass V4=FAIL DONE"
check bad-dup         2 "FAILED"
# base: the first-line carriedFrom rule must have been exercised (2020-03-05 is first only in the REST run)
grep -q '^A,2020-03-05,false,true,first two cells,' "$TMP/base/rest-vs-file.csv" && echo "ok   base: carriedFrom first-two-cells row present" \
  || { echo "FAIL base: carriedFrom rule row missing"; fail=1; }
# base: the MANIFEST must verify
(cd "$TMP/base" && shasum -a 256 -c MANIFEST.sha256 >/dev/null) && echo "ok   base: MANIFEST.sha256 verifies" || { echo "FAIL base: MANIFEST"; fail=1; }
rm -rf "$TMP"
[ $fail -eq 0 ] && echo "self-test: all expectations hold" || echo "self-test: FAILED"
exit $fail
