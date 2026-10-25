// Keeps the notes tidy with no one doing it. Once enough new notes have come in, a background pass
// asks the summarizer which notes say the same thing (merged into one) and which a newer note has
// made untrue (taken out). Nothing is deleted: notes taken out move to <home>/archive/<date>/, and
// every change is logged as "tidied". A reply that doesn't check out changes nothing.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prompt, Summarize } from './capture.js';
import type { Note, NoteType } from './note.js';
import type { Store } from './store.js';

const EVERY = 10; // new notes between passes
const MAX_PER_PASS = 200; // newest per space; older ones wait for a later pass
const MAX_BODY = 300;
const LOCK_STALE_MS = 10 * 60_000;

const stateFile = (home: string) => join(home, 'state', 'tidy.json');

// Due when the note count has grown by EVERY since the last pass (or since none ran).
export function tidyDue(store: Store): boolean {
  let last = 0;
  try {
    last = (JSON.parse(readFileSync(stateFile(store.home), 'utf8')) as { count: number }).count;
  } catch {
    // never ran
  }
  return store.list().length - last >= EVERY;
}

interface Merge {
  ids: string[];
  type: NoteType;
  body: string;
  topics: string[];
}
interface Drop {
  id: string;
  because: string; // the newer note that replaces it
}

export function buildTidyPrompt(notes: Note[]): Prompt {
  const system = `You keep a person's notes tidy. Each note is one thing about how they work ("how") or a fact about them ("fact").

Return two kinds of changes, and only when you are sure:
- merge: two or more notes that say the same thing, even in different words. Write one note that keeps every detail from them, in the notes' own language, under 220 characters.
- drop: a note a NEWER note has made untrue (plans that happened, a job that changed, a preference reversed). Name the newer note in "because".

Leave everything else alone. Notes that are merely related are not the same thing. When unsure, leave it.
Each note id may appear in at most one change.

Output only JSON: {"merge":[{"ids":["..."],"type":"how|fact","body":"...","topics":["..."]}],"drop":[{"id":"...","because":"..."}]}
With nothing to change: {"merge":[],"drop":[]}`;
  const user = `<notes>
${notes.map((n) => `[${n.id}] (${n.type}, ${n.created.slice(0, 10)}) ${n.body}`).join('\n')}
</notes>

Tidy the notes above. Output only the JSON object.`;
  return { system, user };
}

// Keeps only changes that refer to these notes, use each note once, and drop for a newer note.
export function parseTidy(text: string, notes: Note[]): { merge: Merge[]; drop: Drop[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: { merge?: unknown; drop?: unknown };
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw.merge) || !Array.isArray(raw.drop)) return null;
  const byId = new Map(notes.map((n) => [n.id, n]));
  const used = new Set<string>();
  const take = (ids: string[]) => {
    if (ids.some((id) => !byId.has(id) || used.has(id))) return false;
    for (const id of ids) used.add(id);
    return true;
  };
  const merge: Merge[] = [];
  for (const m of raw.merge as Array<Record<string, unknown>>) {
    const ids = Array.isArray(m?.ids) ? [...new Set(m.ids.filter((i): i is string => typeof i === 'string'))] : [];
    const body = typeof m?.body === 'string' ? m.body.trim() : '';
    if (ids.length < 2 || !body || body.length > MAX_BODY || (m.type !== 'how' && m.type !== 'fact') || !take(ids)) continue;
    const topics = Array.isArray(m.topics) ? m.topics.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 4) : [];
    merge.push({ ids, type: m.type, body, topics });
  }
  const drop: Drop[] = [];
  for (const d of raw.drop as Array<Record<string, unknown>>) {
    const id = typeof d?.id === 'string' ? d.id : '';
    const because = typeof d?.because === 'string' ? d.because : '';
    const old = byId.get(id);
    const newer = byId.get(because);
    // The replacing note must be newer and must stay; a merged note can't vouch for a drop.
    if (!old || !newer || id === because || used.has(because) || newer.created < old.created || !take([id])) continue;
    drop.push({ id, because });
  }
  return { merge, drop };
}

function archive(store: Store, note: Note, day: string): void {
  const dir = join(store.home, 'archive', day);
  mkdirSync(dir, { recursive: true });
  renameSync(store.filePath(note), join(dir, `${note.id}.md`));
}

export interface TidyResult {
  merged: number; // notes that went into a merged note
  dropped: number;
  failed: number; // spaces whose reply didn't check out
}

export async function tidy(store: Store, summarize: Summarize, now = new Date()): Promise<TidyResult | null> {
  const lock = join(store.home, 'state', 'tidy.lock');
  mkdirSync(join(store.home, 'state'), { recursive: true });
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return null;
  writeFileSync(lock, String(process.pid));
  const result: TidyResult = { merged: 0, dropped: 0, failed: 0 };
  try {
    const all = store.list();
    const day = now.toISOString().slice(0, 10);
    for (const space of [...new Set(all.map((n) => n.space))]) {
      // Notes the person marked never-share or always-share were decided by hand; leave them be.
      const notes = all
        .filter((n) => n.space === space && !n.share)
        .sort((a, b) => b.created.localeCompare(a.created))
        .slice(0, MAX_PER_PASS);
      if (notes.length < 2) continue;
      let changes: ReturnType<typeof parseTidy>;
      try {
        changes = parseTidy(await summarize(buildTidyPrompt(notes)), notes);
      } catch (err) {
        changes = null;
        store.log({ event: 'tidy-failed', space, error: err instanceof Error ? err.message : String(err) });
      }
      if (!changes) {
        result.failed++;
        continue;
      }
      if (!changes.merge.length && !changes.drop.length) continue;
      const byId = new Map(notes.map((n) => [n.id, n]));
      const merged: Array<{ from: string[]; to: string }> = [];
      for (const m of changes.merge) {
        const parts = m.ids.map((id) => byId.get(id)!).sort((a, b) => b.created.localeCompare(a.created));
        const projects = new Set(parts.map((p) => p.project));
        // The newest part speaks for the merged note, so "not from the same assistant" still holds roughly.
        const { note } = store.add({
          type: m.type,
          space,
          source: parts[0]!.source,
          body: m.body,
          topics: m.topics.length ? m.topics : [...new Set(parts.flatMap((p) => p.topics))].slice(0, 4),
          ...(projects.size === 1 && parts[0]!.project ? { project: parts[0]!.project } : {}),
        });
        if (!note) continue; // the merged text was only a secret: keep the originals
        for (const p of parts) archive(store, p, day);
        merged.push({ from: m.ids, to: note.id });
        result.merged += parts.length;
      }
      for (const d of changes.drop) archive(store, byId.get(d.id)!, day);
      result.dropped += changes.drop.length;
      store.log({ event: 'tidied', space, merged, dropped: changes.drop });
    }
    // A space whose reply didn't check out is tried again after the next note, not the next ten.
    if (!result.failed) writeFileSync(stateFile(store.home), JSON.stringify({ count: store.list().length, at: now.toISOString() }));
  } finally {
    rmSync(lock, { force: true });
  }
  return result;
}
