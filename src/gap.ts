// The Gap Detector answers two separate questions before anything is injected:
//   1. Does this prompt need outside context?  (unresolved references, or the "wrong" tool for the topic)
//   2. Does the agent already have it?          (its own context files, or this session's transcript)

import { conceptsOf, genresOf, TOPIC_CONCEPTS } from './concepts.js';
import { resolveSpace, type Config } from './config.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { projectOf } from './context.js';
import type { Note } from './note.js';
import { verdictFor } from './policy.js';
import { NoteIndex, tokenize, type Hit } from './search.js';

const REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:my|our)\s+(?:usual|side[- ]project|project|app|startup|team|manager|boss|company|internship|voice|tone|style|convention|setup|stack|launch)\b/i,
  /\b(?:like|as)\s+(?:last\s+time|before|usual|always)\b/i,
  /\b(?:like|as)\s+(?:we|i)\s+(?:have|had|do|did|use|used|usually)\b/i,
  /\bat\s+(?:work|my\s+job|the\s+office)\b/i,
  /\bsame\s+\w*\s*(?:as|like)\s+(?:last|before)\b/i,
  /\b(?:last|previous|this\s+past)\s+(?:week|time|session|sprint|summer|semester|year|job|internship)\b/i,
  /\bthe\s+way\s+(?:i|we)\s+(?:usually|always|normally)\b/i,
  /\bin\s+my\s+(?:voice|style|tone|words)\b/i,
  /(?:평소|늘|항상)\s*(?:처럼|대로|하던)/,
  /지난\s*(?:번|주|시간)/,
  /(?:내|우리|제)\s*(?:프로젝트|말투|스타일|팀|회사|앱|서비스)/,
  // "the way I like", "my level": the answer depends on the person, so their notes may hold it.
  /(?:내가|제가)\s*(?:좋아하는|선호하는|원하는|자주\s*쓰는|평소\s*쓰는|쓰는)\s*(?:형식|방식|스타일|말투|톤|포맷)/,
  /평소\s*(?:내|제)?\s*(?:스타일|말투|방식|형식|쓰는|쓰던|하던)/,
  /(?:내|제)\s*(?:수준|직무|담당|업무|상황|경력|커리어|레벨)/,
  /\b(?:the\s+)?(?:way|format|style|tone)\s+(?:i|we)\s+(?:like|prefer|usually\s+use)\b/i,
  /\bmy\s+(?:level|role|skill\s+level|preferred\s+\w+)\b/i,
  // Writing about yourself always needs facts about you, even without "my".
  /\b(?:cover\s+letter|resume|résumé|cv|bio|about\s+me|introduce\s+myself|linkedin\s+(?:post|headline|summary|profile))\b/i,
  /\b(?:tell\s+me\s+about\s+(?:yourself|a\s+(?:project|time))|proud\s+of|interview\s+(?:question|prep))\b/i,
  /(?:자기\s*소개|이력서|커버\s*레터|자소서)/,
];

// A prompt about who the person is in one specific way: their job, their side business, the exam they
// are taking. Narrower than the references above on purpose: it reaches only facts on that same subject,
// and changes nothing else (how-you-work notes, project rules, the bar for asking stay as they are).
// The note side is matched by subject, not by shared words: "지금 하는 일 기준으로" shares no word with
// "오롯에서 퍼포먼스 마케팅을 담당한다", and search alone never brings that fact up.
type Identity = 'role' | 'sideBusiness' | 'exam';
const IDENTITY_IN_PROMPT: Record<Identity, RegExp[]> = {
  role: [
    /(?:내|제)\s*(?:직업|직무)|(?:지금|현재|요즘)\s*(?:내가\s*|제가\s*)?하(?:는|고\s*있는)\s*일|(?:내|제)가\s*하는\s*일/,
    /\bmy\s+(?:job|role|day\s+job|current\s+job|position)\b|\bwhat\s+i\s+do\s+(?:now|for\s+work|for\s+a\s+living)\b/i,
  ],
  sideBusiness: [/(?:내|제)\s*(?:부업|가게)/, /\bmy\s+(?:side\s+(?:gig|business|hustle)|online\s+(?:shop|store))\b/i],
  exam: [
    /(?:내|제)\s*(?:시험|목표\s*(?:급수|점수))|(?:내가|제가)\s*준비\s*(?:하는|중인)\s*시험/,
    /\bmy\s+(?:exam|certification)\b|\bthe\s+(?:exam|test|certification)\s+i(?:'m|\s+am)\s+(?:studying|preparing)\s+for\b/i,
  ],
};
const IDENTITY_IN_NOTE: Record<Identity, RegExp> = {
  role: /담당|맡고\s*있|맡은|직무|직업|재직|근무|에서\s*일하|\b(?:works?\s+(?:as|at)|interns?|internship|interning|role|job|engineer|developer|designer|manager|marketer|PM)\b/i,
  sideBusiness: /부업|스마트스토어|개인\s*사업|쇼핑몰|가게|\b(?:side\s+(?:business|gig|hustle)|etsy|shopify|online\s+(?:shop|store))\b/i,
  exam: /시험|급수|자격증|JLPT|IELTS|TOEIC|TOEFL|\b(?:exam|certification|GRE|GMAT)\b/i,
};
export const identitiesIn = (prompt: string): Identity[] =>
  (Object.keys(IDENTITY_IN_PROMPT) as Identity[]).filter((k) => IDENTITY_IN_PROMPT[k].some((re) => re.test(prompt)));
const IDENTITY_NOTES = 2; // per subject: the newest

const SIDE_PROJECT = /\b(?:my\s+)?(?:side|personal|toy|hobby)\s+project\b|(?:사이드|개인|토이)\s*프로젝트/i;

// The one project in the person's own space, named by their notes, other than the current one.
function onlyOwnProject(notes: Note[], space: string, current: string | undefined): string | undefined {
  const names = new Set(notes.filter((n) => n.space === space && n.project && !GENERIC_FOLDERS.has(n.project.toLowerCase()) && n.project !== current).map((n) => n.project!));
  return names.size === 1 ? [...names][0] : undefined;
}

export interface Signals {
  references: string[];
  usageMismatch?: { topic: string; usualAgents: string[] };
}

export interface Decision {
  targetSpace: string;
  signals: Signals;
  inject: Note[];
  ask: Note[];
  blocked: Note[];
  skippedKnown: Note[];
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
  // compacted: when the agent knows least. Later turns build on what is already said. Default true.
  fresh?: boolean;
}

export function findReferences(prompt: string): string[] {
  return REFERENCE_PATTERNS.map((re) => re.exec(prompt)?.[0]).filter((m): m is string => !!m);
}

export function findUsageMismatch(prompt: string, agent: string, config: Config): Signals['usageMismatch'] {
  const concepts = new Set(conceptsOf(prompt));
  const words = new Set(tokenize(prompt));
  // Known topics resolve through the concept lexicon; anything else the user typed matches by word.
  const about = (topic: string) => {
    const known = TOPIC_CONCEPTS[topic.toLowerCase()];
    return known ? known.some((c) => concepts.has(c)) : tokenize(topic).some((w) => words.has(w));
  };
  const own = config.usage.filter((r) => r.agents.includes(agent));
  // Coding in Claude Code is not off-pattern just because Codex is also used for coding.
  if (own.some((r) => r.topics.some(about))) return undefined;
  for (const rule of config.usage) {
    if (rule.agents.includes(agent)) continue;
    const topic = rule.topics.find(about);
    if (topic) return { topic, usualAgents: rule.agents };
  }
  return undefined;
}

// A note counts as already known when most of its distinctive words are already in front of the agent.
function isKnown(note: Note, known: Set<string>): boolean {
  const words = [...new Set(tokenize(note.body))];
  if (!words.length) return true;
  return words.filter((w) => known.has(w)).length / words.length >= 0.7;
}

// Relevance is gated on shared terms (BM25 only ranks). A shared concept — the same kind of task, as in
// "add tests" ↔ "Prefers Vitest" — or two shared words pass when the prompt shows a gap, and always
// pass for how-you-work notes: they are cheap and apply to whole kinds of work. Facts are what people
// mind leaking, so without a gap signal they need three shared words of their own (concepts excluded,
// since a concept usually fires on one of those words).
const MAX_NOTES = 5;
const RELATIVE_CUTOFF = 0.25; // of the best eligible score

// A note that belongs to another project stays there unless the request is about that project or about
// the person (in a chat outside any project; inside a project, the work is the project). Sharing a stack is not enough: in real use, one project's deployment facts kept riding
// into every other project that also mentions Vercel or Supabase. A note belongs to a project when it was
// a fact learned there, or when its text names the project.
function inScope(note: Note, at: { prompt: string; project?: string; notes: Note[]; aboutSelf: boolean; namesSelf: boolean }): boolean {
  // Inside a project, a fact about the person that belongs to no project (their school, their job search)
  // goes in only when the prompt is plainly about them ("my resume", "my school"). Shared words like
  // "email" or "apply" kept pulling such facts into unrelated project work.
  if (at.project && note.type === 'fact' && !note.project && !at.namesSelf) return false;
  const projects = new Set(at.notes.map((n) => n.project).filter((p): p is string => !!p && !GENERIC_FOLDERS.has(p.toLowerCase())));
  const body = note.body.toLowerCase();
  const owners = new Set([
    ...(note.type === 'fact' && note.project && !GENERIC_FOLDERS.has(note.project.toLowerCase()) ? [note.project] : []),
    ...[...projects].filter((p) => body.includes(p.toLowerCase()) || body.includes(p.toLowerCase().replace(/[-_]/g, ' '))),
  ]);
  if (at.project) owners.delete(at.project);
  if (!owners.size || at.aboutSelf) return true;
  const prompt = at.prompt.toLowerCase();
  return [...owners].some((p) => prompt.includes(p.toLowerCase()) || prompt.includes(p.toLowerCase().replace(/[-_]/g, ' ')));
}

const GENERIC_FOLDERS = new Set(['developer', 'projects', 'code', 'src', 'work', 'home', '']);

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

const SELF_WRITING = /^(?:cover\s+letter|resume|résumé|cv|bio|about\s+me|introduce\s+myself|linkedin.*|자기\s*소개|이력서|커버\s*레터|자소서)$/i;
const POSSESSIVE_SELF = /(?:\bmy\s+|(?:^|\s)(?:내|제)\s*)(?:cover\s+letter|resume|résumé|cv|bio|이력서|자기\s*소개|자소서|커버\s*레터)/i;

// "Writing" and "format" fit almost any request; a shared concept narrower than those (food, travel,
// testing) says the note is really about what is being asked.
const BROAD_CONCEPTS = new Set(['writing', 'format']);
function sharesSpecificConcept(note: Note, promptConcepts: Set<string>): boolean {
  return conceptsOf(`${note.body} ${note.topics.join(' ')}`).some((c) => promptConcepts.has(c) && !BROAD_CONCEPTS.has(c));
}

function relevantEnough(h: Hit, hasSignal: boolean, foreign = false, promptConcepts: Set<string> = new Set()): boolean {
  const words = h.matched - h.concepts;
  // A shared concept counts for a how-you-work note only when the note's text carries it. Topics are the
  // summarizer's labels and run broad: a note on trying out new AI models was tagged "testing" and came
  // up for every "add tests" and "run e2e". Without the concept, it needs two words of its own.
  if (h.note.type === 'how' && !hasSignal && h.concepts && !conceptsOf(h.note.body).some((c) => promptConcepts.has(c))) return words >= 2;
  if (h.note.type === 'how' && foreign && !hasSignal) return (h.concepts >= 1 && words >= 1) || words >= 2;
  if (hasSignal || h.note.type === 'how') return h.concepts >= 1 || h.matched >= 2;
  return h.matched - h.concepts >= 3;
}

export function detect(input: DetectInput): Decision {
  const { prompt, agent, config } = input;
  const targetSpace = input.space ?? (input.cwd ? resolveSpace(input.cwd, config) : config.defaultSpace);
  const signals: Signals = { references: findReferences(prompt), usageMismatch: findUsageMismatch(prompt, agent, config) };
  const empty: Decision = { targetSpace, signals, inject: [], ask: [], blocked: [], skippedKnown: [] };

  // An agent's own notes come back only from other projects: a quorum note can help in northwind,
  // but echoing a project's own sessions into it is noise (that belongs in its CLAUDE.md).
  const project = input.cwd ? projectOf(input.cwd) : undefined;
  // For project scoping, a home or root folder is not a project: the person is not working on anything.
  const inProject = project && !GENERIC_FOLDERS.has(project.toLowerCase()) && resolve(input.cwd!) !== resolve(homedir()) && resolve(input.cwd!) !== '/' ? project : undefined;
  const others = input.notes.filter((n) => !input.resting?.has(n.id) && !input.given?.has(n.id) && !givesOrders(n.body) && (n.source !== agent || (n.project !== undefined && n.project !== project)));
  if (!others.length) return empty;

  const usual = new Set(signals.usageMismatch?.usualAgents ?? []);
  // "my side project" names a project by kind; notes name it ("Quorum is…"). When the person's own
  // space holds exactly one project other than the one they're in, the prompt is read as naming it.
  // With two or more it stays as typed: guessing the wrong project would be worse than nothing.
  const sideProject = SIDE_PROJECT.test(prompt) ? onlyOwnProject(input.notes, config.defaultSpace, inProject) : undefined;
  const query = sideProject ? `${prompt} ${sideProject}` : prompt;
  const hits = new NoteIndex(others)
    .search(query, 10)
    .map((h) => ({ ...h, score: usual.has(h.note.source) ? h.score * 1.5 : h.score }))
    .sort((a, b) => b.score - a.score);

  const hasSignal = signals.references.length > 0 || !!signals.usageMismatch;
  // Inside a project, another project's how-you-work notes need a shared word, not just a shared sense.
  // Notes captured at the top of the projects folder belong to no project.
  const foreign = (n: Note) => !!inProject && !!n.project && n.project !== inProject && !GENERIC_FOLDERS.has(n.project.toLowerCase());
  // A style note written for one kind of writing (emails, commit messages, Slack) stays out of requests
  // for another kind; it pulled answers the wrong way in the launch simulation.
  const promptGenres = new Set(genresOf(prompt));
  const fitsGenre = (n: Note) => {
    const kinds = n.type === 'how' ? genresOf(n.body) : [];
    return !kinds.length || kinds.some((g) => promptGenres.has(g));
  };
  const promptConceptSet = new Set(conceptsOf(prompt));
  // Inside a project, "resume" or "About me" is often what the project is about (a resume builder, a
  // feature name), so it counts as writing about oneself only with "my" / "내" / "제" in front.
  const selfRefs = inProject ? signals.references.filter((r) => !SELF_WRITING.test(r) || POSSESSIVE_SELF.test(prompt)) : signals.references;
  const aboutSelf = !inProject && hasSignal && (signals.references.length > 0 || conceptsOf(prompt).includes('profile'));
  // After the opening, the agent has the conversation to go on: a how-you-work note comes in only for a
  // kind of task it is specifically about (tests, commits, deploys), not for sharing a broad sense like
  // writing or format. General style notes belong at the opening.
  const later = input.fresh === false;
  // A fact comes in later only when the prompt reaches for something the conversation doesn't hold:
  // "my …", "the way we do it at work", or work usually done in another tool.
  const stillHelps = (h: Hit) => !later || hasSignal || (h.note.type === 'how' && sharesSpecificConcept(h.note, promptConceptSet));
  const eligible = hits.filter((h) => stillHelps(h) && relevantEnough(h, hasSignal, foreign(h.note), promptConceptSet) && fitsGenre(h.note) && inScope(h.note, { prompt: query, project: inProject, notes: input.notes, aboutSelf, namesSelf: selfRefs.length > 0 || (!!signals.usageMismatch && sharesSpecificConcept(h.note, promptConceptSet)) }));
  const top = eligible[0]?.score ?? 0;
  const relevant = eligible.filter((h) => h.score >= top * RELATIVE_CUTOFF).slice(0, MAX_NOTES);
  // Facts on the subject the prompt asks about ("my job", "내 부업"), found by subject, within the same
  // rules for spaces and project scope; they don't need to share words, and may be offered for an OK.
  // They come first: the prompt asked about exactly this, so they don't wait behind looser matches.
  const identity = new Set<string>();
  for (const subject of identitiesIn(prompt)) {
    const facts = others
      .filter((n) => n.type === 'fact' && IDENTITY_IN_NOTE[subject].test(`${n.body} ${n.topics.join(' ')}`))
      .filter((n) => inScope(n, { prompt, project: inProject, notes: input.notes, aboutSelf: !inProject, namesSelf: true }))
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, IDENTITY_NOTES);
    for (const n of facts) identity.add(n.id);
  }
  if (identity.size) {
    const byId = new Map(others.map((n) => [n.id, n]));
    const first = [...identity].map((id) => relevant.find((h) => h.note.id === id) ?? { note: byId.get(id)!, score: 0, matched: 0, concepts: 0 });
    relevant.splice(0, relevant.length, ...first, ...relevant.filter((h) => !identity.has(h.note.id)));
    relevant.splice(MAX_NOTES);
  }

  const known = new Set(tokenize(input.knownText));
  const decision = { ...empty };
  for (const { note } of relevant) {
    if (isKnown(note, known)) {
      decision.skippedKnown.push(note);
      continue;
    }
    const verdict = verdictFor(note, targetSpace, config.preset);
    // Asking interrupts the answer and takes the person's attention, so it needs more than adding does:
    // a prompt plainly about the person ("cover letter", "my resume"), or two words of its own in common.
    if (verdict === 'ask' && !selfRefs.length && !identity.has(note.id)) {
      const h = relevant.find((x) => x.note.id === note.id)!;
      if (h.matched - h.concepts < 2) continue;
    }
    (verdict === 'auto' ? decision.inject : verdict === 'ask' ? decision.ask : decision.blocked).push(note);
  }
  return decision;
}
