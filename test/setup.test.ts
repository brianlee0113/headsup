import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hookCommand, installClaudeHook, isInstalled, uninstallClaudeHook } from '../src/install.js';
import { runSetup, USAGE_EXAMPLE } from '../src/setup.js';
import { parseUsage } from '../src/usage.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'headsup-'));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const CMD = 'headsup hook claude-code';

describe('usage profile', () => {
  it('reads the Figma example', () => {
    expect(parseUsage('Claude for coding and side projects, ChatGPT for writing and everyday stuff.')).toEqual([
      { agents: ['claude-code', 'claude-ai'], topics: ['coding', 'side projects'] },
      { agents: ['chatgpt'], topics: ['writing', 'everyday'] },
    ]);
  });

  it('reads Korean and agents that share topics', () => {
    expect(parseUsage('클로드랑 코덱스는 코딩, 챗GPT는 글쓰기나 일상')).toEqual([
      { agents: ['claude-code', 'claude-ai', 'codex'], topics: ['coding'] },
      { agents: ['chatgpt'], topics: ['writing', 'everyday'] },
    ]);
  });

  it('parses the example shown in setup', () => {
    expect(parseUsage(USAGE_EXAMPLE)).toEqual([
      { agents: ['claude-code'], topics: ['coding', 'side projects'] },
      { agents: ['chatgpt'], topics: ['writing', 'everyday'] },
    ]);
  });

  it('does not read "claude code" as both Claude apps', () => {
    expect(parseUsage('Claude Code for code')).toEqual([{ agents: ['claude-code'], topics: ['coding'] }]);
  });

  it('returns nothing when no agent is named', () => {
    expect(parseUsage('mostly coding')).toEqual([]);
  });
});

describe('Claude Code settings', () => {
  it('adds its hook and keeps everything else', () => {
    const path = join(tmp(), 'settings.json');
    const other = { type: 'command', command: 'echo hi' };
    writeFileSync(path, JSON.stringify({ model: 'opus', hooks: { UserPromptSubmit: [{ hooks: [other] }], Stop: [{ hooks: [other] }] } }));
    expect(installClaudeHook(CMD, path)).toBe('added');
    const s = json(path);
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit.flatMap((e: { hooks: unknown[] }) => e.hooks)).toEqual([other, { type: 'command', command: CMD, timeout: 5 }]);
    expect(existsSync(`${path}.headsup-backup`)).toBe(true);
  });

  it('is idempotent and replaces an old command', () => {
    const path = join(tmp(), 'settings.json');
    installClaudeHook(CMD, path);
    expect(installClaudeHook(CMD, path)).toBe('unchanged');
    expect(installClaudeHook('npx -y headsup-ai hook claude-code', path)).toBe('updated');
    expect(json(path).hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('uninstalls only its own entry', () => {
    const path = join(tmp(), 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    installClaudeHook(CMD, path);
    expect(uninstallClaudeHook(path)).toBe(true);
    expect(isInstalled(path)).toBe(false);
    expect(json(path).hooks.UserPromptSubmit).toHaveLength(1);
    expect(uninstallClaudeHook(path)).toBe(false);
  });

  it('refuses to rewrite a settings file it cannot parse', () => {
    const path = join(tmp(), 'settings.json');
    writeFileSync(path, '{ "model": "opus", ');
    expect(() => installClaudeHook(CMD, path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ "model": "opus", ');
  });
});

describe('setup wizard', () => {
  const run = async (answers: string[], isolated = false) => {
    const home = tmp();
    const userHome = tmp();
    mkdirSync(join(userHome, '.claude'));
    const settingsPath = join(userHome, '.claude', 'settings.json');
    const out: string[] = [];
    const queue = [...answers];
    const prefills: string[] = [];
    await runSetup(
      { ask: async (q, prefill = '') => (out.push(q), prefills.push(prefill), queue.shift() ?? ''), print: (l = '') => out.push(l), color: false },
      { home, settingsPath, userHome, command: CMD, version: '0.0.1', browserDirs: [], isolated },
    );
    return { home, settingsPath, out: out.join('\n'), prefills };
  };

  it('saves the profile, spaces and preset, then installs the hook', async () => {
    const r = await run(['Claude for coding, ChatGPT for writing', '', '~/work, ~/clients', '', '1', '', 'y']);
    const config = loadConfig(r.home);
    expect(config.usage).toHaveLength(2);
    expect(config.spaces).toEqual([{ path: '~/work', space: 'work' }, { path: '~/clients', space: 'work' }]);
    expect(r.out).toMatch(/ChatGPT · Claude\.ai +→ personal {3}browser chats have no folder/);
    expect(config.preset).toBe('cautious');
    expect(isInstalled(r.settingsPath)).toBe(true);
    expect(r.out).toContain('Try it: ask Claude Code to do something you usually do in ChatGPT.');
  });

  it('connects installed browsers when asked', async () => {
    const home = tmp();
    const hostDir = join(tmp(), 'Google', 'Chrome', 'NativeMessagingHosts');
    const answers = ['', '', '', '', 'n', 'y'];
    await runSetup(
      { ask: async () => answers.shift() ?? '', print: () => {}, color: false },
      { home, settingsPath: join(tmp(), 'settings.json'), userHome: tmp(), command: CMD, version: '0.0.1', browserDirs: [hostDir] },
    );
    expect(existsSync(join(hostDir, 'ai.headsup.host.json'))).toBe(true);
  });

  it('lets the user edit the parsed profile and skip the hook', async () => {
    const r = await run(['Claude for coding', 'e', 'ChatGPT for writing', '', '', '', '', 'n']);
    expect(r.prefills.slice(0, 3)).toEqual(['', '', 'Claude for coding']); // the edit starts from the last answer
    expect(loadConfig(r.home).usage).toEqual([{ agents: ['chatgpt'], topics: ['writing'] }]);
    expect(loadConfig(r.home).preset).toBe('balanced');
    expect(existsSync(r.settingsPath)).toBe(false);
  });

  it('leaves Claude Code alone on enter when HEADSUP_HOME is set', async () => {
    const r = await run(['', '', '', '', ''], true);
    expect(r.out).toContain('Add it? [y/N]');
    expect(existsSync(r.settingsPath)).toBe(false);
  });

  it('lets the user edit the work folders before saving them', async () => {
    const r = await run(['', '~/work', 'e', '~/work, ~/clients', '', '', '', 'n']);
    expect(r.prefills.slice(1, 4)).toEqual(['', '', '~/work']);
    expect(loadConfig(r.home).spaces).toEqual([{ path: '~/work', space: 'work' }, { path: '~/clients', space: 'work' }]);
  });
});

describe('hook command', () => {
  it('carries a custom HEADSUP_HOME, since Claude Code runs hooks without it', () => {
    const before = process.env.HEADSUP_HOME;
    process.env.HEADSUP_HOME = "/tmp/it's here";
    try {
      expect(hookCommand()).toMatch(/^HEADSUP_HOME='\/tmp\/it'\\''s here' .*hook claude-code$/);
    } finally {
      if (before === undefined) delete process.env.HEADSUP_HOME;
      else process.env.HEADSUP_HOME = before;
    }
  });
});
