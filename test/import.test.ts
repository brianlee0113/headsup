import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Prompt, Summarize } from '../src/capture.js';
import { parseExport, planImport, readExport, runImport } from '../src/import/chatgpt.js';
import { importChatGPT } from '../src/import/flow.js';
import { Store } from '../src/store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'headsup-'));
const day = (iso: string) => new Date(iso).getTime() / 1000;

// One chat in the export's shape: a message tree where current_node marks the visible branch.
function chat(id: string, updated: string, messages: Array<[string, string | unknown[]]>, extra: Record<string, unknown> = {}) {
  const mapping: Record<string, unknown> = { root: { id: 'root', message: null, parent: null, children: ['m0'] } };
  let parent = 'root';
  messages.forEach(([role, content], i) => {
    const key = `m${i}`;
    mapping[key] = {
      id: key,
      parent,
      children: [],
      message: {
        author: { role },
        content: { content_type: Array.isArray(content) ? 'multimodal_text' : 'text', parts: Array.isArray(content) ? content : [content] },
        metadata: role === 'system' ? { is_visually_hidden_from_conversation: true } : {},
      },
    };
    parent = key;
  });
  return { id, conversation_id: id, title: `chat ${id}`, create_time: day(updated), update_time: day(updated), current_node: parent, mapping, ...extra };
}

const long = 'I am a second-year HCI master\'s student and I write in a plain, warm tone without buzzwords. '.repeat(2);
const exportJson = JSON.stringify([
  chat('recent', '2026-09-01', [['system', 'hidden'], ['user', long], ['assistant', 'Sure.'], ['user', [{ asset_pointer: 'img' }, 'and this screenshot']]]),
  chat('old', '2024-01-01', [['user', long]]),
  chat('short', '2026-09-02', [['user', 'what is 2+2']]),
  chat('mid', '2026-05-01', [['user', long], ['assistant', 'Noted.']]),
]);

describe('reading the export', () => {
  it('follows the visible branch and keeps only what was said', () => {
    const json = JSON.parse(exportJson);
    // An edited message leaves a dead branch behind; current_node points at the live one.
    json[0].mapping.m1b = { id: 'm1b', parent: 'm0', children: [], message: { author: { role: 'user' }, content: { parts: ['an abandoned edit'] } } };
    const [first] = parseExport(JSON.stringify(json));
    expect(first!.turns).toEqual([
      { role: 'user', text: long.trim() },
      { role: 'assistant', text: 'Sure.' },
      { role: 'user', text: 'and this screenshot' },
    ]);
  });

  it('opens the zip, the folder, or the json', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'conversations.json'), exportJson);
    expect(readExport(dir)).toBe(exportJson);
    if (spawnSync('zip', ['-v']).status === 0) {
      spawnSync('zip', ['-q', join(dir, 'export.zip'), 'conversations.json'], { cwd: dir });
      expect(readExport(join(dir, 'export.zip'))).toBe(exportJson);
    }
  });

  it('plans only recent, substantial chats it has not read before, newest first', () => {
    const plan = planImport(parseExport(exportJson), { since: new Date('2025-10-19'), done: new Set(['mid']) });
    expect(plan.total).toBe(4);
    expect(plan.inRange).toBe(3);
    expect(plan.todo.map((c) => c.id)).toEqual(['recent']);
  });
});

describe('importing', () => {
  const plan = () => planImport(parseExport(exportJson), { since: new Date('2025-10-19'), done: new Set() });
  const notes = JSON.stringify([
    { type: 'how', body: 'Writes in a plain, warm tone without buzzwords', topics: ['writing'] },
    { type: 'fact', body: "Second-year master's student in HCI", topics: ['education'] },
  ]);

  it('saves ChatGPT notes in the chosen space and remembers which chats it read', async () => {
    const store = new Store(tmp());
    const seen: Prompt[] = [];
    const r = await runImport(plan(), store, { space: 'personal', summarize: async (p) => (seen.push(p), notes) });
    expect(r.saved.map((n) => [n.source, n.space, n.type])).toEqual([['chatgpt', 'personal', 'how'], ['chatgpt', 'personal', 'fact']]);
    expect(seen[0]!.system).toMatch(/Never include health/);
    expect(seen[0]!.user).toContain('<conversation title="chat recent" date="2026-09-01">');
    expect(store.readImported('chatgpt').sort()).toEqual(['mid', 'recent']);
    // A second run over the same export has nothing left to read.
    expect(planImport(parseExport(exportJson), { since: new Date('2025-10-19'), done: new Set(store.readImported('chatgpt')) }).todo).toEqual([]);
  });

  it('leaves a failed batch unread so the next run retries it', async () => {
    const store = new Store(tmp());
    const r = await runImport(plan(), store, { space: 'personal', summarize: async () => 'Sorry, I cannot help with that.' });
    expect(r.failed).toBe(1);
    expect(store.readImported('chatgpt')).toEqual([]);
  });

  it('sends nothing until the user says yes', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'conversations.json'), exportJson);
    let calls = 0;
    const summarize: Summarize = async () => (calls++, notes);
    const out: string[] = [];
    const io = { ask: async () => 'n', print: (l = '') => out.push(l), progress: () => {}, color: false };
    const store = new Store(tmp());
    await importChatGPT(io, store, { path: dir, space: 'personal', summarize, now: new Date(2026, 9, 19) });
    expect(calls).toBe(0);
    expect(out.join('\n')).toContain('4 chats in the export · 3 since 2025-10-19 · 2 to read');
    expect(out.join('\n')).toContain('Nothing was sent.');
    expect(await importChatGPT({ ...io, ask: async () => 'y' }, store, { path: dir, space: 'personal', summarize, now: new Date(2026, 9, 19) })).toBe(2);
  });
});
