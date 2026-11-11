// What the agent can already see: its own instruction files and the current session transcript.

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const CONTEXT_FILES: Record<string, string[]> = {
  'claude-code': ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
  codex: ['AGENTS.md'],
  'gemini-cli': ['GEMINI.md'],
  cursor: ['.cursorrules', 'AGENTS.md'],
};

const GLOBAL_FILES: Record<string, string[]> = {
  'claude-code': [join(homedir(), '.claude', 'CLAUDE.md')],
  codex: [join(homedir(), '.codex', 'AGENTS.md')],
  'gemini-cli': [join(homedir(), '.gemini', 'GEMINI.md')],
};

const MAX_TRANSCRIPT_BYTES = 256 * 1024;

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

export function readAgentContext(agent: string, cwd: string): string {
  const names = CONTEXT_FILES[agent] ?? [];
  const parts = (GLOBAL_FILES[agent] ?? []).map(readIfExists);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of names) parts.push(readIfExists(join(dir, name)));
    if (dirname(dir) === dir || dir === homedir()) break;
  }
  parts.push(...agentMemory(agent, cwd));
  return parts.join('\n');
}

// Claude Code's own memory for a folder (~/.claude/projects/<folder>/memory/*.md): what it wrote down
// there itself is already in front of it.
function agentMemory(agent: string, cwd: string): string[] {
  if (agent !== 'claude-code') return [];
  const dir = join(homedir(), '.claude', 'projects', resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, 50).map((f) => readIfExists(join(dir, f)));
  } catch {
    return [];
  }
}

// Reads the tail of a JSONL transcript and keeps only message text, ignoring tool payloads' structure.
function tailLines(path: string): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8').split('\n');
}

// The assistant's text since the person last typed something: what answered the previous prompt.
export function lastReply(path: string | undefined): string {
  if (!path || !existsSync(path)) return '';
  const parts: string[] = [];
  for (const line of tailLines(path)) {
    let e: { type?: string; isMeta?: boolean; message?: { content?: unknown }; payload?: { type?: string; role?: string; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex rollouts: response items with a role; its own injected text comes as user items too.
    if (e.type === 'response_item' && e.payload?.type === 'message') {
      const texts = Array.isArray(e.payload.content) ? (e.payload.content as Array<{ text?: string }>).map((b) => b?.text ?? '') : [];
      if (e.payload.role === 'user' && texts.some((t) => codexUserText(t))) parts.length = 0;
      else if (e.payload.role === 'assistant') parts.push(...texts.filter(Boolean));
      continue;
    }
    const content = e.message?.content;
    if (e.type === 'user' && !e.isMeta && typeof content === 'string') parts.length = 0;
    else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; text?: string }>) if (b?.type === 'text' && b.text) parts.push(b.text);
    }
  }
  return parts.join('\n');
}

// What the person typed earlier in this conversation, oldest first (the transcript's end; tool results
// and the agents' own inserts left out). The current prompt is usually not in the file yet.
export function earlierPrompts(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  const out: string[] = [];
  for (const line of tailLines(path)) {
    let e: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown }; payload?: { type?: string; role?: string; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user') {
      const texts = Array.isArray(e.payload.content) ? (e.payload.content as Array<{ text?: string }>).map((b) => codexUserText(b?.text ?? '')) : [];
      out.push(...texts.filter(Boolean));
      continue;
    }
    if (e.type !== 'user' || e.isMeta || e.isSidechain) continue;
    const content = e.message?.content;
    if (typeof content === 'string') out.push(content);
    else if (Array.isArray(content) && !content.some((b: { type?: string }) => b?.type === 'tool_result')) {
      out.push(...(content as Array<{ type?: string; text?: string }>).filter((b) => b?.type === 'text' && b.text).map((b) => b.text!));
    }
  }
  return out;
}

// Codex sends its own text as user messages: the AGENTS.md instructions, the environment, app state.
// What is left after dropping those is what the person typed.
const CODEX_INSERTS = /<([\w-]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
export function codexUserText(text: string): string {
  if (/^\s*# AGENTS\.md instructions/.test(text)) return '';
  return text.replace(CODEX_INSERTS, '').trim();
}

export function readTranscript(path: string | undefined): string {
  if (!path || !existsSync(path)) return '';
  const size = statSync(path).size;
  const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const texts: string[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    try {
      collectText(JSON.parse(line), texts);
    } catch {
      // first line may be cut mid-record
    }
  }
  return texts.join('\n');
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) return value.forEach((v) => collectText(v, out));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'text' || k === 'content') && typeof v === 'string') out.push(v);
      else collectText(v, out);
    }
  }
}

// The Codex app starts each chat in a fresh dated folder (~/Documents/Codex/2026-10-24/<slug>):
// a place to put files, not a project.
const CODEX_SCRATCH = /\/Codex\/\d{4}-\d{2}-\d{2}(?:\/|$)/;

// The repo a folder belongs to (nearest .git up the tree), else the folder itself. 'home' for folders
// that are no project at all.
export function projectOf(cwd: string): string {
  if (CODEX_SCRATCH.test(resolve(cwd))) return 'home';
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      // A linked worktree's .git is a file pointing into the main checkout: same project, other folder.
      try {
        if (statSync(dotGit).isFile()) {
          const main = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
          if (main) return basename(main);
        }
      } catch {
        /* unreadable: the folder's own name will do */
      }
      return basename(dir);
    }
    const parent = dirname(dir);
    if (parent === dir || dir === homedir()) return basename(resolve(cwd)) || 'home';
    dir = parent;
  }
}

export function transcriptSize(path: string | undefined): number {
  return path && existsSync(path) ? statSync(path).size : 0;
}

// Whether the conversation was compacted after the transcript was `offset` bytes long. A compaction
// drops the notes added before it from what the agent can see. Reads only what was appended since.
export function compactedSince(path: string | undefined, offset: number): boolean {
  if (!path || !existsSync(path)) return false;
  const size = statSync(path).size;
  if (size < offset) return true; // rewritten from scratch
  if (size === offset) return false;
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  // Claude Code marks it with a compact_boundary entry, Codex with a compacted item.
  return buf.includes('"compact_boundary"') || buf.includes('"type":"compacted"');
}
