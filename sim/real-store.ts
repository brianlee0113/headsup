// A throwaway copy of the person's real store for replays: nothing here ever writes to ~/.headsup.
// Notes that were archived since are put back (a replay of an October prompt should see October's
// notes), with the day each was set aside, and every note gets its scope: from the cache of an earlier
// run, else from `rescope` (model calls, through the person's own Claude login).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseNote, serializeNote, type Note, type Scope } from '../src/note.js';
import { rescope } from '../src/scope.js';
import { Store } from '../src/store.js';
import { askText } from './llm.js';

export interface RealStore {
  home: string; // the copy
  store: Store;
  archivedOn: Map<string, string>; // note id → the day it was set aside (YYYY-MM-DD)
  modelCalls: number;
}

interface Cached { hash: string; scope: Scope; applies: string[] }
const hashOf = (n: Note) => createHash('sha1').update(`${n.type}\n${n.body}`).digest('hex').slice(0, 12);

export async function openRealStore(source: string, cacheFile: string, opts: { model?: boolean } = {}): Promise<RealStore> {
  const home = mkdtempSync(join(tmpdir(), 'headsup-replay-'));
  for (const part of ['notes', 'archive', 'log.jsonl', 'config.json']) {
    if (existsSync(join(source, part))) cpSync(join(source, part), join(home, part), { recursive: true });
  }
  const archivedOn = new Map<string, string>();
  const archive = join(home, 'archive');
  if (existsSync(archive)) {
    for (const day of readdirSync(archive)) {
      for (const f of readdirSync(join(archive, day))) {
        try {
          const n = parseNote(readFileSync(join(archive, day, f), 'utf8'));
          const live = join(home, 'notes', n.space, `${n.id}.md`);
          if (existsSync(live)) continue;
          mkdirSync(dirname(live), { recursive: true });
          writeFileSync(live, serializeNote(n));
          archivedOn.set(n.id, day);
        } catch {
          /* unreadable archived note */
        }
      }
    }
  }
  const store = new Store(home);
  const cache: Record<string, Cached> = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, Cached>) : {};
  for (const n of store.list()) {
    const c = cache[n.id];
    if (!n.scope && c && c.hash === hashOf(n)) store.update({ ...n, scope: c.scope, ...(c.applies.length ? { applies: c.applies } : {}) });
  }
  let modelCalls = 0;
  if (opts.model !== false && store.list().some((n) => !n.scope)) {
    await rescope(store, (p) => {
      modelCalls++;
      return askText('sonnet', p.system, p.user);
    });
    for (const n of store.list()) if (n.scope) cache[n.id] = { hash: hashOf(n), scope: n.scope, applies: n.applies ?? [] };
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  }
  return { home, store, archivedOn, modelCalls };
}
