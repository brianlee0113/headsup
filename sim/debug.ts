// Shows how detect sees one probe against a run's memory: signals, the top search hits with their
// shared words and concepts, and the decision.
//   pnpm tsx sim/debug.ts <run-id> <persona> <week> <probe-id> [...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { detect, findReferences, findUsageMismatch } from '../src/gap.js';
import type { Note } from '../src/note.js';
import { NoteIndex } from '../src/search.js';
import { outDir } from './run.js';
import type { ProbeResult } from './run.js';

const [run, persona, week, ...ids] = process.argv.slice(2);
const out = outDir(run!, persona!);
const config = loadConfig(join(out, 'home'));
const notes = JSON.parse(readFileSync(join(out, `notes-w${week}.json`), 'utf8')) as Note[];
const results = JSON.parse(readFileSync(join(out, `probes-w${week}.json`), 'utf8')) as ProbeResult[];
for (const id of ids) {
  const { probe } = results.find((r) => r.probe.id === id)!;
  console.log(`\n${id} [${probe.kind}] ${probe.tool}: ${probe.prompt}\n  needs ${probe.needs.join(', ') || '-'}`);
  console.log(`  references ${JSON.stringify(findReferences(probe.prompt))} usage ${JSON.stringify(findUsageMismatch(probe.prompt, probe.tool, config))}`);
  for (const h of new NoteIndex(notes.filter((n) => n.source !== probe.tool)).search(probe.prompt, 5)) {
    console.log(`  hit ${h.score.toFixed(2)} matched=${h.matched} concepts=${h.concepts} [${h.note.type}] ${h.note.body.slice(0, 80)}`);
  }
  const d = detect({ prompt: probe.prompt, agent: probe.tool, space: config.defaultSpace, knownText: probe.context ?? '', notes, config });
  console.log(`  → inject ${d.inject.length}, ask ${d.ask.length}`);
}
