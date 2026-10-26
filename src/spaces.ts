// Notes from web chats and imports used to land in the default space whatever they were about, since a
// web chat has no folder. A work goal said in ChatGPT then went into personal requests without an OK
// (the launch simulation caught it). New notes are now sorted by the summarizer (buildImportPrompt);
// this looks once at the ones saved before, and moves those about the person's job to work.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_SPACE, type Prompt, type Summarize } from './capture.js';
import type { Config } from './config.js';
import type { Note } from './note.js';
import type { Store } from './store.js';

const WEB_SOURCES = new Set(['chatgpt', 'claude-ai']);
const BATCH = 40;
const RESTART_MS = 10 * 60_000; // a recheck started this recently is still running, or failed and waits

const checkedFile = (home: string) => join(home, 'state', 'spaces-checked.json');

function readChecked(home: string): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(checkedFile(home), 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

// Notes the summarizer already sorted when it wrote them need no second look.
export function markChecked(home: string, ids: string[]): void {
  if (!ids.length) return;
  const checked = readChecked(home);
  for (const id of ids) checked.add(id);
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(checkedFile(home), JSON.stringify([...checked]));
}

// Web notes in the default space that haven't been looked at yet.
export function unchecked(store: Store, config: Config): Note[] {
  const checked = readChecked(store.home);
  return store.list().filter((n) => WEB_SOURCES.has(n.source) && n.space === config.defaultSpace && !checked.has(n.id));
}

export function buildSpacePrompt(notes: Note[]): Prompt {
  const system = `You sort a person's memory notes into work and personal. A note is "work" when it is about their job or employer: the company's plans, goals and numbers, its products, customers, colleagues, internal tools and processes, or how they do things at work. Everything else is personal: their own projects, studies, job search, hobbies, life, and how they like things done in general. When unsure, call it work: a work note is shared only after the person says yes.

Return ONLY JSON with every note's index in exactly one of the two lists: {"work": [...], "personal": [...]}`;
  const user = `<notes>\n${notes.map((n, i) => `${i}. ${n.body}`).join('\n')}\n</notes>`;
  return { system, user };
}

// The work indexes, or null unless every note was sorted into exactly one list: an empty or partial
// answer would otherwise leave a missed work note in personal for good.
export function parseSpaceReply(text: string, count: number): number[] | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  try {
    const { work, personal } = JSON.parse(json) as { work?: unknown; personal?: unknown };
    if (!Array.isArray(work) || !Array.isArray(personal)) return null;
    const valid = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count;
    if (![...work, ...personal].every(valid)) return null;
    const w = new Set(work as number[]), p = new Set(personal as number[]);
    if (w.size + p.size !== count || [...w].some((i) => p.has(i))) return null;
    return [...w];
  } catch {
    return null;
  }
}

// Until a web note has had that look it is left out wherever notes are read to be shared (the hook,
// the extension, About me, the share card): asking about it would puzzle the person, and treating it as
// work would still let a how-you-work note about their employer through. The look runs soon after an
// update (startRecheck), so this lasts minutes.
export function withoutPending(notes: Note[], home: string, config: Config): Note[] {
  const checked = readChecked(home);
  return notes.filter((n) => !(WEB_SOURCES.has(n.source) && n.space === config.defaultSpace && !checked.has(n.id)));
}

// Whether to start a recheck in the background now: there are notes waiting, and none started lately.
export function recheckDue(store: Store, config: Config, now = Date.now()): boolean {
  if (!spacesCheckDue(store, config)) return false;
  const marker = join(store.home, 'state', 'spaces-started');
  try {
    if (now - statSync(marker).mtimeMs < RESTART_MS) return false;
  } catch {
    /* never started */
  }
  mkdirSync(join(store.home, 'state'), { recursive: true });
  writeFileSync(marker, String(now));
  return true;
}

// A batch whose reply can't be read stays unchecked and is tried again next time.
export async function recheckSpaces(store: Store, config: Config, summarize: Summarize): Promise<{ checked: number; moved: Note[]; failed: number }> {
  const todo = unchecked(store, config);
  const checked = readChecked(store.home);
  const moved: Note[] = [];
  let failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let work: number[] | null = null;
    try {
      work = parseSpaceReply(await summarize(buildSpacePrompt(batch)), batch.length);
    } catch {
      work = null;
    }
    if (!work) {
      failed++;
      continue;
    }
    for (const at of work) moved.push(store.move(batch[at]!, WORK_SPACE));
    for (const n of batch) checked.add(n.id);
  }
  mkdirSync(join(store.home, 'state'), { recursive: true });
  writeFileSync(checkedFile(store.home), JSON.stringify([...checked]));
  if (moved.length) store.log({ event: 'moved-to-work', notes: moved.map((n) => n.id) });
  return { checked: todo.length, moved, failed };
}

export const spacesCheckDue = (store: Store, config: Config) => existsSync(store.home) && unchecked(store, config).length > 0;

// Starts `headsup recheck-spaces` in the background when it is due, from the hook or the extension's
// first request after an update, so older web notes are sorted within minutes of it.
export function startRecheck(store: Store, config: Config): void {
  if (recheckDue(store, config)) spawn(process.execPath, [process.argv[1]!, 'recheck-spaces'], { detached: true, stdio: 'ignore' }).unref();
}
