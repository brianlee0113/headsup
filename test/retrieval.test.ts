import { describe, expect, it } from 'vitest';
import { runEval } from './eval.js';
import { samCases, samHoldout, samKorean, samKoreanNotes, samPending, samPendingNotes } from './fixtures/sam.js';

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

  it('matches Korean by word, not by the bigrams inside words', () => {
    const r = runEval(samKorean, samKoreanNotes);
    expect(r.recall).toBe(1);
    expect(r.noise).toBe(0);
  });

  it('stays silent on every self-contained prompt', () => {
    const silent = (cases: typeof samCases) => cases.filter((c) => !c.expect.length);
    for (const row of runEval(silent([...samCases, ...samHoldout])).rows) expect(row.noise, row.prompt).toEqual([]);
    for (const row of runEval(silent(samKorean), samKoreanNotes).rows) expect(row.noise, row.prompt).toEqual([]);
  });

  // Known noise for the pre-launch simulation; this starts failing once the gates are tuned — move the cases into samKorean then.
  it.fails('stays silent on prompts that only share a testing sense (pending)', () => {
    expect(runEval(samPending, samPendingNotes).noise).toBe(0);
  });
});
