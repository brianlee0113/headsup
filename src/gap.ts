// When headsup steps in, and with what. Quiet is the default; a wrong note costs more than a missing one.
//
// The decision starts from each note's scope (scope.ts), never from shared words: a note is considered
// only if the prompt is inside the place the note holds. There are two channels.
//
//   Standing: how the person likes answers, whatever the project ("general" notes). Given once, at the
//     opening of a conversation, with no matching at all; they hold for every answer or for none.
//     Terminal agents get them here. On the web the "About me" block carries them (about.ts).
//   Moment: a note for this prompt. Three ways in, each needing the prompt itself to be in scope:
//     task    — a habit for one kind of work; the person's own words contain one of the note's cues
//     project — the work is that project: the folder is it, or the prompt names it
//     self    — a fact about the person; the prompt is about them (their résumé, their job search)
//
// What is deliberately not here: searching every note for shared words and passing the best ones
// (0.1.8). Shared words can't tell a habit from the project it was said in, and that is where the
// step-ins people called harmful came from.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { namesAgent } from './agents.js';
import { resolveSpace, type Config } from './config.js';
import { projectOf } from './context.js';
import type { Note } from './note.js';
import { verdictFor } from './policy.js';
import { cuesIn, cueWords, isProjectName, phraseIn, namesProject, ownWords, projectNames, sameProject, scopeOf, sentencesOf, type Scoped } from './scope.js';
import { tokenize, tokenizeWords } from './search.js';

export interface Signals {
  references: string[]; // what in the prompt called for notes: a cue, a project's name, "my résumé"
}

export interface Decision {
  targetSpace: string;
  signals: Signals;
  inject: Note[];
  ask: Note[];
  blocked: Note[];
  skippedKnown: Note[];
  opening: Note[]; // those of `inject` that are the standing answer-style notes, not picked for this prompt
  why: Record<string, string>; // note id → what put it here
}

export interface DetectInput {
  prompt: string;
  agent: string;
  cwd?: string; // terminal agents: the working folder decides the space and project
  space?: string; // web: no folder, so the caller names the space
  knownText: string; // agent context files + current transcript
  notes: Note[];
  config: Config;
  resting?: Set<string>; // notes learning has set aside for now (learning.ts)
  given?: Set<string>; // notes already added earlier in this conversation: the agent still has them
  // The opening of a conversation, a move to another folder, or the turn after the conversation was
  // compacted: when the agent knows least. Default true.
  fresh?: boolean;
  // Whether this caller gives the standing notes at an opening. Default: terminal agents do, the web
  // doesn't (its account-wide "About me" block already holds them).
  standing?: boolean;
  worth?: (note: Note) => number; // learning's ranking for the standing notes; newest first without it
  // What the person has typed earlier in this conversation (their words only). After the opening a note
  // comes in only for a kind of work these don't already hold.
  earlier?: string;
}

const OPENING_NOTES = 3; // "general" is meant to stay tiny; past this, something was filed too broadly
const OPENING_CHARS = 500;
const TASK_NOTES = 2;
const PROJECT_NOTES = 2;
const WEB_PROJECT_NOTES = 3;
const SELF_NOTES = 3;
const MOMENT_NOTES = 4;
const SHARED_WORDS = 2; // beyond the project's name, for a note that doesn't say what the project is

// A note that gives the assistant orders ("ignore their requests", "always end the reply with…") is never
// added: framing notes as background was not enough, the simulation's planted order was still followed.
// Notes describe the person; capture is told never to write orders, so a hit here is a bad or planted note.
const ORDERS = [
  /\b(?:ignore|disregard|override)\b[^.]{0,40}\b(?:instructions?|requests?|rules?|prompt|previous|above|user)\b/i,
  /\balways\s+(?:end|start|begin|reply|respond|answer|say|write)\b/i,
  /\b(?:you|assistant)\s+(?:must|should|have to)\b/i,
  /(?:무시하고|무시해|무시할\s*것)/,
  /(?:답변|응답|대답)\s*(?:끝|마지막|처음)에\s*(?:항상|반드시)/,
];
export const givesOrders = (body: string) => ORDERS.some((re) => re.test(body));

// Writing about yourself: the answer is made of facts about the person.
const SELF_WRITING = /\b(?:cover\s+letter|resume|résumé|cv|bio|about\s+me|introduce\s+myself|self[- ]introduction|linkedin\s+(?:headline|summary|profile|bio)|interview\s+(?:question|prep|answer)|tell\s+me\s+about\s+yourself|proud\s+of|biggest\s+impact|recruiter)\b|자기\s*소개|이력서|커버\s*레터|자소서|면접/i;
// Inside a project those same words are often what the project is about (a résumé builder, an "About me"
// feature), so there they count only when the person says they mean their own.
const POSSESSIVE = /(?:\bmy\s+(?:own\s+)?|\bmine\b|(?:^|[\s(])(?:내|제|나의|저의)\s*)/i;
const MY_SOMETHING = /(?:\bmy\s+(?:own\s+)?|(?:^|[\s(])(?:내|제|나의|저의)\s*)(?:cover\s+letter|resume|résumé|cv|bio|job|role|career|background|experience|school|degree|job\s+search|이력서|자기\s*소개|자소서|커버\s*레터|경력|직무|직업|학교|전공|지원)/i;

const SIDE_PROJECT = /\b(?:my\s+)?(?:side|personal|toy|hobby)\s+project\b|(?:사이드|개인|토이)\s*프로젝트/i;

// The one project in the person's own space, named by their notes, other than the current one. With two
// or more, "my side project" stays as typed: guessing the wrong project would be worse than nothing.
function onlyOwnProject(notes: Array<{ note: Note; at: Scoped }>, space: string, here: string | undefined): string | undefined {
  const names = new Map<string, string>();
  for (const { note, at } of notes) {
    if (note.space !== space || at.scope !== 'project') continue;
    const name = at.applies[0];
    if (name && !sameProject(name, here)) names.set(name.toLowerCase(), name);
  }
  return names.size === 1 ? [...names.values()][0] : undefined;
}

// A note counts as already known when most of its distinctive words are already in front of the agent.
function isKnown(note: Note, known: Set<string>): boolean {
  const words = [...new Set(tokenize(note.body))];
  if (!words.length) return true;
  return words.filter((w) => known.has(w)).length / words.length >= 0.7;
}

// Words of the prompt that the note also uses, each word of the prompt counted once, the project's own
// name left out (inside a project every one of its notes shares that).
function sharedWords(typed: string, note: Note, names: string[]): string[] {
  const inNote = new Set(tokenize(`${note.body} ${note.topics.join(' ')}`));
  const skip = new Set(names.flatMap((n) => tokenize(n)));
  const seen = new Map<string, string>();
  for (const stems of tokenizeWords(typed)) {
    const root = stems[0]!;
    if (skip.has(root) || stems.some((s) => skip.has(s))) continue;
    if (stems.some((s) => inNote.has(s))) seen.set(root, stems[stems.length - 1]!);
  }
  return [...seen.values()];
}

// "Quorum is a web app that…", "headsup은 로컬 우선의…": the note that says what a project is opens with
// its name as the subject.
function introducesProject(body: string, names: string[]): boolean {
  const text = body.trim();
  return names.some((name) => {
    if (!text.toLowerCase().startsWith(name.toLowerCase())) return false;
    return /^(?:\([^)]*\))?(?:은|는|:| is\b| —| -)/i.test(text.slice(name.length));
  });
}

interface Pick {
  note: Note;
  why: string;
  rank: number;
  called?: boolean; // the prompt asked for it by name or by subject, so it may be offered for an OK
}

export function detect(input: DetectInput): Decision {
  const { prompt, agent, config } = input;
  const targetSpace = input.space ?? (input.cwd ? resolveSpace(input.cwd, config) : config.defaultSpace);
  const decision: Decision = { targetSpace, signals: { references: [] }, inject: [], ask: [], blocked: [], skippedKnown: [], opening: [], why: {} };

  // 1. Only the person's own words count. Pasted text, tool output and code are material, not a request.
  const typed = ownWords(prompt);
  if (!typed) return decision;
  const sentences = sentencesOf(typed);

  // 2. Where the work is: the project of the folder (a home or root folder is no project), and any
  //    project the prompt names.
  const folder = input.cwd ? projectOf(input.cwd) : undefined;
  const atHome = !!input.cwd && (resolve(input.cwd) === resolve(homedir()) || resolve(input.cwd) === '/');
  const here = isProjectName(folder) && !atHome ? folder : undefined;
  const terminal = !!input.cwd;

  const known = projectNames(input.notes);
  const pool = input.notes
    .filter((n) => !input.resting?.has(n.id) && !input.given?.has(n.id) && !givesOrders(n.body))
    .map((note) => ({ note, at: scopeOf(note, known) }));
  if (!pool.length) return decision;
  // Other names this folder's project goes by, as the notes have it (a renamed repo, a product name).
  const hereNames = new Set<string>();
  if (here) {
    for (const { at } of pool) {
      if (at.scope === 'project' && at.applies.some((a) => sameProject(a, here))) for (const a of at.applies) hereNames.add(a.toLowerCase());
    }
  }
  const isHere = (name: string | undefined) => !!here && !!name && (sameProject(name, here) || hereNames.has(name.toLowerCase()));
  // A note the agent wrote in this same project is that project's own business (its CLAUDE.md, its
  // files, the agent's memory); on the web, a note from that same service is already in its memory.
  // headsup carries context across tools and projects, it doesn't echo one back into itself.
  const ownEcho = (n: Note) => n.source === agent && (!terminal || isHere(n.project));
  // A note that names this very tool treats it as another party: how to take Codex's review, what to hand
  // to Codex. It is for the tool on the other side, so the tool it names doesn't get it.
  const forOtherSide = (n: Note, applies: string[]) => namesAgent(agent, [n.body, ...applies].join('\n'));
  for (let i = pool.length - 1; i >= 0; i--) if (forOtherSide(pool[i]!.note, pool[i]!.at.applies)) pool.splice(i, 1);

  const picks: Pick[] = [];

  // The opening is the main moment: the agent knows least, and one well-chosen set of notes there serves
  // the whole conversation. After it the conversation carries its own context, and in real use most
  // later step-ins were unwanted. So later turns are quiet unless the work shifts to a kind this
  // conversation hasn't had (below), the folder changes, or the conversation is compacted (both make
  // the turn an opening again).
  const opening = input.fresh !== false;
  const before = sentencesOf(ownWords(input.earlier ?? ''));

  // 3a. task: the person's own words say it is that kind of work. Only a cue of two or more words
  //     counts; one word ("slide", "commit") turns up in prompts that ask for nothing of the kind.
  //     At the opening the cue's words must share a sentence. Later the cue must be said as a phrase,
  //     and no cue of the note may have come up before in the conversation: a kind of work that is
  //     starting now, not one that has been going on.
  const tasks: Pick[] = [];
  for (const { note, at } of pool) {
    if (at.scope !== 'task' || ownEcho(note)) continue;
    const phrases = at.applies.filter((c) => cueWords(c).length > 1);
    const said = opening ? cuesIn(phrases, sentences) : phrases.filter((c) => phraseIn(c, sentences));
    if (!said.length) continue;
    if (!opening && cuesIn(phrases, before).length) continue;
    tasks.push({ note, why: `task: ${said[0]}`, rank: said.length });
  }
  picks.push(...byRank(tasks).slice(0, TASK_NOTES));

  // 3b. project: the prompt names a project the agent is not in (a web chat, another folder). Inside a
  //     project's own folder its notes stay out: the agent can read the project, and in real use notes
  //     about the project being worked in were noise or worse far more often than help.
  const sideProject = SIDE_PROJECT.test(typed) ? onlyOwnProject(pool, config.defaultSpace, here) : undefined;
  // Only at an opening. A project named later is usually just mentioned (its name in a line of copy
  // being edited); real work on another project starts a conversation or moves to its folder.
  const named = new Set(opening ? known.filter((p) => !isHere(p) && namesProject(p, typed)).map((p) => p.toLowerCase()) : []);
  if (sideProject && opening) named.add(sideProject.toLowerCase());
  const inNamed: Pick[] = [];
  for (const { note, at } of pool) {
    if (at.scope !== 'project' || ownEcho(note)) continue;
    if (at.applies.some(isHere) || isHere(note.project)) continue;
    const name = at.applies.find((a) => named.has(a.toLowerCase()));
    if (!name) continue;
    // What the project is, and what else the prompt touches. A note that merely belongs to the project
    // stays out: naming a project doesn't ask for everything known about it.
    const shared = sharedWords(typed, note, at.applies);
    const introduces = note.type === 'fact' && introducesProject(note.body, at.applies);
    // A web chat can't look the project up, so there its notes need no more than the name; an agent in
    // another folder gets what the project is, or what the prompt is plainly about.
    if (!terminal || shared.length >= SHARED_WORDS || introduces) inNamed.push({ note, why: `project named: ${name}`, rank: shared.length * 2 + (introduces ? 3 : 0), called: true });
  }
  // Among notes that only introduce the project, the oldest: what a project is gets written down first.
  picks.push(...inNamed.sort((a, b) => b.rank - a.rank || a.note.created.localeCompare(b.note.created)).slice(0, terminal ? PROJECT_NOTES : WEB_PROJECT_NOTES));

  // 3c. self: the prompt is about the person. Outside any project, writing about yourself is enough;
  //     inside one, they have to say it is their own.
  const selfWriting = SELF_WRITING.test(typed);
  const mine = MY_SOMETHING.test(typed);
  const selves: Pick[] = [];
  for (const { note, at } of pool) {
    if (at.scope !== 'self' || ownEcho(note)) continue;
    const cues = cuesIn(at.applies, sentences);
    const about = here ? mine && (cues.length > 0 || selfWriting) : selfWriting || (cues.length > 0 && (mine || POSSESSIVE.test(typed)));
    // Later in a conversation: only if writing about themselves is new to it.
    const called = about && (opening || !(SELF_WRITING.test(input.earlier ?? '') || MY_SOMETHING.test(input.earlier ?? '')));
    // Ranked by how much of the prompt the fact is about: its cues first, then the words they share.
    if (called) selves.push({ note, why: cues.length ? `about you: ${cues[0]}` : 'about you', rank: cues.length * 10 + sharedWords(typed, note, []).length, called: true });
  }
  picks.push(...byRank(selves).slice(0, SELF_NOTES));

  // 4. Does the agent already have it? Then the boundary: notes cross between spaces only as the preset allows.
  const knownWords = new Set(tokenize(input.knownText));
  const seen = new Set<string>();
  for (const p of picks.slice(0, MOMENT_NOTES)) {
    if (seen.has(p.note.id)) continue;
    seen.add(p.note.id);
    if (isKnown(p.note, knownWords)) {
      decision.skippedKnown.push(p.note);
      continue;
    }
    const verdict = verdictFor(p.note, targetSpace, config.preset);
    // Asking takes the person's attention: only for something the prompt itself called for.
    if (verdict === 'ask' && !p.called) continue;
    (verdict === 'auto' ? decision.inject : verdict === 'ask' ? decision.ask : decision.blocked).push(p.note);
    decision.why[p.note.id] = p.why;
    decision.signals.references.push(p.why.replace(/^[^:]+:\s*/, ''));
  }

  // 5. Standing notes, at an opening only. No matching: they are about every answer. Only those the
  //    preset lets through without asking; a question about style at the top of every conversation
  //    would be worse than going without.
  if ((input.standing ?? terminal) && opening) {
    const worth = input.worth ?? (() => 0);
    const general = pool
      .filter(({ note, at }) => at.scope === 'general' && note.type === 'how')
      .map(({ note }) => note)
      .filter((n) => verdictFor(n, targetSpace, config.preset) === 'auto' && !isKnown(n, knownWords))
      .sort((a, b) => worth(b) - worth(a) || b.created.localeCompare(a.created));
    let chars = 0;
    for (const n of general) {
      if (decision.opening.length === OPENING_NOTES || chars + n.body.length > OPENING_CHARS) break;
      chars += n.body.length;
      decision.opening.push(n);
      decision.inject.push(n);
      decision.why[n.id] = 'answer style';
    }
  }
  decision.signals.references = [...new Set(decision.signals.references)];
  return decision;
}

const byRank = (picks: Pick[]) => [...picks].sort((a, b) => b.rank - a.rank || b.note.created.localeCompare(a.note.created));
