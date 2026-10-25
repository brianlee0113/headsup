import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Prompt } from '../src/capture.js';
import { Store } from '../src/store.js';
import { parseTidy, tidy, tidyDue } from '../src/tidy.js';

const NOW = new Date('2026-10-22T10:00:00Z');

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
  const add = (body: string, at: string, over: { type?: 'how' | 'fact'; space?: string; source?: string } = {}) =>
    store.add({ type: over.type ?? 'fact', space: over.space ?? 'personal', source: over.source ?? 'claude-code', body }, new Date(at)).note!;
  return { store, add };
}

describe('tidying notes', () => {
  it('merges notes that say the same thing and sets aside ones a newer note replaced', async () => {
    const { store, add } = setup();
    const short = add('Likes short emails.', '2026-10-01', { type: 'how' });
    const brief = add('Keeps emails brief, conclusion first.', '2026-10-05', { type: 'how', source: 'chatgpt' });
    const applying = add('Applying to PM roles for 2027.', '2026-09-01');
    const offer = add('Accepted a PM offer at Northwind for 2027.', '2026-10-20');
    const work = add('Northwind uses Linear.', '2026-10-02', { space: 'work' });

    const prompts: Prompt[] = [];
    const r = await tidy(store, async (p) => {
      prompts.push(p);
      return p.user.includes(short.id)
        ? JSON.stringify({ merge: [{ ids: [short.id, brief.id], type: 'how', body: 'Keeps emails short and brief, conclusion first.', topics: ['email'] }], drop: [{ id: applying.id, because: offer.id }] })
        : '{"merge":[],"drop":[]}';
    }, NOW);

    expect(r).toEqual({ merged: 2, dropped: 1, failed: 0 });
    // One pass per space, never across; a space with a single note has nothing to tidy.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.user).not.toContain(work.id);
    const left = store.list();
    expect(left.map((n) => n.body).sort()).toEqual(['Accepted a PM offer at Northwind for 2027.', 'Keeps emails short and brief, conclusion first.', 'Northwind uses Linear.']);
    expect(left.find((n) => n.body.startsWith('Keeps'))).toMatchObject({ type: 'how', source: 'chatgpt', topics: ['email'] });
    // Set aside, not deleted.
    for (const n of [short, brief, applying]) expect(existsSync(join(store.home, 'archive', '2026-10-22', `${n.id}.md`))).toBe(true);
    expect(store.readLog().find((e) => e.event === 'tidied')).toMatchObject({ space: 'personal', dropped: [{ id: applying.id, because: offer.id }] });
  });

  it('changes nothing when the reply does not check out', async () => {
    const { store, add } = setup();
    add('Likes short emails.', '2026-10-01');
    add('Keeps emails brief.', '2026-10-05');
    const r = await tidy(store, async () => 'Sorry, I cannot help with that.', NOW);
    expect(r).toEqual({ merged: 0, dropped: 0, failed: 1 });
    expect(store.list()).toHaveLength(2);
    expect(tidyDue(store)).toBe(false); // only 2 notes; due again once 20 are in
  });

  it('runs again once ten new notes are in', async () => {
    const { store, add } = setup();
    for (let i = 0; i < 9; i++) add(`Note number ${i}.`, '2026-10-01');
    expect(tidyDue(store)).toBe(false);
    add('One more.', '2026-10-02');
    expect(tidyDue(store)).toBe(true);
    await tidy(store, async () => '{"merge":[],"drop":[]}', NOW);
    expect(tidyDue(store)).toBe(false);
  });
});

describe('checking the reply', () => {
  const { store, add } = setup();
  const a = add('A.', '2026-10-01');
  const b = add('B.', '2026-10-02');
  const c = add('C.', '2026-10-03');
  const notes = store.list();

  it('ignores unknown ids, notes used twice, and drops for an older note', () => {
    const r = parseTidy(JSON.stringify({
      merge: [{ ids: [a.id, 'made-up'], type: 'fact', body: 'x' }, { ids: [a.id, b.id], type: 'fact', body: 'A and B.' }],
      drop: [{ id: b.id, because: c.id }, { id: c.id, because: a.id }],
    }), notes);
    expect(r).toEqual({ merge: [{ ids: [a.id, b.id], type: 'fact', body: 'A and B.', topics: [] }], drop: [] });
  });

  it('is null for a reply with no JSON', () => {
    expect(parseTidy('no idea', notes)).toBeNull();
  });
});
