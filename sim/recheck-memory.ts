// Sorts a saved simulation memory's web notes into work and personal the way headsup now does
// (src/spaces.ts), into a new run id, so the gate can replay the same notes with the new spaces
// without regenerating memory.
//   pnpm tsx sim/recheck-memory.ts <from-run> <to-run> <persona>...
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeSummarizer, WORK_SPACE } from '../src/capture.js';
import type { Note } from '../src/note.js';
import { buildSpacePrompt, parseSpaceReply } from '../src/spaces.js';
import { outDir } from './run.js';

const [from, to, ...personas] = process.argv.slice(2);
const summarize = claudeSummarizer();
for (const id of personas) {
  rmSync(outDir(to!, id), { recursive: true, force: true });
  cpSync(outDir(from!, id), outDir(to!, id), { recursive: true });
  const files = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => join(outDir(to!, id), `notes-w${w}.json`)).filter(existsSync);
  const weeks = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Note[]);
  const web = [...new Map(weeks.flat().filter((n) => (n.source === 'chatgpt' || n.source === 'claude-ai') && n.space === 'personal').map((n) => [n.id, n])).values()];
  const work = new Set<string>();
  for (let i = 0; i < web.length; i += 40) {
    const batch = web.slice(i, i + 40);
    const picked = parseSpaceReply(await summarize(buildSpacePrompt(batch)), batch.length);
    if (!picked) throw new Error(`unreadable reply for ${id}`);
    for (const at of picked) work.add(batch[at]!.id);
  }
  weeks.forEach((notes, w) => writeFileSync(files[w]!, JSON.stringify(notes.map((n) => (work.has(n.id) ? { ...n, space: WORK_SPACE } : n)), null, 2)));
  console.log(`${id}: ${web.length} web notes, ${work.size} moved to work`);
  for (const n of web.filter((n) => work.has(n.id))) console.log(`  work  ${n.body}`);
}
