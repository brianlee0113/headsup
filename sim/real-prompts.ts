// Every real prompt headsup has seen on this computer, in the order it was typed: the ones it stepped in
// on (from its own log) and the ones it let through (from Claude Code's transcripts, since quiet turns
// aren't logged). Read-only; used by sim/replay-real.ts.
//
// Keys match sim/label-real.ts: a log entry's `at`, or `quiet:<transcript timestamp>`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LoggedDecision {
  injected: string[];
  asked: string[];
  blocked: string[];
  skippedKnown: string[];
}

export interface RealPrompt {
  key: string;
  at: string; // when it was typed (transcript time when known, else the log's)
  agent: string;
  session: string;
  cwd?: string; // none on the web
  prompt: string; // the full text when the transcript has it, else the log's first 200 characters
  logged?: LoggedDecision; // what headsup did at the time; absent when it stayed quiet and logged nothing
  before: string; // the conversation up to this prompt (its end), for "does the agent already have it"
  compacted: boolean; // the conversation was compacted since the previous prompt
  typed: boolean; // false for messages nobody typed (task notifications, hand-backs) that the old hook let through
}

interface LogEntry extends LoggedDecision {
  at: string;
  event: string;
  agent: string;
  session: string;
  cwd?: string;
  prompt?: string;
}

const KNOWN_TAIL = 256 * 1024;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

export function readHeadsUps(home: string): LogEntry[] {
  return readFileSync(join(home, 'log.jsonl'), 'utf8').split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l) as LogEntry];
    } catch {
      return [];
    }
  }).filter((e) => e.event === 'heads-up' && e.prompt);
}

function textOf(content: unknown): { text: string; toolResult: boolean } {
  if (typeof content === 'string') return { text: content, toolResult: false };
  if (!Array.isArray(content)) return { text: '', toolResult: false };
  const blocks = content as Array<{ type?: string; text?: unknown }>;
  return {
    text: blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n'),
    toolResult: blocks.some((b) => b?.type === 'tool_result'),
  };
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

export function collectRealPrompts(home: string, projectsRoot = join(homedir(), '.claude', 'projects')): RealPrompt[] {
  const log = readHeadsUps(home);
  const since = log[0]?.at ?? '';
  const bySession = new Map<string, LogEntry[]>();
  for (const e of log) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e]);
  const used = new Set<LogEntry>();
  const out: RealPrompt[] = [];

  if (existsSync(projectsRoot)) {
    for (const dir of readdirSync(projectsRoot)) {
      const d = join(projectsRoot, dir);
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.jsonl'))) {
        const session = f.slice(0, -6);
        const entries = bySession.get(session) ?? [];
        let before = '';
        let compacted = false;
        for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
          if (!line) continue;
          let e: { type?: string; subtype?: string; isMeta?: boolean; isSidechain?: boolean; timestamp?: string; cwd?: string; message?: { content?: unknown } };
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (line.includes('"compact_boundary"')) {
            compacted = true;
            before = '';
          }
          const { text, toolResult } = e.type === 'user' && !e.isMeta && !e.isSidechain ? textOf(e.message?.content) : { text: '', toolResult: true };
          const prompt = text.trim();
          const isPrompt = !toolResult && !!prompt && !!e.timestamp && e.timestamp >= since;
          if (isPrompt) {
            // The log entry for this prompt, when headsup stepped in: same session, same opening words,
            // written within seconds of the transcript line.
            const match = entries.find((x) => !used.has(x) && norm(x.prompt!) === norm(prompt.slice(0, 200)) && Math.abs(Date.parse(x.at) - Date.parse(e.timestamp!)) < 120_000)
              ?? entries.find((x) => !used.has(x) && norm(x.prompt!).slice(0, 40) === norm(prompt).slice(0, 40) && Math.abs(Date.parse(x.at) - Date.parse(e.timestamp!)) < 120_000);
            if (match) used.add(match);
            const generated = prompt.startsWith('<') || prompt.startsWith('/');
            // Quiet prompts follow label-real's sample rule: typed text only, at least four characters.
            if (match || (!generated && prompt.length >= 4)) {
              out.push({
                key: match ? match.at : `quiet:${e.timestamp}`,
                at: e.timestamp!,
                agent: match?.agent ?? 'claude-code',
                session,
                cwd: e.cwd ?? match?.cwd,
                prompt,
                ...(match ? { logged: { injected: match.injected ?? [], asked: match.asked ?? [], blocked: match.blocked ?? [], skippedKnown: match.skippedKnown ?? [] } } : {}),
                before: before.slice(-KNOWN_TAIL),
                compacted,
                typed: !generated,
              });
              compacted = false;
            }
          }
          const texts: string[] = [];
          collectText(e, texts);
          if (texts.length) before = (before + '\n' + texts.join('\n')).slice(-KNOWN_TAIL * 2);
        }
      }
    }
  }

  // Step-ins with no transcript on this computer (the web, Codex, sessions since deleted): replayed from
  // the log line alone, with its first 200 characters and no conversation.
  for (const e of log) {
    if (used.has(e)) continue;
    out.push({
      key: e.at, at: e.at, agent: e.agent, session: e.session, ...(e.cwd ? { cwd: e.cwd } : {}), prompt: e.prompt!,
      logged: { injected: e.injected ?? [], asked: e.asked ?? [], blocked: e.blocked ?? [], skippedKnown: e.skippedKnown ?? [] },
      before: '', compacted: false, typed: !e.prompt!.trimStart().startsWith('<'),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
