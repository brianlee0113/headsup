import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { detect } from '../src/gap.js';
import type { Note } from '../src/note.js';
import { ownWords, rescope } from '../src/scope.js';
import { Store } from '../src/store.js';

const note = (over: Partial<Note> & Pick<Note, 'body'>): Note => ({
  id: `n-${Math.random().toString(36).slice(2, 8)}`,
  type: 'how',
  space: 'personal',
  source: 'chatgpt',
  topics: [],
  created: '2026-10-19T00:00:00.000Z',
  ...over,
});
const reply = (items: unknown[]) => async () => JSON.stringify(items);

describe('own words', () => {
  it('stays fast on a long unbroken paste', () => {
    const t = Date.now();
    expect(ownWords(`fix this ${'a'.repeat(200_000)} please`)).toContain('fix this');
    expect(ownWords(`look at ${'{"k":"v",'.repeat(25_000)}`)).toContain('look at');
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('still leaves paths out', () => {
    expect(ownWords('open ~/side/marketing/plan.md and src/app.ts now')).toBe('open   and   now');
  });
});

describe('a kind of work already under way', () => {
  it('is seen anywhere in the earlier prompts, not just their first 1,500 characters', () => {
    const habit = note({ scope: 'task', applies: ['commit message'], body: 'Keeps commit messages to one short line' });
    const on = (earlier: string) =>
      detect({ prompt: 'now write the commit message', agent: 'claude-code', cwd: '/tmp', knownText: '', notes: [habit], config: DEFAULT_CONFIG, fresh: false, earlier }).inject.length;
    expect(on('fix the loop')).toBe(1);
    expect(on(`${'we talked a lot about other things. '.repeat(80)}draft a commit message for this`)).toBe(0);
  });
});

describe('rescope', () => {
  const store = () => new Store(mkdtempSync(join(tmpdir(), 'headsup-scope-')));

  it('gives up on a note after three passes it could not scope', async () => {
    const s = store();
    const n = note({ body: 'Some habit the model keeps misreading' });
    s.add(n);
    let calls = 0;
    const bad = async () => {
      calls++;
      return 'not json';
    };
    for (let i = 0; i < 5; i++) await rescope(s, bad);
    expect(calls).toBe(3);
    expect(s.list()[0]!.scope).toBeUndefined();
  });

  it('does not bring back a note set aside while the model was answering', async () => {
    const s = store();
    s.add(note({ body: 'Prefers tables for options' }));
    const n = s.list()[0]!;
    await rescope(s, async () => {
      s.archive(n);
      return JSON.stringify([{ i: 0, scope: 'task', applies: ['options table'] }]);
    });
    expect(s.list()).toHaveLength(0);
    expect(existsSync(s.filePath(n))).toBe(false);
  });

  it('waits while another pass is running', async () => {
    const s = store();
    s.add(note({ body: 'Leads with the conclusion' }));
    let second: Awaited<ReturnType<typeof rescope>> | undefined;
    await rescope(s, async () => {
      second = await rescope(s, reply([{ i: 0, scope: 'general', applies: [] }]));
      return JSON.stringify([{ i: 0, scope: 'general', applies: [] }]);
    });
    expect(second?.busy).toBe(true);
    expect(s.list()[0]!.scope).toBe('general');
    rmSync(s.home, { recursive: true, force: true });
  });
});
