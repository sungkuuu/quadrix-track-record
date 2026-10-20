# R47 red-team run — the mark-vault deployment tool (qETH1.5X)

Run date 2026-10-20. Target: the public record repository at commit `05678825c6d04cd3c5a29fe167f290ca9ef9ca95` — `keeper/deploy-mark-vault.mjs` (the deployment, guardian, open-deposits and pause actions), its tests, `keeper/leverage-vaults.json`, `.github/workflows/mark-vault-setup.yml`, and the mark path of `keeper/leverage-index.mjs` (markVault and the registry checks before it). The vault contract itself is out of scope here (R44–R46 of the redeployment decision): only the ways the tool could use it wrongly.

Method (R47): a finding counts only when a test in a clean checkout reproduces it with the code's own test runner; every break meets two sceptics' objections; every block gets a voidness check (the same input with the attack removed passes, and for two blocks a mutant copy of the tool with the checked line removed lets the attack through). A block is not a proof of absence. Everything ran offline against a fake JSON-RPC node; no transaction was sent to any chain.

Baseline: the existing tests pass, 20/20 (`keeper/test/deploy-mark-vault.test.mjs` 12, `keeper/test/deploy-mocks-readback.test.mjs` 8).

## Count

- Hypotheses: 11 (registry/argument mismatch · guardian-rule bypass by input form · a write without `--live --confirm EXECUTE` · artifact substitution · cap units · re-run and partial failure · registry rewrite side effects · RPC answers that lie · the mark path under a swapped registry · the window between a send and its log line · the local-RPC classification).
- Test cases: 17 (about 55 input variants) in three files.
- Reproduced breaks: 5, of which 2 stand after the sceptics and 3 are rebutted (kept as hardening).
- Blocks: 9, each with a voidness check.

## Breaks that stand

1. **Owner actions do not check which vault the registry line names.** `open-deposits` and `pause` read the address from `keeper/leverage-vaults.json` and act on it after reading only `owner()`; `set-guardian` on the same line checks the code and the `symbol()` and refuses. With the `qeth15` line pointing at the qBTC2X vault — the shape a hand-written address takes after a partial run — `setDepositCap` and `setDepositsPaused(true)` are simulated, sent and read back on the qBTC2X vault, and the log records them under `qeth15`. Fix proposed: run the same code-and-symbol check before every owner action.
2. **A send whose response is lost leaves no line on disk, and the re-run guard then deploys a second vault.** The "sent" line is appended after the transaction hash comes back. If the node accepts the transaction and the HTTP response is lost (the transport does not retry a send: one lost response is one accepted, unlogged transaction), the run exits 1 with nothing written, and the next run — which checks only the log and the registry, not the chain's nonce — says "would deploy" and deploys again. Fix proposed: sign first, log the hash and nonce as an intent, then broadcast; treat an intent without a later sent/mined/abandoned line as unresolved. Until then: after any failed live run, a person reads the keeper's transaction count and the explorer before re-running, and a workflow re-run is not used.

## Breaks reproduced but rebutted (hardening only)

3. A crafted artifact file (`metadataBytes` set to the whole runtime length, `immutableReferences` emptied) makes the code-shape comparison with the reference vault compare two empty strings and pass. Rebutted: whoever can commit a crafted artifact can edit the tool; the comparison guards against an honest stale build, and that case is refused (tested). Hardening: take the metadata length from the chain's own code and bound it; run the artifact test in CI (no CI job runs the keeper tests today).
4. The local-RPC test is a prefix match: `http://127.0.0.1:9@<host>` is classified as a local fork, and the HTTP client turns the userinfo into Basic auth and talks to `<host>`. Rebutted: the arguments are the operator's own, the fork path never reads the keeper key, and the workflow has no RPC input. Hardening: classify by the parsed hostname and refuse userinfo.
5. The mark path accepts any vault whose `symbol()` and `keeper()` match; anyone can deploy such a contract with the keeper's address as manager, and a swapped registry line would have the keeper mark it. Rebutted: the swap needs a commit to main, which could change the mark leg itself. Hardening: have the leg check that the registry's `deployTx` is the keeper's creation transaction of that address.

## Blocks (voidness-checked)

- Guardian rule: a leading space, a missing `0x`, a broken checksum, 41 bytes, the manager in any case, the zero address — all refused before anything is sent.
- The live switch: `execute`, `EXECUTE ` (trailing space), ` EXECUTE`, `--confirm=EXECUTE`, `--confirm` alone, `--live=true`, `--LIVE` — none sends; the exact form sends; a copy of the tool with the confirm line removed sends on `--live` alone.
- An artifact of an older build (no `setGuardian` in the ABI, honest metadata) is refused by the reference-vault comparison; a copy of the tool with that comparison removed lets it through to the simulation.
- Cap: every non-integer form (`1e12`, `-1`, `1.5`, `0x10`, `1_000`, full-width digits, whitespace, empty) is refused; a value past uint256 fails before any send. Observation: an integer passes with no bound and the log does not say what it means in mUSD.
- Re-run after a partial failure: a vault already named, a sent-but-unregistered deployment, and a deployment whose `setGuardian` reverted all block a second deployment (existing tests).
- The registry rewrite keeps every other entry, the `_doc` and the key order.
- A receipt naming an address with no code: the read-back times out (30 s), exit 1, the registry is not written; writing that address by hand is stopped at the next action. Read-back values that differ: reported, exit 1, no `setGuardian` sent.
- Mark path: a gate of `{halt, pct 0}`, negative, non-numeric, or an unknown mode is refused after the anchor and before any mark; a vault with the right symbol but another keeper, or another symbol with the right keeper, is refused before any mark.

Known limit: the RPC is the single root of trust for every read; an RPC that lies consistently is believed. The CREATE address could be computed from the sender and nonce and compared with the receipt.

## Verdict

**R47 run — fail**: two reproduced breaks (1, 2) are open; the run passes once each has an action and a date. The three rebutted items are hardening work.

## Reproduce

```
node --test keeper/test/deploy-mark-vault.test.mjs keeper/test/deploy-mocks-readback.test.mjs   # baseline 20/20
node --test keeper/test/redteam-r47-deploy-mark-vault.test.mjs      # 9/9  (breaks 1, 2, 4; blocks)
node --test keeper/test/redteam-r47-artifact-readback.test.mjs      # 6/6  (break 3; read-back blocks; two mutant checks) — about 70 s
node --test keeper/test/redteam-r47-mark-path.test.mjs              # 2/2  (break 5; gate and registry blocks)
```

The "BREAK" tests assert today's weak behaviour so that the run is green and the record exact; a fix turns each into a regression test by inverting its assertion.

## Fixes (2026-10-20, same day)

Both standing breaks are fixed in `keeper/deploy-mark-vault.mjs` at commit `570431fef6f67999f6c78327e89bc59caf4930e2` (branch `keeper/r47-fix-2026-10-20`; the fixed file's sha256 is `94263084aff6afad3c89e2382a3f7bd893d1076499e66fc594cf9b1682db87fb`):

1. One check, `registryVault()`, now runs before every owner action (`set-guardian`, `open-deposits`, `pause`): the registry address must run the artifact's code, answer `symbol()` = the index's ticker and, on a live run, have the signer as its keeper. A line naming another vault sends nothing (REFUSED, exit 2).
2. Every transaction is signed first and logged with its hash and nonce (`signed`) before it is broadcast (`sendRawTransaction`; the node's echoed hash must equal the computed one), then logged `sent` and `mined`. Before anything new is sent, every transaction of the index that the log shows signed or sent with no outcome is looked up on the chain by its hash: found, its receipt is recorded and the run goes on (a mined deployment continues to its read-back and the registry, never deploying again); not found, the run is refused and nothing is sent until a person has looked at that hash and nonce. On a local fork an impersonated account, which the node cannot sign for, falls back to `eth_sendTransaction` and is logged `sent`; on any other RPC that condition is refused.

The two BREAK tests became regression tests (`deploy-mark-vault-registry-and-send.test.mjs`); the test files were renamed to describe what they test. All keeper tests pass: 255 across 31 files, each file run alone. On an anvil fork of GIWA Sepolia (block 39124137) a harness with a reference vault deployed from the same artifact ran stage 1 of the keeper's rehearsal through the fixed send path: three deployments and three guardians, about 4 s in total; a keyed account passed the signed → sent → mined path. The unmodified rehearsal needs a fork taken after the 2026-10-21 redeployment, as its header says, and the tool's own dry run against GIWA is to be made before the deployment. Items 3–5 (rebutted) stay as hardening work.

**Verdict after the fixes: R47 run — pass** (two breaks, each with an action taken the same day and a regression test; three rebutted items listed).
