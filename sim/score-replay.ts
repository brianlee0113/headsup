// Scores a replay (sim/replay-real.ts) against the person's labels of what headsup really did.
//
//   pnpm tsx sim/score-replay.ts <labels.json> [replay.json] [--list]
//
// A label is about the step-in that happened at the time (or the quiet turn). So for each label the
// question is what the new logic does on that same prompt:
//   harmful, noise   → it should be quiet now, or at least no longer show the notes that were shown
//   needed, partly   → kept if any of the notes shown then is shown now, or is already in front of the
//                      agent because the new logic gave it earlier in the same conversation
//   wrong, missing   → listed, with what the person said was needed; a person has to read these
//   fine             → it should still be quiet
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Replayed } from './replay-real.js';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = process.argv.includes('--list');
if (!args[0]) {
  console.error('usage: pnpm tsx sim/score-replay.ts <labels.json> [replay.json] [--list]');
  process.exit(1);
}
const labels = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(args[0], 'utf8')) as Record<string, string | { label: string; need?: string }>).map(([k, v]) => [k.replace(/#\d+$/, ''), typeof v === 'string' ? { label: v } : v]),
) as Record<string, { label: string; need?: string }>;
const replay = (JSON.parse(readFileSync(args[1] ?? join(ROOT, '.local', 'redesign', 'replay.json'), 'utf8')) as { prompts: Record<string, Replayed> }).prompts;

const ORDER = ['harmful', 'noise', 'wrong', 'partly', 'needed', 'fine', 'missing'];
interface Row { n: number; oldStepped: number; newStepped: number; newQuiet: number; kept: number; keptEarlier: number; sameNotesAgain: number; opening: number; missingKey: number }
const rows: Record<string, Row> = {};
const detail: string[] = [];
const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 110);

for (const [key, { label, need }] of Object.entries(labels)) {
  const row = (rows[label] ??= { n: 0, oldStepped: 0, newStepped: 0, newQuiet: 0, kept: 0, keptEarlier: 0, sameNotesAgain: 0, opening: 0, missingKey: 0 });
  row.n++;
  const r = replay[key];
  if (!r) {
    row.missingKey++;
    continue;
  }
  const then = new Set([...(r.logged?.added ?? []), ...(r.logged?.offered ?? [])].map((s) => s.id));
  const now = [...r.new.added, ...r.new.offered];
  const nowAll = new Set([...now, ...(r.new.opening ?? [])].map((s) => s.id));
  const again = [...then].filter((id) => nowAll.has(id));
  const earlier = [...then].filter((id) => r.new.held?.includes(id));
  if (r.old.decision === 'stepped') row.oldStepped++;
  if (r.new.decision === 'stepped') row.newStepped++;
  else row.newQuiet++;
  if (r.new.opening?.length) row.opening++;
  if (again.length) row.kept++;
  else if (earlier.length) row.keptEarlier++;
  if (now.some((s) => then.has(s.id))) row.sameNotesAgain++;
  if (list || label === 'wrong' || label === 'missing') {
    detail.push(`\n[${label}] ${r.agent} @${r.project}${r.fresh ? ' (opening)' : ''} · ${short(r.prompt)}${need ? `\n   person wanted: ${need}` : ''}`);
    for (const s of r.logged?.added ?? []) detail.push(`   then +  ${short(s.body)}`);
    for (const s of r.logged?.offered ?? []) detail.push(`   then ?  ${short(s.body)}`);
    for (const s of r.new.opening ?? []) detail.push(`   now  ○  (opening) ${short(s.body)}`);
    for (const s of r.new.added) detail.push(`   now  +  [${s.why}] ${short(s.body)}`);
    for (const s of r.new.offered) detail.push(`   now  ?  [${s.why}] ${short(s.body)}`);
    if (earlier.length) detail.push(`   now  =  ${earlier.length} of the notes shown then were already given earlier in this conversation`);
    if (!now.length && !r.new.opening?.length) detail.push('   now     quiet');
  }
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log('label      n   old logic   new: stepped  quiet   same note   note from then still served');
console.log('               stepped                           shown again  (now / earlier in conversation)');
for (const label of [...ORDER, ...Object.keys(rows).filter((l) => !ORDER.includes(l))]) {
  const r = rows[label];
  if (!r) continue;
  console.log(`${label.padEnd(8)} ${pad(r.n, 3)} ${pad(r.oldStepped, 9)} ${pad(r.newStepped, 14)} ${pad(r.newQuiet, 6)} ${pad(r.sameNotesAgain, 11)} ${pad(`${r.kept} / ${r.keptEarlier}`, 14)}${r.missingKey ? `   (${r.missingKey} not in replay)` : ''}`);
}
const sum = (ls: string[], f: (r: Row) => number) => ls.reduce((n, l) => n + (rows[l] ? f(rows[l]!) : 0), 0);
const bad = ['harmful', 'noise'];
const good = ['needed', 'partly'];
console.log(`\nharmful + noise: ${sum(bad, (r) => r.newQuiet)}/${sum(bad, (r) => r.n)} quiet now, ${sum(bad, (r) => r.sameNotesAgain)} show one of the same notes again`);
console.log(`needed + partly: ${sum(good, (r) => r.kept + r.keptEarlier)}/${sum(good, (r) => r.n)} still get a note they got then (${sum(good, (r) => r.keptEarlier)} because it was given earlier in the conversation)`);
console.log(`fine (rightly quiet): ${rows.fine ? rows.fine.newQuiet : 0}/${rows.fine?.n ?? 0} still quiet`);
if (detail.length) console.log(detail.join('\n'));
