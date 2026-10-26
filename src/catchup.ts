// SessionEnd alone misses most sessions: in tmux a session stays open for days, and a reboot or a
// killed pane ends it without the hook running. So any prompt also starts a background catch-up
// that captures sessions gone quiet, whether they ended or not. A session that comes back to life
// only adds its new turns (the captured watermark), so capturing early loses nothing.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, readConversation, TOO_SHORT, type Summarize } from './capture.js';
import type { Config } from './config.js';
import { codexHome } from './install.js';
import type { Note } from './note.js';
import type { Store } from './store.js';

export const IDLE_MS = 30 * 60_000; // quiet this long counts as a pause worth capturing
const MAX_AGE_MS = 7 * 24 * 60 * 60_000; // older transcripts are left alone
const EVERY_MS = 10 * 60_000; // between catch-up runs
const MAX_SUMMARIES = 3; // per run; the rest wait for the next one
const LOCK_STALE_MS = 15 * 60_000;

export const claudeProjectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export const codexSessionsDir = () => join(codexHome(), 'sessions');

const stateFile = (home: string) => join(home, 'state', 'catch-up.json');

// Throwaway runs (tests, scratch folders) aren't the user's work.
const TEMP_DIRS = [...new Set([tmpdir(), '/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/'])];
const isTemp = (cwd: string) => TEMP_DIRS.some((d) => cwd.startsWith(d.endsWith('/') ? d : `${d}/`));

export function catchUpDue(store: Store, now = Date.now()): boolean {
  try {
    return now - (JSON.parse(readFileSync(stateFile(store.home), 'utf8')) as { at: number }).at >= EVERY_MS;
  } catch {
    return true; // never ran
  }
}

export interface Pending {
  agent: 'claude-code' | 'codex';
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  modified: number;
}

// Claude Code: top-level <project>/<session>.jsonl files only; subagent transcripts sit in folders below
// them. Codex: sessions/<yyyy>/<mm>/<dd>/rollout-…-<session>.jsonl.
// `include` names a session to treat as quiet however recently it was written: the one whose hook
// noticed it had been idle, since its new prompt may already be in the file.
export function findPending(store: Store, opts: { root?: string; codexRoot?: string; now?: number; include?: string } = {}): Pending[] {
  const now = opts.now ?? Date.now();
  const found: Pending[] = [];
  const consider = (agent: Pending['agent'], transcriptPath: string, sessionId: string) => {
    const modified = statSync(transcriptPath).mtimeMs;
    if (now - modified > MAX_AGE_MS) return;
    if (now - modified < IDLE_MS && sessionId !== opts.include) return;
    if (readConversation(transcriptPath).length <= store.readCaptured(sessionId)) return;
    const cwd = transcriptCwd(transcriptPath);
    if (cwd && !isTemp(cwd)) found.push({ agent, sessionId, transcriptPath, cwd, modified });
  };
  const root = opts.root ?? claudeProjectsDir();
  if (existsSync(root)) {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const file of readdirSync(join(root, project.name))) {
        if (file.endsWith('.jsonl')) consider('claude-code', join(root, project.name, file), file.slice(0, -'.jsonl'.length));
      }
    }
  }
  const codexRoot = opts.codexRoot ?? codexSessionsDir();
  for (const day of recentDays(codexRoot, now)) {
    for (const file of readdirSync(day)) {
      const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1];
      if (id) consider('codex', join(day, file), id);
    }
  }
  return found.sort((a, b) => b.modified - a.modified);
}

// The <yyyy>/<mm>/<dd> folders of the last week, so old years aren't walked on every run.
function recentDays(root: string, now: number): string[] {
  const days: string[] = [];
  for (let t = now - MAX_AGE_MS; t <= now + 24 * 60 * 60_000; t += 24 * 60 * 60_000) {
    const d = new Date(t);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (existsSync(dir) && !days.includes(dir)) days.push(dir);
  }
  return days;
}

// Claude Code puts cwd on each entry; Codex in the session_meta payload at the top.
function transcriptCwd(path: string): string | undefined {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const e = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = e.cwd ?? e.payload?.cwd;
      if (typeof cwd === 'string') return cwd;
    } catch {
      // a partly written last line
    }
  }
  return undefined;
}

export interface CatchUpResult {
  sessions: number; // summarized
  saved: Note[];
  failed: number;
}

export async function catchUp(
  store: Store,
  config: Config,
  summarize: Summarize,
  opts: { root?: string; codexRoot?: string; now?: number; include?: string } = {},
): Promise<CatchUpResult | null> {
  const lock = join(store.home, 'state', 'catch-up.lock');
  mkdirSync(join(store.home, 'state'), { recursive: true });
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return null;
  writeFileSync(lock, String(process.pid));
  writeFileSync(stateFile(store.home), JSON.stringify({ at: opts.now ?? Date.now() }));
  const result: CatchUpResult = { sessions: 0, saved: [], failed: 0 };
  try {
    for (const p of findPending(store, opts)) {
      if (result.sessions >= MAX_SUMMARIES) break;
      const base = { session: p.sessionId, agent: p.agent, cwd: p.cwd, via: 'catch-up' };
      try {
        const r = await capture({ sessionId: p.sessionId, transcriptPath: p.transcriptPath, cwd: p.cwd, agent: p.agent }, store, config, summarize);
        // Too short asks nothing of the model; it is looked at again once the session grows.
        if (r.reason === TOO_SHORT) continue;
        result.sessions++;
        result.saved.push(...r.saved);
        store.log({ event: 'captured', ...base, saved: r.saved.map((n) => n.id), skipped: r.skipped, ...(r.reason ? { reason: r.reason } : {}) });
      } catch (err) {
        result.sessions++;
        result.failed++;
        store.log({ event: 'capture-failed', ...base, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    rmSync(lock, { force: true });
  }
  return result;
}
