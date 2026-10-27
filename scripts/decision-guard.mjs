/**
 * The "is this decision final?" check that scripts/anchor-decision.mjs runs
 * before it reads the key. An anchor cannot be undone, so every way a draft
 * marks itself — or marks a value it has not filled yet — is refused here.
 *
 * findUnfinished(text) returns one entry per hit: { rule, line, text }, the
 * line being 1-based and the text the trimmed source line. An empty list
 * means the document carries no marker this check knows.
 *
 * Run directly it checks files without touching a key or the chain (a dry run
 * of the anchor guard), prints every hit and exits 1 if any file has one:
 *
 *   node scripts/decision-guard.mjs trackrecord/decisions/<file>.md [...]
 *
 * Why each rule exists:
 * - A generated draft (keeper/gen-recon-decision.mjs) carries a DRAFT marker,
 *   a TO FILL comment and, before the mocks exist, "_to be deployed_" in place
 *   of addresses.
 * - Hand-written drafts open their comment box with a rule of "=" before the
 *   word DRAFT, and mark unfilled values ⟦…⟧ or TO FILL / TO-FILL-… in the
 *   body (reviews of 2026-10-05).
 * - Other hand-written drafts mark unfilled values ⟨…⟩, 〔…〕 or ［…］, write
 *   dates as YYYY-MM-DD, and say DRAFT in a quote-block banner or a heading
 *   instead of an HTML comment; none of those matched the rules above
 *   (review of 2026-10-15). They are refused as well, together with {{ }},
 *   TODO / TBD / FIXME, XXX / xxx, a bare `0x…`, `0xXXXX` / `0x____`, a bare
 *   `0x` in code and an empty sha256 (all zeros, or an ellipsis alone). A
 *   bytes32 zero quoted inside a code span as an argument of a contract call
 *   (`cast call … hashOperation(…) … 0x000…`) is a value and passes.
 *
 * The lower-case word "draft" is NOT refused everywhere: anchored decisions
 * use it in running text ("the depeg rule in the rulebook draft", "column
 * header 'draft value'"). It is refused in upper case anywhere, and in any
 * case where a draft announces itself: inside an HTML comment, in a quote
 * block, in a heading, emphasised, at the start of a line, as "Status: draft"
 * or as "draft · not anchored / final / a decision". A truncated real hash
 * (`caa07149f67ff7a9…`) is not an empty sha256 and passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNFINISHED = [
  // Draft banners and comment boxes.
  { rule: 'HTML comment opening with DRAFT', re: /<!--\s*DRAFT/gi },
  { rule: 'HTML comment opening with TO FILL', re: /<!--\s*TO FILL/gi },
  { rule: 'DRAFT / TO FILL inside an HTML comment', re: /<!--(?:(?!-->)[\s\S])*?\b(?:DRAFT|TO FILL)\b/gi },
  { rule: 'DRAFT in upper case', re: /\bDRAFT\b/g },
  { rule: '"draft" in a quote block', re: /^[ \t]*>.*\bdraft\b/gim },
  { rule: '"draft" in a heading', re: /^[ \t]*#{1,6}[ \t].*\bdraft\b/gim },
  { rule: '"draft" at the start of a line', re: /^[ \t]*(?:[*_~]+[ \t]*)?draft\b/gim },
  { rule: '"draft" emphasised', re: /(?:\*|\b_)[ \t]*draft\b/gi },
  { rule: '"Status: draft"', re: /\bstatus\b[*_ \t]*:[*_ \t]*draft\b/gi },
  { rule: '"draft · not anchored / final / a decision"', re: /\bdraft\b[^\n]{0,4}\bnot (?:anchored|final|a decision)\b/gi },
  // Values left unfilled.
  { rule: 'TO FILL marker', re: /\bTO[- ]FILL\b/g },
  { rule: '_to be deployed_', re: /_to be deployed_/g },
  { rule: 'TODO / TBD / FIXME', re: /\b(?:TODO|TBD|FIXME)\b/gi },
  { rule: 'placeholder bracket ⟦ ⟧', re: /[⟦⟧]/g },
  { rule: 'placeholder bracket ⟨ ⟩ 〈 〉', re: /[⟨⟩〈〉〈〉]/g },
  { rule: 'placeholder bracket 〔 〕 【 】', re: /[〔〕【】]/g },
  { rule: 'placeholder bracket ［ ］', re: /[［］]/g },
  { rule: 'template braces {{ }}', re: /\{\{|\}\}/g },
  { rule: 'placeholder XXX', re: /(?<![0-9A-Za-z-])(?:XXX+|xxx+)(?![0-9A-Za-z])/g },
  // A bare 0x… / 0x... (nothing after the ellipsis) is a placeholder; a
  // shortened real value (0x5F1F…19F6, or 0x…19F6 with its tail) passes.
  { rule: 'placeholder 0x…', re: /(?<![0-9A-Za-z])0x(?:…|\.{3})(?![0-9A-Fa-f])/g },
  { rule: 'placeholder 0xXXXX / 0x____', re: /(?<![0-9A-Za-z])0x(?:[Xx]{2,}|_{2,})(?![0-9A-Za-z])/g },
  { rule: 'bare 0x in code', re: /`0x`/g },
  {
    rule: 'date placeholder (YYYY-MM-DD, 2026-10-XX, …)',
    re: /\bY{4}\b|\b(?:\d{4}|20XX)-(?:MM|XX)\b|\b\d{4}-(?:\d{2}|MM|XX)-(?:DD|XX)\b|\bMM-DD\b/gi,
  },
  // An empty sha256: 64 zeros, a run of zeros cut with an ellipsis, or the
  // label followed by nothing but an ellipsis. One exception: a bytes32 zero
  // passed as an argument of a contract call quoted in code (a timelock's
  // predecessor or salt in a decision's verification steps) is a real value.
  // It is skipped only when the zeros sit inside the same backtick span as,
  // and after, `cast call` / `cast send` / `cast calldata` or a call opening
  // `hashOperation(` / `schedule(` / `execute(`; a word in the prose (bytes32,
  // schedule, execute) does not exempt a line.
  {
    rule: 'empty sha256 (all zeros)',
    re: /(?<![0-9a-f])(?:0x)?0{64}(?![0-9a-f])/gi,
    skipMatch: (line, col) => {
      const open = line.lastIndexOf('`', col);
      if (open === -1) return false;
      const before = line.slice(0, open).split('`').length - 1; // backticks before the opening one
      if (before % 2 !== 0) return false; // `open` closes a span: the zeros are outside code
      const close = line.indexOf('`', col);
      if (close === -1) return false;
      const span = line.slice(open + 1, col);
      return /\bcast (?:call|send|calldata)\b|\bhashOperation\(|\bschedule\(|\bexecute\(/.test(span);
    },
  },
  { rule: 'empty sha256 (0000…)', re: /(?<![0-9a-f.,])0{4,}(?:…|\.{3})/gi },
  { rule: 'empty sha256 (ellipsis only)', re: /\bsha-?256\b[ \t:=`*|]*(?:…|\.{3})/gi },
];

export function findUnfinished(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const hits = [];
  const seen = new Set();
  for (const { rule, re, skipMatch } of UNFINISHED) {
    for (const m of text.matchAll(re)) {
      // Report the line where the match ends: for a multi-line comment box
      // that is the line carrying the word DRAFT / TO FILL.
      const idx = lineAt(m.index + Math.max(m[0].length - 1, 0));
      const key = `${rule}\u0000${idx}`;
      if (seen.has(key)) continue;
      const end = idx + 1 < starts.length ? starts[idx + 1] - 1 : text.length;
      const line = text.slice(starts[idx], end).replace(/\r$/, '');
      if (skipMatch && skipMatch(line, m.index - starts[idx])) continue;
      seen.add(key);
      hits.push({ rule, line: idx + 1, text: line.trim() });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function formatHits(hits, max = 40) {
  const shown = hits.slice(0, max).map((h) => {
    const t = h.text.length > 160 ? `${h.text.slice(0, 157)}...` : h.text;
    return `  line ${h.line} [${h.rule}]: ${t}`;
  });
  if (hits.length > max) shown.push(`  ... and ${hits.length - max} more`);
  return shown.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/decision-guard.mjs <decision .md> [...]');
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const hits = findUnfinished(fs.readFileSync(f, 'utf8'));
    if (hits.length) {
      bad += 1;
      console.log(`${f}: not final (${hits.length} hit${hits.length === 1 ? '' : 's'})\n${formatHits(hits)}`);
    } else {
      console.log(`${f}: final`);
    }
  }
  process.exit(bad ? 1 : 0);
}
