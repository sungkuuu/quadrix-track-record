/**
 * The working-capital sleeve of the sleeve indexes (Barbell, Triens).
 *
 * The RULE (barbell.md §1, triens.md §1, owner 2026-09-21): the sleeve holds
 * fiat-backed, fully-reserved stablecoins whose issuer publishes an
 * attestation; interest-bearing forms are allowed. The list of names is an
 * anchored decision and does not exist yet, because there is no fiat-backed
 * stablecoin canonical on GIWA to put on it.
 *
 * The PAPER RECORD therefore cannot hold the sleeve's real assets. It holds a
 * PROXY instead, and says so on every record line (`wcProxy: "DTB3"`): a
 * synthetic $1 unit that accrues the 3-month Treasury bill rate daily,
 *
 *     unitValue *= (1 + r_d/100) ** (1/365)   for each day d
 *
 * where r_d is FRED's DTB3 print for that day, or the last print before it on
 * days FRED does not publish (weekends, holidays, and the two-to-three-day
 * publication lag). This is the same assumption the backtests ran on
 * (docs/research/barbell/barbell_common.py `cash_step`, mode 'tbill'), which
 * is why it is the proxy and not a zero-yield dollar: an interest-bearing
 * fully-reserved stablecoin is a claim on short Treasuries, so the T-bill rate
 * is the honest stand-in for its yield, gross of whatever the issuer keeps.
 *
 * What the proxy is NOT: it carries no issuer, no redemption, no depeg and no
 * spread to the bill. The real sleeve will differ by the issuer's cut and by
 * every risk a T-bill does not have. The record states the proxy so the
 * difference stays visible instead of being absorbed into the level.
 *
 * Source: FRED DTB3 (3-Month Treasury Bill, Secondary Market Rate, Discount
 * Basis, daily, percent per annum), https://fred.stlouisfed.org/series/DTB3
 * fetched as CSV. No fallback source: if the fetch fails and no cached copy
 * exists, the run fails rather than guessing a rate.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DTB3_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3';
export const WC_PROXY_ID = 'DTB3';

/** Parses FRED's two-column CSV into { 'YYYY-MM-DD': ratePercent }.
 *
 *  A date with no print carries an EMPTY value field, not a '.' — 800 of the
 *  18,970 rows in the 2026-09-21 download look like `2026-07-03,` (holidays
 *  and the odd missing business day). An empty field must be dropped, not
 *  read as a number: `Number('')` is 0 in JavaScript, and a 0 here is not a
 *  gap, it is a day the working-capital sleeve silently earns nothing. That
 *  bug was in the first version of this file and cost 0.04 percentage points
 *  over one quarter's accrual before the output was checked against an
 *  independent computation of the same series. */
export function parseDTB3(csv) {
  const out = {};
  const lines = csv.trim().split('\n');
  for (const line of lines.slice(1)) {
    const [d, v] = line.split(',');
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) continue;
    if (v == null || v.trim() === '' || v.trim() === '.') continue; // no print that day
    const r = Number(v);
    if (!Number.isFinite(r)) continue;
    out[d.trim()] = r;
  }
  return out;
}

/**
 * The series, from `${cacheDir}/fred-dtb3-${dateKey}.json` when that file is
 * fresher than ttlMs, else re-fetched. A stale cached copy is used (with a
 * warning) when the fetch fails — a missing recent print only means the last
 * one is carried forward one more day, which is what the rule does anyway.
 */
export async function loadDTB3({ cacheDir, dateKey, ttlMs = 24 * 60 * 60 * 1000 }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const fresh = path.join(cacheDir, `fred-dtb3-${dateKey}.json`);
  if (fs.existsSync(fresh) && Date.now() - fs.statSync(fresh).mtimeMs <= ttlMs) {
    return { series: JSON.parse(fs.readFileSync(fresh, 'utf8')), source: 'fred-dtb3 (cached)' };
  }
  try {
    const r = await fetch(DTB3_CSV_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const series = parseDTB3(await r.text());
    if (!Object.keys(series).length) throw new Error('empty DTB3 series');
    fs.writeFileSync(fresh, JSON.stringify(series));
    return { series, source: 'fred-dtb3' };
  } catch (e) {
    const stale = fs
      .readdirSync(cacheDir)
      .filter((f) => f.startsWith('fred-dtb3-'))
      .sort();
    if (stale.length) {
      const p = path.join(cacheDir, stale[stale.length - 1]);
      console.warn(`  FRED DTB3 fetch failed (${e.message}) — using the cached copy ${stale[stale.length - 1]}`);
      return { series: JSON.parse(fs.readFileSync(p, 'utf8')), source: `fred-dtb3 (stale cache ${stale[stale.length - 1]})` };
    }
    throw new Error(`FRED DTB3 unavailable and nothing cached: ${e.message}`);
  }
}

/** The last DTB3 print on or before `dateStr` (percent p.a.), or null if the
 *  series starts after it. Weekends, holidays and the publication lag all
 *  resolve here — the rule is "carry the last published rate forward". */
export function rateOn(series, dateStr, maxLookbackDays = 30) {
  let d = Date.parse(dateStr + 'T00:00:00Z');
  for (let i = 0; i <= maxLookbackDays; i++) {
    const key = new Date(d).toISOString().slice(0, 10);
    if (key in series) return { rate: series[key], asOf: key };
    d -= 86_400_000;
  }
  return { rate: null, asOf: null };
}

/**
 * The growth factor of one synthetic working-capital unit over (fromDate,
 * toDate] — one compounding step per calendar day, each at that day's carried
 * rate. Returns 1 when the dates are equal (a same-day re-run accrues nothing,
 * so re-running the keeper twice in a day cannot pay interest twice).
 */
export function accrue(series, fromDate, toDate) {
  let factor = 1;
  const days = [];
  let t = Date.parse(fromDate + 'T00:00:00Z') + 86_400_000;
  const end = Date.parse(toDate + 'T00:00:00Z');
  if (end < t - 86_400_000) throw new Error(`working capital: accrual runs backwards (${fromDate} -> ${toDate})`);
  let guard = 0;
  while (t <= end) {
    if (++guard > 4000) throw new Error('working capital: accrual window absurdly long — refusing to compound');
    const day = new Date(t).toISOString().slice(0, 10);
    const { rate, asOf } = rateOn(series, day);
    if (rate == null) throw new Error(`working capital: no DTB3 print on or before ${day}`);
    factor *= (1 + rate / 100) ** (1 / 365);
    days.push({ day, rate, rateAsOf: asOf });
    t += 86_400_000;
  }
  return { factor, days };
}
