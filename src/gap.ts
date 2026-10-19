// The Gap Detector answers two separate questions before anything is injected:
//   1. Does this prompt need outside context?  (unresolved references, or the "wrong" tool for the topic)
//   2. Does the agent already have it?          (its own context files, or this session's transcript)

import { conceptsOf, TOPIC_CONCEPTS } from './concepts.js';
import { resolveSpace, type Config } from './config.js';
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
  // Writing about yourself always needs facts about you, even without "my".
  /\b(?:cover\s+letter|resume|résumé|cv|bio|about\s+me|introduce\s+myself|linkedin\s+(?:post|headline|summary|profile))\b/i,
  /\b(?:tell\s+me\s+about\s+(?:yourself|a\s+(?:project|time))|proud\s+of|interview\s+(?:question|prep))\b/i,
  /(?:자기\s*소개|이력서|커버\s*레터|자소서)/,
];

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
  const concepts = new Set(conceptsOf(prompt));
  const words = new Set(tokenize(prompt));
  for (const rule of config.usage) {
    if (rule.agents.includes(agent)) continue;
    for (const topic of rule.topics) {
      // Known topics resolve through the concept lexicon; anything else the user typed matches by word.
      const known = TOPIC_CONCEPTS[topic.toLowerCase()];
      const hit = known ? known.some((c) => concepts.has(c)) : tokenize(topic).some((w) => words.has(w));
      if (hit) return { topic, usualAgents: rule.agents };
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

// Relevance is gated on shared terms (BM25 only ranks). A shared concept — the same kind of task, as in
// "add tests" ↔ "Prefers Vitest" — or two shared words pass when the prompt shows a gap, and always
// pass for how-you-work notes: they are cheap and apply to whole kinds of work. Facts are what people
// mind leaking, so without a gap signal they need three shared words of their own (concepts excluded,
// since a concept usually fires on one of those words).
const MAX_NOTES = 5;
const RELATIVE_CUTOFF = 0.25; // of the best eligible score

function relevantEnough(h: Hit, hasSignal: boolean): boolean {
  if (hasSignal || h.note.type === 'how') return h.concepts >= 1 || h.matched >= 2;
  return h.matched - h.concepts >= 3;
}

export function detect(input: DetectInput): Decision {
  const { prompt, agent, config } = input;
  const targetSpace = resolveSpace(input.cwd, config);
  const signals: Signals = { references: findReferences(prompt), usageMismatch: findUsageMismatch(prompt, agent, config) };
  const empty: Decision = { targetSpace, signals, inject: [], ask: [], blocked: [], skippedKnown: [] };

  // An agent's own notes come back only from other projects: a quorum note can help in northwind,
  // but echoing a project's own sessions into it is noise (that belongs in its CLAUDE.md).
  const project = projectOf(input.cwd);
  const others = input.notes.filter((n) => n.source !== agent || (n.project !== undefined && n.project !== project));
  if (!others.length) return empty;

  const usual = new Set(signals.usageMismatch?.usualAgents ?? []);
  const hits = new NoteIndex(others)
    .search(prompt, 10)
    .map((h) => ({ ...h, score: usual.has(h.note.source) ? h.score * 1.5 : h.score }))
    .sort((a, b) => b.score - a.score);

  const hasSignal = signals.references.length > 0 || !!signals.usageMismatch;
  const eligible = hits.filter((h) => relevantEnough(h, hasSignal));
  const top = eligible[0]?.score ?? 0;
  const relevant = eligible.filter((h) => h.score >= top * RELATIVE_CUTOFF).slice(0, MAX_NOTES);

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
