import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type Preset = 'cautious' | 'balanced' | 'open';

export interface UsageRule {
  agents: string[]; // e.g. ["claude-code", "claude-ai"]
  topics: string[]; // e.g. ["coding", "side projects"]
}

export interface Config {
  preset: Preset;
  defaultSpace: string;
  spaces: Array<{ path: string; space: string }>; // "~/work" → "work"; longest matching prefix wins
  usage: UsageRule[];
}

export const DEFAULT_CONFIG: Config = { preset: 'balanced', defaultSpace: 'personal', spaces: [], usage: [] };

export function headsupHome(): string {
  return process.env.HEADSUP_HOME ?? join(homedir(), '.headsup');
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function loadConfig(home = headsupHome()): Config {
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Partial<Config>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config, home = headsupHome()): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

export function resolveSpace(cwd: string, config: Config): string {
  const dir = resolve(cwd);
  let best: { len: number; space: string } | undefined;
  for (const rule of config.spaces) {
    const root = resolve(expandHome(rule.path.replace(/\/\*+$/, '')));
    if ((dir === root || dir.startsWith(root + sep)) && (!best || root.length > best.len)) {
      best = { len: root.length, space: rule.space };
    }
  }
  return best?.space ?? config.defaultSpace;
}
