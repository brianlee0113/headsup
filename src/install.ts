// Registers the headsup hook in Claude Code's user settings. The file belongs to the user, so this
// only ever touches headsup's own entry, keeps a one-time backup, and refuses to rewrite a file it
// cannot parse.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

const EVENT = 'UserPromptSubmit';
const OURS = /\bheadsup\b.*\bhook claude-code\b/;

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
}

// Prefer the installed binary; fall back to npx (slower, but survives cache cleanup) and, when run
// from a checkout, to this very file.
export function hookCommand(): string {
  if (spawnSync('sh', ['-c', 'command -v headsup'], { encoding: 'utf8' }).stdout.trim()) return 'headsup hook claude-code';
  const self = process.argv[1] ? realpathSync(process.argv[1]) : '';
  if (!self || self.includes('/_npx/')) return 'npx -y headsup-ai hook claude-code';
  return `"${process.execPath}" "${self}" hook claude-code`;
}

function read(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Settings;
  } catch {
    throw new Error(`${path} is not valid JSON — fix it first; headsup won't overwrite it`);
  }
}

function write(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const backup = `${path}.headsup-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

const withoutOurs = (entries: HookEntry[]) =>
  entries
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !OURS.test(h.command)) }))
    .filter((e) => e.hooks.length);

export function isInstalled(path = claudeSettingsPath()): boolean {
  return (read(path).hooks?.[EVENT] ?? []).some((e) => e.hooks.some((h) => OURS.test(h.command)));
}

export function installClaudeHook(command: string, path = claudeSettingsPath()): 'added' | 'updated' | 'unchanged' {
  const settings = read(path);
  const entries = settings.hooks?.[EVENT] ?? [];
  const existing = entries.flatMap((e) => e.hooks).find((h) => OURS.test(h.command));
  if (existing?.command === command) return 'unchanged';
  const hook = { type: 'command', command, timeout: 5 };
  settings.hooks = { ...settings.hooks, [EVENT]: [...withoutOurs(entries), { hooks: [hook] }] };
  write(path, settings);
  return existing ? 'updated' : 'added';
}

export function uninstallClaudeHook(path = claudeSettingsPath()): boolean {
  const settings = read(path);
  const entries = settings.hooks?.[EVENT];
  if (!entries || !isInstalled(path)) return false;
  const rest = withoutOurs(entries);
  const hooks = { ...settings.hooks };
  if (rest.length) hooks[EVENT] = rest;
  else delete hooks[EVENT];
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  write(path, settings);
  return true;
}
