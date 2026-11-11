// Prints retrieval quality on the Sam eval set: `pnpm tsx test/eval.ts`.

import { detect } from '../src/gap.js';
import { samCases, samConfig, samHoldout, samKorean, samKoreanNotes, samNotes, samPending, samPendingNotes, type EvalCase } from './fixtures/sam.js';

export function runEval(cases: EvalCase[], notes = samNotes) {
  let found = 0;
  let wanted = 0;
  let extra = 0;
  let surfaced = 0;
  const rows = cases.map((c) => {
    // A web chat has no folder: the extension names the space instead.
    const web = c.agent === 'chatgpt' || c.agent === 'claude-ai';
    const d = detect({ prompt: c.prompt, agent: c.agent, ...(web ? { space: samConfig.defaultSpace } : { cwd: c.cwd }), knownText: '', notes, config: samConfig });
    const standing = new Set(d.opening.map((n) => n.id));
    const served = [...d.inject, ...d.ask, ...d.blocked].map((n) => n.id);
    const got = served.filter((id) => !standing.has(id)); // picked for this prompt
    const hit = c.expect.filter((id) => served.includes(id));
    const miss = c.expect.filter((id) => !served.includes(id));
    const noise = got.filter((id) => !c.expect.includes(id) && !c.ok?.includes(id));
    found += hit.length;
    wanted += c.expect.length;
    extra += noise.length;
    surfaced += got.length;
    return { prompt: c.prompt, hit, miss, noise };
  });
  return { rows, recall: wanted ? found / wanted : 1, precision: surfaced ? (surfaced - extra) / surfaced : 1, noise: extra };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, cases, notes] of [['tuning', samCases, samNotes], ['holdout', samHoldout, samNotes], ['korean', samKorean, samKoreanNotes], ['pending (known noise)', samPending, samPendingNotes]] as const) {
    const r = runEval(cases, notes);
    console.log(`\n— ${name}`);
    for (const row of r.rows) {
      const mark = row.miss.length ? '✗' : row.noise.length ? '~' : '✓';
      console.log(`${mark} ${row.prompt.slice(0, 60).padEnd(60)}  miss: ${row.miss.join(',') || '-'}  noise: ${row.noise.join(',') || '-'}`);
    }
    console.log(`recall ${(r.recall * 100).toFixed(0)}%  precision ${(r.precision * 100).toFixed(0)}%  noisy notes ${r.noise}`);
  }
}
