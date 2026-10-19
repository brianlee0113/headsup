// The Gap Detector answers two separate questions before anything is injected:
//   1. Does this prompt need outside context?  (unresolved references, or the "wrong" tool for the topic)
//   2. Does the agent already have it?          (its own context files, or this session's transcript)

import { resolveSpace, type Config } from './config.js';
import type { Note } from './note.js';
import { verdictFor } from './policy.js';
import { NoteIndex, tokenize } from './search.js';

const REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:my|our)\s+(?:usual|side[- ]project|project|app|startup|team|manager|boss|company|internship|voice|tone|style|convention|setup|stack|launch)\b/i,
  /\b(?:like|as)\s+(?:last\s+time|before|usual|always)\b/i,
  /\b(?:like|as)\s+(?:we|i)\s+(?:have|had|do|did|use|used|usually)\b/i,
  /\bat\s+(?:work|my\s+job|the\s+office)\b/i,
  /\bsame\s+\w*\s*(?:as|like)\s+(?:last|before)\b/i,
  /\b(?:last|previous)\s+(?:week|time|session|sprint)\b/i,
  /\bthe\s+way\s+(?:i|we)\s+(?:usually|always|normally)\b/i,
  /\bin\s+my\s+(?:voice|style|tone|words)\b/i,
  /(?:평소|늘|항상)\s*(?:처럼|대로|하던)/,
  /지난\s*(?:번|주|시간)/,
  /(?:내|우리|제)\s*(?:프로젝트|말투|스타일|팀|회사|앱|서비스)/,
  // Writing about yourself always needs facts about you, even without "my".
  /\b(?:cover\s+letter|resume|résumé|cv|bio|about\s+me|introduce\s+myself|linkedin\s+(?:post|headline|summary|profile))\b/i,
  /(?:자기\s*소개|이력서|커버\s*레터|자소서)/,
];

// Expands usage-profile topics ("writing") into words a prompt about that topic would contain.
const TOPIC_WORDS: Record<string, string[]> = {
  writing: ['write', 'draft', 'post', 'email', 'letter', 'essay', 'blog', 'linkedin', 'tweet', 'cover', 'copy', 'announcement', 'rewrite', 'edit', 'tone', '글', '이메일', '편지', '작성'],
  coding: ['code', 'bug', 'function', 'repo', 'deploy', 'build', 'test', 'refactor', 'api', 'error', 'typescript', 'python', '코드', '버그', '배포'],
  'side projects': ['side', 'project', 'launch', 'app', 'users', 'mvp', 'ship', '사이드', '프로젝트', '런칭'],
  everyday: ['plan', 'trip', 'recipe', 'gift', 'schedule', 'weekend', '여행', '일정'],
};

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
  cwd: string;
  knownText: string; // agent context files + current transcript
  notes: Note[];
  config: Config;
}

export function findReferences(prompt: string): string[] {
  return REFERENCE_PATTERNS.map((re) => re.exec(prompt)?.[0]).filter((m): m is string => !!m);
}

export function findUsageMismatch(prompt: string, agent: string, config: Config): Signals['usageMismatch'] {
  const words = new Set(tokenize(prompt));
  for (const rule of config.usage) {
    if (rule.agents.includes(agent)) continue;
    for (const topic of rule.topics) {
      const vocab = TOPIC_WORDS[topic.toLowerCase()] ?? tokenize(topic);
      if (vocab.some((w) => words.has(w) || words.has(w.toLowerCase()))) {
        return { topic, usualAgents: rule.agents };
      }
    }
  }
  return undefined;
}

// A note counts as already known when most of its distinctive words are already in front of the agent.
function isKnown(note: Note, known: Set<string>): boolean {
  const words = [...new Set(tokenize(note.body))];
  if (!words.length) return true;
  return words.filter((w) => known.has(w)).length / words.length >= 0.7;
}

// Relevance is gated on how many distinct prompt words a note shares (BM25 only ranks). Without a gap
// signal the bar is higher, and lower for how-you-work notes than facts: they are cheap, low-risk,
// and matter for whole task types ("set up a new package").
const MIN_MATCHED_WITH_SIGNAL = 1;
const MIN_MATCHED_WITHOUT_SIGNAL: Record<Note['type'], number> = { how: 2, fact: 3 };
const MAX_NOTES = 5;

export function detect(input: DetectInput): Decision {
  const { prompt, agent, config } = input;
  const targetSpace = resolveSpace(input.cwd, config);
  const signals: Signals = { references: findReferences(prompt), usageMismatch: findUsageMismatch(prompt, agent, config) };
  const empty: Decision = { targetSpace, signals, inject: [], ask: [], blocked: [], skippedKnown: [] };

  const others = input.notes.filter((n) => n.source !== agent);
  if (!others.length) return empty;

  const usual = new Set(signals.usageMismatch?.usualAgents ?? []);
  const hits = new NoteIndex(others)
    .search(prompt, 10)
    .map((h) => ({ ...h, score: usual.has(h.note.source) ? h.score * 1.5 : h.score }))
    .sort((a, b) => b.score - a.score);

  const hasSignal = signals.references.length > 0 || !!signals.usageMismatch;
  const floor = (n: Note) => (hasSignal ? MIN_MATCHED_WITH_SIGNAL : MIN_MATCHED_WITHOUT_SIGNAL[n.type]);
  const top = hits[0]?.score ?? 0;
  const relevant = hits.filter((h) => h.matched >= floor(h.note) && h.score >= top * 0.4).slice(0, MAX_NOTES);

  const known = new Set(tokenize(input.knownText));
  const decision = { ...empty };
  for (const { note } of relevant) {
    if (isKnown(note, known)) {
      decision.skippedKnown.push(note);
      continue;
    }
    const verdict = verdictFor(note, targetSpace, config.preset);
    (verdict === 'auto' ? decision.inject : verdict === 'ask' ? decision.ask : decision.blocked).push(note);
  }
  return decision;
}
