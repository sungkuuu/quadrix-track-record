/**
 * Which send errors are a nonce race, and the bounded resend loop around them.
 *
 * The keeper key is shared by the crons, the desk and other signers outside
 * this repository's `keeper-key` concurrency group, so another sender can
 * take the nonce a send was signed with. Two node answers mean that:
 *
 *   - any text with "nonce" ("nonce too low", "nonce too high", viem's
 *     NonceTooLowError text) — the condition every sender used before;
 *   - "replacement transaction underpriced": the nonce is already held in the
 *     pool by another transaction at the same fee (2026-11-13: a nonce read
 *     one behind the keeper's own last send; 2026-11-16: four nonces taken by
 *     other sends from the same key). viem wraps it as "Missing or invalid
 *     parameters." with "Details: replacement transaction underpriced", so a
 *     test on "nonce" alone missed it and the step failed on the first try.
 *
 * Both are rejections by the node: the transaction did not enter the pool.
 * A resend is a new call of `fn`, and viem (no nonceManager, no explicit
 * nonce) reads the pending nonce again for it, so the resend goes out under
 * the next free nonce.
 *
 * One answer is not a rejection: "already known" (and "transaction already
 * imported") means these exact bytes are already in the pool — e.g. viem's
 * transport resent a raw transaction after an HTTP error — so the call may
 * have landed. viem reports it as NonceTooLowError ("Nonce provided for the
 * transaction is lower than ..."), so the "nonce" test matched it before
 * this module and still does; a resend can then land the call twice. Every
 * call the paper-index run resends (setNav and setRefPrice to the same value,
 * an anchor self-send with the same calldata) is harmless twice.
 */

export const NONCE_RACE = /nonce|replacement transaction underpriced/i;

/** True when `e` is a send error that a resend under a fresh nonce fixes. */
export function isNonceRace(e) {
  return NONCE_RACE.test(String(e?.message ?? e));
}

/** First wait before a resend; the n-th resend waits n times this. */
export const RESEND_WAIT_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls `fn` (one signed send) up to `tries` times. A nonce race waits
 * RESEND_WAIT_MS × attempt and calls `fn` again; anything else is rethrown at
 * once. After `tries` nonce races the last error is thrown. `wait` is for
 * tests.
 */
export async function sendNonceSafe(fn, { tries = 5, wait = sleep } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isNonceRace(e)) throw e;
      if (i + 1 < tries) await wait(RESEND_WAIT_MS * (i + 1));
    }
  }
  throw last;
}
