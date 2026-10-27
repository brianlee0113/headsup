// The share card: which AI the person uses for what, how context crossed between them, and a few
// general lines about how they work. Built on this computer from counts, tool names, broad topics
// and reworded how-you-work notes. Facts, work notes, never-share notes and names never go on it.

import { agentName } from './agents.js';
import type { Prompt, Summarize } from './capture.js';
import { conceptsOf, TOPIC_CONCEPTS } from './concepts.js';
import type { Config } from './config.js';
import type { Note } from './note.js';
import { withoutPending } from './spaces.js';
import type { Store } from './store.js';

export interface CardTool {
  name: string;
  topics: string[];
  share: number; // 0..1 of the person's notes
}
export interface CardFlow {
  from: string;
  to: string;
  what: string;
  times: number;
}
export interface CardData {
  month: string; // "OCT 2026"
  headline: string;
  tools: CardTool[];
  flows: CardFlow[];
  style: string[];
  numbers: { tools: number; notes: number; steppedIn: number; prompts: number | null };
}

// Concept tags as words a stranger would read on a card.
const CONCEPT_LABEL: Record<string, string> = {
  profile: 'career', traction: 'launching', testing: 'testing', packages: 'tooling', git: 'git', ci: 'CI',
  writing: 'writing', format: 'summaries', food: 'food', travel: 'travel', education: 'school',
};
const KNOWN_TOPICS = new Set([...Object.keys(TOPIC_CONCEPTS), ...Object.values(CONCEPT_LABEL)]);

// On a card people know it as Claude; "Claude.ai" is for telling it apart from Claude Code elsewhere.
const cardName = (agent: string) => (agent === 'claude-ai' ? 'Claude' : agentName(agent));

const top = <T>(counts: Map<T, number>, n: number): T[] => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const tally = <T>(items: T[]) => items.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<T, number>());
const conceptWords = (notes: Note[]) => notes.flatMap((n) => conceptsOf(`${n.body} ${n.topics.join(' ')}`)).map((c) => CONCEPT_LABEL[c]!);

// Only topics from the shared list: the usage profile is free text and could name a project.
function topicsFor(agent: string, notes: Note[], config: Config): string[] {
  const said = config.usage.filter((r) => r.agents.includes(agent)).flatMap((r) => r.topics.map((t) => t.toLowerCase()));
  const fromProfile = [...new Set(said.filter((t) => KNOWN_TOPICS.has(t)))];
  if (fromProfile.length) return fromProfile.slice(0, 3);
  return top(tally(conceptWords(notes)), 3);
}

export function cardFacts(store: Store, config: Config, now = new Date()): Omit<CardData, 'headline' | 'style'> {
  const notes = store.list();
  // Counts reveal nothing and use every note. The words on the card (topics, what crossed over) come
  // only from notes the person could post: personal, sorted, not an employer's process.
  const postable = new Set(withoutPending(notes, store.home, config).filter((n) => n.space === config.defaultSpace && !n.internal && n.share !== 'never').map((n) => n.id));
  const words = (ns: Note[]) => ns.filter((n) => postable.has(n.id));
  const bySource = new Map<string, Note[]>();
  for (const n of notes) bySource.set(n.source, [...(bySource.get(n.source) ?? []), n]);
  const tools = [...bySource]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([agent, ns]) => ({ name: cardName(agent), topics: topicsFor(agent, words(ns), config), share: ns.length / notes.length }));

  // Every note that went into a prompt, by where it came from and where it went.
  const byId = new Map(notes.map((n) => [n.id, n]));
  const log = store.readLog();
  const pairs = new Map<string, Note[]>();
  const used = (e: Record<string, unknown>) => (e.event === 'heads-up' ? e.injected : e.event === 'shared-after-ask' ? e.notes : []) as string[] | undefined;
  for (const e of log) {
    for (const id of used(e) ?? []) {
      const n = byId.get(id);
      if (!n || n.source === e.agent) continue;
      const key = `${n.source}\u0000${e.agent as string}`;
      pairs.set(key, [...(pairs.get(key) ?? []), n]);
    }
  }
  const flows = [...pairs]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([key, ns]) => {
      const [from, to] = key.split('\u0000') as [string, string];
      const what = top(tally(conceptWords(words(ns))), 2).join(', ') || (ns.every((n) => n.type === 'how') ? 'how you work' : 'context');
      return { from: cardName(from), to: cardName(to), what, times: ns.length };
    });

  const counted = store.readPromptCount();
  const since = counted?.since ?? '';
  const steppedIn = log.filter((e) => String(e.at) >= since && ((e.event === 'heads-up' && (e.injected as string[]).length) || e.event === 'shared-after-ask')).length;
  const agents = new Set([...bySource.keys(), ...log.map((e) => e.agent).filter((a): a is string => typeof a === 'string')]);
  return {
    month: now.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase(),
    tools,
    flows,
    numbers: { tools: agents.size, notes: notes.length, steppedIn, prompts: counted ? Math.max(counted.count, steppedIn) : null },
  };
}

export function templateHeadline(tools: CardTool[]): string {
  const lines = tools.filter((t) => t.topics.length).slice(0, 2).map((t) => `${t.name} for ${t.topics[0]}.`);
  return lines.join(' ') || 'One memory across my AI tools.';
}

// Only how-you-work notes from the person's own spaces, never ones marked never-share, and never a web
// note not yet sorted into work or personal (see spaces.ts): the card is public.
export function styleSource(store: Store, config: Config): Note[] {
  const work = new Set(config.spaces.map((s) => s.space));
  return withoutPending(store.list(), store.home, config).filter((n) => n.type === 'how' && n.share !== 'never' && !work.has(n.space) && n.space !== 'work');
}

export function buildCardPrompt(tools: CardTool[], how: Note[]): Prompt {
  const system = `You write two things for a card a person will post publicly about how they use AI tools.

1. headline: one or two short sentences, under 60 characters in all, naming their main AI tools and what each is for. Example: "Claude for building. ChatGPT for words."
2. style: up to 3 lines about how they like to work with AI, each under 70 characters, in plain English.

Rules for the style lines:
- Generalize. Never include names of people, projects, products, companies, schools, places, numbers or dates.
- Never copy a note word for word; say what kind of person this is.
- Leave out anything private, health, money or relationship related.

Output only JSON: {"headline":"...","style":["...","...","..."]}`;
  const user = `<tools>
${tools.map((t) => `- ${t.name}: ${t.topics.join(', ') || '(no topics)'} (${Math.round(t.share * 100)}%)`).join('\n')}
</tools>

<how_they_work>
${how.slice(0, 40).map((n) => `- ${n.body}`).join('\n') || '(none)'}
</how_they_work>

Write the headline and style lines. Output only the JSON object.`;
  return { system, user };
}

// Rejects lines that still carry a project name or are too long; the card falls back to fewer lines.
export function parseCardReply(text: string, notes: Note[]): { headline?: string; style: string[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let raw: { headline?: unknown; style?: unknown } = {};
  try {
    if (start >= 0 && end > start) raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    // fall through to nothing
  }
  const names = [...new Set(notes.map((n) => n.project).filter((p): p is string => !!p && p.length > 2))].map((p) => p.toLowerCase());
  const clean = (s: unknown, max: number) => (typeof s === 'string' && s.trim() && s.trim().length <= max && !names.some((p) => s.toLowerCase().includes(p)) ? s.trim() : undefined);
  const style = Array.isArray(raw.style) ? raw.style.map((s) => clean(s, 70)).filter((s): s is string => !!s).slice(0, 3) : [];
  return { headline: clean(raw.headline, 60), style };
}

export async function buildCard(store: Store, config: Config, summarize: Summarize | null): Promise<CardData> {
  const facts = cardFacts(store, config);
  const how = styleSource(store, config);
  let headline = templateHeadline(facts.tools);
  let style: string[] = [];
  if (summarize && how.length) {
    try {
      const r = parseCardReply(await summarize(buildCardPrompt(facts.tools, how)), store.list());
      headline = r.headline ?? headline;
      style = r.style;
    } catch {
      // No claude, or it failed: the card goes out with the template headline and no style lines.
    }
  }
  return { ...facts, headline, style };
}
