/**
 * Two-source reconciliation rules (owner 2026-09-29, decision draft
 * trackrecord/decisions/2026-09-29-source-reconciliation.md): where a rule reads
 * a quantity that CoinMarketCap and CoinGecko both publish, the keeper reads
 * both, takes the ONE that serves the rule's purpose — never an average — and
 * discloses the other when the two disagree.
 *
 *   listing age (Triens Quality sleeve, qAI): counted from the EARLIER of CMC
 *     `dateAdded` and the CoinGecko proxy (the earlier of ath_date and
 *     atl_date), i.e. the larger age; both dates disclosed when they are more
 *     than `disagreementDays` apart.
 *   issuance fallback (qREV, Triens; only where the on-chain registry cannot
 *     measure a name): the LARGER of the two circulating-supply increases over
 *     the trailing 365 days; both disclosed when they differ by more than
 *     `disagreementFraction` of the larger.
 *
 * Pure functions; keeper/source-reconciliation.test.mjs drives them.
 */

const DAY_MS = 86_400_000;

/** Days from a name's earlier ath/atl date to `dateStr` — the proxy every leg
 *  used before this rule (and qREV/qDEFI still use). */
export function proxyAgeDays(coin, dateStr) {
  const times = [coin?.athDate, coin?.atlDate].filter(Boolean).map((d) => Date.parse(d)).filter(Number.isFinite);
  if (!times.length) return null;
  return (Date.parse(dateStr + 'T00:00:00Z') - Math.min(...times)) / DAY_MS;
}

export function reconciledListingAge(coin, cmcRow, dateStr, disagreementDays = 90) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  const cmcDate =
    typeof cmcRow?.dateAdded === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cmcRow.dateAdded) ? cmcRow.dateAdded : null;
  const ageCmc = cmcDate ? (t - Date.parse(cmcDate + 'T00:00:00Z')) / DAY_MS : null;
  const ageProxy = proxyAgeDays(coin, dateStr);
  if (ageCmc == null && ageProxy == null) return { days: null, source: 'unavailable' };
  const useCmc = ageProxy == null || (ageCmc != null && ageCmc >= ageProxy);
  const out = useCmc ? { days: ageCmc, source: 'cmc-date-added' } : { days: ageProxy, source: 'ath-atl-proxy' };
  if (ageCmc != null && ageProxy != null && Math.abs(ageCmc - ageProxy) > disagreementDays) {
    const times = [coin.athDate, coin.atlDate].filter(Boolean).map((d) => Date.parse(d)).filter(Number.isFinite);
    out.listingDateCmc = cmcDate;
    out.listingDateGecko = new Date(Math.min(...times)).toISOString().slice(0, 10);
    out.listingDisagreement = true;
  }
  return out;
}

/**
 * @param {object} a
 * @param {{s0:number,s1:number}|null} a.gecko  CoinGecko supply a year ago / now (null = cannot measure)
 * @param {{s0:number,s1:number}|null} a.cmc    CoinMarketCap supply a year ago / now (null = cannot measure)
 * @param {number} a.price                      today's price (the same for both)
 * @param {boolean} a.censusIncomplete          appends "-census-incomplete" to the source label
 * @param {number} a.disagreementFraction       e.g. 0.05
 */
export function reconcileIssuance({ gecko, cmc, price, censusIncomplete = false, disagreementFraction = 0.05 }) {
  const suffix = censusIncomplete ? '-census-incomplete' : '';
  const g = gecko ? Math.max(0, gecko.s1 - gecko.s0) * price : null;
  const c = cmc ? Math.max(0, cmc.s1 - cmc.s0) * price : null;
  if (g == null && c == null) return { value: null, source: `unavailable${suffix}`, issuanceGecko: null, issuanceCmc: null, issuanceDisagreement: false };
  const useCmc = g == null || (c != null && c > g);
  const out = useCmc ? { value: c, source: `cmc${suffix}`, ...cmc } : { value: g, source: `coingecko${suffix}`, ...gecko };
  out.issuanceGecko = g;
  out.issuanceCmc = c;
  const hi = Math.max(g ?? 0, c ?? 0);
  out.issuanceDisagreement = g != null && c != null && hi > 0 && Math.abs(g - c) > disagreementFraction * hi;
  return out;
}
