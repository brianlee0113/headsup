import { mkdtempSync } from 'node:fs';
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

const prompt = (store: Store, text: string, session = 's1') =>
  handleUserPromptSubmit({ session_id: session, cwd: personalRepo, prompt: text }, store, config);

describe('Claude Code hook', () => {
  it('injects quietly, and only announces work facts by topic', () => {
    const store = setup();
    const out = prompt(store, 'set up CI like we have at work');
    expect(out?.systemMessage).toMatch(/^⌃ heads-up · /);
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
});
