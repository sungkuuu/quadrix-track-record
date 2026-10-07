/**
 * Leverage stage A — the level of a daily-reset 2x book, computed from bars.
 *
 * Pure functions, no network, no file system. keeper/leverage-index.mjs (the
 * daily leg) calls them; scripts/verify.mjs re-implements the same arithmetic
 * on its own (it never imports this file), so a line is only appended when two
 * implementations agree.
 *
 * The level is the sixth leverage test's engine (leverage-params-v6.mjs,
 * sha256 ceadadd3…, function `simulate`, daily reset · long · no stress path)
 * run bar by bar on 15-minute bars aggregated from Binance spot 1-minute bars
 * exactly as that engine's --build does. It is computed BY CONSTRUCTION from
 * the bars at the grid times, never from a price at the time the keeper
 * wakes: a late keeper computes the same level, and anyone can recompute it
 * from the bars a record line carries.
 *
 * The order and the form of every floating-point operation below are the
 * engine's (a trigger at λ exactly equal to T depends on it). Do not
 * "simplify" an expression here without re-running keeper/test/leverage-*.
 *
 * Book: A = collateral value (> 0), C = debt (< 0), E = A + C = equity.
 * Level = 100 × E. A day ends at 00:00 UTC (the close of the UTC day's last
 * 15-minute bar), where the book is brought back to the target; between day
 * ends, at the close of a check bar of period n minutes, the book is brought
 * back to the target when λ = A / E ≥ T (the trigger only reduces leverage).
 */
import crypto from 'node:crypto';

export const MINUTE_MS = 60_000;
export const BAR_MIN = 15;
export const BAR_MS = BAR_MIN * MINUTE_MS;
export const DAY_MIN = 1440;
export const DAY_MS = DAY_MIN * MINUTE_MS;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const r8 = (x) => Math.round(x * 1e8) / 1e8;

/** "YYYY-MM-DD" → ms at 00:00 UTC. */
export const dayMs = (date) => Date.parse(`${date}T00:00:00Z`);
/** ms → "YYYY-MM-DD" (UTC). */
export const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
/** ms → "HH:MM" (UTC). */
export const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
/** ms → "YYYY-MM-DDTHH:MM" (UTC). */
export const stamp = (ms) => new Date(ms).toISOString().slice(0, 16);
/** "YYYY-MM-DDTHH:MM" → ms. */
export const stampMs = (s) => Date.parse(`${s}:00Z`);
export const addDays = (date, k) => dateOf(dayMs(date) + k * DAY_MS);
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dateOf(dayMs(s)) === s;

// ---------------------------------------------------------------- rulebook

/**
 * The two tested values (check.minutes, check.trigger) and the level's cost
 * convention (level.primary) are null in the rulebook until the sixth test's
 * output and the owner's choices fill them. Returns the first reason the rule
 * cannot run, or null. Order and messages are the spec's §1-6 1–3.
 */
export function ruleProblem({ target, minutes, trigger, primary }) {
  if (!(Number.isInteger(minutes) && minutes >= BAR_MIN && minutes < DAY_MIN && minutes % BAR_MIN === 0 && DAY_MIN % minutes === 0)) {
    return { field: 'check.minutes', why: `must be an integer n with 15 <= n < 1440, n % 15 = 0 and 1440 % n = 0 (got ${JSON.stringify(minutes ?? null)})` };
  }
  if (!(typeof trigger === 'number' && Number.isFinite(trigger) && trigger > target)) {
    return { field: 'check.trigger', why: `must be a number above product.target ${target} (got ${JSON.stringify(trigger ?? null)})` };
  }
  if (!(primary && typeof primary === 'object' && typeof primary.costBp === 'number' && primary.costBp >= 0 && typeof primary.ratePct === 'number' && primary.ratePct >= 0)) {
    return { field: 'level.primary', why: `must be {costBp >= 0, ratePct >= 0} (got ${JSON.stringify(primary ?? null)})` };
  }
  return null;
}

/** Fixed parts of the rulebook the code relies on; a mismatch is a config error. */
export function rulebookShapeProblem(rb) {
  if (!rb || typeof rb !== 'object') return 'rulebook is not an object';
  if (rb.kind !== 'leverage-synthetic') return `kind must be leverage-synthetic (got ${rb.kind})`;
  if (rb.product?.target !== 2) return `product.target must be 2 (got ${rb.product?.target})`;
  if (rb.product?.reset !== 'daily-00:00-utc') return `product.reset must be daily-00:00-utc (got ${rb.product?.reset})`;
  if (rb.product?.intradayReleverage !== false) return 'product.intradayReleverage must be false';
  if (rb.underlying?.barMinutes !== BAR_MIN) return `underlying.barMinutes must be ${BAR_MIN}`;
  if (rb.underlying?.interval !== '1m') return 'underlying.interval must be 1m';
  if (!/^[A-Z]+USDT$/.test(String(rb.underlying?.symbol))) return `underlying.symbol ${rb.underlying?.symbol} is not a Binance spot USDT pair`;
  if (!(typeof rb.model?.lltv === 'number' && rb.model.lltv > 0 && rb.model.lltv < 1)) return 'model.lltv must be in (0, 1)';
  if (rb.genesisLevel !== 100) return 'genesisLevel must be 100';
  if (!Array.isArray(rb.level?.also)) return 'level.also must be an array (empty when unused)';
  for (const a of rb.level.also) {
    if (!(a && typeof a.id === 'string' && /^[a-z0-9-]+$/.test(a.id) && a.costBp >= 0 && a.ratePct >= 0)) return `level.also entry ${JSON.stringify(a)} must be {id, costBp >= 0, ratePct >= 0}`;
  }
  return null;
}

// ------------------------------------------------------------------- bars

/**
 * Binance kline rows → minutes {openMs, closeMs, o, h, l, c} (Numbers). A time
 * of 10^15 or more is microseconds (the engine's fetch-api-1m.mjs line 60).
 * Throws on a malformed row.
 */
export function parseKlines(raw) {
  if (!Array.isArray(raw)) throw new Error(`klines: expected an array, got ${typeof raw}`);
  return raw.map((r) => {
    if (!Array.isArray(r) || r.length < 7) throw new Error(`klines: malformed row ${JSON.stringify(r).slice(0, 120)}`);
    let openMs = Number(r[0]);
    let closeMs = Number(r[6]);
    if (openMs >= 1e15) openMs = Math.floor(openMs / 1000);
    if (closeMs >= 1e15) closeMs = Math.floor(closeMs / 1000);
    const [o, h, l, c] = [r[1], r[2], r[3], r[4]].map(Number);
    if (!Number.isInteger(openMs) || openMs % MINUTE_MS !== 0) throw new Error(`klines: open time ${r[0]} is not on the minute grid`);
    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) throw new Error(`klines: non-positive price at ${stamp(openMs)}`);
    if (!(l <= Math.min(o, c) && Math.max(o, c) <= h)) throw new Error(`klines: inconsistent bar at ${stamp(openMs)} (o ${o} h ${h} l ${l} c ${c})`);
    return { openMs, closeMs, o, h, l, c };
  });
}

/** The canonical text of a day's 1-minute bars, whose sha256 a line records. */
export function canonicalMinuteText(minutes) {
  let s = '';
  for (const m of minutes) s += `${m.openMs},${String(Number(m.o))},${String(Number(m.h))},${String(Number(m.l))},${String(Number(m.c))}\n`;
  return s;
}

/**
 * 1-minute bars → 15-minute bars, the engine's --build rule
 * (leverage-params-v6.mjs buildData): key = floor(openMinute / 15), open =
 * first minute's open, high = max, low = min, close = last minute's close,
 * n1m = minutes present. A slot without a minute has no bar (never invented).
 */
export function aggregate15(minutes) {
  const out = [];
  for (const m of minutes) {
    const key = Math.floor(m.openMs / MINUTE_MS / BAR_MIN);
    const b = out.at(-1);
    if (!b || b.key !== key) out.push({ key, openMs: key * BAR_MS, o: m.o, h: m.h, l: m.l, c: m.c, n1m: 1 });
    else {
      if (m.h > b.h) b.h = m.h;
      if (m.l < b.l) b.l = m.l;
      b.c = m.c;
      b.n1m++;
    }
  }
  return out.map(({ key, ...b }) => b);
}

/** Gaps of a day's minutes: [{from: "HH:MM", to: "HH:MM", minutes}] (both ends missing minutes, inclusive). */
export function minuteGaps(minutes, day) {
  const start = dayMs(day);
  const present = new Set(minutes.map((m) => m.openMs));
  const gaps = [];
  let run = null;
  for (let k = 0; k < DAY_MIN; k++) {
    const t = start + k * MINUTE_MS;
    if (!present.has(t)) {
      if (!run) run = { from: t, to: t, minutes: 0 };
      run.to = t;
      run.minutes++;
    } else if (run) {
      gaps.push(run);
      run = null;
    }
  }
  if (run) gaps.push(run);
  return gaps.map((g) => ({ from: hhmm(g.from), to: hhmm(g.to), minutes: g.minutes }));
}

/** A bar as a line stores it: ["HH:MM", open, high, low, close, n1m]. */
export const barRow = (b) => [hhmm(b.openMs), b.o, b.h, b.l, b.c, b.n1m];

// ------------------------------------------------------------------ check bars

/**
 * The engine's check-bar rule (leverage-params-v6.mjs makeBars): the bar
 * opening at openMs is a check bar of period n iff a UTC grid time m·n
 * (minutes since the epoch) satisfies close ≤ m·n < next bar's close. When a
 * gap covers grid times, the last bar before the gap stands for them.
 * Returns {t: first grid time (minutes since the epoch), gridTimes} or null.
 */
export function checkSlot(openMs, nextOpenMs, n) {
  const cMin = openMs / MINUTE_MS + BAR_MIN;
  const nxtMin = nextOpenMs == null ? Infinity : nextOpenMs / MINUTE_MS + BAR_MIN;
  const first = Math.ceil(cMin / n) * n;
  if (!(first < nxtMin)) return null;
  const gridTimes = nxtMin === Infinity ? 1 : Math.ceil(nxtMin / n) - Math.ceil(cMin / n);
  return { t: first, gridTimes };
}

/** Per-bar debt factor for d steps of 15 minutes (engine interestTable). */
export function interestFactor(ratePct, d) {
  return ratePct === 0 ? 1 : Math.pow(1 + ratePct / 100 / 365, (d * BAR_MIN) / DAY_MIN);
}

// --------------------------------------------------------------------- the day

/**
 * One UTC day of one book. `book` = {A, C, E, lastBar ("YYYY-MM-DDTHH:MM", the
 * previous bar's open), lastClose}; `bars` = the day's 15-minute bars in open
 * order, every one opening on `day`; `p` = {target, minutes, trigger, costBp,
 * ratePct, lltv}; `log` = true to build the check log (the primary book).
 *
 * Returns {book, E, liquidated, slots, stats}. `liquidated` is null or
 * {bar, ltvLow, tMs}; after it the book is zero and the series ends (the
 * tests count a model liquidation as a total loss — engine line 448).
 */
export function runDay(book, bars, p, { log = true } = {}) {
  const lam = p.target;
  const c = p.costBp / 1e4;
  let A = book.A;
  let C = book.C;
  let E = book.E;
  let prevClose = book.lastClose;
  let prevOpenMs = stampMs(book.lastBar);
  const slots = [];
  const stats = { trades: 0, triggers: 0, turnover: 0, cost: 0, maxLtvLow: null };
  let liquidated = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = (b.openMs - prevOpenMs) / BAR_MS;
    if (!(Number.isInteger(d) && d >= 1 && d < 4096)) throw new Error(`bad step before ${stamp(b.openMs)}: ${d} bars of 15 minutes`);
    C = C * interestFactor(p.ratePct, d);
    const gL = Math.min(1, b.l / prevClose);
    const Ax = A * gL;
    const ltvLow = -C / Ax;
    if (stats.maxLtvLow === null || ltvLow > stats.maxLtvLow.raw) stats.maxLtvLow = { raw: ltvLow, bar: hhmm(b.openMs) };
    if (-C >= p.lltv * Ax) {
      const tMs = b.openMs + BAR_MS;
      const Ex = Ax + C;
      liquidated = { bar: hhmm(b.openMs), ltvLow: r6(ltvLow), tMs };
      if (log) slots.push({ t: stamp(tMs) + 'Z', bar: hhmm(b.openMs), lambdaBefore: Ex > 0 ? r6(Ax / Ex) : null, action: 'liquidated', notional: 0, cost: 0, lambdaAfter: null, level: 0 });
      A = 0;
      C = 0;
      E = 0;
      prevClose = b.c;
      prevOpenMs = b.openMs;
      break;
    }
    const gC = b.c / prevClose;
    A = A * gC;
    E = A + C;
    const dayEnd = i === bars.length - 1;
    const slot = dayEnd ? null : checkSlot(b.openMs, bars[i + 1].openMs, p.minutes);
    let kind = null;
    if (dayEnd) kind = 'reset';
    else if (slot && Math.abs(A) >= p.trigger * E) kind = 'trigger';
    const Apre = A;
    let E2 = E;
    let q = 0;
    let cost = 0;
    if (kind) {
      E2 = lam * E - A >= 0 ? (E + c * A) / (1 + c * lam) : (E - c * A) / (1 - c * lam);
      q = lam * E2 - A;
      A = lam * E2;
      C = E2 - A;
      cost = (c * Math.abs(q)) / E;
      stats.trades++;
      if (kind === 'trigger') stats.triggers++;
      stats.turnover += Math.abs(q) / E;
      stats.cost += cost;
    }
    if (log && (dayEnd || slot)) {
      const tMs = dayEnd ? b.openMs + BAR_MS : slot.t * MINUTE_MS;
      const row = {
        t: stamp(tMs) + 'Z',
        bar: hhmm(b.openMs),
        lambdaBefore: r6(Apre / E),
        action: kind ?? 'none',
        notional: r8(q / E),
        cost: r8(cost),
        lambdaAfter: r6(A / E2),
        level: r6(100 * E2),
      };
      if (!dayEnd && slot.gridTimes >= 2) row.gridTimes = slot.gridTimes;
      slots.push(row);
    }
    E = E2;
    prevClose = b.c;
    prevOpenMs = b.openMs;
  }
  const last = bars.length ? bars.at(-1) : null;
  const out = {
    book: { A, C, E, lastBar: liquidated ? stamp(prevOpenMs) : last ? stamp(last.openMs) : book.lastBar, lastClose: liquidated ? prevClose : last ? last.c : book.lastClose },
    E,
    liquidated,
    slots,
    stats: {
      trades: stats.trades,
      triggers: stats.triggers,
      turnover: r8(stats.turnover),
      cost: r8(stats.cost),
      maxLtvLow: stats.maxLtvLow ? { value: r6(stats.maxLtvLow.raw), bar: stats.maxLtvLow.bar } : null,
    },
  };
  return out;
}

/** The book at the inception close: λ* of collateral against λ* − 1 of debt, equity 1 (engine line 392). */
export function genesisBook(target, lastBar) {
  return { A: target, C: 1 - target, E: 1, lastBar: stamp(lastBar.openMs), lastClose: lastBar.c };
}

/** The level a line records for equity E. */
export const levelOf = (E) => Math.round(100 * E * 1e6) / 1e6;

// ------------------------------------------------------------------- the line

/**
 * The record line for date D (UTC day D − 1's bars) or the genesis line
 * (seq 0, date I). Key order is fixed: the hash depends on it.
 */
export function buildLine({
  seq, date, observedAt, ticker, prevHash, rule, keeper, sources, gaps = null, gapAccepted = null,
  liquidationAccepted = null, genesis = null, day = null, rehearsal = null,
}) {
  const late = dateOf(Date.parse(observedAt)) > date;
  const line = { seq, date, observedAt, index: ticker };
  if (genesis) {
    line.level = levelOf(genesis.book.E);
    if (late) line.late = true;
    if (genesis.books && Object.keys(genesis.books).length) line.levels = Object.fromEntries(Object.entries(genesis.books).map(([id, b]) => [id, levelOf(b.E)]));
    line.book = genesis.book;
    if (genesis.books && Object.keys(genesis.books).length) line.books = genesis.books;
    line.dayStats = { trades: 0, triggers: 0, turnover: 0, cost: 0, maxLtvLow: null };
    line.liquidated = null;
    line.slots = [];
    line.bars = [barRow(genesis.lastBar)];
  } else {
    line.level = levelOf(day.primary.E);
    if (late) line.late = true;
    if (day.also.length) line.levels = Object.fromEntries(day.also.map((a) => [a.id, levelOf(a.E)]));
    line.book = day.primary.book;
    if (day.also.length) line.books = Object.fromEntries(day.also.map((a) => [a.id, a.book]));
    line.dayStats = day.primary.stats;
    line.liquidated = day.primary.liquidated ? { bar: day.primary.liquidated.bar, ltvLow: day.primary.liquidated.ltvLow } : null;
    line.slots = day.primary.slots;
    line.bars = day.bars.map(barRow);
  }
  line.sources = sources;
  if (gaps) {
    line.gaps = gaps;
    line.gapAccepted = gapAccepted;
  }
  // the id of the keeper/leverage-gaps.json entry in which a person accepted this line's model liquidation
  if (liquidationAccepted) line.liquidationAccepted = liquidationAccepted;
  line.rule = rule;
  line.keeper = keeper;
  if (rehearsal) line.rehearsal = rehearsal;
  if (genesis) line.inception = genesis.inception;
  line.prevHash = prevHash;
  line.hash = sha256(JSON.stringify(line));
  return line;
}

/**
 * Run one day for the primary book and every `also` book. `prev` = the
 * previous line (its book and books are the start). Returns {primary, also,
 * bars}. An `also` book already at zero stays at zero.
 */
export function computeDay(prev, bars, rule) {
  const base = { target: rule.target, minutes: rule.checkMinutes, trigger: rule.trigger, lltv: rule.lltv };
  const primary = runDay(prev.book, bars, { ...base, costBp: rule.costBp, ratePct: rule.ratePct }, { log: true });
  const also = (rule.also ?? []).map((a) => {
    const start = prev.books?.[a.id];
    if (!start) throw new Error(`previous line has no book for level.also ${a.id}`);
    if (start.E === 0) return { id: a.id, E: 0, book: start };
    const r = runDay(start, bars, { ...base, costBp: a.costBp, ratePct: a.ratePct }, { log: false });
    return { id: a.id, E: r.E, book: r.book };
  });
  return { primary, also, bars };
}

// ------------------------------------------------------------------- vault marks

/** Contract bound (QuadrixIndexVault.sol MAX_NAV_MOVE_BPS = 2_500, BPS = 10_000). */
export const MAX_NAV_MOVE_BPS = 2_500n;
export const BPS = 10_000n;

/**
 * The setNav steps from `cur` to `target` (6-decimal units, BigInt), each
 * inside the contract's own bound (old ± old·2500/10000, integer division,
 * inclusive). Stops when a step cannot move (the floor: from 4 the next is 3,
 * from 3 nothing). Returns the list of successive navPerShare values.
 */
export function markSteps(cur, target) {
  const out = [];
  let x = cur;
  for (let guard = 0; guard < 400 && x !== target; guard++) {
    const delta = (x * MAX_NAV_MOVE_BPS) / BPS;
    const lo = x - delta;
    const hi = x + delta;
    const next = target < lo ? lo : target > hi ? hi : target;
    if (next === x) break;
    out.push(next);
    x = next;
  }
  return out;
}
