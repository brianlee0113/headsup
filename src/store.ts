import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
  internal?: boolean;
}

export interface AddResult {
  note?: Note; // undefined when the whole note was a secret
  dropped: string[];
}

// Notes live in <home>/notes/<space>/<id>.md so people can read, edit and grep them directly.
export interface SessionState {
  cwd: string;
  given: string[];
  offset: number;
}

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
      ...(input.internal ? { internal: true as const } : {}),
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

  // Sets a note aside in <home>/archive/<date>/: out of use, never deleted.
  archive(note: Note, now = new Date()): void {
    const dir = join(this.home, 'archive', now.toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    renameSync(this.filePath(note), join(dir, `${note.id}.md`));
  }

  // Files a note under another space (a web note found to be about work).
  move(note: Note, space: string): Note {
    const moved = { ...note, space };
    mkdirSync(this.notesDir(space), { recursive: true });
    writeFileSync(this.filePath(moved), serializeNote(moved));
    rmSync(this.filePath(note), { force: true });
    return moved;
  }

  remove(id: string): boolean {
    const note = this.list().find((n) => n.id === id);
    if (!note) return false;
    rmSync(join(this.notesDir(note.space), `${note.id}.md`));
    return true;
  }

  // A prompt goes in as its start, with secrets taken out first (before cutting, so a key cut in half
  // can't slip past the patterns).
  log(entry: Record<string, unknown>): void {
    mkdirSync(this.home, { recursive: true });
    const record = typeof entry.prompt === 'string' ? { ...entry, prompt: redactSecrets(entry.prompt).text.slice(0, 200) } : entry;
    appendFileSync(join(this.home, 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
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

  // Per-session state: the folder of the last prompt, the notes already added (the agent still has them
  // until the conversation is compacted), and how far the transcript had grown, to spot a compaction since.
  readSession(sessionId: string): SessionState | null {
    try {
      return JSON.parse(readFileSync(this.stateFile(sessionId, 'session'), 'utf8')) as SessionState;
    } catch {
      return null;
    }
  }

  writeSession(sessionId: string, state: SessionState): void {
    mkdirSync(join(this.home, 'state'), { recursive: true });
    writeFileSync(this.stateFile(sessionId, 'session'), JSON.stringify(state));
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

  // Ids already imported from an export, so a rerun (or a newer export) only adds what is new.
  readImported(source: string): string[] {
    try {
      return (JSON.parse(readFileSync(this.stateFile(`import-${source}`, 'json'), 'utf8')) as { ids: string[] }).ids;
    } catch {
      return [];
    }
  }

  writeImported(source: string, ids: string[]): void {
    mkdirSync(join(this.home, 'state'), { recursive: true });
    writeFileSync(this.stateFile(`import-${source}`, 'json'), JSON.stringify({ ids }));
  }

  // How many prompts headsup looked at, so the share card can say how few it stepped into.
  countPrompt(now = new Date()): void {
    const { count, since } = this.readPromptCount() ?? { count: 0, since: now.toISOString() };
    mkdirSync(join(this.home, 'state'), { recursive: true });
    writeFileSync(join(this.home, 'state', 'prompts.json'), JSON.stringify({ count: count + 1, since }));
  }

  readPromptCount(): { count: number; since: string } | null {
    try {
      return JSON.parse(readFileSync(join(this.home, 'state', 'prompts.json'), 'utf8')) as { count: number; since: string };
    } catch {
      return null;
    }
  }

  private pendingFile(sessionId: string): string {
    return this.stateFile(sessionId, 'json');
  }

  private stateFile(sessionId: string, ext: string): string {
    return join(this.home, 'state', `${sessionId.replace(/[^\w-]/g, '_')}.${ext}`);
  }
}
