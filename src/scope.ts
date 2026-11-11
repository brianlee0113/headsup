// Where a note holds, and whether a prompt is in that place.
//
// `note.project` is the folder a note was captured in, not where it applies: the person's answer-style
// preferences were mostly said inside some project, and a rule said in one folder is often about another
// project. Real use showed what that costs: of the notes put in front of prompts the person later called
// harmful, most were written for some other project or some other kind of task. So each note carries a
// scope (note.ts), set when it is saved, and the per-prompt decision (gap.ts) only ever asks "is this
// prompt inside the note's scope?" with plain string checks: no model call per prompt.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prompt, Summarize } from './capture.js';
import { parseNote, SCOPES, type Note, type Scope } from './note.js';
import { tokenize } from './search.js';
import type { Store } from './store.js';

// Folders that are where someone keeps projects, not a project.
export const GENERIC_FOLDERS = new Set(['developer', 'projects', 'code', 'src', 'work', 'home', 'documents', 'desktop', 'downloads', '']);
export const isProjectName = (name: string | undefined): name is string => !!name && name.length >= 3 && !GENERIC_FOLDERS.has(name.toLowerCase());

export interface Scoped {
  scope: Scope | 'unknown';
  applies: string[];
}

// Project names the person's notes know: the ones scoped notes apply to, and the folders notes came from.
export function projectNames(notes: Note[]): string[] {
  const names = new Map<string, string>();
  for (const n of notes) {
    for (const name of [...(n.scope === 'project' ? n.applies ?? [] : []), n.project]) {
      if (isProjectName(name) && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  return [...names.values()];
}

// A note's scope as saved. A note saved before scopes existed gets the narrowest reading its text
// supports until `headsup rescope` has looked at it: a fact belongs to the project it came from or
// names, a fact with no project is about the person, and a how-you-work note that names no project is
// "unknown" and goes nowhere. Staying out is the safe side of not knowing.
export function scopeOf(note: Note, projects: string[]): Scoped {
  if (note.scope === 'project') {
    const applies = (note.applies ?? []).filter(isProjectName);
    return { scope: 'project', applies: applies.length ? applies : isProjectName(note.project) ? [note.project] : [] };
  }
  if (note.scope) return { scope: note.scope, applies: note.applies ?? [] };
  const named = projects.filter((p) => namesProject(p, note.body));
  if (note.type === 'fact') {
    const owners = [...new Set([...(isProjectName(note.project) ? [note.project] : []), ...named])];
    return owners.length ? { scope: 'project', applies: owners } : { scope: 'self', applies: [] };
  }
  return named.length ? { scope: 'project', applies: named } : { scope: 'unknown', applies: [] };
}

// ---- the prompt side ----

// Messages nobody typed: a background task finishing, a subagent handing back, command output.
const GENERATED = /^\s*(?:<(?:task-notification|local-command-[\w-]+|command-[\w-]+|agent-message|teammate-message|system-reminder|bash-[\w-]+)\b|This session is being continued from a previous conversation|Caveat: The messages below were generated|[/!]\S)/;
const BLOCKS = [
  /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content[^>]*>|$)/g, // pasted text: what the request is about, not the request
  // Anything in a tagged block was put there by a tool (reminders, IDE state, browser instructions), not typed.
  /<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi,
  /<(?:system-reminder|task-notification|agent-message|teammate-message|local-command-[\w-]+|command-[\w-]+|bash-[\w-]+)\b[^>]*>[\s\S]*$/g, // one cut off before it closed
  /```[\s\S]*?(?:```|$)/g, // code and logs
  /\[(?:Image|Pasted text)[^\]]*\]/g,
  /^#+ Files (?:mentioned|pasted) by the user:[\s\S]*?(?:\n\s*\n|$)/gm, // Codex's list of attachments
];
// Paths and links: a folder called "marketing" in a path is not the person talking about marketing. Done
// per word, not with one /\S*[/~\\]\S*/ pass: on a long unbroken paste (minified JSON, a token) that
// regex backtracks from every position and took seconds, past the hook's time limit.
const withoutPaths = (text: string) => text.split(/(\s+)/).map((w) => (/[/~\\]/.test(w) ? ' ' : w)).join('');
const MAX_TYPED = 1500; // past this a prompt is mostly material, and stray words start matching

// The person's own words in a prompt. Pasted documents, tool output and code are what the request is
// about; reading them as the request made "About me", "CV" and "resume" in a pasted review or rule book
// look like the person asking about themselves.
// `max` caps a single prompt; the earlier prompts of a conversation pass a larger one, since what they
// are checked for (has this kind of work come up yet?) can sit anywhere in them.
export function ownWords(prompt: string, max = MAX_TYPED): string {
  if (GENERATED.test(prompt)) return '';
  let text = prompt;
  for (const re of BLOCKS) text = text.replace(re, ' ');
  return withoutPaths(text).trim().slice(0, max);
}

const HANGUL = /[가-힣]/;
const ONLY_HANGUL = /^[가-힣]+$/;
const ENDINGS = new Set(['s', 'es', 'ed', 'd', 'ing']);
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export const sentencesOf = (text: string): string[][] => text.split(/[.?!\n。]+/).map(wordsOf).filter((s) => s.length);

// One word of a cue against one word of the prompt. Korean puts particles and endings on the end
// ("커밋해줘", "push하고"), so the cue has to start the word; English allows a plain inflection.
function wordMatches(cue: string, word: string): boolean {
  if (word === cue) return true;
  if (!word.startsWith(cue)) return false;
  const rest = word.slice(cue.length);
  if (HANGUL.test(cue)) return cue.length >= 2;
  return ONLY_HANGUL.test(rest) || ENDINGS.has(rest);
}

// The words of a cue that can tell a situation apart: no one-letter words, none of the everyday words
// search already ignores ("to", "is", "진행"). "to-be" has none left and is no cue at all.
export const cueWords = (cue: string): string[] => wordsOf(cue).filter((w) => w.length >= 2 && tokenize(w).length > 0);

// A cue is in the prompt when all of its words are in one sentence of it. One sentence, because in a
// long message words from unrelated parts pair up by chance.
export function cueIn(cue: string, sentences: string[][]): boolean {
  const parts = cueWords(cue);
  if (!parts.length) return false;
  return sentences.some((s) => parts.every((p) => s.some((w) => wordMatches(p, w))));
}
export const cuesIn = (cues: string[], sentences: string[][]): string[] => cues.filter((c) => cueIn(c, sentences));

// The cue said as a phrase: its words next to each other and in order ("code review", "코드 리뷰를").
// The stricter test, used once a conversation is under way.
export function phraseIn(cue: string, sentences: string[][]): boolean {
  const parts = cueWords(cue);
  if (parts.length < 2) return false;
  return sentences.some((s) => {
    for (let i = 0; i + parts.length <= s.length; i++) if (parts.every((p, j) => wordMatches(p, s[i + j]!))) return true;
    return false;
  });
}

// Whether text names a project: its name as consecutive words ("aeo-agent", "class notes"), the last
// one free to carry a Korean particle ("headsup은"). A name in capitals (LINE) must be typed that way,
// or every "line" would name it.
export function namesProject(name: string, text: string): boolean {
  if (!isProjectName(name)) return false;
  const caps = /^[A-Z0-9 ._-]+$/.test(name) && /[A-Z]/.test(name);
  const split = (s: string) => (caps ? s : s.toLowerCase()).match(/[\p{L}\p{N}]+/gu) ?? [];
  const parts = split(name);
  const words = split(text);
  if (!parts.length) return false;
  for (let i = 0; i + parts.length <= words.length; i++) {
    const ok = parts.every((p, j) => {
      const w = words[i + j]!;
      if (w === p) return true;
      return j === parts.length - 1 && w.startsWith(p) && ONLY_HANGUL.test(w.slice(p.length));
    });
    if (ok) return true;
  }
  return false;
}

// The same project under two folder names: a second checkout or build copy ("class-notes-build2").
export function sameProject(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort((p, q) => p.length - q.length) as [string, string];
  if (x === y) return true;
  return x.length >= 4 && y.startsWith(x) && /^[-_. ]/.test(y.slice(x.length));
}

// ---- giving older notes a scope (`headsup rescope`) ----

const BATCH = 40;
const RESTART_MS = 10 * 60_000;
// A note the model still can't scope after this many passes is left to the narrow fallback (it stays
// quiet), rather than costing a model call every ten minutes for good.
const MAX_TRIES = 3;
// A pass older than this is taken to have died; a newer one is still running, and a second waits.
const LOCK_MS = 30 * 60_000;
const triesFile = (store: Store) => join(store.home, 'state', 'rescope-tries.json');
const lockFile = (store: Store) => join(store.home, 'state', 'rescope.lock');
function readTries(store: Store): Record<string, number> {
  try {
    return JSON.parse(readFileSync(triesFile(store), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}
const running = (store: Store, now: number) => {
  try {
    return now - statSync(lockFile(store)).mtimeMs < LOCK_MS;
  } catch {
    return false;
  }
};

// What each scope means and what goes in `applies`, in the words given to the model: here when sorting
// older notes, and in the summarizers' prompts (capture.ts, import/chatgpt.ts) when a note is first written.
export const SCOPE_RULES = `Scopes for a "how" note:
- "general": the few preferences about how ANY answer should be shaped that hold with no condition at all: in every project, every kind of request, every tool, every language, on a one-line question as much as on a long piece of work. "Lead with the conclusion, then the points" is general. Almost nothing else is. If the preference has a "when" in it, even an unstated one, it is task: a table for options (when there are options to weigh), sources and figures (when researching or reporting), which language to answer in (people who use several want different ones at different times), blunt verdicts (when asking for a decision), asking questions in one batch (when they are away). Engineering, design and workflow habits are never general. When unsure, it is task.
- "task": a habit for one kind of task, document, audience or situation, which they would want in any project where that situation comes up: emails, slides, commits, code review, UI review, naming, translation, posts for one social network, laying out options, research with sources, trying out a new library, handling secrets, long unattended runs. A note that opens with a condition ("when …", "for …", "…할 때", "…은/는 …") is task. A workaround for a problem in one tool or environment (output that breaks in a terminal multiplexer, a device that misbehaves) is not a preference at all: file it as task, with the name of that environment as its cue.
- "project": it depends on something only one project has: its platform or device, its users, its screens, its vendor, its release steps, its files, its team; or it names the project; or it is a decision or taste formed for that one product. "Deploy only after checking on the store's tablet" is project (one shop's app). "Labels on the kiosk screen stay in large type" is project. "The new app's name should sound like a train line" is project (one product). "Commit when a spike ends and note the result in the changelog" is task: nothing in it belongs to one project.
Between task and project, when the note would mislead in a different project, choose project.

Scopes for a "fact" note:
- "project": about a project, product, course assignment or codebase.
- "self": about the person: school, job, role, job search, where they live, goals, skills.

"applies" says what calls for the note:
- project: the name or names the project goes by, as the person would type them. Use a name from KNOWN PROJECTS when it is one of them, or a product name the notes give. Not a generic folder such as "home", "Developer" or "marketing" unless that is really the project's name. If the note is about a project you cannot name, use the folder it was captured in.
- task: 2 to 6 cues. Each cue is a phrase of 2 or 3 words that a request to DO that kind of work would contain, in the languages the notes are written in and in English: "code review", "코드 리뷰", "문의 메일", "new repo", "새 레포", "options table", "선택지 정리". One word is never a cue ("slide", "commit", "test", "email", "review", "figma" turn up in requests that have nothing to do with the habit); pair it with what makes it this situation ("slide text", "장표 문구", "commit message"). Cue on the act, not the topic: a habit about not pasting secrets into chat is called for by "paste the key" or "키 붙여넣기", not by any mention of "api key"; a habit about how they want text handed over for slides they lay out themselves is called for by "slide text", not by any talk about decks. Korean cues in bare form, without particles ("커밋 메시지", not "커밋 메시지를").
- self: 2 to 6 cues for the subject, by the same rules ("resume", "이력서", "job search", "PM 지원", "cover letter").
- general: []`;

export function buildScopePrompt(batch: Note[], projects: string[]): Prompt {
  const system = `You sort a person's memory notes by WHERE EACH ONE HOLDS. The notes were taken from their sessions with AI tools. Later, a note is put in front of a new request only where it holds. A note filed too broadly ends up in front of work it has nothing to do with, and the person finds that worse than a note that is missing.

Each note is "how" (a way they like things done) or "fact" (something true about them or their projects), and says which folder it was captured in. The folder is only where the conversation happened. Judge by what the note says: a habit is not about a project just because it was said there, and a note captured in one folder is often about another project.

${SCOPE_RULES}

Return ONLY a JSON array with one item per note, in order: [{"i": 0, "scope": "...", "applies": ["..."]}]`;
  const user = `KNOWN PROJECTS: ${projects.length ? projects.join(', ') : '(none)'}

<notes>
${batch.map((n, i) => `${i}. (${n.type} · captured in ${n.project ?? 'a web chat, no folder'}) ${n.body.replace(/\s+/g, ' ')}`).join('\n')}
</notes>`;
  return { system, user };
}

// A scope and its cues as a model wrote them, cleaned: a scope the note's type can't have is dropped,
// cues are short, lowercase unless a project name, and few.
export function cleanScope(type: Note['type'], scope: unknown, applies: unknown, project?: string): { scope: Scope; applies: string[] } | null {
  if (typeof scope !== 'string' || !SCOPES[type].includes(scope as Scope)) return null;
  const list = (Array.isArray(applies) ? applies : [])
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.replace(/[,\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((a) => a.length >= 2 && a.length <= 40 && a.split(' ').length <= 4);
  if (scope === 'general') return { scope, applies: [] };
  if (scope === 'project') {
    const names = [...new Set(list.filter(isProjectName))].slice(0, 4);
    return { scope, applies: names.length ? names : isProjectName(project) ? [project] : [] };
  }
  return { scope: scope as Scope, applies: [...new Set(list.map((a) => a.toLowerCase()))].slice(0, 8) };
}

export function parseScopeReply(text: string, batch: Note[]): Array<{ scope: Scope; applies: string[] } | null> {
  const out: Array<{ scope: Scope; applies: string[] } | null> = batch.map(() => null);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(raw)) return out;
  for (const item of raw as Array<{ i?: unknown; scope?: unknown; applies?: unknown }>) {
    if (!item || !Number.isInteger(item.i) || (item.i as number) < 0 || (item.i as number) >= batch.length) continue;
    const note = batch[item.i as number]!;
    out[item.i as number] = cleanScope(note.type, item.scope, item.applies, note.project);
  }
  return out;
}

export const unscoped = (notes: Note[]) => notes.filter((n) => !n.scope);
// Unscoped notes a pass should still try.
export const toScope = (store: Store, notes: Note[]) => {
  const tries = readTries(store);
  return unscoped(notes).filter((n) => (tries[n.id] ?? 0) < MAX_TRIES);
};

// Looks at every note that has no scope yet and writes one into its file. A batch whose reply can't be
// read is left as it was and tried again next time; until then those notes keep the narrow fallback.
export async function rescope(store: Store, summarize: Summarize, now = Date.now()): Promise<{ scoped: number; failed: number; busy?: true }> {
  if (running(store, now)) return { scoped: 0, failed: 0, busy: true };
  mkdirSync(join(store.home, 'state'), { recursive: true });
  writeFileSync(lockFile(store), String(process.pid));
  try {
    return await rescopeAll(store, summarize);
  } finally {
    rmSync(lockFile(store), { force: true });
  }
}

async function rescopeAll(store: Store, summarize: Summarize): Promise<{ scoped: number; failed: number }> {
  const all = store.list();
  const todo = toScope(store, all);
  const projects = projectNames(all);
  const tries = readTries(store);
  let scoped = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let reply: ReturnType<typeof parseScopeReply>;
    try {
      reply = parseScopeReply(await summarize(buildScopePrompt(batch, projects)), batch);
    } catch {
      reply = batch.map(() => null);
    }
    batch.forEach((note, at) => {
      const found = reply[at];
      if (!found) {
        tries[note.id] = (tries[note.id] ?? 0) + 1;
        return void failed++;
      }
      // The model call took a while: in the meantime tidy may have set the note aside, a recheck moved
      // it to another space, or a review changed it. Writing the old copy back would undo that.
      const now = current(store, note);
      if (!now || now.scope || now.type !== note.type || now.body !== note.body) return;
      store.update({ ...now, scope: found.scope, ...(found.applies.length ? { applies: found.applies } : {}) });
      delete tries[note.id];
      scoped++;
    });
  }
  writeFileSync(triesFile(store), JSON.stringify(tries));
  if (todo.length) store.log({ event: 'rescoped', scoped, failed });
  return { scoped, failed };
}

// The note as its file has it now, or undefined if it is no longer there.
function current(store: Store, note: Note): Note | undefined {
  const file = store.filePath(note);
  if (!existsSync(file)) return undefined;
  try {
    return parseNote(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Starts `headsup rescope` in the background when notes are waiting and none was started lately: from
// the hook or the extension's first request after an update, so older notes are sorted within minutes.
export function startRescope(store: Store, notes: Note[], now = Date.now()): void {
  if (!unscoped(notes).length || !toScope(store, notes).length || running(store, now)) return;
  const marker = join(store.home, 'state', 'rescope-started');
  try {
    if (now - statSync(marker).mtimeMs < RESTART_MS) return;
  } catch {
    /* never started */
  }
  mkdirSync(join(store.home, 'state'), { recursive: true });
  writeFileSync(marker, String(now));
  const child = spawn(process.execPath, [process.argv[1]!, 'rescope'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // tried again after RESTART_MS
  child.unref();
}
