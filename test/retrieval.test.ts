import { describe, expect, it } from 'vitest';
import { runEval } from './eval.js';
import { samCases, samHoldout } from './fixtures/sam.js';

// Guards retrieval quality on the Sam eval set (`pnpm tsx test/eval.ts` prints the details).
describe('retrieval quality', () => {
  it('finds context that shares no words with the prompt', () => {
    const r = runEval(samCases);
    expect(r.recall).toBe(1);
    expect(r.noise).toBe(0);
  });

  it('holds up on prompts the gates were not tuned on', () => {
    const r = runEval(samHoldout);
    expect(r.recall).toBeGreaterThanOrEqual(0.85);
    expect(r.precision).toBeGreaterThanOrEqual(0.85);
  });

  it('stays silent on every self-contained prompt', () => {
    const silent = [...samCases, ...samHoldout].filter((c) => !c.expect.length);
    for (const row of runEval(silent).rows) expect(row.noise, row.prompt).toEqual([]);
  });
});
