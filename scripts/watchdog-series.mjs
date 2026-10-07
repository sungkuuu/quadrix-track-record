/**
 * Freshness of the daily series that scripts/watchdog.mjs did not watch: the
 * five paper indexes and the two leverage levels (run sheet option 18, design
 * checklist D14 "an alarm that catches the job not running at all").
 *
 * A job that never starts raises no failure of its own, so this reads only the
 * outputs. For each series it flags three cases:
 *
 *   missing    — the series' latest inception decision in trackrecord/decisions.jsonl
 *                is effective from day I, more than 16 hours have passed since
 *                I 00:00 UTC, and record-<series>.jsonl does not exist or is empty;
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
 */
import fs from 'node:fs';
import path from 'node:path';

export const SERIES = ['qrev', 'qdefi', 'barbell', 'triens', 'qai', 'qbtc2x', 'qeth2x'];
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
    const inception = decisions.filter((d) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${key}-paper-inception$`).test(d.id)).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1) ?? null;
    const records = readLines(path.join(dir, `record-${key}.jsonl`));
    const anchors = readLines(path.join(dir, `anchors-${key}.jsonl`)) ?? [];
    if (records === null || records.length === 0) {
      const trip = simulate === 'series-missing' && !tripped;
      if (inception) {
        const ageH = (now - dayStart(inception.effectiveFrom)) / H;
        if (ageH > LIMIT_MISSING_H || trip) {
          problems.push(`${key}: no record-${key}.jsonl ${ageH.toFixed(1)}h after its inception ${inception.effectiveFrom} 00:00 UTC (decision ${inception.id}) — the daily job has not written the first line${trip ? ' [simulated]' : ''}`);
          tripped ||= trip;
        }
        summary.push(`${key} pending (inception ${inception.effectiveFrom})`);
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
