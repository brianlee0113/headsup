import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, capture, parseNotes, readConversation, type Summarize } from '../src/capture.js';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { detect } from '../src/gap.js';
import type { Note } from '../src/note.js';
import { Store } from '../src/store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'headsup-'));
const config: Config = { ...DEFAULT_CONFIG, spaces: [{ path: '~/work', space: 'work' }] };

const user = (text: string, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra });
const assistant = (blocks: unknown[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });

function transcript(lines: string[]): string {
  const path = join(tmp(), 'session.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const session = () =>
  transcript([
    JSON.stringify({ type: 'attachment' }),
    user('Set up tests for the Quorum scheduler. We always use Vitest, never Jest.<system-reminder>harness text</system-reminder>'),
    user('Caveat: local command output', { isMeta: true }),
    assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Adding Vitest config.' }, { type: 'tool_use', name: 'Bash' }]),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    user('Great. Quorum has about 140 weekly users now, so keep the API stable.'),
    assistant([{ type: 'text', text: 'Done.' }]),
  ]);

describe('transcript', () => {
  it('keeps what the user and assistant said, nothing the harness or tools added', () => {
    expect(readConversation(session())).toEqual([
      { role: 'user', text: 'Set up tests for the Quorum scheduler. We always use Vitest, never Jest.' },
      { role: 'assistant', text: 'Adding Vitest config.' },
      { role: 'user', text: 'Great. Quorum has about 140 weekly users now, so keep the API stable.' },
      { role: 'assistant', text: 'Done.' },
    ]);
  });

  it('keeps the newest turns when the conversation is long', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({ role: 'user' as const, text: `turn ${i} ${'x'.repeat(1000)}` }));
    const { user } = buildPrompt(turns, [], 'quorum', 'personal');
    expect(user).toContain('turn 199');
    expect(user).not.toContain('turn 0 ');
  });
});

describe('model output', () => {
  it('retries next time when the model answers in prose instead of JSON', async () => {
    const store = new Store(tmp());
    const input = { sessionId: 's1', transcriptPath: session(), cwd: tmp(), agent: 'claude-code' };
    const r = await capture(input, store, config, async () => 'Let me check the capture code first.');
    expect(r.reason).toMatch(/^model returned no JSON/);
    expect(store.readCaptured('s1')).toBe(0);
  });

  it('reads a JSON array even with prose around it, and drops malformed items', () => {
    const notes = parseNotes('Here you go:\n[{"type":"how","body":"Uses Vitest","topics":["Testing"]},{"type":"todo","body":"x"},{"type":"fact","body":""}]\nThanks');
    expect(notes).toEqual([{ type: 'how', body: 'Uses Vitest', topics: ['testing'] }]);
    expect(parseNotes('nothing to save')).toEqual([]);
  });
});

describe('capture', () => {
  const quorum = join(homedir(), 'side', 'quorum');
  const reply = (notes: unknown[]): Summarize => async () => JSON.stringify(notes);

  it('saves new notes with their project and space, skipping duplicates and secrets', async () => {
    const store = new Store(tmp());
    store.add({ type: 'how', space: 'personal', source: 'codex', body: 'Always uses Vitest and never Jest' });
    const r = await capture(
      { sessionId: 's1', transcriptPath: session(), cwd: quorum, agent: 'claude-code' },
      store,
      config,
      reply([
        { type: 'how', body: 'Always uses Vitest, never Jest', topics: ['testing'] },
        { type: 'fact', body: 'Quorum has about 140 weekly users', topics: ['quorum', 'users'] },
        { type: 'fact', body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      ]),
    );
    expect(r.saved.map((n) => n.body)).toEqual(['Quorum has about 140 weekly users']);
    expect(r.saved[0]).toMatchObject({ source: 'claude-code', project: 'quorum', space: 'personal' });
    expect(r.skipped).toBe(2);
  });

  it('only looks at turns added since the last capture', async () => {
    const store = new Store(tmp());
    const path = session();
    const prompts: string[] = [];
    const spy: Summarize = async (p) => (prompts.push(p.user), '[]');
    const input = { sessionId: 's1', transcriptPath: path, cwd: quorum, agent: 'claude-code' };
    await capture(input, store, config, spy);
    expect((await capture(input, store, config, spy)).reason).toBe('too short to learn from');
    appendFileSync(path, [user('Also, deploys go through Vercel only, and the database is Supabase. ' + 'More context. '.repeat(15)), user('Thanks!')].join('\n') + '\n');
    await capture(input, store, config, spy);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('deploys go through Vercel');
  });
});

describe('notes from the same tool', () => {
  const note = (project: string | undefined): Note => ({
    id: project ?? 'none', type: 'how', space: 'personal', source: 'claude-code', topics: ['testing'],
    created: '2026-10-19T00:00:00.000Z', body: 'Prefers Vitest with test files next to the source', ...(project ? { project } : {}),
  });

  it('come back from other projects but not from the one they were written in', () => {
    const repo = join(tmp(), 'northwind');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const d = detect({ prompt: 'add tests like usual', agent: 'claude-code', cwd: repo, knownText: '', notes: [note('quorum'), note('northwind'), note(undefined)], config });
    expect(d.inject.map((n) => n.id)).toEqual(['quorum']);
  });
});

describe('updates', () => {
  it('keeps a note whose figures changed, so the old one can be replaced', async () => {
    const { duplicates } = await import('../src/capture.js');
    const old = [{ id: 'a', type: 'fact', space: 'personal', source: 'claude-code', topics: [], created: '', body: 'Quorum has 140 weekly users across 9 clubs' }] as never;
    expect(duplicates('Quorum has 180 weekly users across 12 clubs', old)).toBe(false);
    expect(duplicates('Quorum has 140 weekly users across 9 clubs now', old)).toBe(true);
  });
});
