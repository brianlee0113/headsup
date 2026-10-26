// Account sync: while a chatgpt.com or claude.ai tab is open, the extension reads the chats that
// changed since it last looked and hands them over here. They wait in a queue on disk and a
// separate `headsup sync-run` turns them into notes, since summarizing takes longer than a native
// message may. Nothing polls in the background: chats come in when the person opens the site.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNotes, reviewNotes, saveNotes, type Summarize } from './capture.js';
import type { Config } from './config.js';
import { buildImportPrompt, parseChatGPTChat, planImport, type Chat, type ExportChat } from './import/chatgpt.js';
import { redactSecrets } from './secrets.js';
import type { Store } from './store.js';

export const SYNC_AGENTS: Record<string, { agent: string; label: string }> = {
  'chatgpt.com': { agent: 'chatgpt', label: 'ChatGPT' },
  'claude.ai': { agent: 'claude-ai', label: 'Claude' },
};

const BACKFILL_MONTHS = 12;
const MIN_NEW_USER_CHARS = 80; // what a chat added since last time has to say before it is worth reading
const CONTEXT_TURNS = 4; // earlier turns that go along with the new ones, so they read in context
const NOTES_PER_BATCH = 6;
const LOCK_STALE_MS = 15 * 60_000;

interface SyncState {
  since: string; // chats last changed before this are not read (consent time, or 12 months back)
  lastCaught?: string; // the last time the extension finished catching up
  chats: Record<string, { updated: string; turns: number }>; // turns: how many were already summarized
}

interface Queued {
  agent: string;
  chat: { id: string; title: string; updated: string; turns: Chat['turns'] };
}

export type SyncRequest =
  | { type: 'sync-start'; site: string; backfill: boolean }
  | { type: 'sync-chats'; site: string; chats: unknown[]; done?: boolean };

const dir = (home: string) => join(home, 'sync');
const queueDir = (home: string) => join(dir(home), 'queue');
const stateFile = (home: string, agent: string) => join(dir(home), `${agent}.json`);
const safe = (s: string) => s.replace(/[^\w-]/g, '_');

export function readState(home: string, agent: string): SyncState | null {
  try {
    return JSON.parse(readFileSync(stateFile(home, agent), 'utf8')) as SyncState;
  } catch {
    return null;
  }
}

function writeState(home: string, agent: string, state: SyncState): void {
  mkdirSync(dir(home), { recursive: true });
  writeFileSync(stateFile(home, agent), JSON.stringify(state));
}

// claude.ai's conversation endpoint: chat_messages with a sender and text (or text blocks).
interface ClaudeChat {
  uuid?: string;
  name?: string;
  updated_at?: string;
  chat_messages?: Array<{ sender?: string; text?: string; content?: Array<{ type?: string; text?: string }> }>;
}

export function parseClaudeChat(c: ClaudeChat): Chat {
  if (!c.uuid || !Array.isArray(c.chat_messages)) throw new Error('claude.ai chat without uuid or chat_messages');
  const turns: Chat['turns'] = [];
  for (const m of c.chat_messages) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const blocks = (m.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text!);
    const text = (blocks.length ? blocks.join('\n') : (m.text ?? '')).trim();
    if (text) turns.push({ role, text });
  }
  return { id: c.uuid, title: c.name ?? '', updated: new Date(c.updated_at ?? 0), turns };
}

function parseChat(agent: string, raw: unknown): Chat {
  if (!raw || typeof raw !== 'object') throw new Error('chat is not an object');
  if (agent === 'claude-ai') return parseClaudeChat(raw as ClaudeChat);
  const c = raw as ExportChat;
  if (!c.mapping || !c.current_node) throw new Error('ChatGPT chat without mapping or current_node');
  return parseChatGPTChat(c);
}

export function handleSync(req: SyncRequest, store: Store, opts: { now?: Date; startRunner?: () => void } = {}): unknown {
  const target = SYNC_AGENTS[req.site];
  if (!target) return { type: 'error', message: `headsup doesn't sync ${req.site}` };
  const now = opts.now ?? new Date();
  const home = store.home;

  if (req.type === 'sync-start') {
    let state = readState(home, target.agent);
    if (!state) {
      const since = new Date(now);
      if (req.backfill) since.setMonth(since.getMonth() - BACKFILL_MONTHS);
      state = { since: since.toISOString(), chats: {} };
      writeState(home, target.agent, state);
    }
    const seen = Object.fromEntries(Object.entries(state.chats).map(([id, c]) => [id, c.updated]));
    return { type: 'sync-start', since: state.since, seen };
  }

  const state = readState(home, target.agent);
  if (!state) return { type: 'error', message: 'sync-start comes first' };
  mkdirSync(queueDir(home), { recursive: true });
  let queued = 0;
  for (const raw of req.chats) {
    const chat = parseChat(target.agent, raw); // a shape we don't know fails the whole request, so the extension can say so
    if (chat.updated < new Date(state.since)) continue;
    // The queue is on disk until summarized (longer if summarizing fails), so secrets come out first.
    const turns = chat.turns.map((t) => ({ ...t, text: redactSecrets(t.text).text }));
    const entry: Queued = { agent: target.agent, chat: { ...chat, title: redactSecrets(chat.title).text, turns, updated: chat.updated.toISOString() } };
    writeFileSync(join(queueDir(home), `${target.agent}-${safe(chat.id)}.json`), JSON.stringify(entry));
    state.chats[chat.id] = { updated: entry.chat.updated, turns: state.chats[chat.id]?.turns ?? 0 };
    queued++;
  }
  if (req.done) state.lastCaught = now.toISOString();
  writeState(home, target.agent, state);
  // Also at the end of a catch-up, in case a runner was finishing just as the last chats arrived.
  const waiting = queued || (req.done && readdirSync(queueDir(home)).length > 0);
  if (waiting) (opts.startRunner ?? startRunner)();
  return { type: 'sync-chats', queued };
}

// What the popup shows under KEEP IN SYNC.
export function syncStatus(store: Store, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const queue = existsSync(queueDir(store.home)) ? readdirSync(queueDir(store.home)) : [];
  const log = store.readLog().filter((e) => e.event === 'synced' && String(e.at).startsWith(today));
  return Object.fromEntries(
    Object.entries(SYNC_AGENTS).map(([site, { agent }]) => {
      const state = readState(store.home, agent);
      return [site, state && {
        since: state.since,
        lastCaught: state.lastCaught ?? null,
        queued: queue.filter((f) => f.startsWith(`${agent}-`)).length,
        notesToday: log.filter((e) => e.agent === agent).reduce((n, e) => n + ((e.saved as string[] | undefined)?.length ?? 0), 0),
      }];
    }),
  );
}

// The native host must answer right away, so summarizing runs in its own process.
function startRunner(): void {
  spawn(process.execPath, [process.argv[1]!, 'sync-run'], { detached: true, stdio: 'ignore' }).unref();
}

// One runner at a time; a lock left by a crash expires.
function takeLock(home: string): (() => void) | null {
  const lock = join(dir(home), 'run.lock');
  mkdirSync(dir(home), { recursive: true });
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return null;
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

export interface SyncRunResult {
  chats: number;
  saved: number;
  failed: number;
}

export async function runSync(store: Store, config: Config, summarize: Summarize, opts: { concurrency?: number } = {}): Promise<SyncRunResult | null> {
  const release = takeLock(store.home);
  if (!release) return null; // another runner is on it and will pick up what was just queued
  const total: SyncRunResult = { chats: 0, saved: 0, failed: 0 };
  try {
    // Chats can arrive while this runs; keep going until a pass finds the queue empty or only failures.
    for (;;) {
      const r = await runPass(store, config, summarize, opts.concurrency ?? 2);
      total.chats += r.chats;
      total.saved += r.saved;
      total.failed += r.failed;
      if (!r.chats || r.failed) break;
    }
  } finally {
    release();
  }
  return total;
}

async function runPass(store: Store, config: Config, summarize: Summarize, concurrency: number): Promise<SyncRunResult> {
  const home = store.home;
  const files = existsSync(queueDir(home)) ? readdirSync(queueDir(home)).filter((f) => f.endsWith('.json')) : [];
  const result: SyncRunResult = { chats: files.length, saved: 0, failed: 0 };
  const byAgent = new Map<string, Array<{ file: string; text: string; entry: Queued }>>();
  for (const f of files) {
    const path = join(queueDir(home), f);
    try {
      const text = readFileSync(path, 'utf8');
      const entry = JSON.parse(text) as Queued;
      byAgent.set(entry.agent, [...(byAgent.get(entry.agent) ?? []), { file: path, text, entry }]);
    } catch {
      rmSync(path, { force: true });
    }
  }

  for (const [agent, items] of byAgent) {
    const label = Object.values(SYNC_AGENTS).find((a) => a.agent === agent)?.label ?? agent;
    const state = readState(home, agent);
    if (!state) continue;
    // Only what changed since the last summary, with a few turns before it for context.
    const work = items.map(({ file, text, entry }) => {
      const turns = entry.chat.turns;
      const done = Math.min(state.chats[entry.chat.id]?.turns ?? 0, turns.length);
      const fresh = turns.slice(done).filter((t) => t.role === 'user').reduce((n, t) => n + t.text.length, 0);
      const chat: Chat = { id: entry.chat.id, title: entry.chat.title, updated: new Date(entry.chat.updated), turns: turns.slice(Math.max(0, done - CONTEXT_TURNS)) };
      return { file, text, chat, total: turns.length, worth: fresh >= MIN_NEW_USER_CHARS };
    });
    const finish = (w: (typeof work)[number]) => {
      const latest = readState(home, agent) ?? state;
      latest.chats[w.chat.id] = { updated: latest.chats[w.chat.id]?.updated ?? w.chat.updated.toISOString(), turns: w.total };
      writeState(home, agent, latest);
      // Re-queued with newer turns while this ran: leave the newer copy for the next pass.
      if (existsSync(w.file) && readFileSync(w.file, 'utf8') === w.text) rmSync(w.file);
    };
    for (const w of work.filter((w) => !w.worth)) finish(w);

    const worth = work.filter((w) => w.worth);
    const plan = planImport(worth.map((w) => w.chat), { since: new Date(0), done: new Set() });
    const inBatches = new Set(plan.batches.flat().map((c) => c.id));
    for (const w of worth.filter((w) => !inBatches.has(w.chat.id))) finish(w);

    let next = 0;
    const worker = async () => {
      while (next < plan.batches.length) {
        const batch = plan.batches[next++]!;
        try {
          const existing = store.list().filter((n) => n.space === config.defaultSpace);
          const reply = await summarize(buildImportPrompt(batch, existing, label));
          if (!reply.includes('[')) throw new Error('no JSON in reply');
          const r = saveNotes(await reviewNotes(parseNotes(reply, NOTES_PER_BATCH), existing, summarize), existing, store, { space: config.defaultSpace, source: agent });
          result.saved += r.saved.length;
          for (const c of batch) finish(worth.find((w) => w.chat.id === c.id)!);
          store.log({ event: 'synced', agent, chats: batch.map((c) => c.id), saved: r.saved.map((n) => n.id), skipped: r.skipped });
        } catch (err) {
          result.failed++; // left in the queue; the next run tries again
          store.log({ event: 'sync-failed', agent, chats: batch.map((c) => c.id), error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, plan.batches.length) }, worker));
  }
  return result;
}
