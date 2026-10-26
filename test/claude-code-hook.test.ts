import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  store.add({ type: 'fact', space: 'work', source: 'codex', body: 'Northwind CI runs lint, typecheck and test as parallel jobs on self-hosted runners', topics: ['ci', 'runners'] });
  store.add({ type: 'how', space: 'personal', source: 'codex', body: 'Prefers Vitest with colocated test files', topics: ['testing', 'ci'] });
  return store;
}

const prompt = (store: Store, text: string, session = 's1', transcript_path?: string) =>
  handleUserPromptSubmit({ session_id: session, cwd: personalRepo, prompt: text, ...(transcript_path ? { transcript_path } : {}) }, store, config);

describe('Claude Code hook', () => {
  it('injects quietly, and only announces work facts by topic', () => {
    const store = setup();
    const out = prompt(store, 'set up CI like we have at work');
    expect(out?.systemMessage?.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/^⌃ heads-up · /);
    expect(out?.systemMessage).toContain('\x1b[1;38;5;205m⌃ heads-up\x1b[0m'); // stands out from Claude Code's dim hook text
    expect(out?.systemMessage).toContain('waiting for your OK (ci, runners)');
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Prefers Vitest');
    expect(ctx).not.toContain('self-hosted runners'); // work content stays out until approved
    expect(store.readPending('s1')).toHaveLength(1);
  });

  it('adds approved notes on the next message', () => {
    const store = setup();
    prompt(store, 'set up CI like we have at work');
    const out = prompt(store, 'yes, share them');
    expect(out?.hookSpecificOutput?.additionalContext).toContain('self-hosted runners');
    expect(store.readPending('s1')).toHaveLength(0);
  });

  it('forgets pending notes when the user declines', () => {
    const store = setup();
    prompt(store, 'set up CI like we have at work');
    expect(prompt(store, 'no, keep them private')).toBeNull();
    expect(store.readPending('s1')).toHaveLength(0);
    expect(store.readLog().at(-1)?.event).toBe('declined');
  });

  it('returns nothing when there is nothing to add', () => {
    expect(prompt(setup(), 'explain how a hash map works')).toBeNull();
  });

  it('skips messages nobody typed, like a background task finishing', () => {
    const store = setup();
    expect(prompt(store, '<task-notification>\n<status>completed</status>\n<summary>set up CI tests</summary>\n</task-notification>')).toBeNull();
    expect(store.readLog()).toHaveLength(0);
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
    expect(vitest('and tests for the cache')).toContain('Prefers Vitest');
    // Another conversation starts with nothing given.
    expect(prompt(store, 'add tests for the parser', 's3')?.hookSpecificOutput?.additionalContext).toContain('Prefers Vitest');
  });

  it('works for Codex too: leaves out Codex\'s own notes and prints the mark without color codes', () => {
    const store = setup();
    store.add({ type: 'how', space: 'personal', source: 'claude-code', body: 'Runs the parser tests with pnpm test --watch', topics: ['testing'] });
    const out = handleUserPromptSubmit({ session_id: 'c1', cwd: personalRepo, prompt: 'add tests for the parser' }, store, config, 'codex');
    expect(out?.systemMessage).toBe('⌃ heads-up · added 1 note from Claude Code · personal');
    expect(out?.hookSpecificOutput?.additionalContext).not.toContain('Prefers Vitest'); // Codex wrote it
    expect(store.readLog().at(-1)).toMatchObject({ agent: 'codex' });
  });
});
