/**
 * Special-situation trigger LOG for the paper indexes whose rulebook §9 defines
 * triggers — qREV (site repo docs/methodology/value-capture.md §9) and the
 * Quality sleeve of Triens (triens.md §9: "qREV §9 as is"). The definitions are
 * data in keeper/rulebooks/{index}.json `specialEvents.triggerLog`; a rulebook
 * without that block gets no evaluation and no record field (qDEFI and qAI:
 * their §9 is qX20 §9 — the rule follows the price, no death trigger; Barbell:
 * BTC has none).
 *
 * LOG ONLY. value-capture.md §9 (D17): "종이 지수 단계에서는 기록에 트리거 발동
 * 여부만 남긴다" — at the paper stage the record says whether a trigger fired
 * and nothing else happens. Nothing here changes membership, weights, units or
 * the level; the caller writes the returned object into the record line as
 * `specialSituation` and carries on.
 *
 *   A  protocol death — BOTH (1) the 24h move against BTC is at or below the
 *      threshold (-40%) with the two price sources agreeing, AND (2) protocol
 *      TVL fell by the threshold (-50%) or more over 48h. The rulebook's
 *      alternative to (2) — an official incident notice disclosing a loss of
 *      10% or more of TVL — is not machine-checked; it is a human reading.
 *      (1) is read for every held name from the primary price pull; the second
 *      price source and the TVL series are fetched only for a name that meets
 *      (1) on the first source, because both legs are required. A name that
 *      meets (1) but whose second source or TVL cannot be read is reported
 *      with `met: null` and `needsReview: true` — never as fired, never as
 *      cleared.
 *   B  control-address outflow — a week-on-week fall in the balance of the
 *      supply registry's protocol-controlled addresses of 5% of circulating
 *      supply or more ("주간 공급 스냅샷이 곧 트리거"). Measured from
 *      keeper/supply/supply-weekly.json (`excluded` = controlled balances),
 *      and only where the latest weekly point is no older than
 *      `maxSnapshotAgeDays`; everything else is listed as not measured, with
 *      the reason.
 *   C  price loss — a held name with no live price in the primary pull
 *      (qX20 §9: fallback source, then at most three runs at the last price).
 *
 * Pure apart from the two injected fetchers, so the test can drive it with
 * synthetic data (keeper/special-situation.test.mjs).
 */

const round2 = (x) => Math.round(x * 100) / 100;
const DAY_MS = 86_400_000;

/** A 24h percent move restated against BTC's 24h percent move, in percent. */
export function relVsBtcPct(pct, btcPct) {
  if (!Number.isFinite(pct) || !Number.isFinite(btcPct) || btcPct <= -100) return null;
  return ((1 + pct / 100) / (1 + btcPct / 100) - 1) * 100;
}

/** TVL change over 48h from a [[unixSeconds, usd], ...] series: the last point
 *  against the latest point at or before (last - 48h). The research study
 *  (site repo docs/research/qrev/event-trigger-study.py) takes the same
 *  day-over-two-days ratio on daily points. */
export function tvlChange48hPct(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const pts = series
    .map(([t, v]) => [Number(t), Number(v)])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;
  const [tLast, vLast] = pts[pts.length - 1];
  let base = null;
  for (const [t, v] of pts) {
    if (t <= tLast - 48 * 3600) base = v;
    else break;
  }
  if (!(base > 0)) return null;
  return (vLast / base - 1) * 100;
}

/** Week-on-week outflow from the registry's controlled addresses, as a
 *  fraction of circulating supply at the latest week. */
export function weeklyControlOutflow(weekly, dateStr, maxAgeDays) {
  if (!weekly || typeof weekly !== 'object') return { status: 'no-series' };
  const dates = Object.keys(weekly).sort();
  if (dates.length < 2) return { status: 'no-series' };
  const latest = dates[dates.length - 1];
  const previous = dates[dates.length - 2];
  const ageDays = (Date.parse(dateStr + 'T00:00:00Z') - Date.parse(latest + 'T00:00:00Z')) / DAY_MS;
  if (!(ageDays <= maxAgeDays)) return { status: 'stale', latest };
  const e0 = Number(weekly[previous]?.excluded);
  const e1 = Number(weekly[latest]?.excluded);
  const circ = Number(weekly[latest]?.circulating);
  if (!Number.isFinite(e0) || !Number.isFinite(e1) || !(circ > 0)) return { status: 'no-series' };
  return { status: 'measured', latest, previous, fraction: (e0 - e1) / circ };
}

/**
 * @param {object} args
 * @param {object} args.def          rulebook `specialEvents.triggerLog`
 * @param {string[]} args.held       symbols the trigger applies to (held names)
 * @param {Map<string, {price?: number, priceChange24h?: number}>} args.markets primary price pull, by symbol
 * @param {string} args.dateStr      run date (YYYY-MM-DD)
 * @param {object} args.supplyWeekly keeper/supply/supply-weekly.json
 * @param {object} args.supplyRegistry keeper/supply/registry.json
 * @param {() => Promise<Map<string, number>>} args.fetchSecond24h   the other price source's 24h % change by symbol
 * @param {(symbol: string) => Promise<Array<[number, number]>|null>} args.fetchTvlSeries
 */
export async function evaluateSpecialSituation({ def, held, markets, dateStr, supplyWeekly, supplyRegistry, fetchSecond24h, fetchTvlSeries }) {
  const btc = def.btcSymbol ?? 'BTC';

  // ------------------------------------------------------------------ A
  const A = { id: 'A', evaluated: false, fired: false };
  const thrPrice = def.A.priceVsBtc24hMaxPct;
  const thrTvl = def.A.tvl48hMaxPct;
  const btcPct = markets.get(btc)?.priceChange24h;
  if (!Number.isFinite(btcPct)) {
    A.reason = `no 24h change for ${btc} in the primary price pull`;
  } else {
    A.evaluated = true;
    const rel = [];
    const missing = [];
    for (const sym of held) {
      const r = relVsBtcPct(markets.get(sym)?.priceChange24h, btcPct);
      if (r == null) missing.push(sym);
      else rel.push({ symbol: sym, vsBtc24hPct: round2(r) });
    }
    A.checked = rel.length;
    if (missing.length) A.missing = missing;
    if (rel.length) {
      const w = rel.reduce((a, b) => (b.vsBtc24hPct < a.vsBtc24hPct ? b : a));
      A.worst = { symbol: w.symbol, vsBtc24hPct: w.vsBtc24hPct };
    }
    const hits = rel.filter((r) => r.vsBtc24hPct <= thrPrice);
    if (hits.length) {
      let second = null;
      let secondError = null;
      try {
        second = await fetchSecond24h();
      } catch (e) {
        secondError = String(e?.message ?? e);
      }
      A.hits = [];
      for (const h of hits) {
        const entry = { symbol: h.symbol, vsBtc24hPct: { primary: h.vsBtc24hPct, second: null } };
        let priceAgree = null;
        if (second) {
          const r2 = relVsBtcPct(second.get(h.symbol), second.get(btc));
          if (r2 != null) {
            entry.vsBtc24hPct.second = round2(r2);
            priceAgree = r2 <= thrPrice;
          }
        } else if (secondError) {
          entry.secondSourceError = secondError;
        }
        if (priceAgree === false) {
          entry.met = false;
          entry.reason = 'the second price source does not confirm the move';
        } else {
          let t48 = null;
          try {
            t48 = tvlChange48hPct(await fetchTvlSeries(h.symbol));
          } catch (e) {
            entry.tvlError = String(e?.message ?? e);
          }
          entry.tvl48hPct = t48 == null ? null : round2(t48);
          const tvlMet = t48 == null ? null : t48 <= thrTvl;
          if (priceAgree === true && tvlMet === true) entry.met = true;
          else if (priceAgree === null || tvlMet === null) {
            entry.met = null;
            entry.needsReview = true;
          } else entry.met = false;
        }
        A.hits.push(entry);
      }
      A.fired = A.hits.some((x) => x.met === true);
      if (A.hits.some((x) => x.met === null)) A.needsReview = true;
    }
  }

  // ------------------------------------------------------------------ B
  const B = { id: 'B', evaluated: false, fired: false };
  const thrOut = def.B.weeklyOutflowMinFractionOfCirculating;
  const notMeasured = { censusIncomplete: [], noSeries: [], stale: [] };
  const measured = [];
  let staleLatest = null;
  for (const sym of held) {
    if (supplyRegistry?.[sym]?.census_status === 'incomplete') {
      notMeasured.censusIncomplete.push(sym);
      continue;
    }
    const o = weeklyControlOutflow(supplyWeekly?.[sym], dateStr, def.B.maxSnapshotAgeDays);
    if (o.status === 'measured') measured.push({ symbol: sym, ...o });
    else if (o.status === 'stale') {
      notMeasured.stale.push(sym);
      if (!staleLatest || o.latest > staleLatest) staleLatest = o.latest;
    } else notMeasured.noSeries.push(sym);
  }
  B.evaluated = measured.length > 0;
  B.measured = measured.length;
  const nm = Object.fromEntries(Object.entries(notMeasured).filter(([, v]) => v.length));
  if (Object.keys(nm).length) B.notMeasured = nm;
  if (staleLatest) B.latestSnapshot = staleLatest;
  if (!B.evaluated) B.reason = `no held name has a weekly control-address snapshot within ${def.B.maxSnapshotAgeDays} days`;
  const bHits = measured.filter((m) => m.fraction >= thrOut);
  if (bHits.length) {
    B.fired = true;
    B.hits = bHits.map((m) => ({ symbol: m.symbol, outflowPctOfCirculating: round2(m.fraction * 100), weeks: [m.previous, m.latest] }));
  }

  // ------------------------------------------------------------------ C
  const noPrice = held.filter((sym) => !(markets.get(sym)?.price > 0));
  const C = { id: 'C', evaluated: true, fired: noPrice.length > 0 };
  if (noPrice.length) C.noPrice = noPrice;

  const out = {
    evaluated: true,
    mode: 'log-only',
    rule: def.rule,
    held: held.length,
    triggers: [A, B, C],
    fired: A.fired || B.fired || C.fired,
  };
  if (A.needsReview) out.needsReview = true;
  return out;
}
