/**
 * Freshness of the daily series that scripts/watchdog.mjs did not watch: the
 * five paper indexes, the leverage levels and the qVOL realized line (run
 * sheet option 18, design checklist D14 "an alarm that catches the job not
 * running at all").
 *
 * A job that never starts raises no failure of its own, so this reads only the
 * outputs. For each series it flags three cases:
 *
 *   missing    — the series' latest inception decision in trackrecord/decisions.jsonl
 *                puts its first line on day I, more than 16 hours have passed since
 *                I 00:00 UTC, and record-<series>.jsonl does not exist or is empty.
 *                A paper or leverage decision (`<date>-<series>-paper-inception`)
 *                is effective on I; the qVOL decision (`<date>-qvol-inception`)
 *                is effective the day before I (it is anchored on its effective
 *                day and the first line is dated the next UTC day);
 *   stale      — the last line is dated D, more than 40 hours have passed since
 *                D 00:00 UTC, and the line is not a model liquidation (a
 *                liquidated series has ended and writes nothing more);
 *   unanchored — a line has no anchor with a 0x… transaction hash in
 *                anchors-<series>.jsonl.
 *
 * The limits (review 2 minor 9, red team F07a; monitoring thresholds, not rule
 * parameters): these series are dated by the day they are written on, so line
 * D + 1 is due at the daily run of D + 1, scheduled 00:25 UTC and observed up
 * to about 7 h late. 40 h after D 00:00 is about 9 h past that; the genesis
 * line gets the same margin, 16 h after I 00:00. With the watchdog running
 * every 6 hours at :47, a missed opening line is flagged at 18:47 UTC of day I.
 * (The LIVE check's 30 h counts from the close of the record's day, about 6 h
 * after its next run.)
 *
 * A series with neither a record file nor an inception decision has not started
 * and is not a problem. A postponed opening is a later inception decision; the
 * latest one counts (red team F07b). Pure: it reads files under `dir` and takes
 * `now`, so the tests fix the clock (keeper/test/watchdog-series.test.mjs).
 *
 * `simulate` trips one case on purpose so the alert path can be tested:
 * series-missing | series-stale | series-anchor.
 *
 * Fresh and anchored says that lines exist, not that they are right. For the
 * qVOL realized line, recomputeSeries also runs the public verifier on the
 * record (red team R47 F5): `node scripts/verify.mjs --dir <dir> --series qvol
 * --recompute-only` — hashes and chain, every value recomputed by
 * scripts/verify-vol.mjs, the first line bound to its decision; no network.
 * Its failure is a problem line. A series not started or pending passes there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// qvol before the leverage levels: the leverage keeper's own table (keeper/leverage-index.mjs INDEXES) is the last three entries
export const SERIES = ['qrev', 'qdefi', 'barbell', 'triens', 'qai', 'qvol', 'qbtc2x', 'qeth2x', 'qeth15'];
/** The inception decision of a series and the day of its first line: qVOL's decision is effective the day before its first line. */
const INCEPTION = { qvol: { id: /^\d{4}-\d{2}-\d{2}-qvol-inception$/, firstLineAfterDays: 1 } };
const inceptionSpec = (key) => INCEPTION[key] ?? { id: new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${key}-paper-inception$`), firstLineAfterDays: 0 };
export const LIMIT_H = 40; // stale: hours after D 00:00 UTC of the last line
export const LIMIT_MISSING_H = 16; // missing: hours after I 00:00 UTC of the inception
export const SIMULATE = ['series-missing', 'series-stale', 'series-anchor'];
const H = 3600 * 1000;
const TX = /^0x[0-9a-f]{64}$/i;

function readLines(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const dayStart = (d) => Date.parse(`${d}T00:00:00Z`);

/**
 * @param {{dir: string, now: number, simulate?: string|null, series?: string[]}} o
 *   dir = the trackrecord folder; now = milliseconds since the epoch
 * @returns {{problems: string[], summary: string[]}}
 */
export function checkSeries({ dir, now, simulate = null, series = SERIES }) {
  if (simulate !== null && !SIMULATE.includes(simulate)) throw new Error(`unknown simulate name ${simulate} (one of ${SIMULATE.join(', ')})`);
  const problems = [];
  const summary = [];
  const decisions = readLines(path.join(dir, 'decisions.jsonl')) ?? [];
  let tripped = false;
  for (const key of series) {
    const spec = inceptionSpec(key);
    const inception = decisions.filter((d) => spec.id.test(d.id)).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1) ?? null;
    const records = readLines(path.join(dir, `record-${key}.jsonl`));
    const anchors = readLines(path.join(dir, `anchors-${key}.jsonl`)) ?? [];
    if (records === null || records.length === 0) {
      const trip = simulate === 'series-missing' && !tripped;
      if (inception) {
        const firstDay = new Date(dayStart(inception.effectiveFrom) + spec.firstLineAfterDays * 24 * H).toISOString().slice(0, 10);
        const ageH = (now - dayStart(firstDay)) / H;
        if (ageH > LIMIT_MISSING_H || trip) {
          problems.push(`${key}: no record-${key}.jsonl ${ageH.toFixed(1)}h after ${spec.firstLineAfterDays ? `its first line's day ${firstDay}` : `its inception ${inception.effectiveFrom}`} 00:00 UTC (decision ${inception.id}) — the daily job has not written the first line${trip ? ' [simulated]' : ''}`);
          tripped ||= trip;
        }
        summary.push(`${key} pending (inception ${inception.effectiveFrom}${spec.firstLineAfterDays ? `, first line ${firstDay}` : ''})`);
      } else {
        if (trip) {
          problems.push(`${key}: no record-${key}.jsonl [simulated — as if its inception decision were more than ${LIMIT_MISSING_H}h old]`);
          tripped = true;
        }
        summary.push(`${key} not started`);
      }
      continue;
    }
    const last = records[records.length - 1];
    const ageH = (now - dayStart(last.date)) / H;
    const tripStale = simulate === 'series-stale' && !tripped;
    const ended = !!last.liquidated; // a leverage line with a model liquidation ends its series (red team F07c)
    if ((ageH > LIMIT_H && !ended) || tripStale) {
      problems.push(`${key}: stale — latest line is ${last.date} (seq ${last.seq}), ${ageH.toFixed(1)}h after that day began; the next line is overdue${tripStale ? ' [simulated]' : ''}`);
      tripped ||= tripStale;
    }
    const anchored = new Set(anchors.filter((a) => TX.test(a.txHash || '')).map((a) => a.seq));
    for (const r of records) {
      const tripAnchor = simulate === 'series-anchor' && !tripped;
      if (!anchored.has(r.seq) || tripAnchor) {
        problems.push(`${key}: line seq ${r.seq} (${r.date}) has no anchor txHash${tripAnchor ? ' [simulated]' : ''}`);
        tripped ||= tripAnchor;
      }
    }
    summary.push(`${key} ${records.length} lines → ${last.date}${ended ? ' (ended: model liquidation)' : ''}`);
  }
  if (simulate !== null && !tripped) problems.push(`simulate ${simulate}: no series in a state that case applies to — nothing tripped, which is itself a failure of the test`);
  return { problems, summary };
}

/** The series whose record the watchdog also recomputes with scripts/verify.mjs --recompute-only (red team R47 F5). */
export const RECOMPUTE = ['qvol'];
const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify.mjs');

/**
 * Runs `node scripts/verify.mjs --dir <dir> --series <key> --recompute-only` for each series in `series`
 * and turns a failure into one problem line that names the first failures.
 * @param {{dir: string, series?: string[], verifyScript?: string}} o
 * @returns {{problems: string[], summary: string[]}}
 */
export function recomputeSeries({ dir, series = RECOMPUTE, verifyScript = VERIFY }) {
  const problems = [];
  const summary = [];
  for (const key of series) {
    const r = spawnSync(process.execPath, [verifyScript, '--dir', dir, '--series', key, '--recompute-only'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 300_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0) {
      // the verifier's own summary of the series: "QVOL 3 records 2099-02-02 → 2099-02-04", "QVOL not started", …
      const lines = out.split('\n');
      const state = lines.slice(lines.findIndex((l) => l.startsWith('VERIFIED')) + 1).map((l) => l.trim()).filter(Boolean).join('; ');
      summary.push(`${key} verifies (verify.mjs --recompute-only: ${state || 'VERIFIED'})`);
      continue;
    }
    const fails = out.split('\n').filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim().replace(/^FAIL\s+/, ''));
    const why = fails.length ? `${fails.slice(0, 3).join(' | ')}${fails.length > 3 ? ` (and ${fails.length - 3} more)` : ''}` : (r.error?.message ?? out.trim().split('\n').slice(-2).join(' | '));
    problems.push(`${key}: the record does not verify — scripts/verify.mjs --recompute-only --series ${key} exited ${r.status ?? r.signal}: ${why}`);
    summary.push(`${key} does not verify`);
  }
  return { problems, summary };
}
