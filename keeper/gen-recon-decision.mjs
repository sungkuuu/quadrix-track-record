/**
 * Renders a DRAFT decision document for one basket's registry reconstitution
 * from its plan file (keeper/basket-plan.mjs) and that day's record row.
 *
 * The announcement on chain carries the sha256 of an anchored decision
 * document; this script writes the text a person then reads, corrects and
 * anchors (anchor-decision workflow). It anchors nothing, appends nothing to
 * trackrecord/decisions.jsonl, and refuses to overwrite an existing file
 * unless --force. The first line of the output is a DRAFT marker — delete it
 * before anchoring (the sha256 the announcement carries is the anchored
 * file's, read back from decisions.jsonl; never this draft's).
 *
 * Usage:
 *   node keeper/gen-recon-decision.mjs --index qrev [--date YYYY-MM-DD | --plan p] [--out p] [--force]
 *
 * Default output: trackrecord/decisions/{date}-{index}-basket-reconstitution.md
 * (the path the plan and the pending-registry file both name).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEXES, TICKER, loadPlan, latestPlan, planPath, recordRow, sha256 } from './basket-plan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const INDEX = opt('--index', null);
if (!INDEXES.includes(INDEX)) {
  console.error(`usage: node keeper/gen-recon-decision.mjs --index ${INDEXES.join('|')} [--date YYYY-MM-DD | --plan p] [--out p] [--force]`);
  process.exit(2);
}
const planFile = opt('--plan', null) ?? (opt('--date', null) ? planPath(INDEX, opt('--date')) : latestPlan(INDEX));
if (!planFile || !fs.existsSync(planFile)) {
  console.error(`no plan file for ${INDEX}${opt('--date', null) ? ` on ${opt('--date')}` : ''} — run keeper/basket-plan.mjs first`);
  process.exit(1);
}
const plan = loadPlan(planFile);
const T = TICKER[INDEX];
const row = recordRow(INDEX, plan.date);
const out = opt('--out', path.join(ROOT, plan.decisionFile));
if (fs.existsSync(out) && !flag('--force')) {
  console.error(`${path.relative(ROOT, out)} exists — pass --force to overwrite the draft`);
  process.exit(1);
}

const pct = (x) => `${(Number(x) * 100).toFixed(2)}%`;
const pt = (x) => `${Number(x) >= 0 ? '+' : ''}${Number(x).toFixed(1)} pt`;

// The plan's own arithmetic must agree with itself before any of it is
// printed for anchoring: the weights it expects after its fills
// (expectedPostTradeWeights) are what the auctions are sized to reach
// (tradeTargetWeight, which the executor verifies against). A removal split
// over two buys is where they can diverge; more than half a point apart on
// any traded name is a planner defect, not a rounding.
const CROSS_CHECK_TOL = 0.005;
const crossCheck = plan.expectedPostTradeWeights
  .map((w) => ({ ...w, target: plan.targets.find((t) => t.symbol === w.symbol) }))
  .filter((w) => w.target?.traded)
  .map((w) => ({ ...w, gap: Math.abs(Number(w.weight) - Number(w.target.tradeTargetWeight)) }));
const off = crossCheck.filter((w) => w.weight < -1e-9 || w.gap > CROSS_CHECK_TOL);
if (off.length) {
  console.error(`plan arithmetic disagrees with itself — not rendering a document to anchor: ${off.map((w) => `${w.symbol} expected ${pct(w.weight)} after fills vs trade target ${pct(w.target.tradeTargetWeight)}`).join('; ')} (keeper/basket-plan.mjs computeTrades)`);
  process.exit(1);
}
const short = (a) => (a ? `\`${a}\`` : '_to be deployed_');
const days = Number(plan.vaultState.registryDelay ?? 604800) / 86400;
const eta = plan.announce?.etaIso ? plan.announce.etaIso.slice(0, 10) : `announce + ${days} days`;
const owner = plan.vaultState.owner;
const keeper = plan.vaultState.keeper;
const rolesCollapsed = owner.toLowerCase() === keeper.toLowerCase();
const bidder = plan.fills?.[0]?.bidder ?? null;
const bookWeight = (sym) => plan.targets.find((t) => t.symbol === sym)?.targetWeight;
const rowWeight = (sym) => row?.members?.find((m) => m.symbol === sym)?.weight;
// qX20 has no record series: its day is the keeper book and the NAV mark.
const navMark = INDEX === 'qx20' && fs.existsSync(path.join(ROOT, 'keeper', 'nav-marks.jsonl'))
  ? fs.readFileSync(path.join(ROOT, 'keeper', 'nav-marks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => String(m.postedAt).slice(0, 10) === plan.date).pop() ?? null
  : null;
const qx20State = INDEX === 'qx20' && fs.existsSync(path.join(ROOT, 'keeper', 'state.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'keeper', 'state.json'), 'utf8')) : null;
const unfunded = plan.adds.filter((a) => !plan.trades.some((t) => t.buy === a.symbol));

const lines = [];
lines.push(`<!-- DRAFT — generated ${new Date().toISOString()} by keeper/gen-recon-decision.mjs from ${path.relative(ROOT, planFile)}. Review every number, delete this line, then anchor with the anchor-decision workflow. The generator anchors nothing. -->`);
// What is still open, as a comment outside the document body (deleted with
// the DRAFT line before anchoring).
const toFill = [];
if (plan.adds.some((a) => !a.address)) toFill.push(`mock addresses of ${plan.adds.filter((a) => !a.address).map((a) => a.symbol).join(', ')}: deploy them (basket-recon-setup, task deploy-mocks), re-run the plan stage with mocks=keeper/mocks/${plan.date}.json, then regenerate this draft with --force — the address and decimals columns and the Pinned table come from that plan`);
if (INDEX !== 'qx20' && !row) toFill.push(`the record row of ${plan.date} (seq, hash): none was present when this draft was generated`);
if (INDEX === 'qx20' && !navMark) toFill.push(`the qX20 NAV mark of ${plan.date} (keeper/nav-marks.jsonl): none was present`);
toFill.push(`after anchoring: trackrecord/decisions.jsonl gives this document's id and sha256 (the plan stage's decision input) and the anchor tx — none of them goes into this document, which is anchored before the announcement exists; the announce tx and the ETA are written to keeper/plans/${INDEX}/<date>.json by the announce stage`);
lines.push(`<!-- TO FILL / CHECK BEFORE ANCHORING (delete with the line above): ${toFill.map((x, i) => `(${i + 1}) ${x}`).join(' ')} -->`);
lines.push(`# ${T} basket — registry reconstitution of ${plan.date}`);
lines.push('');
const seriesLine = INDEX === 'qx20'
  ? `the qX20 keeper book (\`keeper/state.json\`${qx20State?.reconstitutedIn ? `, reconstituted for ${qx20State.reconstitutedIn}` : ''}) and its NAV marks (\`keeper/nav-marks.jsonl\`)${navMark ? `; the mark of ${plan.date}: level ${navMark.level}, tx \`${navMark.txHash}\`` : ''}`
  : `\`trackrecord/record-${INDEX}.jsonl\`${row ? `, row seq ${row.seq} of ${row.date} (hash \`${row.hash}\`, reconstituted ${row.reconstituted === true})` : ''}`;
lines.push(`**Decided:** ${plan.date}, on the keeper's reconstitution of the same day${plan.keeperRun ? ` (run ${plan.keeperRun.id})` : ''}. **Effective on chain:** announced ${plan.announce ? `${plan.announce.at.slice(0, 10)} (tx \`${plan.announce.txHash}\`)` : 'on the day this document is anchored'}; executable from ${eta} — \`REGISTRY_DELAY\` is ${days} days and is not shortened. **Series:** ${seriesLine}. **Vault:** \`${plan.vault}\` (GIWA Sepolia, chain ${plan.chainId}), \`assetCount\` ${plan.vaultState.assetCount} at block ${plan.block.number}.`);
lines.push('');
lines.push('## What enters');
lines.push('');
if (plan.adds.length === 0) lines.push('Nothing enters the registry in this change.');
else {
  lines.push(`| Name | Mock (GIWA Sepolia) | Decimals | Book weight | First reference price on ${plan.date} (USD × 1e18 per base unit) | Source A | Source B | Apart |`);
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const a of plan.adds) {
    lines.push(`| ${a.symbol} | ${short(a.address)} | ${a.decimals} (${a.decimalsSource.startsWith('onchain') ? 'read from the mock' : 'by the price rule; re-read from the mock before posting'}) | ${pct(bookWeight(a.symbol))} | \`${a.firstRefPrice}\` | ${a.priceA} | ${a.priceB ?? '—'} | ${a.disagreementBps ?? '—'} bp |`);
  }
  lines.push('');
  lines.push(`The first reference price of a new asset is band-free by construction (\`setRefPrice\` applies the ±15% band only from the second post), so it is the one number in this change that nothing on chain bounds. Policy: it is posted only when two independent sources agree within ${pct(plan.policy.firstPriceTolBps / 10_000)} and the mock's \`decimals()\` on chain equals the value above; a wrong decimal is a 10× price and the band then needs about fifteen steps to walk it back. The price posted is taken from the two sources on the execution day, when the plan is regenerated; the prices above are those of ${plan.date}.`);
}
lines.push('');
lines.push('## What leaves');
lines.push('');
if (plan.removes.length === 0) lines.push('Nothing leaves the registry in this change.');
else {
  lines.push('| Name | Mock | Vault balance at planning | Already in removal |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of plan.removes) lines.push(`| ${r.symbol} | \`${r.address}\` | ${r.balance} | ${r.inRemoval ? 'yes' : 'no'} |`);
  lines.push('');
  lines.push('A leaving asset stays in every redemption payout until auctions drain its balance to exactly zero; only then does `finalizeRemoval` drop it, by swap-and-pop, which changes the on-chain order of the remaining assets. The site\'s creation vector must follow `assets(i)`, not the manifest.');
  lines.push('');
  lines.push(`\`finalizeRemoval\` is called right after the auction that drains the asset. Anything that reaches the vault in between — a transfer from anyone, or the pro-rata slice a creation pays in — is drained again at once (a remainder under $1 is filled at the start of the curve, at most 2% above reference), up to five times; after that the asset is recorded as pending, disclosed, and drained again in a later session. A pending remainder stays in redemption payouts and does not change the record.`);
}
lines.push('');
lines.push('## Target weights and the vault today');
lines.push('');
lines.push(`"Target (book)" is the keeper's book after the reconstitution, at the plan's prices; "vault" is the vault's holdings at the same prices.${row ? ' "Record row" is the weight the day\'s record row prints, at the record\'s prices; on a reconstitution day the two can differ, because the book keeps a name inside the tolerance at its drifted unit count.' : ''} Rule: a name whose vault weight is within ${plan.policy.tolerancePoints} points of target is not traded${plan.policy.capMaxWeight ? `; any name above the ${pct(plan.policy.capMaxWeight)} cap is always cut` : ''}${plan.policy.sleeve ? '; if any sleeve is outside the tolerance every sleeve resets to target' : ''}.`);
lines.push('');
lines.push(`| Name |${plan.policy.sleeve ? ' Sleeve |' : ''} Target (book) |${row ? ' Record row |' : ''} Vault | Drift | Action | Auctions aim at |`);
lines.push(`| --- |${plan.policy.sleeve ? ' --- |' : ''} --- |${row ? ' --- |' : ''} --- | --- | --- | --- |`);
for (const t of [...plan.targets].sort((a, b) => b.targetWeight - a.targetWeight)) {
  lines.push(`| ${t.symbol} |${plan.policy.sleeve ? ` ${t.sleeve ?? ''} |` : ''} ${pct(t.targetWeight)} |${row ? ` ${rowWeight(t.symbol) != null ? pct(rowWeight(t.symbol)) : '—'} |` : ''} ${pct(t.currentWeight)} | ${pt(t.driftPoints)} | ${t.traded ? `trade (${t.reason})` : 'hold'} | ${t.traded ? pct(t.tradeTargetWeight ?? t.targetWeight) : '—'} |`);
}
lines.push('');
lines.push('"Auctions aim at" is what the trades can reach while the held names keep their value: the traded set shares its own value in proportion to the book targets. The gap to the book target on a traded name is the tolerance rule holding the others back, not a shortfall of the session.');
lines.push('');
lines.push('## The seven-day lag');
lines.push('');
lines.push(`The paper index reconstituted on ${plan.date}; the record row of that day carries the new membership and weights. The vault cannot: \`announceRegistryChange\` fixes the tuple (adds, removes, this document's sha256) and \`executeRegistryChange\` accepts exactly that tuple only after ${days} days — from ${eta}. Between the two the vault holds the old shape, \`navPerShare\` keeps tracking the index, and redemptions pay the old shape. Only one change can be pending per vault and announcing again restarts the clock, so the tuple above is not to be amended by a second announcement. The tracking difference over the lag week is published, not hidden.`);
lines.push('');
lines.push('## Auction policy in force');
lines.push('');
lines.push(`- Every weight change goes through the vault's bounded dutch auctions (keeper opens \`openAuction(sell, buy, amount, ${plan.policy.duration} s)\`; the curve runs from +${Number(plan.vaultState.premiumBps) / 100}% to −${Number(plan.vaultState.maxFillLossBps) / 100}% of the reference over the duration; per-fill floor ${Number(plan.vaultState.maxFillLossBps)} bp and daily budget ${Number(plan.vaultState.dailyLossBudgetBps)} bp are the contract's and are not changed).`);
lines.push(`- Fills by our own bidder are taken at the curve's fair point (\`fill\` policy \`${plan.policy.fill}\`: factor 10,000 to 10,010 bp, \`lossAtRef\` 0), so share value at reference prices is unchanged by the session and the record shows no gift either way. The one exception is a remainder under $1 of a leaving asset, filled at the start of the curve (at most 2% above reference) so that the removal can be finalized at once.${bidder ? ` Bidder: \`${bidder}\`.` : ''}`);
lines.push(`- During a session a reference price is re-posted only at the value already on chain (to refresh the v3.1 staleness clock, \`maxRefAge\` ${Number(plan.vaultState.maxRefAge)} s); a session never moves a reference, and it refuses to start while any reference is more than ${pct(plan.policy.refDriftTolBps / 10_000)} away from the day's mark.`);
lines.push(`- Roles as deployed: owner \`${owner}\`, keeper \`${keeper}\`${rolesCollapsed ? ' — the same key, which is also whitelisted to create and to bid. This is the testnet shape and not the mainnet one; the contract cannot bound a keeper that both marks and fills, so every safety of this reconstitution rests on the script guards stated here.' : '.'} Fills are signed by a whitelisted bidder; \`setBidder\` emits no event, so each whitelisting transaction is listed in \`keeper/bidder-log.jsonl\`.`);
lines.push('');
lines.push('## Planned auctions');
lines.push('');
if (plan.trades.length === 0) {
  lines.push(unfunded.length
    ? `None. Every held name is inside the tolerance, and an entering name is bought only with the value of names the auctions trade, so ${unfunded.map((a) => a.symbol).join(', ')} ${unfunded.length > 1 ? 'enter' : 'enters'} the registry with a zero balance and ${unfunded.length > 1 ? 'are' : 'is'} bought only when a later session trades the names that would pay for ${unfunded.length > 1 ? 'them' : 'it'}. Until then the vault holds 0% of ${unfunded.length > 1 ? 'them' : 'it'} against ${unfunded.map((a) => `${pct(bookWeight(a.symbol))}`).join(', ')} in the book.`
    : 'None — the registry change alone; no weight-only trade is inside the rule.');
}
else {
  lines.push('| # | Sell | Buy | Sell amount (base units) | ≈ USD | Duration | Note |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of plan.trades) lines.push(`| ${t.seq} | ${t.sell} | ${t.buy} | ${t.sellAmount} | ${Math.round(t.sellValueUsd).toLocaleString('en-US')} | ${t.duration} s | ${t.drain ? 'drains the removal to zero' : t.reason} |`);
  lines.push('');
  const aims = plan.targets.filter((t) => t.traded && !plan.removes.some((r) => r.symbol === t.symbol));
  const worstGap = crossCheck.reduce((m, w) => Math.max(m, w.gap), 0);
  lines.push(`The amounts and weights here are those of the plan of ${plan.date}. On the execution day the plan is regenerated with that day's prices and balances under the same rules, and the session follows that plan; a removal's last slice sells whatever balance remains. The auctions aim at, and the executor verifies against, these weights of the traded names: ` + aims.map((t) => `${t.symbol} ${pct(t.tradeTargetWeight)}`).join(', ') + `${plan.removes.length ? `; ${plan.removes.map((r) => r.symbol).join(', ')} drained to zero` : ''}. The plan's own projection of the weights after these fills at its prices agrees with those targets within ${(worstGap * 100).toFixed(2)} pt (generator tolerance ${CROSS_CHECK_TOL * 100} pt).`);
}
lines.push('');
lines.push('## Pinned');
lines.push('');
lines.push(`| Item | Value |`);
lines.push(`| --- | --- |`);
lines.push(`| Plan file | \`${path.relative(ROOT, planFile)}\` sha256 \`${sha256(fs.readFileSync(planFile))}\` (generated ${plan.generatedAt}) |`);
lines.push(`| Rulebook | \`${plan.sources.rulebook.path}\` sha256 \`${plan.sources.rulebook.sha256}\` |`);
lines.push(`| Book | \`${plan.sources.book}\` |`);
lines.push(`| Prices | A: ${plan.sources.priceA}; B: ${plan.sources.priceB} |`);
if (row) lines.push(`| Record row | seq ${row.seq}, \`${row.hash}\` |`);
if (plan.keeperRun) lines.push(`| Keeper run | ${plan.keeperRun.workflow ?? ''} ${plan.keeperRun.id} |`);
lines.push(`| Chain read | block ${plan.block.number} (${new Date(Number(plan.block.timestamp) * 1000).toISOString()}) |`);
lines.push('');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote DRAFT ${path.relative(ROOT, out)} (${lines.length} lines; draft sha256 ${sha256(fs.readFileSync(out))} — changes when the marker line is removed; anchor nothing from here)`);
