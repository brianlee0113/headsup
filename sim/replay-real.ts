// Replays every real prompt on this computer through the old decision logic (0.1.8, sim/legacy) and the
// new one (src/gap.ts), conversation by conversation, against a throwaway copy of the store. Nothing is
// written to ~/.headsup, and no labels are read: scoring against labels is sim/score-replay.ts.
//
//   pnpm tsx sim/replay-real.ts                 writes .local/redesign/replay.json
//   pnpm tsx sim/replay-real.ts --no-model      never calls a model: notes without a cached scope keep the narrow fallback
//
// Each prompt is judged with the notes that existed when it was typed (created before it, not yet set
// aside), the conversation up to it, and the per-conversation state both versions keep (notes already
// given, the opening turn). What can't be brought back: the CLAUDE.md files as they were then (today's
// are read), and learning's resting notes (none are rested here, in either version).
//
// Scopes for notes saved before scopes existed come from `rescope` (sonnet, through your own Claude
// login) and are cached in .local/redesign/scopes.json, so only the first run calls a model.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { headsupHome, loadConfig } from '../src/config.js';
import { projectOf, readAgentContext } from '../src/context.js';
import { detect } from '../src/gap.js';
import type { Note } from '../src/note.js';
import { ownWords } from '../src/scope.js';
import { detect as detectOld } from './legacy/gap-0.1.8.js';
import { usage } from './llm.js';
import { collectRealPrompts, type RealPrompt } from './real-prompts.js';
import { openRealStore } from './real-store.js';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = flag('--out') ?? join(ROOT, '.local', 'redesign', 'replay.json');
const SCOPES = flag('--scopes') ?? join(ROOT, '.local', 'redesign', 'scopes.json');
const source = flag('--home') ?? headsupHome();

interface Shown { id: string; type: string; scope?: string; project?: string; why?: string; body: string }
export interface Outcome {
  decision: 'stepped' | 'quiet';
  added: Shown[];
  offered: Shown[];
  opening?: Shown[]; // new logic only: the standing answer-style notes given at a conversation's opening
  held?: string[]; // new logic only: ids given earlier in this conversation and still in front of the agent
}
export interface Replayed {
  at: string;
  agent: string;
  project: string; // the folder's project, or "web"
  session: string;
  fresh: boolean;
  typed: boolean;
  prompt: string;
  logged?: { added: Shown[]; offered: Shown[] }; // what headsup really did then (the labels are about this)
  old: Outcome;
  new: Outcome;
}

const real = await openRealStore(source, SCOPES, { model: !args.includes('--no-model') });
const config = loadConfig(real.home);
const all = real.store.list();
const byId = new Map(all.map((n) => [n.id, n]));
const show = (n: Note, why?: string): Shown => ({ id: n.id, type: n.type, ...(n.scope ? { scope: n.scope } : {}), ...(n.project ? { project: n.project } : {}), ...(why ? { why } : {}), body: n.body });
const showId = (id: string): Shown => (byId.has(id) ? show(byId.get(id)!) : { id, type: '?', body: '(note no longer exists)' });

// The notes there were when a prompt was typed.
const existing = (at: string) => all.filter((n) => n.created <= at && !(real.archivedOn.has(n.id) && `${real.archivedOn.get(n.id)}T00:00:00.000Z` <= at));

const prompts = collectRealPrompts(real.home);
interface State { cwd?: string; given: Set<string>; said?: string[] }
const oldState = new Map<string, State>();
const newState = new Map<string, State>();
const context = new Map<string, string>();
const agentContext = (agent: string, cwd: string) => {
  const key = `${agent}\n${cwd}`;
  if (!context.has(key)) context.set(key, readAgentContext(agent, cwd));
  return context.get(key)!;
};

const out: Record<string, Replayed> = {};
for (const p of prompts) {
  const web = p.agent === 'chatgpt' || p.agent === 'claude-ai';
  const notes = existing(p.at);
  const knownText = web || !p.cwd ? p.before : `${agentContext(p.agent, p.cwd)}\n${p.before}`;
  const turn = (state: Map<string, State>) => {
    const was = web ? undefined : state.get(p.session);
    const fresh = !was || p.compacted || was.cwd !== p.cwd;
    return { was, fresh, given: p.compacted ? new Set<string>() : was?.given ?? new Set<string>() };
  };
  const where = web || !p.cwd ? { space: config.defaultSpace } : { cwd: p.cwd };

  // Old: the 0.1.8 hook let generated messages through only when they didn't start with a known tag; the
  // log shows what really happened, this shows what its logic does with today's inputs.
  const o = turn(oldState);
  const od = detectOld({ prompt: p.prompt, agent: p.agent, ...where, knownText, notes, config, ...(web ? {} : { given: o.given, fresh: o.fresh }) });
  if (!web) oldState.set(p.session, { cwd: p.cwd, given: new Set([...o.given, ...od.inject.map((n) => n.id), ...od.ask.map((n) => n.id)]) });

  const n = turn(newState);
  const said = n.fresh ? [] : n.was?.said ?? [];
  const nd = detect({ prompt: p.prompt, agent: p.agent, ...where, knownText, notes, config, ...(web ? {} : { given: n.given, fresh: n.fresh, earlier: said.join('\n') }) });
  // The new hook leaves a message with nothing typed in it alone, state included: the opening is still ahead.
  if (!web && ownWords(p.prompt)) newState.set(p.session, { cwd: p.cwd, given: new Set([...n.given, ...nd.inject.map((x) => x.id), ...nd.ask.map((x) => x.id)]), said: [...said, ownWords(p.prompt)] });
  const picked = nd.inject.filter((x) => !nd.opening.includes(x));

  out[p.key] = {
    at: p.at,
    agent: p.agent,
    project: web || !p.cwd ? 'web' : projectOf(p.cwd) || basename(p.cwd),
    session: p.session,
    fresh: n.fresh,
    typed: !!ownWords(p.prompt),
    prompt: p.prompt.slice(0, 1200),
    ...(p.logged ? { logged: { added: p.logged.injected.map(showId), offered: p.logged.asked.map(showId) } } : {}),
    old: { decision: od.inject.length + od.ask.length ? 'stepped' : 'quiet', added: od.inject.map((x) => show(x)), offered: od.ask.map((x) => show(x)) },
    new: {
      // The opening block alone is not a step into this prompt: it is the standing channel, given once
      // per conversation whatever the prompt says. It is listed apart so both readings can be counted.
      decision: picked.length + nd.ask.length ? 'stepped' : 'quiet',
      added: picked.map((x) => show(x, nd.why[x.id])),
      offered: nd.ask.map((x) => show(x, nd.why[x.id])),
      ...(nd.opening.length ? { opening: nd.opening.map((x) => show(x)) } : {}),
      ...(n.given.size ? { held: [...n.given] } : {}),
    },
  };
}

mkdirSync(dirname(OUT), { recursive: true });
const list = Object.values(out);
const count = (f: (r: Replayed) => boolean) => list.filter(f).length;
const ids = (o: { added: Shown[]; offered: Shown[] }) => [...o.added, ...o.offered].map((s) => s.id).sort().join(',');
const loggedStepped = (r: Replayed) => !!r.logged && r.logged.added.length + r.logged.offered.length > 0;
const summary = {
  prompts: list.length,
  loggedStepIns: count(loggedStepped),
  oldStepped: count((r) => r.old.decision === 'stepped'),
  newStepped: count((r) => r.new.decision === 'stepped'),
  newSteppedAtOpening: count((r) => r.new.decision === 'stepped' && r.fresh),
  newSteppedLater: count((r) => r.new.decision === 'stepped' && !r.fresh),
  newOpenings: count((r) => !!r.new.opening?.length),
  // against what really happened at the time
  loggedSteppedNowQuiet: count((r) => loggedStepped(r) && r.new.decision === 'quiet'),
  loggedSteppedStillStepped: count((r) => loggedStepped(r) && r.new.decision === 'stepped'),
  loggedSteppedSameNotes: count((r) => loggedStepped(r) && r.new.decision === 'stepped' && ids(r.new) === ids(r.logged!)),
  loggedQuietNowStepped: count((r) => !loggedStepped(r) && r.new.decision === 'stepped'),
  // old logic re-run on the same inputs, for a like-for-like comparison
  oldSteppedNewQuiet: count((r) => r.old.decision === 'stepped' && r.new.decision === 'quiet'),
  oldQuietNewStepped: count((r) => r.old.decision === 'quiet' && r.new.decision === 'stepped'),
  bothSteppedDifferentNotes: count((r) => r.old.decision === 'stepped' && r.new.decision === 'stepped' && ids(r.old) !== ids(r.new)),
  bothSteppedSameNotes: count((r) => r.old.decision === 'stepped' && r.new.decision === 'stepped' && ids(r.old) === ids(r.new)),
};
writeFileSync(OUT, JSON.stringify({ meta: { made: new Date().toISOString(), source, notes: all.length, scopedByModelCalls: real.modelCalls, modelUsd: usage.usd, summary }, prompts: out }, null, 1));
rmSync(real.home, { recursive: true, force: true });
console.log(summary);
console.log(`→ ${OUT}${real.modelCalls ? `  (${real.modelCalls} model calls, $${usage.usd.toFixed(2)})` : ''}`);
