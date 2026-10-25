// Re-runs only the probes of an earlier run against its saved memory snapshots, into a new run id.
// For tuning detect without paying to rebuild memory: same notes, new decisions.
//   pnpm tsx sim/redetect.ts <from-run> <to-run> <persona>
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { detect } from '../src/gap.js';
import { renderNotes } from '../src/hooks/claude-code.js';
import type { Note } from '../src/note.js';
import { loadPersona } from './generate.js';
import { outDir, type ProbeResult } from './run.js';

const [from, to, id] = process.argv.slice(2);
const p = loadPersona(id!);
rmSync(outDir(to!, id!), { recursive: true, force: true });
cpSync(outDir(from!, id!), outDir(to!, id!), { recursive: true });
const out = outDir(to!, id!);
const config = loadConfig(join(out, 'home'));
const TERMINAL = new Set(['claude-code', 'codex']);
for (const week of [1, 2]) {
  const notes = JSON.parse(readFileSync(join(out, `notes-w${week}.json`), 'utf8')) as Note[];
  const old = JSON.parse(readFileSync(join(out, `probes-w${week}.json`), 'utf8')) as ProbeResult[];
  const results = old.map(({ probe }) => {
    const projects = p.tools[probe.tool]?.projects ?? {};
    const cwd = (projects[probe.project ?? ''] ?? Object.values(projects)[0] ?? '~').replace(/^~/, homedir());
    const t0 = performance.now();
    const d = detect({ prompt: probe.prompt, agent: probe.tool, ...(TERMINAL.has(probe.tool) ? { cwd } : { space: config.defaultSpace }), knownText: probe.context ?? '', notes, config });
    return { probe, week, inject: d.inject, ask: d.ask, blocked: d.blocked, known: d.skippedKnown, ms: performance.now() - t0, addedChars: d.inject.length ? renderNotes(d.inject).length : 0 };
  });
  writeFileSync(join(out, `probes-w${week}.json`), JSON.stringify(results, null, 2));
  console.log(`${id} w${week}: stepped in on ${results.filter((r) => r.inject.length || r.ask.length).length}/${results.length}`);
}
