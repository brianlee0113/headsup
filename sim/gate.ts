// The development gate: one command that checks a change against everything that needs no model calls,
// compares with the last accepted numbers, and fails if anything got worse.
//   1. the eval set (test/eval.ts)
//   2. the persona simulation, re-judged on saved memory (redetect + fast scoring)
//   3. the person's labeled real decisions, re-judged on this computer (.local/real-labels.json)
// pnpm gate            check
// pnpm gate --accept   take the current numbers as the new baseline
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { headsupHome, loadConfig } from '../src/config.js';
import { projectOf } from '../src/context.js';
import { detect } from '../src/gap.js';
import { Store } from '../src/store.js';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const MEMORY_RUN = process.env.GATE_MEMORY_RUN ?? 'r9'; // saved memory the persona check replays
const PERSONAS = ['sam', 'jieun'];
const BASELINE = join(ROOT, '.local', 'gate-baseline.json'); // includes real-label numbers, so it stays local
const TOLERANCE = { rate: 0.02, count: 1 };
const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');

type Metric = { value: number; better: 'higher' | 'lower'; kind: 'rate' | 'count'; max?: number };
const metrics: Record<string, Metric> = {};
// `max`: a hard limit that fails on its own, not only when worse than the baseline.
const put = (name: string, value: number, better: Metric['better'], kind: Metric['kind'] = 'rate', max?: number) =>
  (metrics[name] = { value, better, kind, ...(max !== undefined ? { max } : {}) });

// 1. eval set
const evalOut = execFileSync(tsx, [join(ROOT, 'test', 'eval.ts')], { encoding: 'utf8' });
const [tuned, holdout] = [...evalOut.matchAll(/recall (\d+)%\s+precision (\d+)%/g)].map((m) => ({ recall: Number(m[1]) / 100, precision: Number(m[2]) / 100 }));
if (tuned) { put('eval: recall', tuned.recall, 'higher'); put('eval: precision', tuned.precision, 'higher'); }
if (holdout) { put('eval holdout: recall', holdout.recall, 'higher'); put('eval holdout: precision', holdout.precision, 'higher'); }

// 2. persona simulation on saved memory
if (PERSONAS.every((p) => existsSync(join(ROOT, 'sim', 'out', MEMORY_RUN, p, 'notes-w1.json')))) {
  for (const p of PERSONAS) execFileSync(tsx, [join(ROOT, 'sim', 'redetect.ts'), MEMORY_RUN, 'gate', p], { stdio: 'ignore' });
  execFileSync(tsx, [join(ROOT, 'sim', 'score.ts'), 'gate', ...PERSONAS, '--fast'], { stdio: 'ignore' });
  const scores = JSON.parse(readFileSync(join(ROOT, 'sim', 'out', 'gate', 'scores.json'), 'utf8')) as Array<{ persona: string; unnecessary: number; neededRecall: { mean: number }; outcome: { noteKinds: Record<string, number> }; violations: string[] }>;
  for (const s of scores) {
    // A work note crossing into personal without an OK is never acceptable, whatever the baseline says.
    put(`sim ${s.persona}: boundary violations`, s.violations.length, 'lower', 'count', 0);
    for (const v of s.violations) console.log(`  boundary violation (${s.persona}): ${v}`);
    put(`sim ${s.persona}: needless step-ins`, s.unnecessary, 'lower');
    put(`sim ${s.persona}: needed moments caught`, s.neededRecall.mean, 'higher');
    put(`sim ${s.persona}: notes from another project`, s.outcome.noteKinds.otherProject ?? 0, 'lower', 'count');
    put(`sim ${s.persona}: unrelated notes added`, s.outcome.noteKinds.unrelated ?? 0, 'lower', 'count');
  }
} else console.log(`(persona check skipped: no saved memory in sim/out/${MEMORY_RUN})`);

// 3. the person's labeled real decisions
const labelsFile = join(ROOT, '.local', 'real-labels.json');
if (existsSync(labelsFile)) {
  const home = headsupHome(), config = loadConfig(home), notes = new Store(home).list();
  const label = new Map(Object.entries(JSON.parse(readFileSync(labelsFile, 'utf8')) as Record<string, string>).map(([k, v]) => [k.split('#')[0], v]));
  const cwdOf = new Map<string, string>();
  const root = join(homedir(), '.claude', 'projects');
  if (existsSync(root)) for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d))) if (f.endsWith('.jsonl')) {
    const m = /-Developer-(.+)$/.exec(d);
    cwdOf.set(f.slice(0, -6), m ? join(homedir(), 'Developer', m[1]!) : homedir());
  }
  // Replayed in order as conversations, so a note added earlier in one isn't counted as missing later.
  const log = readFileSync(join(home, 'log.jsonl'), 'utf8').split('\n').flatMap((l) => {
    try { return [JSON.parse(l) as { at: string; event: string; agent: string; prompt?: string; session: string; cwd?: string }]; } catch { return []; }
  }).filter((e) => e.event === 'heads-up' && e.prompt);
  const generic = new Set(['developer', 'projects', 'code', 'src', 'work', 'home']);
  const sessions = new Map<string, { cwd: string; given: Set<string> }>();
  let needed = 0, neededCaught = 0, noiseNotes = 0, otherFacts = 0, quietNeeded = 0, terminal = 0, stepped = 0, later = 0, laterStepped = 0;
  for (const e of log) {
    const web = e.agent === 'chatgpt' || e.agent === 'claude-ai';
    const cwd = e.cwd ?? cwdOf.get(e.session) ?? homedir();
    const was = web ? undefined : sessions.get(e.session);
    const fresh = !was || was.cwd !== cwd;
    const d = detect({ prompt: e.prompt!, agent: e.agent, ...(web ? { space: config.defaultSpace } : { cwd, given: was?.given ?? new Set(), fresh }), knownText: '', notes, config });
    const added = [...d.inject, ...d.ask];
    if (!web) {
      sessions.set(e.session, { cwd, given: new Set([...(was?.given ?? []), ...added.map((n) => n.id)]) });
      terminal++; if (added.length) stepped++;
      if (!fresh) { later++; if (added.length) laterStepped++; }
    }
    const l = label.get(e.at);
    if (!l) continue;
    // A needed note added earlier in the conversation still serves this prompt: the agent has it.
    const servedEarlier = !web && !!was && [...detect({ prompt: e.prompt!, agent: e.agent, cwd, knownText: '', notes, config }).inject].some((n) => was.given.has(n.id));
    if (l === 'needed') { needed++; if (added.length || servedEarlier) neededCaught++; }
    if (l === 'noise') noiseNotes += added.length;
    if (l === 'fine' && added.length) quietNeeded++;
    if (!web) otherFacts += added.filter((n) => n.type === 'fact' && n.project && n.project !== projectOf(cwd) && !generic.has(n.project.toLowerCase())).length;
  }
  console.log(`real Claude Code prompts: stepped in on ${stepped}/${terminal}; after the opening ${laterStepped}/${later}`);
  put('real: Claude Code prompts stepped in', terminal ? stepped / terminal : NaN, 'lower');
  put('real: "needed" prompts still served', needed ? neededCaught / needed : NaN, 'higher');
  put('real: notes on "noise" prompts', noiseNotes, 'lower', 'count');
  put('real: other projects\' facts added', otherFacts, 'lower', 'count');
  put('real: steps on rightly quiet prompts', quietNeeded, 'lower', 'count');
} else console.log('(real-label check skipped: no .local/real-labels.json; label with sim/label-real.ts)');

const accept = process.argv.includes('--accept');
const base = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>) : {};
const fmt = (m: Metric, v: number) => (Number.isNaN(v) ? '—' : m.kind === 'rate' ? `${Math.round(v * 100)}%` : String(v));
let failed = 0;
let broken = 0; // hard limits: --accept can't take these as a baseline
for (const [name, m] of Object.entries(metrics)) {
  const was = base[name];
  const over = m.max !== undefined && m.value > m.max;
  const worse = over || (was !== undefined && !Number.isNaN(m.value) && (m.better === 'higher' ? was - m.value : m.value - was) > TOLERANCE[m.kind]);
  if (worse) failed++;
  if (over) broken++;
  console.log(`${worse ? '✗' : '✓'} ${name.padEnd(42)} ${fmt(m, m.value).padStart(5)}${was === undefined ? '' : `  (was ${fmt(m, was)})`}`);
}
if (accept) {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, m.value])), null, 2));
  console.log(`\nbaseline saved to ${BASELINE}`);
  if (broken) {
    console.log(`${broken} hard limit${broken === 1 ? '' : 's'} still broken; that can't be accepted, only fixed`);
    process.exit(1);
  }
} else if (failed) {
  console.log(`\n${failed} got worse than the baseline or broke a hard limit. Fix it, or accept a baseline change on purpose with: pnpm gate --accept`);
  process.exit(1);
} else console.log(`\nnothing got worse${Object.keys(base).length ? '' : ' (no baseline yet: pnpm gate --accept)'}`);
