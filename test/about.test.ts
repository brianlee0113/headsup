import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aboutLines } from '../src/about.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Note } from '../src/note.js';
import { ABOUT_END, ABOUT_START, aboutBlock, ownText, spliceAbout } from '../src/shared/about.js';
import { Store } from '../src/store.js';
import { handleWeb } from '../src/web.js';

const note = (id: string, over: Partial<Note>): Note => ({ id, type: 'how', space: 'personal', source: 'claude-code', topics: [], created: '2026-10-01', body: `note ${id}`, ...over });

describe('the About me block', () => {
  const block = aboutBlock(['Writes plainly.', 'Likes a TL;DR first.']);

  it('goes after the person\'s own text and replaces itself', () => {
    const once = spliceAbout("I'm Sam. Keep answers short.", block);
    expect(once).toBe(`I'm Sam. Keep answers short.\n\n${ABOUT_START}\n• Writes plainly.\n• Likes a TL;DR first.\n${ABOUT_END}`);
    expect(spliceAbout(once, aboutBlock(['Writes plainly.']))).toBe(`I'm Sam. Keep answers short.\n\n${ABOUT_START}\n• Writes plainly.\n${ABOUT_END}`);
  });

  it('keeps text the person added after the block, and an empty block removes it', () => {
    const field = `Intro.\n\n${block}\n\nOne more thing.`;
    expect(ownText(field)).toBe('Intro.\n\nOne more thing.');
    expect(spliceAbout(field, '')).toBe('Intro.\n\nOne more thing.');
    expect(spliceAbout('', block)).toBe(block);
  });
});

describe('what goes in', () => {
  const notes = [
    note('how-old', { created: '2026-09-01' }),
    note('how-new', { created: '2026-10-10' }),
    note('fact', { type: 'fact' }),
    note('work-fact', { type: 'fact', space: 'work' }),
    note('work-how', { space: 'work' }),
    note('never', { share: 'never' }),
    note('from-chatgpt', { source: 'chatgpt' }),
  ];

  it('how-you-work first, personal facts, never work facts, never-share, or the same assistant\'s own', () => {
    expect(aboutLines(notes, DEFAULT_CONFIG, 'chatgpt', 1200).ids).toEqual(['how-new', 'work-how', 'how-old', 'fact']);
    expect(aboutLines(notes, DEFAULT_CONFIG, 'claude-ai', 1200).ids).toContain('from-chatgpt');
  });

  it('follows the sharing preset: Cautious keeps work how-you-work notes out', () => {
    expect(aboutLines(notes, { ...DEFAULT_CONFIG, preset: 'cautious' }, 'chatgpt', 1200).ids).toEqual(['how-new', 'how-old', 'fact']);
  });

  it('puts notes answers drew on ahead of newer ones, and keeps seats for facts', () => {
    const many = [
      ...Array.from({ length: 12 }, (_, i) => note(`how-${i}`, { created: `2026-10-${String(10 + i).padStart(2, '0')}` })),
      note('core', { created: '2026-08-01' }),
      note('fact-a', { type: 'fact' }),
      note('fact-b', { type: 'fact' }),
      note('resting', { created: '2026-10-30' }),
    ];
    const book = {
      core: { shown: 6, used: 4, ignored: 2, removed: 0 },
      resting: { shown: 5, used: 0, ignored: 5, removed: 0, restUntil: '2026-11-30T00:00:00Z' },
    };
    const ids = aboutLines(many, DEFAULT_CONFIG, 'chatgpt', 5000, book, new Date('2026-11-01')).ids;
    expect(ids[0]).toBe('core'); // old, but answers keep drawing on it
    expect(ids).toEqual(expect.arrayContaining(['fact-a', 'fact-b'])); // twelve style notes don't push facts out
    expect(ids).not.toContain('resting');
    expect(ids).toHaveLength(12);
  });

  it('leaves out a how-you-work rule that names one project', () => {
    const notes = [
      note('rule', { body: 'headsup runs in autonomous mode: commit and push without asking', project: 'headsup' }),
      note('general', { body: 'Answers in Korean', project: 'headsup' }),
    ];
    expect(aboutLines(notes, DEFAULT_CONFIG, 'chatgpt', 1200).ids).toEqual(['general']);
  });

  it('leaves an employer\'s own process out, without asking', () => {
    const notes = [
      note('process', { body: 'Release needs a security review first', space: 'work', internal: true }),
      note('habit', { body: 'Writes tickets as background, then acceptance criteria', space: 'work' }),
    ];
    expect(aboutLines(notes, DEFAULT_CONFIG, 'chatgpt', 1200).ids).toEqual(['habit']);
  });

  it('fits the room it is given', () => {
    const r = aboutLines(notes, DEFAULT_CONFIG, 'chatgpt', aboutBlock(['note how-new']).length);
    expect(r.lines).toEqual(['note how-new']);
    expect(aboutLines(notes, DEFAULT_CONFIG, 'chatgpt', 10).lines).toEqual([]);
  });

  it('answers the extension and logs what was written', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
    const { note: saved } = store.add({ type: 'how', space: 'personal', source: 'claude-code', body: 'Writes plainly.' });
    expect(handleWeb({ type: 'about-me', site: 'chatgpt.com', room: 1200 }, store, DEFAULT_CONFIG, '0')).toEqual({ type: 'about-me', lines: ['Writes plainly.'], ids: [saved!.id] });
    handleWeb({ type: 'about-written', site: 'chatgpt.com', ids: [saved!.id] }, store, DEFAULT_CONFIG, '0');
    expect(store.readLog().at(-1)).toMatchObject({ event: 'about-me', agent: 'chatgpt', notes: [saved!.id] });
  });
});
