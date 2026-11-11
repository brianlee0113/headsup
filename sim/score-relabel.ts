// How the person's labels of one replay fare under a later one.
//
//   pnpm tsx sim/score-relabel.ts <replay-labels.json> <labeled-replay.json> [new-replay.json] [--list]
//
// The labels (sim/label-replay.ts) are about what a replay's logic did: `opening:<note id>` for each note of
// the answer-style block (keep | project | drop), and a prompt key for each step-in (needed | partly |
// wrong | noise | harmful). For each, this says what the new replay does with the same note or prompt:
//   keep            → still in the opening block
//   project, drop   → out of the opening block (and for "project": whether it is still reachable as a task note)
//   needed          → the same notes still come (now, or already given earlier in that conversation)
//   noise, harmful  → quiet now, or at least none of the same notes
//   partly, wrong   → listed; a person has to read these
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Replayed } from './replay-real.js';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = process.argv.includes('--list');
if (!args[1]) {
  console.error('usage: pnpm tsx sim/score-relabel.ts <replay-labels.json> <labeled-replay.json> [new-replay.json] [--list]');
  process.exit(1);
}
const labels = JSON.parse(readFileSync(args[0]!, 'utf8')) as Record<string, { label: string; why?: string }>;
const load = (f: string) => (JSON.parse(readFileSync(f, 'utf8')) as { prompts: Record<string, Replayed> }).prompts;
const was = load(args[1]);
const now = load(args[2] ?? join(ROOT, '.local', 'redesign', 'replay.json'));
const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 100);

// The opening block: which notes the new replay ever gives at an opening, and each note's scope now.
const openingNow = new Map<string, number>();
const scopeNow = new Map<string, string>();
for (const r of Object.values(now)) {
  for (const n of r.new.opening ?? []) openingNow.set(n.id, (openingNow.get(n.id) ?? 0) + 1);
  for (const n of [...(r.new.opening ?? []), ...r.new.added, ...r.new.offered]) if (n.scope) scopeNow.set(n.id, n.scope);
}
console.log('— the opening block');
for (const [key, { label }] of Object.entries(labels)) {
  if (!key.startsWith('opening:')) continue;
  const id = key.slice('opening:'.length);
  const body = Object.values(was).flatMap((r) => r.new.opening ?? []).find((n) => n.id === id)?.body ?? id;
  const times = openingNow.get(id) ?? 0;
  const ok = label === 'keep' ? times > 0 : times === 0;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(7)} ${times ? `in ${times} openings` : 'out of the opening'}  · ${short(body)}`);
}

interface Row { n: number; quiet: number; same: number; someSame: number; different: number; earlier: number }
const rows: Record<string, Row> = {};
const lines: string[] = [];
const place = { opening: { n: 0, stepped: 0 }, later: { n: 0, stepped: 0 } };
for (const [key, { label, why }] of Object.entries(labels)) {
  if (key.startsWith('opening:')) continue;
  const a = was[key];
  const b = now[key];
  if (!a || !b) continue;
  const row = (rows[label] ??= { n: 0, quiet: 0, same: 0, someSame: 0, different: 0, earlier: 0 });
  row.n++;
  const then = [...a.new.added, ...a.new.offered].map((s) => s.id);
  const got = [...b.new.added, ...b.new.offered].map((s) => s.id);
  const kept = then.filter((id) => got.includes(id));
  const held = then.filter((id) => b.new.held?.includes(id));
  const outcome = !got.length ? (held.length ? 'earlier' : 'quiet') : kept.length === then.length && got.length === then.length ? 'same' : kept.length ? 'someSame' : 'different';
  row[outcome]++;
  const where = a.fresh ? place.opening : place.later;
  where.n++;
  if (got.length) where.stepped++;
  const good = label === 'needed' ? outcome === 'same' || outcome === 'someSame' || outcome === 'earlier' : label === 'noise' || label === 'harmful' ? outcome === 'quiet' || outcome === 'different' : undefined;
  if (list || good === false || label === 'partly' || label === 'wrong') {
    lines.push(`\n${good === undefined ? '·' : good ? '✓' : '✗'} [${label}] ${a.fresh ? 'opening' : 'later'} · ${a.agent} @${a.project} · ${short(a.prompt)}${why ? `\n   why: ${short(why)}` : ''}`);
    for (const s of [...a.new.added, ...a.new.offered]) lines.push(`   was ${got.includes(s.id) ? '=' : held.includes(s.id) ? '~' : '−'} [${s.why}] ${short(s.body)}`);
    for (const s of [...b.new.added, ...b.new.offered]) if (!then.includes(s.id)) lines.push(`   now + [${s.why}] ${short(s.body)}`);
    lines.push(`   → ${outcome === 'earlier' ? 'quiet now; the note was already given earlier in this conversation' : outcome}`);
  }
}
console.log('\n— the step-ins that were labeled');
console.log('label      n   quiet  same notes  some of them  other notes  given earlier');
for (const label of ['needed', 'partly', 'wrong', 'noise', 'harmful']) {
  const r = rows[label];
  if (r) console.log(`${label.padEnd(8)} ${String(r.n).padStart(3)} ${String(r.quiet).padStart(7)} ${String(r.same).padStart(11)} ${String(r.someSame).padStart(13)} ${String(r.different).padStart(12)} ${String(r.earlier).padStart(14)}`);
}
console.log(`\nlabeled at an opening: ${place.opening.stepped}/${place.opening.n} still stepped into · later in a conversation: ${place.later.stepped}/${place.later.n}`);
const unlabeled = Object.entries(now).filter(([k, r]) => r.new.decision === 'stepped' && !labels[k]);
console.log(`step-ins in the new replay with no label yet: ${unlabeled.length}`);
for (const [, r] of unlabeled) {
  console.log(`  ${r.fresh ? 'opening' : 'later  '} ${r.agent} @${r.project} · ${short(r.prompt)}`);
  for (const s of [...r.new.added, ...r.new.offered]) console.log(`      [${s.why}] ${short(s.body)}`);
}
if (lines.length) console.log(lines.join('\n'));
