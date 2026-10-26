// What headsup learns from the person's own use, kept on this computer (state/learning.json). For each
// note it counts how often it went in, how often the answer actually drew on it, and how often the
// person took it out (unticked on the web, or said no when asked). A note that keeps being taken out
// or ignored rests for a while, then gets a fresh start, so one bad stretch is not forever.
// Boundary rules and the person's own never-share / always-share choices are never touched here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { Note } from './note.js';
import { tokenize } from './search.js';

export interface Evidence {
  shown: number; // added to a request
  used: number; // the answer that followed drew on it
  ignored: number; // the answer that followed did not
  removed: number; // the person took it out: unticked, or declined when asked
  restUntil?: string; // left out of requests until then
  reason?: 'removed' | 'ignored';
}
export type Book = Record<string, Evidence>;

const REMOVED_TO_REST = 2;
const SHOWN_BEFORE_JUDGING = 4;
const USED_SHARE_TO_STAY = 0.2;
const REST_DAYS = { removed: 14, ignored: 7 };

const file = (home: string) => join(home, 'state', 'learning.json');
const pendingFile = (home: string, session: string) => join(home, 'state', `${session.replace(/[^\w-]/g, '_')}.shown.json`);
const blank = (): Evidence => ({ shown: 0, used: 0, ignored: 0, removed: 0 });

export const learningOn = (config: Config) => config.learning !== false;

export function readBook(home: string): Book {
  try {
    return JSON.parse(readFileSync(file(home), 'utf8')) as Book;
  } catch {
    return {};
  }
}

function writeBook(home: string, book: Book): void {
  mkdirSync(dirname(file(home)), { recursive: true });
  writeFileSync(file(home), JSON.stringify(book, null, 1));
}

// Notes resting right now. A rest that ran out clears, with counts started over.
export function resting(home: string, now = new Date()): Map<string, Evidence> {
  const book = readBook(home);
  const out = new Map<string, Evidence>();
  let changed = false;
  for (const [id, e] of Object.entries(book)) {
    if (!e.restUntil) continue;
    if (new Date(e.restUntil) > now) out.set(id, e);
    else {
      book[id] = blank();
      changed = true;
    }
  }
  if (changed) writeBook(home, book);
  return out;
}

function settle(e: Evidence, now: Date): void {
  if (e.restUntil) return;
  const rest = (reason: 'removed' | 'ignored') => {
    e.reason = reason;
    e.restUntil = new Date(now.getTime() + REST_DAYS[reason] * 86_400_000).toISOString();
  };
  if (e.removed >= REMOVED_TO_REST) rest('removed');
  else if (e.used + e.ignored >= SHOWN_BEFORE_JUDGING && e.used / (e.used + e.ignored) < USED_SHARE_TO_STAY) rest('ignored');
}

function update(home: string, ids: string[], change: (e: Evidence) => void, now: Date): void {
  if (!ids.length) return;
  const book = readBook(home);
  for (const id of ids) {
    const e = (book[id] ??= blank());
    change(e);
    settle(e, now);
  }
  writeBook(home, book);
}

export const recordShown = (home: string, ids: string[], now = new Date()) => update(home, ids, (e) => e.shown++, now);
export const recordRemoved = (home: string, ids: string[], now = new Date()) => update(home, ids, (e) => e.removed++, now);

// An answer drew on a note when it repeats enough of the note's own words. A rough sign, not proof the
// note helped, which is why one answer never decides anything on its own.
export function usedIn(note: Pick<Note, 'body'>, reply: string): boolean {
  const words = [...new Set(tokenize(note.body))];
  if (!words.length) return false;
  const said = new Set(tokenize(reply));
  const shared = words.filter((w) => said.has(w)).length;
  return shared >= 2 && shared / words.length >= 0.25;
}

// Terminal agents: notes added to this prompt are remembered, and the next prompt in the same session
// checks the answer in between against them.
export function rememberShown(home: string, session: string, ids: string[]): void {
  if (!ids.length) return;
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(pendingFile(home, session), JSON.stringify(ids));
}

export function settleShown(home: string, session: string, notes: Note[], reply: string, now = new Date()): void {
  const path = pendingFile(home, session);
  if (!existsSync(path)) return;
  let ids: string[] = [];
  try {
    ids = JSON.parse(readFileSync(path, 'utf8')) as string[];
  } catch {
    /* unreadable: nothing to settle */
  }
  writeFileSync(path, '[]');
  if (!reply.trim()) return;
  const byId = new Map(notes.map((n) => [n.id, n]));
  const used = ids.filter((id) => byId.has(id) && usedIn(byId.get(id)!, reply));
  const ignored = ids.filter((id) => byId.has(id) && !used.includes(id));
  update(home, used, (e) => e.used++, now);
  update(home, ignored, (e) => e.ignored++, now);
}
