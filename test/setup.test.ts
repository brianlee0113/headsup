import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hookCommand, installHook, isInstalled, moveToLauncher, uninstallHook } from '../src/install.js';
import { launcherPath, launcherScript } from '../src/launcher.js';
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
    expect(installHook('claude-code', CMD, path)).toBe('added');
    const s = json(path);
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit.flatMap((e: { hooks: unknown[] }) => e.hooks)).toEqual([other, { type: 'command', command: CMD, timeout: 5 }]);
    expect(existsSync(`${path}.headsup-backup`)).toBe(true);
  });

  it('is idempotent and replaces an old command', () => {
    const path = join(tmp(), 'settings.json');
    installHook('claude-code', CMD, path);
    expect(installHook('claude-code', CMD, path)).toBe('unchanged');
    expect(installHook('claude-code', 'npx -y headsup-ai hook claude-code', path)).toBe('updated');
    expect(json(path).hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('uninstalls only its own entry', () => {
    const path = join(tmp(), 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    installHook('claude-code', CMD, path);
    expect(uninstallHook('claude-code', path)).toBe(true);
    expect(isInstalled('claude-code', path)).toBe(false);
    expect(json(path).hooks.UserPromptSubmit).toHaveLength(1);
    expect(uninstallHook('claude-code', path)).toBe(false);
  });

  it('refuses to rewrite a settings file it cannot parse', () => {
    const path = join(tmp(), 'settings.json');
    writeFileSync(path, '{ "model": "opus", ');
    expect(() => installHook('claude-code', CMD, path)).toThrow(/not valid JSON/);
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
    expect(isInstalled('claude-code', r.settingsPath)).toBe(true);
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

describe('Codex hooks', () => {
  it('writes its own entries to hooks.json, next to Claude Code\'s and apart from them', () => {
    const path = join(tmp(), 'hooks.json');
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }));
    expect(installHook('codex', 'headsup hook codex', path)).toBe('added');
    const hooks = json(path).hooks;
    expect(hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: 'headsup hook codex', timeout: 3 });
    expect(hooks.SessionEnd).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
    expect(isInstalled('codex', path)).toBe(true);
    expect(isInstalled('claude-code', path)).toBe(false);
    expect(uninstallHook('codex', path)).toBe(true);
    expect(json(path).hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] });
  });

  it('offers to connect Codex in setup when it is installed', async () => {
    const userHome = tmp();
    mkdirSync(join(userHome, '.codex'));
    const codexHooksPath = join(userHome, '.codex', 'hooks.json');
    const out: string[] = [];
    await runSetup(
      { ask: async () => '', print: (l = '') => out.push(l), color: false },
      { home: tmp(), settingsPath: join(tmp(), 'settings.json'), userHome, command: CMD, codexHooksPath, codexCommand: 'headsup hook codex', version: '0.0.1', browserDirs: [] },
    );
    expect(isInstalled('codex', codexHooksPath)).toBe(true);
    expect(out.join('\n')).toContain('/hooks');
  });
});

describe('hook command', () => {
  it('goes through the launcher in the headsup home, which names that home', () => {
    const home = join(tmp(), "it's here");
    expect(hookCommand('claude-code', home)).toBe(`"${launcherPath(home)}" hook claude-code`);
    expect(readFileSync(launcherPath(home), 'utf8')).toContain(`export HEADSUP_HOME='${home.replace(/'/g, "'\\''")}'`);
  });

  it('moves an entry that names a Node binary over to the launcher, once', () => {
    const home = tmp();
    const path = join(tmp(), 'settings.json');
    installHook('claude-code', '"/Users/me/.nvm/versions/node/v23.6.1/bin/node" "/Users/me/.nvm/versions/node/v23.6.1/lib/node_modules/headsup-ai/dist/cli.js" hook claude-code', path);
    expect(moveToLauncher(home, path)).toBe(true);
    expect(json(path).hooks.UserPromptSubmit[0].hooks[0].command).toBe(`"${launcherPath(home)}" hook claude-code`);
    expect(json(path).hooks.SessionEnd).toHaveLength(1);
    expect(moveToLauncher(home, path)).toBe(false);
  });

  it('still starts headsup after the Node it was written with is gone', () => {
    const dir = tmp();
    const cli = join(dir, 'cli.js');
    writeFileSync(cli, 'console.log(["ran", ...process.argv.slice(2)].join(" "))');
    const file = join(dir, 'headsup');
    writeFileSync(file, launcherScript(dir, '/nowhere/.nvm/versions/node/v20.0.0/bin/node', cli, process.env.PATH));
    chmodSync(file, 0o755);
    expect(execFileSync(file, ['hook', 'claude-code'], { encoding: 'utf8' }).trim()).toBe('ran hook claude-code');
  });
});
