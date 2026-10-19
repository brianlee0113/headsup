import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseNote, serializeNote, type Note, type NoteType } from './note.js';
import { redactSecrets } from './secrets.js';

export interface NewNote {
  type: NoteType;
  space: string;
  source: string;
  body: string;
  topics?: string[];
  project?: string;
}

export interface AddResult {
  note?: Note; // undefined when the whole note was a secret
  dropped: string[];
}

// Notes live in <home>/notes/<space>/<id>.md so people can read, edit and grep them directly.
export class Store {
  constructor(readonly home: string) {}

  private notesDir(space?: string): string {
    return space ? join(this.home, 'notes', space) : join(this.home, 'notes');
  }

  add(input: NewNote, now = new Date()): AddResult {
    const { text, dropped } = redactSecrets(input.body);
    const leftover = text.replace(/\[[a-z-]+ removed\]/g, '').replace(/[\s\p{P}]/gu, '');
    if (!leftover) return { dropped };
    const note: Note = {
      id: `${now.toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`,
      type: input.type,
      space: input.space,
      source: input.source,
      ...(input.project ? { project: input.project } : {}),
      topics: input.topics ?? [],
      created: now.toISOString(),
      body: text,
    };
    mkdirSync(this.notesDir(note.space), { recursive: true });
    writeFileSync(join(this.notesDir(note.space), `${note.id}.md`), serializeNote(note));
    return { note, dropped };
  }

  list(): Note[] {
    const root = this.notesDir();
    if (!existsSync(root)) return [];
    const notes: Note[] = [];
    for (const space of readdirSync(root, { withFileTypes: true })) {
      if (!space.isDirectory()) continue;
      for (const file of readdirSync(join(root, space.name))) {
        if (!file.endsWith('.md')) continue;
        try {
          notes.push(parseNote(readFileSync(join(root, space.name, file), 'utf8')));
        } catch {
          // A hand-edited note that no longer parses is skipped rather than breaking every prompt.
        }
      }
    }
    return notes;
  }

  filePath(note: Pick<Note, 'id' | 'space'>): string {
    return join(this.notesDir(note.space), `${note.id}.md`);
  }

  // Rewrites a note in place (type, share, topics or body changed in review).
  update(note: Note): void {
    writeFileSync(this.filePath(note), serializeNote(note));
  }

  remove(id: string): boolean {
    const note = this.list().find((n) => n.id === id);
    if (!note) return false;
    rmSync(join(this.notesDir(note.space), `${note.id}.md`));
    return true;
  }

  log(entry: Record<string, unknown>): void {
    mkdirSync(this.home, { recursive: true });
    appendFileSync(join(this.home, 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }

  readLog(): Array<Record<string, unknown>> {
    const file = join(this.home, 'log.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  // Per-session state: notes that are waiting for the user's go-ahead.
  readPending(sessionId: string): string[] {
    try {
      return (JSON.parse(readFileSync(this.pendingFile(sessionId), 'utf8')) as { ids: string[] }).ids;
    } catch {
      return [];
    }
  }

  writePending(sessionId: string, ids: string[]): void {
    mkdirSync(join(this.home, 'state'), { recursive: true });
    if (ids.length) writeFileSync(this.pendingFile(sessionId), JSON.stringify({ ids }));
    else rmSync(this.pendingFile(sessionId), { force: true });
  }

  // How many turns of a session were already captured, so a resumed session only adds what is new.
  readCaptured(sessionId: string): number {
    try {
      return (JSON.parse(readFileSync(this.stateFile(sessionId, 'captured'), 'utf8')) as { turns: number }).turns;
    } catch {
      return 0;
    }
  }

  writeCaptured(sessionId: string, turns: number): void {
    mkdirSync(join(this.home, 'state'), { recursive: true });
    writeFileSync(this.stateFile(sessionId, 'captured'), JSON.stringify({ turns }));
  }

  private pendingFile(sessionId: string): string {
    return this.stateFile(sessionId, 'json');
  }

  private stateFile(sessionId: string, ext: string): string {
    return join(this.home, 'state', `${sessionId.replace(/[^\w-]/g, '_')}.${ext}`);
  }
}
