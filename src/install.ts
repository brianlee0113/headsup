// Registers the headsup hook in Claude Code's user settings, or in Codex's hooks.json (same shape).
// The file belongs to the user, so this only ever touches headsup's own entry, keeps a one-time
// backup, and refuses to rewrite a file it cannot parse.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { headsupHome } from './config.js';
import { writeLauncher } from './launcher.js';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

// UserPromptSubmit adds context; SessionEnd starts capture. Same command, dispatched on the payload.
const EVENTS = ['UserPromptSubmit', 'SessionEnd'] as const;
export type HookTarget = 'claude-code' | 'codex';
const ours = (target: HookTarget) => new RegExp(`\\bheadsup\\b.*\\bhook ${target}\\b`);
// Codex gives SessionEnd at most 3 seconds; starting the background capture takes well under one.
const TIMEOUT: Record<HookTarget, number> = { 'claude-code': 5, codex: 3 };

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

export function codexHooksPath(): string {
  return join(codexHome(), 'hooks.json');
}

export const hooksPath = (target: HookTarget) => (target === 'codex' ? codexHooksPath() : claudeSettingsPath());

// Hooks start headsup through the launcher in its home (launcher.ts), which finds Node and headsup
// again on every run, so a Node switch or reinstall doesn't break the entry. Writing the command also
// (re)writes the launcher.
export function hookCommand(target: HookTarget = 'claude-code', home = headsupHome()): string {
  return `"${writeLauncher(home)}" hook ${target}`;
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

const withoutOurs = (entries: HookEntry[], target: HookTarget) =>
  entries
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !ours(target).test(h.command)) }))
    .filter((e) => e.hooks.length);

const oursIn = (settings: Settings, event: string, target: HookTarget) =>
  (settings.hooks?.[event] ?? []).flatMap((e) => e.hooks).find((h) => ours(target).test(h.command));

export function isInstalled(target: HookTarget = 'claude-code', path = hooksPath(target)): boolean {
  const settings = read(path);
  return EVENTS.every((event) => oursIn(settings, event, target));
}

export function installHook(target: HookTarget, command: string, path = hooksPath(target)): 'added' | 'updated' | 'unchanged' {
  const settings = read(path);
  const before = EVENTS.map((event) => oursIn(settings, event, target)?.command);
  if (before.every((c) => c === command)) return 'unchanged';
  const hooks = { ...settings.hooks };
  for (const event of EVENTS) {
    hooks[event] = [...withoutOurs(hooks[event] ?? [], target), { hooks: [{ type: 'command', command, timeout: TIMEOUT[target] }] }];
  }
  settings.hooks = hooks;
  write(path, settings);
  return before.some(Boolean) ? 'updated' : 'added';
}

export function uninstallHook(target: HookTarget, path = hooksPath(target)): boolean {
  const settings = read(path);
  if (!EVENTS.some((event) => oursIn(settings, event, target))) return false;
  const hooks = { ...settings.hooks };
  for (const event of EVENTS) {
    const rest = withoutOurs(hooks[event] ?? [], target);
    if (rest.length) hooks[event] = rest;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  write(path, settings);
  return true;
}

// An entry written before the launcher names a Node binary by path; the first hook run after an update
// moves it over, touching only headsup's own entry. Claude Code only: Codex trusts a hook by its exact
// command, so changing it there would switch the hook off until the person trusts it again (setup does
// that one, and says so).
export function moveToLauncher(home = headsupHome(), path = claudeSettingsPath()): boolean {
  const settings = read(path);
  const entry = oursIn(settings, 'UserPromptSubmit', 'claude-code');
  if (!entry || entry.command.includes('/bin/headsup" hook ')) return false;
  installHook('claude-code', hookCommand('claude-code', home), path);
  return true;
}

