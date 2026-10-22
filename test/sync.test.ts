import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Prompt } from '../src/capture.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Store } from '../src/store.js';
import { handleSync, parseClaudeChat, readState, runSync, syncStatus } from '../src/sync.js';
import { handleWeb } from '../src/web.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'headsup-'));
const NOW = new Date('2026-10-21T10:00:00Z');
const long = (s: string) => `${s} I write release notes in a plain, warm voice and keep them under 150 words. `.repeat(2);

// A chat as chatgpt.com's conversation endpoint returns it (the export's shape).
function chatgpt(id: string, updated: string, messages: Array<[string, string, string?]>) {
  const mapping: Record<string, unknown> = { root: { message: null, parent: null } };
  let parent = 'root';
  messages.forEach(([role, text, kind = 'text'], i) => {
    mapping[`m${i}`] = { parent, message: { author: { role }, content: { content_type: kind, parts: [text] } } };
    parent = `m${i}`;
  });
  return { conversation_id: id, title: `chat ${id}`, update_time: new Date(updated).getTime() / 1000, current_node: parent, mapping };
}

const claude = (id: string, updated: string, messages: Array<[string, string]>) => ({
  uuid: id,
  name: `chat ${id}`,
  updated_at: updated,
  chat_messages: messages.map(([sender, text]) => ({ sender, text: '', content: [{ type: 'text', text }] })),
});

const setup = (backfill = true) => {
  const store = new Store(tmp());
  let runs = 0;
  const opts = { now: NOW, startRunner: () => runs++ };
  const start = handleSync({ type: 'sync-start', site: 'chatgpt.com', backfill }, store, opts) as { since: string; seen: Record<string, string> };
  return { store, opts, start, runs: () => runs };
};

describe('reading chats from the sites', () => {
  it('reads claude.ai messages, text blocks first', () => {
    const c = parseClaudeChat({
      uuid: 'c1', name: 'Release notes', updated_at: '2026-10-20T08:00:00Z',
      chat_messages: [
        { sender: 'human', text: 'fallback', content: [{ type: 'text', text: 'Write the notes' }, { type: 'tool_use' }] },
        { sender: 'assistant', text: 'Sure, here they are.' },
      ],
    });
    expect(c.turns).toEqual([{ role: 'user', text: 'Write the notes' }, { role: 'assistant', text: 'Sure, here they are.' }]);
    expect(c.updated.toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('leaves out ChatGPT reasoning', () => {
    const { store, opts } = setup();
    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [chatgpt('a', '2026-10-20', [['user', long('Hi.')], ['assistant', 'thinking…', 'thoughts'], ['assistant', 'Done.']])] }, store, opts);
    const queued = JSON.parse(readFileSync(join(store.home, 'sync', 'queue', 'chatgpt-a.json'), 'utf8'));
    expect(queued.chat.turns.map((t: { text: string }) => t.text)).toEqual([long('Hi.').trim(), 'Done.']);
  });
});

describe('catching up', () => {
  it('starts 12 months back with consent to backfill, otherwise now', () => {
    expect(setup(true).start.since).toBe('2025-10-21T10:00:00.000Z');
    expect(setup(false).start.since).toBe(NOW.toISOString());
  });

  it('queues chats in range, remembers them, and starts the runner', () => {
    const { store, opts, runs } = setup();
    const r = handleSync({
      type: 'sync-chats', site: 'chatgpt.com', done: true,
      chats: [chatgpt('new', '2026-10-20', [['user', long('Hi.')]]), chatgpt('ancient', '2024-01-01', [['user', long('Old.')]])],
    }, store, opts);
    expect(r).toEqual({ type: 'sync-chats', queued: 1 });
    expect(runs()).toBe(1);
    const again = handleSync({ type: 'sync-start', site: 'chatgpt.com', backfill: true }, store, opts) as { seen: Record<string, string> };
    expect(Object.keys(again.seen)).toEqual(['new']);
    expect(readState(store.home, 'chatgpt')!.lastCaught).toBe(NOW.toISOString());
  });

  it('refuses a shape it does not know, so the extension can say so', () => {
    const { store, opts } = setup();
    expect(() => handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [{ id: 'x', messages: [] }] }, store, opts)).toThrow(/mapping/);
  });

  it('shows when each site last caught up', () => {
    const { store, opts } = setup();
    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [], done: true }, store, opts);
    const status = handleWeb({ type: 'status' }, store, DEFAULT_CONFIG, '0.0.1') as { sync: ReturnType<typeof syncStatus> };
    expect(status.sync['chatgpt.com']).toMatchObject({ lastCaught: NOW.toISOString(), queued: 0 });
    expect(status.sync['claude.ai']).toBeNull();
  });
});

describe('turning queued chats into notes', () => {
  const reply = JSON.stringify([{ type: 'how', body: 'Writes release notes plainly and warmly, under 150 words', topics: ['writing'] }]);

  it('summarizes, saves ChatGPT notes and empties the queue', async () => {
    const { store, opts } = setup();
    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [chatgpt('a', '2026-10-20', [['user', long('Hi.')], ['assistant', 'Done.']])] }, store, opts);
    const prompts: Prompt[] = [];
    const r = await runSync(store, DEFAULT_CONFIG, async (p) => (prompts.push(p), reply));
    expect(r).toEqual({ chats: 1, saved: 1, failed: 0 });
    expect(store.list()[0]).toMatchObject({ source: 'chatgpt', space: 'personal' });
    expect(readdirSync(join(store.home, 'sync', 'queue'))).toEqual([]);
    expect(readState(store.home, 'chatgpt')!.chats.a!.turns).toBe(2);
    expect(syncStatus(store)['chatgpt.com']!.notesToday).toBe(1);
  });

  it('reads only what a continued chat added, with a little context', async () => {
    const { store, opts } = setup();
    const turns: Array<[string, string]> = Array.from({ length: 8 }, (_, i) => [i % 2 ? 'assistant' : 'user', i % 2 ? `answer ${i}` : long(`Question ${i}.`)]);
    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [chatgpt('a', '2026-10-20', turns)] }, store, opts);
    await runSync(store, DEFAULT_CONFIG, async () => '[]');

    // A one-word follow-up is not worth a summary.
    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [chatgpt('a', '2026-10-21', [...turns, ['user', 'thanks']])] }, store, opts);
    let calls = 0;
    await runSync(store, DEFAULT_CONFIG, async () => (calls++, '[]'));
    expect(calls).toBe(0);

    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [chatgpt('a', '2026-10-21', [...turns, ['user', 'thanks'], ['user', long('Question 9.')]])] }, store, opts);
    const prompts: Prompt[] = [];
    await runSync(store, DEFAULT_CONFIG, async (p) => (prompts.push(p), '[]'));
    expect(prompts[0]!.user).toContain('Question 9.');
    expect(prompts[0]!.user).toContain('Question 6.');
    expect(prompts[0]!.user).not.toContain('Question 0.');
  });

  it('keeps a failed batch queued for next time', async () => {
    const { store, opts } = setup();
    handleSync({ type: 'sync-chats', site: 'chatgpt.com', chats: [chatgpt('a', '2026-10-20', [['user', long('Hi.')]])] }, store, opts);
    const r = await runSync(store, DEFAULT_CONFIG, async () => { throw new Error('claude is not logged in'); });
    expect(r).toEqual({ chats: 1, saved: 0, failed: 1 });
    expect(existsSync(join(store.home, 'sync', 'queue', 'chatgpt-a.json'))).toBe(true);
    expect(store.readLog().at(-1)).toMatchObject({ event: 'sync-failed', error: 'claude is not logged in' });
  });

  it('labels claude.ai chats as Claude', async () => {
    const store = new Store(tmp());
    const opts = { now: NOW, startRunner: () => {} };
    handleSync({ type: 'sync-start', site: 'claude.ai', backfill: true }, store, opts);
    handleSync({ type: 'sync-chats', site: 'claude.ai', chats: [claude('c', '2026-10-20T08:00:00Z', [['human', long('Hi.')], ['assistant', 'Sure.']])] }, store, opts);
    const prompts: Prompt[] = [];
    await runSync(store, DEFAULT_CONFIG, async (p) => (prompts.push(p), reply));
    expect(prompts[0]!.system).toContain("person's Claude conversations");
    expect(prompts[0]!.user).toContain('CLAUDE: Sure.');
    expect(store.list()[0]!.source).toBe('claude-ai');
  });
});
