// What the agent can already see: its own instruction files and the current session transcript.

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
  return parts.join('\n');
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
    let e: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
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

// The repo a folder belongs to (nearest .git up the tree), else the folder itself.
export function projectOf(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return basename(dir);
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
  return buf.includes('"compact_boundary"');
}
