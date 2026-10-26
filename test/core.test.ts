import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveSpace, type Config } from '../src/config.js';
import { detect, findUsageMismatch } from '../src/gap.js';
import { parseNote, serializeNote, type Note } from '../src/note.js';
import { verdictFor } from '../src/policy.js';
import { redactSecrets } from '../src/secrets.js';
import { Store } from '../src/store.js';

const note = (over: Partial<Note> & Pick<Note, 'body'>): Note => ({
  id: Math.random().toString(36).slice(2),
  type: 'fact',
  space: 'personal',
  source: 'claude-code',
  topics: [],
  created: '2026-10-19T00:00:00.000Z',
  ...over,
});

// Persona from the Figma demos: Sam codes in Claude Code (Quorum side project, Northwind internship)
// and writes in ChatGPT.
const config: Config = {
  ...DEFAULT_CONFIG,
  spaces: [{ path: '~/work', space: 'work' }, { path: '~/side', space: 'personal' }],
  usage: [
    { agents: ['claude-code', 'claude-ai'], topics: ['coding', 'side projects'] },
    { agents: ['chatgpt'], topics: ['writing', 'everyday'] },
  ],
};
const quorum = [
  note({ body: 'Quorum is a web app that finds a meeting time for student clubs from everyone\'s calendar', topics: ['quorum', 'side project', 'launch'] }),
  note({ body: 'Quorum has 140 weekly users across 9 clubs; built with Next.js and Supabase', topics: ['quorum', 'users', 'stack'] }),
];
const northwind = [
  note({ space: 'work', body: 'Northwind internship on the payments team, summer 2026', topics: ['northwind', 'internship'] }),
  note({ space: 'work', body: 'Shipped payout retries at Northwind that cut failed payouts by 30%', topics: ['northwind', 'payouts', 'internship'] }),
];

describe('notes', () => {
  it('round-trips through Markdown with frontmatter', () => {
    const n = note({ body: 'Prefers named exports', type: 'how', topics: ['typescript', 'style'], share: 'never' });
    expect(parseNote(serializeNote(n))).toEqual(n);
  });
});

describe('secrets', () => {
  it('drops keys before anything is stored', () => {
    const r = redactSecrets('webhook 401, key is sk_live_51NxABCDEFGHIJKLMNOP');
    expect(r.dropped).toEqual(['stripe-key']);
    expect(r.text).not.toContain('sk_live');
  });

  it('saves nothing when the note was only a secret', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
    expect(store.add({ type: 'fact', space: 'work', source: 'claude-code', body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }).note).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});

describe('spaces and policy', () => {
  it('maps folders to spaces by longest prefix', () => {
    const c = { ...config, spaces: [...config.spaces, { path: '~/work/oss', space: 'personal' }] };
    expect(resolveSpace(join(homedir(), 'work/northwind-api'), c)).toBe('work');
    expect(resolveSpace(join(homedir(), 'work/oss/lib'), c)).toBe('personal');
    expect(resolveSpace('/tmp/elsewhere', c)).toBe('personal');
  });

  it('shares how you work, not what you work on', () => {
    const how = note({ type: 'how', space: 'personal', body: 'x' });
    const fact = note({ type: 'fact', space: 'work', body: 'x' });
    expect(verdictFor(how, 'work', 'balanced')).toBe('auto');
    expect(verdictFor(fact, 'personal', 'balanced')).toBe('ask');
    expect(verdictFor(fact, 'personal', 'cautious')).toBe('block');
    expect(verdictFor(fact, 'work', 'cautious')).toBe('auto'); // same space always flows
    expect(verdictFor({ ...how, share: 'never' }, 'work', 'open')).toBe('block');
  });
});

describe('gap detector', () => {
  // Web chats have no folder, as in the extension; terminal agents work in one.
  const run = (prompt: string, agent: string, notes: Note[], over: Partial<Config> = {}, knownText = '', cwd = '/tmp') =>
    detect({ prompt, agent, ...(agent === 'chatgpt' || agent === 'claude-ai' ? { space: 'personal' } : { cwd }), knownText, notes, config: { ...config, ...over } });

  it('Demo 1: a launch post in ChatGPT pulls the side project from Claude Code', () => {
    const d = run('Write a LinkedIn post announcing my side project launch. Keep it short.', 'chatgpt', [...quorum, ...northwind]);
    expect(d.signals.references.length).toBeGreaterThan(0);
    expect(d.inject.map((n) => n.body)).toEqual(expect.arrayContaining([quorum[0]!.body]));
    expect([...d.ask, ...d.inject].some((n) => n.space === 'work')).toBe(false);
  });

  it('Demo 2: a cover letter asks before work facts cross into personal', () => {
    const d = run('Help me write a cover letter for a product internship at Fieldnote.', 'chatgpt', [...quorum, ...northwind]);
    expect(d.ask.map((n) => n.space)).toContain('work');
    expect(d.inject.every((n) => n.space === 'personal')).toBe(true);
  });

  it('Cautious keeps work facts home', () => {
    const d = run('Help me write a cover letter for a product internship.', 'chatgpt', northwind, { preset: 'cautious' });
    expect(d.blocked.length).toBeGreaterThan(0);
    expect(d.ask).toHaveLength(0);
  });

  it('stays silent when the agent already knows the note', () => {
    const pnpm = note({ type: 'how', source: 'codex', body: 'Uses pnpm workspaces for every package', topics: ['package', 'pnpm'] });
    const d = run('use pnpm to add zod to the billing package', 'claude-code', [pnpm], {}, '# Project\nUse pnpm workspaces for every package.');
    expect(d.inject).toHaveLength(0);
    expect(d.skippedKnown).toHaveLength(1);
  });

  it('after the opening, adds only what the conversation is reaching for', () => {
    const notes = [
      note({ source: 'chatgpt', type: 'how', body: 'Reviews open pull requests first thing in the morning', topics: ['review'] }),
      note({ source: 'codex', type: 'how', body: 'Prefers Vitest with test files next to the source; never Jest', topics: ['testing'] }),
      note({ source: 'chatgpt', body: 'Applying to product roles for summer 2027', topics: ['job search'] }),
    ];
    const at = (prompt: string, fresh: boolean) =>
      detect({ prompt, agent: 'claude-code', cwd: join(homedir(), 'side', 'quorum'), knownText: '', notes, config, fresh }).inject.map((n) => n.body);
    expect(at('review the open pull requests', true)).toContain(notes[0]!.body);
    expect(at('review the open pull requests', false)).toEqual([]); // a habit that shares only words belongs at the opening
    expect(at('add tests for the slot finder', false)).toEqual([notes[1]!.body]); // the kind of task it is about
    expect(at('add tests for the slot finder', false)).not.toContain(notes[2]!.body);
  });

  it('leaves out notes already added in this conversation', () => {
    const d = detect({ prompt: 'write a launch post for Quorum', agent: 'chatgpt', space: 'personal', knownText: '', notes: quorum, config, given: new Set([quorum[0]!.id]) });
    expect(d.inject.map((n) => n.id)).not.toContain(quorum[0]!.id);
  });

  it('never surfaces notes the current agent wrote itself', () => {
    const d = run('my side project launch post', 'claude-code', quorum);
    expect(d.inject).toHaveLength(0);
  });

  it('does nothing for a self-contained prompt', () => {
    const d = run('What is the time complexity of quicksort?', 'chatgpt', [...quorum, ...northwind]);
    expect([...d.inject, ...d.ask, ...d.blocked]).toHaveLength(0);
  });

  it('does not call a topic off-pattern when this agent covers it too', () => {
    const usage = { ...DEFAULT_CONFIG, usage: [
      { agents: ['claude-code'], topics: ['coding', 'side projects'] },
      { agents: ['chatgpt'], topics: ['writing'] },
      { agents: ['codex'], topics: ['coding'] },
    ] };
    expect(findUsageMismatch('fix the failing test and commit', 'claude-code', usage)).toBeUndefined();
    expect(findUsageMismatch('fix the failing test and commit', 'chatgpt', usage)?.usualAgents).toEqual(['claude-code']);
  });
});
