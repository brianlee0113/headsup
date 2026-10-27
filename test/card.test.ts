import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Prompt } from '../src/capture.js';
import { markChecked } from '../src/spaces.js';
import { buildCard, cardFacts, parseCardReply, styleSource, templateHeadline } from '../src/card.js';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { Store } from '../src/store.js';

const config: Config = { ...DEFAULT_CONFIG, spaces: [{ path: '~/work', space: 'work' }], usage: [{ agents: ['claude-code'], topics: ['coding', 'Quorum launch'] }] };

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
  const add = (body: string, over: { type?: 'how' | 'fact'; space?: string; source?: string; project?: string } = {}) =>
    store.add({ type: over.type ?? 'how', space: over.space ?? 'personal', source: over.source ?? 'claude-code', body, ...(over.project ? { project: over.project } : {}) }).note!;
  const voice = add('Writes release notes in a plain, warm voice.', { source: 'claude-code', project: 'quorum' });
  add('Prefers pnpm workspaces and vitest for tests.', { source: 'claude-code' });
  add('Applying to product roles; interview prep for internships.', { type: 'fact', source: 'chatgpt' });
  add('Northwind ships on Fridays.', { type: 'fact', space: 'work', source: 'claude-code' });
  add('Never share: the Northwind roadmap.', { source: 'chatgpt' });
  store.log({ event: 'heads-up', agent: 'chatgpt', injected: [voice.id] });
  store.log({ event: 'heads-up', agent: 'chatgpt', injected: [voice.id] });
  store.log({ event: 'heads-up', agent: 'claude-code', injected: [voice.id] }); // same tool: not a crossing
  markChecked(store.home, store.list().map((n) => n.id)); // web notes already sorted into work and personal
  return { store, voice };
}

describe('the share card', () => {
  it('counts tools, keeps topics to the shared list, and counts crossings between tools', () => {
    const { store } = setup();
    store.countPrompt();
    const f = cardFacts(store, config, new Date('2026-10-22T10:00:00Z'));
    expect(f.month).toBe('OCT 2026');
    expect(f.tools[0]).toMatchObject({ name: 'Claude Code', topics: ['coding'], share: 0.6 }); // "Quorum launch" is free text: left out
    expect(f.tools[1]!.name).toBe('ChatGPT');
    expect(f.flows).toEqual([{ from: 'Claude Code', to: 'ChatGPT', what: 'writing', times: 2 }]);
    expect(f.numbers).toMatchObject({ tools: 2, notes: 5 });
    store.add({ type: 'how', space: 'personal', source: 'claude-ai', body: 'Reads papers with a summary first.' });
    expect(cardFacts(store, config).tools.map((t) => t.name)).toContain('Claude');
  });

  it('takes its words only from notes the person could post', () => {
    const { store } = setup();
    // A work note's topics and an unsorted web note's never name what crossed over or what a tool is for.
    const secret = store.add({ type: 'fact', space: 'work', source: 'chatgpt', body: 'Plans the Lumen team offsite trip to Lisbon' }).note!;
    const unsorted = store.add({ type: 'fact', space: 'personal', source: 'chatgpt', body: 'Vegetarian and allergic to peanuts; cooks dinner most nights' }).note!;
    store.log({ event: 'heads-up', agent: 'claude-code', injected: [secret.id, unsorted.id] });
    const f = cardFacts(store, config);
    expect(f.flows.find((x) => x.from === 'ChatGPT')).toBeDefined(); // the crossing still counts
    expect(JSON.stringify(f)).not.toMatch(/travel|food/);
  });

  it('rewords only how-you-work notes from personal spaces', () => {
    const { store } = setup();
    const bodies = styleSource(store, config).map((n) => n.body);
    expect(bodies).toContain('Writes release notes in a plain, warm voice.');
    expect(bodies.some((b) => b.includes('Applying') || b.includes('Fridays'))).toBe(false);
  });

  it('drops reworded lines that still name a project', () => {
    const { store } = setup();
    const r = parseCardReply(JSON.stringify({ headline: 'Claude for building. ChatGPT for words.', style: ['Ships Quorum on weekends.', 'Bottom line first, then the detail.'] }), store.list());
    expect(r).toEqual({ headline: 'Claude for building. ChatGPT for words.', style: ['Bottom line first, then the detail.'] });
  });

  it('falls back to a template headline and no style lines without claude', async () => {
    const { store } = setup();
    const card = await buildCard(store, config, async () => { throw new Error('claude is not installed'); });
    expect(card.headline).toBe('Claude Code for coding. ChatGPT for career.');
    expect(card.style).toEqual([]);
    expect(templateHeadline([])).toBe('One memory across my AI tools.');
  });

  it('asks claude once for the headline and style lines', async () => {
    const { store } = setup();
    const prompts: Prompt[] = [];
    const card = await buildCard(store, config, async (p) => (prompts.push(p), '{"headline":"Claude for building.","style":["Plain, warm writing."]}'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.user).not.toContain('Fridays');
    expect(card).toMatchObject({ headline: 'Claude for building.', style: ['Plain, warm writing.'] });
  });
});
