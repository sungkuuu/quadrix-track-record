/**
 * Dated parameters in a rulebook.
 *
 * A rulebook's `ranking` block may carry
 *
 *   "scheduled": [ { "effectiveFrom": "YYYY-MM-DD", "decision": "<id>",
 *                    "targetCount": 15, "rankBuffer": { "entryMaxRank": 12, "exitMinRank": 19 } } ]
 *
 * — an anchored decision that changes a ranking parameter from a date on,
 * written down before that date so the keeper needs no edit on the day.
 * rankingFor(rulebook, dateStr) returns the `ranking` block as it stands on
 * dateStr: the base values with every scheduled entry whose effectiveFrom is
 * on or before that date merged in, earliest first. Entries dated later are
 * ignored, so a run before the date is byte-for-byte the old rule. Only the
 * ranking block is date-resolved; nothing else in the rulebook is.
 *
 * The keeper reconstitutes on the first run after a quarter boundary, so a
 * change dated on a quarter's first day takes effect at that reconstitution
 * and daily marks before it are untouched (they read no ranking parameter).
 */
export function rankingFor(rulebook, dateStr) {
  const base = rulebook.ranking;
  const out = { ...base, rankBuffer: { ...(base.rankBuffer ?? {}) } };
  delete out.scheduled;
  const due = (base.scheduled ?? [])
    .filter((e) => typeof e.effectiveFrom === 'string' && e.effectiveFrom <= dateStr)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (const e of due) {
    const { effectiveFrom, decision, note, rankBuffer, ...params } = e;
    Object.assign(out, params);
    if (rankBuffer) Object.assign(out.rankBuffer, rankBuffer);
    out.appliedSchedule = { effectiveFrom, decision: decision ?? null };
  }
  return out;
}
