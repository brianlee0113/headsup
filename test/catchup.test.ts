import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConversation, type Summarize } from '../src/capture.js';
import { catchUp, catchUpDue, findPending } from '../src/catchup.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Store } from '../src/store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'headsup-'));
const MIN = 60_000;
const NOW = Date.parse('2026-10-23T18:00:00Z');

const user = (text: string) => JSON.stringify({ type: 'user', cwd: '/Users/me/side/quorum', message: { role: 'user', content: text } });
const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const LONG = [
  user('Quorum is a scheduling app for study groups. We deploy it on Vercel with Neon Postgres.'),
  assistant('Got it.'),
  user('Always use pnpm in Quorum, never npm.'),
  assistant('Noted.'),
];

// A Claude Code projects folder: <project>/<session>.jsonl, last written `ago` before NOW.
function projects(sessions: Record<string, { lines: string[]; ago: number }>): string {
  const root = tmp();
  mkdirSync(join(root, '-Users-me-side-quorum', 'abc', 'subagents'), { recursive: true });
  writeFileSync(join(root, '-Users-me-side-quorum', 'abc', 'subagents', 'agent-1.jsonl'), LONG.join('\n'));
  for (const [id, { lines, ago }] of Object.entries(sessions)) {
    const path = join(root, '-Users-me-side-quorum', `${id}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    utimesSync(path, (NOW - ago) / 1000, (NOW - ago) / 1000);
  }
  return root;
}

describe('catch-up', () => {
  it('finds sessions gone quiet, not live ones, old ones or subagents', () => {
    const store = new Store(tmp());
    const root = projects({
      quiet: { lines: LONG, ago: 45 * MIN },
      live: { lines: LONG, ago: 5 * MIN },
      old: { lines: LONG, ago: 10 * 24 * 60 * MIN },
    });
    const found = findPending(store, { root, codexRoot: tmp(), now: NOW });
    expect(found.map((p) => p.sessionId)).toEqual(['quiet']);
    expect(found[0]!.cwd).toBe('/Users/me/side/quorum');
    // The hook can vouch for its own session even though the new prompt just touched the file.
    expect(findPending(store, { root, codexRoot: tmp(), now: NOW, include: 'live' }).map((p) => p.sessionId)).toEqual(['live', 'quiet']);
  });

  it('captures a session that never ended, then only what it adds later', async () => {
    const store = new Store(tmp());
    const root = projects({ tmux: { lines: LONG, ago: 45 * MIN } });
    const summarize: Summarize = async () => JSON.stringify([{ type: 'how', body: 'Uses pnpm in Quorum, never npm', topics: ['quorum'] }]);

    const r = await catchUp(store, DEFAULT_CONFIG, summarize, { root, codexRoot: tmp(), now: NOW });
    expect(r?.saved.map((n) => n.body)).toEqual(['Uses pnpm in Quorum, never npm']);
    expect(store.readLog().at(-1)).toMatchObject({ event: 'captured', session: 'tmux', via: 'catch-up' });
    expect(findPending(store, { root, codexRoot: tmp(), now: NOW })).toEqual([]); // nothing new since
  });

  it('skips short sessions without logging them, so they wait until there is more to read', async () => {
    const store = new Store(tmp());
    const root = projects({ short: { lines: [user('hi'), assistant('hello')], ago: 45 * MIN } });
    let asked = 0;
    const r = await catchUp(store, DEFAULT_CONFIG, async () => (asked++, '[]'), { root, codexRoot: tmp(), now: NOW });
    expect(r).toEqual({ sessions: 0, saved: [], failed: 0 });
    expect(asked).toBe(0);
    expect(store.readLog()).toEqual([]);
  });

  it('runs at most every ten minutes on its own', async () => {
    const store = new Store(tmp());
    expect(catchUpDue(store, NOW)).toBe(true);
    await catchUp(store, DEFAULT_CONFIG, async () => '[]', { root: projects({}), codexRoot: tmp(), now: NOW });
    expect(catchUpDue(store, NOW + 5 * MIN)).toBe(false);
    expect(catchUpDue(store, NOW + 11 * MIN)).toBe(true);
  });
});

describe('Codex sessions', () => {
  const item = (role: string, text: string) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
  const ID = '01a16f3e-642f-7501-b3a8-39d48c40766e';

  it('finds a quiet Codex session by its rollout file, with the folder it ran in', () => {
    const codexRoot = tmp();
    const day = join(codexRoot, '2026', '10', '23');
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-10-23T16-00-00-${ID}.jsonl`);
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: '/Users/me/side/quorum' } }),
      item('user', '# AGENTS.md instructions\n<INSTRUCTIONS>use pnpm</INSTRUCTIONS>'),
      item('developer', '[headsup] Notes the user saved'),
      item('user', '<environment_context><cwd>/Users/me/side/quorum</cwd></environment_context>'),
      item('user', 'Quorum is a scheduling app for study groups. We deploy it on Vercel with Neon Postgres.'),
      item('assistant', 'Got it.'),
      item('user', 'Always use pnpm in Quorum, never npm.'),
    ].join('\n') + '\n');
    utimesSync(path, (NOW - 45 * MIN) / 1000, (NOW - 45 * MIN) / 1000);
    const found = findPending(new Store(tmp()), { root: tmp(), codexRoot, now: NOW });
    expect(found).toMatchObject([{ agent: 'codex', sessionId: ID, cwd: '/Users/me/side/quorum' }]);
    expect(readConversation(path).map((t) => t.text)).toEqual([
      'Quorum is a scheduling app for study groups. We deploy it on Vercel with Neon Postgres.',
      'Got it.',
      'Always use pnpm in Quorum, never npm.',
    ]);
  });
});

describe('catch-up scope', () => {
  it('leaves sessions run in temp folders alone', () => {
    const store = new Store(tmp());
    const scratch = LONG.map((l) => l.replace('/Users/me/side/quorum', '/private/tmp/claude-501/scratchpad/e2e'));
    const root = projects({ scratch: { lines: scratch, ago: 45 * MIN }, quiet: { lines: LONG, ago: 45 * MIN } });
    expect(findPending(store, { root, codexRoot: tmp(), now: NOW }).map((p) => p.sessionId)).toEqual(['quiet']);
  });
});
