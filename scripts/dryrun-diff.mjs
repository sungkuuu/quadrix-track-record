/**
 * Summarise a paper-index reconstitution rehearsal, and diff two of them.
 *
 * Reads what .github/workflows/paper-index-dryrun.yml collects per side
 * (a directory per git ref):
 *
 *   <side>/ref.txt              the commit the side ran
 *   <side>/live/state-*.json    the live books the rehearsal started from
 *   <side>/dryrun/              keeper/dryrun/ after the run (state, record, eval-*.json)
 *   <side>/logs/<index>.log     console output of each index
 *   <side>/exit-codes.txt       "<index> <exit code>" per line
 *
 * and writes <out>/summary-<label>.json per side, <out>/diff.json when two
 * sides are given, and a Markdown digest on stdout (the workflow appends it
 * to the job summary). Pure file reads: no network, no keys, no git.
 *
 *   node scripts/dryrun-diff.mjs --a out/A [--b out/B] --out out --as-of 2026-10-01
 *
 * "Today" is the live book the rehearsal copied into keeper/dryrun/, so
 * in/out is the rehearsed reconstitution against the book held now.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR_A = opt('--a');
const DIR_B = opt('--b');
const OUT = opt('--out', '.');
const AS_OF = opt('--as-of');
if (!DIR_A) {
  console.error('usage: node scripts/dryrun-diff.mjs --a <dir> [--b <dir>] [--out <dir>] [--as-of YYYY-MM-DD]');
  process.exit(2);
}

const INDEXES = ['qrev', 'qdefi', 'qai', 'triens', 'barbell'];
const CASH = '__CASH__';
/** Fields of an evaluated candidate that the listing-age and issuance rules
 *  decide (or that a rank is computed from). Market data (price, market cap,
 *  volume) is reported separately: with a shared cache it is identical on
 *  both sides and any difference there is data, not code. */
const RULE_FIELDS = [
  'listingAgeDays', 'listingSource', 'listingDateCmc', 'listingDateGecko', 'listingDisagreement',
  'issuance12m', 'issuanceSource', 'issuanceGecko', 'issuanceCmc', 'issuanceDisagreement', 'issuanceRatio',
  'holderRevenue12m', 'holderRevenue12mGross', 'netRevenue12m', 'phr', 'posMonths',
];
const MARKET_FIELDS = ['price', 'marketCap', 'marketCapCmc', 'volume24h'];

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const lastLine = (p) => {
  const t = readText(p);
  if (!t) return null;
  const lines = t.trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
};
const sorted = (xs) => [...xs].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Names held by a book: the ranked indexes' units (cash excluded), or every
 *  sleeve's names with working capital as WC. */
function heldNames(state) {
  if (!state) return [];
  if (state.sleeves) {
    const out = [];
    for (const [sleeve, v] of Object.entries(state.sleeves)) {
      if (sleeve === 'workingCapital') out.push('WC');
      else out.push(...Object.keys(v?.units ?? {}));
    }
    return out;
  }
  return Object.keys(state.units ?? {}).filter((s) => s !== CASH);
}

/** The units a reconstitution renormalises: the whole book (qREV, qDEFI,
 *  qAI — cash included, it is a position) or the Quality sleeve (Triens). */
function renormalisedUnits(state) {
  if (!state) return null;
  if (state.sleeves) return state.sleeves.quality?.units ?? null;
  return state.units ?? null;
}

/** The ×k the tolerance step's renormalisation applied. Printed by the keeper
 *  only when |k-1| > 0.5%; otherwise inferred: every name the tolerance kept
 *  (unit count left alone) is scaled by exactly k, so it is the dry-run/live
 *  unit ratio those names share. Traded names get arbitrary ratios. */
function normalisation(log, liveState, dryState) {
  const m = /(?:book|quality sleeve) normalised by ×([0-9.]+)/.exec(log ?? '');
  const logged = m ? Number(m[1]) : null;
  const live = renormalisedUnits(liveState);
  const dry = renormalisedUnits(dryState);
  const ratios = {};
  if (live && dry) {
    for (const [s, u] of Object.entries(dry)) if (live[s] > 0 && u > 0) ratios[s] = u / live[s];
  }
  // Cluster ratios equal to 1e-9 relative; the largest cluster of >= 2 names is k.
  const groups = [];
  for (const [s, r] of Object.entries(ratios)) {
    const g = groups.find((x) => Math.abs(x.r - r) <= 1e-9 * Math.max(1, Math.abs(x.r)));
    if (g) g.names.push(s);
    else groups.push({ r, names: [s] });
  }
  groups.sort((a, b) => b.names.length - a.names.length);
  const best = groups[0] && groups[0].names.length >= 2 ? groups[0] : null;
  return {
    logged,
    inferred: best ? Number(best.r.toFixed(9)) : null,
    retainedByTolerance: best ? sorted(best.names) : [],
    note: logged != null
      ? 'printed by the keeper (|k-1| > 0.5%)'
      : best
        ? 'not printed (|k-1| <= 0.5%); inferred from the names the tolerance kept'
        : Object.keys(ratios).length <= 1
          ? 'not printed; fewer than two names common to both books — k cannot be inferred from ratios'
          : 'not printed; no two retained names share a ratio — every common name was traded (k = 1 by construction)',
  };
}

function summarise(dir, index) {
  const exitCodes = Object.fromEntries(
    (readText(path.join(dir, 'exit-codes.txt')) ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(/\s+/))
      .map(([k, v]) => [k, Number(v)])
  );
  const log = readText(path.join(dir, 'logs', `${index}.log`));
  const liveState = readJson(path.join(dir, 'live', `state-${index}.json`));
  const dryState = readJson(path.join(dir, 'dryrun', `state-${index}.json`));
  // The rehearsal's record line carries the rehearsal date. A last line with
  // any other date is the live line copied in before the run — the run did
  // not get as far as writing — and is not read as the rehearsal's result.
  const lastRec = lastLine(path.join(dir, 'dryrun', `record-${index}.jsonl`));
  const record = lastRec && (!AS_OF || lastRec.date === AS_OF) ? lastRec : null;
  const evalDump = readJson(path.join(dir, 'dryrun', `eval-${index}.json`));

  const today = heldNames(liveState);
  const members = record ? record.members.map((m) => m.symbol) : [];
  const out = {
    index,
    exitCode: exitCodes[index] ?? null,
    recordWritten: !!record,
    date: record?.date ?? null,
    seq: record?.seq ?? null,
    reconstituted: record?.reconstituted ?? null,
    levelBefore: liveState?.level ?? null,
    level: record?.level ?? null,
    marketsSource: record?.sources?.marketsSource ?? null,
    categorySource: record?.sources?.categorySource ?? null,
    reconstitutionDeferred: record?.sources?.reconstitutionDeferred ?? null,
    today: sorted(today),
    members: sorted(members),
    in: sorted(members.filter((s) => !today.includes(s))),
    out: sorted(today.filter((s) => !members.includes(s))),
    weights: Object.fromEntries((record?.members ?? []).map((m) => [m.symbol, m.weight])),
    eligibleCount: record?.eligibleCount ?? evalDump?.eligibleCount ?? null,
    ...(index === 'qai' ? { emptySeats: record?.emptySeats ?? null, cashWeight: record?.cashWeight ?? null } : {}),
    ...(record?.sleeves ? { sleeves: record.sleeves } : {}),
    // Only a reconstitution renormalises, and Barbell has no per-name book.
    normalisation:
      record?.reconstituted && renormalisedUnits(liveState)
        ? normalisation(log, liveState, dryState)
        : { logged: null, inferred: null, retainedByTolerance: [], note: record?.reconstituted ? 'no per-name book (sleeves reset only)' : 'no reconstitution in this run' },
    sourceStats: {
      defillama: record?.sources?.defillama ?? null,
      categoryUniverse: record?.sources?.categoryUniverse ?? null,
    },
    ...(record?.specialSituation ? { specialSituationFired: record.specialSituation.fired ?? null } : {}),
    onNotice: dryState?.onNotice ?? null,
    evaluated: evalDump?.evaluated?.length ?? null,
    eligible: evalDump ? sorted(evalDump.evaluated.filter((e) => e.eligible).map((e) => e.symbol)) : null,
    warnings: (log ?? '').split('\n').filter((l) => /DEFERRED|FAILED:|WATCH|unavailable|failed|Error/.test(l) && !/^\s*\[/.test(l)).slice(0, 40),
  };
  return { summary: out, evalDump, record };
}

function diffIndex(index, A, B) {
  const a = A.summary;
  const b = B.summary;
  const onlyA = a.members.filter((s) => !b.members.includes(s));
  const onlyB = b.members.filter((s) => !a.members.includes(s));
  const weightChanges = [];
  for (const s of new Set([...Object.keys(a.weights), ...Object.keys(b.weights)])) {
    const wa = a.weights[s] ?? 0;
    const wb = b.weights[s] ?? 0;
    if (Math.abs(wa - wb) >= 0.0001) weightChanges.push({ symbol: s, a: wa, b: wb });
  }
  weightChanges.sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a));

  const evA = new Map((A.evalDump?.evaluated ?? []).map((e) => [e.symbol, e]));
  const evB = new Map((B.evalDump?.evaluated ?? []).map((e) => [e.symbol, e]));
  const candidates = [];
  for (const s of new Set([...evA.keys(), ...evB.keys()])) {
    const ea = evA.get(s);
    const eb = evB.get(s);
    if (!ea || !eb) {
      candidates.push({ symbol: s, inUniverse: { a: !!ea, b: !!eb }, eligible: { a: ea?.eligible ?? null, b: eb?.eligible ?? null } });
      continue;
    }
    const gates = {};
    for (const g of new Set([...Object.keys(ea.gate ?? {}), ...Object.keys(eb.gate ?? {})])) {
      if (!same(ea.gate?.[g], eb.gate?.[g])) gates[g] = { a: ea.gate?.[g] ?? null, b: eb.gate?.[g] ?? null };
    }
    const rule = {};
    for (const f of RULE_FIELDS) if (!same(ea[f], eb[f])) rule[f] = { a: ea[f] ?? null, b: eb[f] ?? null };
    const market = {};
    for (const f of MARKET_FIELDS) if (!same(ea[f], eb[f])) market[f] = { a: ea[f] ?? null, b: eb[f] ?? null };
    const other = {};
    for (const f of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
      if (['gate', 'eligible', 'symbol', ...RULE_FIELDS, ...MARKET_FIELDS].includes(f)) continue;
      if (!same(ea[f], eb[f])) other[f] = { a: ea[f] ?? null, b: eb[f] ?? null };
    }
    if (ea.eligible !== eb.eligible || Object.keys(gates).length || Object.keys(rule).length || Object.keys(market).length || Object.keys(other).length) {
      candidates.push({
        symbol: s,
        eligible: { a: ea.eligible, b: eb.eligible },
        ...(Object.keys(gates).length ? { gates } : {}),
        ...(Object.keys(rule).length ? { rule } : {}),
        ...(Object.keys(market).length ? { market } : {}),
        ...(Object.keys(other).length ? { other } : {}),
      });
    }
  }
  candidates.sort((x, y) => x.symbol.localeCompare(y.symbol));

  /** Why a name is a member on one side only: the gate that flipped, or — when
   *  it is eligible on both — the rank inputs that changed. */
  const why = (s) => {
    const c = candidates.find((x) => x.symbol === s);
    if (!c) return 'no candidate difference recorded (rank buffer / seat count)';
    if (c.inUniverse) return `universe (a: ${c.inUniverse.a ? 'in' : 'out'}, b: ${c.inUniverse.b ? 'in' : 'out'})`;
    if (c.eligible.a !== c.eligible.b) {
      const flipped = Object.entries(c.gates ?? {}).map(([g, v]) => `${g} ${v.a}→${v.b}`);
      return `eligibility ${c.eligible.a}→${c.eligible.b}: ${flipped.join(', ') || 'no gate flag changed'}`;
    }
    return `rank (eligible on both; changed: ${Object.keys({ ...(c.rule ?? {}), ...(c.market ?? {}) }).join(', ') || 'nothing — seat/buffer'})`;
  };

  return {
    index,
    sameCommitBehaviour: onlyA.length === 0 && onlyB.length === 0 && candidates.length === 0,
    membersOnlyA: onlyA.map((s) => ({ symbol: s, why: why(s) })),
    membersOnlyB: onlyB.map((s) => ({ symbol: s, why: why(s) })),
    eligibleCount: { a: a.eligibleCount, b: b.eligibleCount },
    reconstituted: { a: a.reconstituted, b: b.reconstituted },
    normalisation: { a: a.normalisation.logged ?? a.normalisation.inferred, b: b.normalisation.logged ?? b.normalisation.inferred },
    level: { a: a.level, b: b.level },
    weightChanges,
    candidates,
  };
}

// ------------------------------------------------------------------- main
const sides = [['A', DIR_A], ...(DIR_B ? [['B', DIR_B]] : [])];
const results = {};
fs.mkdirSync(OUT, { recursive: true });
for (const [label, dir] of sides) {
  const ref = (readText(path.join(dir, 'ref.txt')) ?? '').trim();
  results[label] = { ref, indexes: {} };
  for (const ix of INDEXES) results[label].indexes[ix] = summarise(dir, ix);
  fs.writeFileSync(
    path.join(OUT, `summary-${label}.json`),
    JSON.stringify({ ref, indexes: Object.fromEntries(INDEXES.map((ix) => [ix, results[label].indexes[ix].summary])) }, null, 2) + '\n'
  );
}

const md = [];
const fmtK = (n) => (n.logged != null ? `×${n.logged} (logged)` : n.inferred != null ? `×${n.inferred} (inferred)` : '—');
for (const [label] of sides) {
  md.push(`### Side ${label} — ${results[label].ref}`);
  md.push('');
  md.push('| index | exit | recon | today → rehearsed | in | out | ×k | eligible | marketsSource | categorySource | deferred |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const ix of INDEXES) {
    const s = results[label].indexes[ix].summary;
    md.push(
      `| ${ix} | ${s.exitCode ?? '—'} | ${s.reconstituted ?? '—'} | ${s.today.length} → ${s.members.length} | ${s.in.join(' ') || '—'} | ${s.out.join(' ') || '—'} | ${fmtK(s.normalisation)} | ${s.eligibleCount ?? '—'} | ${s.marketsSource ?? '—'} | ${s.categorySource ?? '—'} | ${s.reconstitutionDeferred ? s.reconstitutionDeferred.reason : '—'} |`
    );
  }
  md.push('');
}

if (DIR_B) {
  const diff = {
    a: results.A.ref,
    b: results.B.ref,
    indexes: Object.fromEntries(INDEXES.map((ix) => [ix, diffIndex(ix, results.A.indexes[ix], results.B.indexes[ix])])),
  };
  fs.writeFileSync(path.join(OUT, 'diff.json'), JSON.stringify(diff, null, 2) + '\n');
  md.push(`### A vs B — members and eligibility`);
  md.push('');
  md.push('| index | only in A | only in B | eligible A/B | candidates that differ |');
  md.push('| --- | --- | --- | --- | --- |');
  for (const ix of INDEXES) {
    const d = diff.indexes[ix];
    const names = (xs) => xs.map((x) => `${x.symbol} (${x.why})`).join('; ') || '—';
    md.push(
      `| ${ix} | ${names(d.membersOnlyA)} | ${names(d.membersOnlyB)} | ${d.eligibleCount.a ?? '—'}/${d.eligibleCount.b ?? '—'} | ${d.candidates.map((c) => c.symbol).join(' ') || '—'} |`
    );
  }
  md.push('');
}
console.log(md.join('\n'));
