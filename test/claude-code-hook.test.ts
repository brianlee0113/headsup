import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { handleUserPromptSubmit } from '../src/hooks/claude-code.js';
import { Store } from '../src/store.js';

const config: Config = { ...DEFAULT_CONFIG, spaces: [{ path: '~/work', space: 'work' }] };
const personalRepo = join(homedir(), 'side', 'quorum');

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
  store.add({ type: 'fact', space: 'work', source: 'codex', body: 'Shipped payout retries at Northwind that cut failed payouts by 30%', topics: ['northwind', 'payouts'], scope: 'self', applies: ['resume', 'cover letter'] });
  store.add({ type: 'how', space: 'personal', source: 'codex', body: 'Prefers Vitest with colocated test files', topics: ['testing', 'ci'], scope: 'task', applies: ['add tests', 'test runner'] });
  store.add({ type: 'how', space: 'personal', source: 'codex', body: 'Likes the conclusion first, then bullets', topics: ['format'], scope: 'general' });
  return store;
}

const prompt = (store: Store, text: string, session = 's1', transcript_path?: string) =>
  handleUserPromptSubmit({ session_id: session, cwd: personalRepo, prompt: text, ...(transcript_path ? { transcript_path } : {}) }, store, config);

describe('Claude Code hook', () => {
  it('opens with how they like answers, adds what fits the prompt, and only announces work facts by topic', () => {
    const store = setup();
    // The colored mark is the default; NO_COLOR in the test runner's shell shouldn't decide the result.
    const noColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    const out = prompt(store, 'polish my resume, then add tests for the parser');
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
    expect(out?.systemMessage?.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/^⌃ heads-up · /);
    expect(out?.systemMessage).toContain('\x1b[1;38;5;205m⌃ heads-up\x1b[0m'); // stands out from Claude Code's dim hook text
    expect(out?.systemMessage).toContain('your answer style (1 note)');
    expect(out?.systemMessage).toContain('added 1 note from Codex · personal');
    expect(out?.systemMessage).toContain('waiting for your OK (northwind, payouts)');
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Likes the conclusion first');
    expect(ctx).toContain('Prefers Vitest');
    expect(ctx).not.toContain('payout retries'); // work content stays out until approved
    expect(store.readPending('s1')).toHaveLength(1);
    expect(store.readLog().at(-1)).toMatchObject({ event: 'heads-up', opening: [expect.any(String)] });
  });

  it('adds approved notes on the next message', () => {
    const store = setup();
    prompt(store, 'polish my resume');
    const out = prompt(store, 'yes, share them');
    expect(out?.hookSpecificOutput?.additionalContext).toContain('payout retries');
    expect(store.readPending('s1')).toHaveLength(0);
  });

  it('forgets pending notes when the user declines', () => {
    const store = setup();
    prompt(store, 'polish my resume');
    expect(prompt(store, 'no, keep them private')).toBeNull();
    expect(store.readPending('s1')).toHaveLength(0);
    expect(store.readLog().at(-1)?.event).toBe('declined');
  });

  it('after the opening, returns nothing when nothing fits', () => {
    const store = setup();
    expect(prompt(store, 'explain how a hash map works')?.hookSpecificOutput?.additionalContext).toContain('Likes the conclusion first');
    expect(prompt(store, 'and a trie?')).toBeNull();
  });

  it('keeps the standing notes out of learning\'s used-or-ignored count', () => {
    const store = setup();
    prompt(store, 'explain how a hash map works');
    expect(existsSync(join(store.home, 'state', 'learning.json'))).toBe(false);
  });

  it('skips messages nobody typed, like a background task finishing', () => {
    const store = setup();
    expect(prompt(store, '<task-notification>\n<status>completed</status>\n<summary>set up CI tests</summary>\n</task-notification>')).toBeNull();
    expect(store.readLog()).toHaveLength(0);
    // …and the opening is still ahead for the first thing the person types.
    expect(prompt(store, 'explain how a hash map works')?.systemMessage).toContain('your answer style');
  });

  it('adds a note once per conversation, and again after the conversation is compacted', () => {
    const store = setup();
    const transcript = join(store.home, 'transcript.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    const vitest = (text: string) => prompt(store, text, 's2', transcript)?.hookSpecificOutput?.additionalContext ?? '';
    expect(vitest('add tests for the parser')).toContain('Prefers Vitest');
    expect(vitest('now add tests for the formatter')).not.toContain('Prefers Vitest');
    expect(vitest('add tests for the router too')).toBe('');
    appendFileSync(transcript, '{"type":"system","subtype":"compact_boundary"}\n');
    expect(vitest('and add tests for the cache')).toContain('Prefers Vitest');
    // Another conversation starts with nothing given.
    expect(prompt(store, 'add tests for the parser', 's3')?.hookSpecificOutput?.additionalContext).toContain('Prefers Vitest');
  });

  it('works for Codex too: leaves out what Codex learned in this same project, and prints the mark without color codes', () => {
    const store = setup();
    store.add({ type: 'how', space: 'personal', source: 'claude-code', body: 'Runs the parser tests with pnpm test --watch', topics: ['testing'], scope: 'task', applies: ['add tests'] });
    store.add({ type: 'how', space: 'personal', source: 'codex', project: 'quorum', body: 'Keeps fixtures for the slot finder under tests/fixtures', topics: ['testing'], scope: 'task', applies: ['add tests'] });
    const transcript_path = join(store.home, 'rollout.jsonl');
    writeFileSync(transcript_path, '');
    const out = handleUserPromptSubmit({ session_id: 'c1', cwd: personalRepo, prompt: 'add tests for the parser', transcript_path }, store, config, 'codex');
    expect(out?.systemMessage).toBe('⌃ heads-up · your answer style (1 note) · added 2 notes from 2 places');
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('pnpm test --watch'); // from Claude Code
    expect(ctx).toContain('Prefers Vitest'); // Codex's own, but from outside this project
    expect(ctx).not.toContain('tests/fixtures'); // Codex learned it here: the project's own business
    expect(store.readLog().at(-1)).toMatchObject({ agent: 'codex' });
  });

  it('leaves alone the Codex app\'s own background prompts, which run in threads it doesn\'t save', () => {
    const store = setup();
    expect(handleUserPromptSubmit({ session_id: 'bg', cwd: personalRepo, prompt: 'Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex' }, store, config, 'codex')).toBeNull();
    expect(store.readLog()).toHaveLength(0);
  });
});
