// Registers the headsup hook in Claude Code's user settings, or in Codex's hooks.json (same shape).
// The file belongs to the user, so this only ever touches headsup's own entry, keeps a one-time
// backup, and refuses to rewrite a file it cannot parse.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { shellQuote } from './config.js';

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

// Prefer the installed binary; fall back to npx (slower, but survives cache cleanup) and, when run
// from a checkout, to this very file. A custom HEADSUP_HOME goes along, since hooks run without it.
export function hookCommand(target: HookTarget = 'claude-code'): string {
  const env = process.env.HEADSUP_HOME ? `HEADSUP_HOME=${shellQuote(process.env.HEADSUP_HOME)} ` : '';
  return `${env}${binary()} hook ${target}`;
}

function binary(): string {
  if (spawnSync('sh', ['-c', 'command -v headsup'], { encoding: 'utf8' }).stdout.trim()) return 'headsup';
  const self = process.argv[1] ? realpathSync(process.argv[1]) : '';
  if (!self || self.includes('/_npx/')) return 'npx -y headsup-ai';
  return `"${process.execPath}" "${self}"`;
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
