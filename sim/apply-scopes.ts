// Writes the scopes the replay was validated with (.local/redesign/scopes.json) into the person's real
// notes, so the live hook behaves as tested instead of re-classifying (which varies between runs). Only a
// note whose type and body are unchanged since then takes its cached scope; the rest are listed, and
// `headsup rescope` scopes them later. Archived notes are left alone. Dry run unless --write.
//   pnpm tsx sim/apply-scopes.ts [--write]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headsupHome } from '../src/config.js';
import type { Note, Scope } from '../src/note.js';
import { Store } from '../src/store.js';

const HERE = new URL('.', import.meta.url).pathname;
const cache = JSON.parse(readFileSync(join(HERE, '..', '.local', 'redesign', 'scopes.json'), 'utf8')) as Record<string, { hash: string; scope: Scope; applies: string[] }>;
const hashOf = (n: Note) => createHash('sha1').update(`${n.type}\n${n.body}`).digest('hex').slice(0, 12);
const write = process.argv.includes('--write');

const store = new Store(headsupHome());
const notes = store.list();
const counts: Record<string, number> = {};
const already: Note[] = [];
const missing: Note[] = [];
const general: Note[] = [];
let applied = 0;
for (const n of notes) {
  if (n.scope) {
    already.push(n);
    continue;
  }
  const c = cache[n.id];
  if (!c || c.hash !== hashOf(n)) {
    missing.push(n);
    continue;
  }
  counts[c.scope] = (counts[c.scope] ?? 0) + 1;
  if (c.scope === 'general') general.push(n);
  if (write) store.update({ ...n, scope: c.scope, ...(c.applies.length ? { applies: c.applies } : {}) });
  applied++;
}
console.log(`${write ? 'wrote' : 'would write'} ${applied} of ${notes.length} live notes:`, counts);
console.log(`already scoped: ${already.length}`);
console.log(`no cached scope (new or edited since): ${missing.length}`);
for (const n of missing) console.log(`  ${n.id} [${n.type}] ${n.body.replace(/\s+/g, ' ').slice(0, 90)}`);
console.log('general (given at every opening):');
for (const n of general) console.log(`  ${n.id} ${n.body.replace(/\s+/g, ' ').slice(0, 120)}`);
