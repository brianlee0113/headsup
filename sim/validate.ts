// Checks a persona's generated weeks against its ground truth before they are scored: what the person
// says about themselves that the ground truth doesn't hold (an invented shop name, a made-up opening
// date), and planned items the sessions never actually state. A run built on invented facts measures the
// generator, not headsup. One judge call per week; the result is saved beside the week's inputs.
//   pnpm tsx sim/validate.ts <persona>...
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, itemText, loadPersona } from './generate.js';
import { askJson } from './llm.js';
import type { Session } from './types.js';

export interface Validation {
  invented: Array<{ session: string; claim: string }>; // said about the person, not in the ground truth
  missing: Array<{ session: string; item: string }>; // planned to be revealed there, never stated
}

export async function validateWeek(id: string, week: number): Promise<Validation> {
  const p = loadPersona(id);
  const sessions = JSON.parse(readFileSync(join(dataDir(id, week), 'sessions.json'), 'utf8')) as Session[];
  const system = `You check generated chats against the ground truth about a fictional person (as of week ${week}). Look only at what the PERSON says about themselves (their jobs, projects, studies, businesses, names, numbers, dates, results, habits), not at task content or the assistant. Return ONLY JSON:
{"invented": [{"session": "<id>", "claim": "<a statement about the person that the ground truth does not contain, e.g. a name, date or figure it never gives>"}], "missing": [{"session": "<id>", "item": "<ground-truth id the session was meant to reveal but the person never states>"}]}
Details that only restate or plainly follow from the ground truth are fine. Empty lists are fine.`;
  const truth = p.items.map((i) => `- ${i.id}: ${itemText(i, week)}`).join('\n');
  const chats = sessions
    .map((s) => `## ${s.id} (meant to reveal: ${s.reveals.join(', ') || 'nothing'})\n${s.turns.filter((t) => t.role === 'user').map((t) => `PERSON: ${t.text}`).join('\n')}`)
    .join('\n\n');
  return askJson<Validation>('sonnet', system, `GROUND TRUTH:\n${truth}\n\nCHATS:\n${chats}`);
}

if (process.argv[1]?.endsWith('validate.ts')) {
  for (const id of process.argv.slice(2)) {
    for (const week of [1, 2, 3, 4, 5, 6, 7, 8]) {
      if (!existsSync(join(dataDir(id, week), 'sessions.json'))) continue;
      const file = join(dataDir(id, week), 'validation.json');
      const v = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Validation) : await validateWeek(id, week);
      writeFileSync(file, JSON.stringify(v, null, 2));
      console.log(`${id} w${week}: ${v.invented.length} invented, ${v.missing.length} missing`);
      for (const x of v.invented) console.log(`  invented ${x.session}: ${x.claim}`);
      for (const x of v.missing) console.log(`  missing  ${x.session}: ${x.item}`);
    }
  }
}
