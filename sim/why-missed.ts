// Sorts the needed probes a run missed by why: the fact never reached memory, search did not surface the
// note, or a rule left it out (and which). Uses saved memory and audits only; no model calls.
//   pnpm tsx sim/why-missed.ts <run-id> <persona> [...]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { genresOf } from '../src/concepts.js';
import { loadConfig } from '../src/config.js';
import { detect, findReferences, findUsageMismatch, givesOrders } from '../src/gap.js';
import type { Note } from '../src/note.js';
import { NoteIndex } from '../src/search.js';
import { loadPersona } from './generate.js';
import { outDir, type ProbeResult } from './run.js';

const [run, ...ids] = process.argv.slice(2);
for (const id of ids) {
  const p = loadPersona(id);
  const out = outDir(run!, id);
  const config = loadConfig(join(out, 'home'));
  const tally: Record<string, number> = {};
  for (const week of [1, 2]) {
    const notes = JSON.parse(readFileSync(join(out, `notes-w${week}.json`), 'utf8')) as Note[];
    const audit = JSON.parse(readFileSync(join(out, `audit-w${week}-0.json`), 'utf8')) as { notes: Array<{ id: string; items: string[]; verdict: string }> };
    const carrying = (iid: string) => audit.notes.filter((a) => a.verdict === 'accurate' && a.items.includes(iid)).map((a) => notes.find((n) => n.id === a.id)!).filter(Boolean);
    const results = JSON.parse(readFileSync(join(out, `probes-w${week}.json`), 'utf8')) as ProbeResult[];
    for (const r of results) {
      if (!r.probe.needs.length) continue;
      const got = new Set([...r.inject, ...r.ask].map((n) => n.id));
      for (const iid of r.probe.needs) {
        const holders = carrying(iid);
        if (holders.some((n) => got.has(n.id))) continue;
        const terminal = ['claude-code', 'codex'].includes(r.probe.tool);
        const projects = p.tools[r.probe.tool]?.projects ?? {};
        const cwd = (projects[r.probe.project ?? ''] ?? Object.values(projects)[0] ?? '~').replace(/^~/, homedir());
        let why: string;
        if (!holders.length) why = 'not in memory';
        else {
          const hits = new NoteIndex(notes).search(r.probe.prompt, 20);
          const hit = hits.find((h) => holders.some((n) => n.id === h.note.id));
          const n = holders[0]!;
          const signal = findReferences(r.probe.prompt).length > 0 || !!findUsageMismatch(r.probe.prompt, r.probe.tool, config);
          if (n.source === r.probe.tool && (!n.project || !terminal)) why = 'same tool it came from';
          else if (givesOrders(n.body)) why = 'looks like an order';
          else if (!hit) why = 'search: no shared word or concept';
          else if (!signal && n.type === 'fact' && hit.matched - hit.concepts < 3) why = `fact without a signal: ${hit.matched - hit.concepts} shared words (needs 3)`;
          else if (n.type === 'how' && genresOf(n.body).length && !genresOf(n.body).some((g) => genresOf(r.probe.prompt).includes(g))) why = 'style note for another kind of writing';
          else if (hit.concepts < 1 && hit.matched < 2) why = 'too weak a match (1 word)';
          else why = 'ranked below the cutoff, or out of project scope';
          const d = detect({ prompt: r.probe.prompt, agent: r.probe.tool, ...(terminal ? { cwd } : { space: config.defaultSpace }), knownText: r.probe.context ?? '', notes, config });
          if (d.skippedKnown.some((k) => k.id === n.id)) why = 'treated as already known';
        }
        tally[why] = (tally[why] ?? 0) + 1;
        if (process.argv.includes('--list')) console.log(`  [${why}] ${r.probe.id} "${r.probe.prompt.slice(0, 60)}" needs ${iid}`);
      }
    }
  }
  console.log(`${id}: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(' · ')}`);
}
