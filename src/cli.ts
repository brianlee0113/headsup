#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { agentName } from './agents.js';
import { capture, CAPTURING_ENV, claudeSummarizer } from './capture.js';
import { headsupHome, loadConfig } from './config.js';
import { handleUserPromptSubmit, type UserPromptSubmitInput } from './hooks/claude-code.js';
import { claudeSettingsPath, uninstallClaudeHook } from './install.js';
import { browserHostDirs, encode, EXTENSION_ID, installNativeHost, readMessage, uninstallNativeHost } from './native.js';
import { handleWeb, type WebRequest } from './web.js';
import type { NoteType } from './note.js';
import { NoteIndex } from './search.js';
import { importChatGPT } from './import/flow.js';
import { runReview } from './review/tui.js';
import { runSetup } from './setup.js';
import { Store } from './store.js';

// src/cli.ts and dist/cli.js both sit one level below package.json.
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const HELP = `headsup — gives your AI a heads-up before it answers

  headsup setup                 connect Claude Code and choose what may be shared
  headsup connect-browser       let the Chrome extension reach headsup on this computer
  headsup uninstall             remove the Claude Code hook and browser connection (your notes stay)
  headsup review                see what was shared where, and fix or delete notes
  headsup import chatgpt <export.zip> [--since YYYY-MM-DD] [--limit N] [--space <space>] [--yes]
                                turn your ChatGPT history into notes (default: the last 12 months)
  headsup add <text> --type how|fact --space <space> --source <agent> [--topics a,b]
  headsup list
  headsup search <query>
  headsup log
  headsup capture --session <id> --transcript <path> --cwd <dir>
                                save notes from a Claude Code session (SessionEnd runs this)
  headsup hook claude-code      (reads a UserPromptSubmit or SessionEnd payload on stdin)

Memory lives in ${headsupHome()}`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// In a terminal, readline edits the line in place, which lets an answer start pre-typed. Piped
// input is buffered instead, so answers sent ahead of their question aren't dropped; EOF answers ''.
function lineReader() {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    return {
      ask(question: string, prefill = ''): Promise<string> {
        const answer = new Promise<string>((resolve) => rl.question(question, resolve));
        if (prefill) rl.write(prefill);
        return answer;
      },
      close: () => rl.close(),
    };
  }
  const rl = createInterface({ input: process.stdin });
  const buffered: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let closed = false;
  rl.on('line', (line) => (waiting.length ? waiting.shift()!(line) : buffered.push(line)));
  rl.on('close', () => {
    closed = true;
    for (const resolve of waiting.splice(0)) resolve('');
  });
  return {
    ask(question: string): Promise<string> {
      process.stdout.write(question + '\n');
      if (buffered.length) return Promise.resolve(buffered.shift()!);
      return closed ? Promise.resolve('') : new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: 'string', default: 'fact' },
      space: { type: 'string' },
      source: { type: 'string', default: 'manual' },
      topics: { type: 'string' },
      session: { type: 'string' },
      transcript: { type: 'string' },
      cwd: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  const store = new Store(headsupHome());
  const config = loadConfig();

  switch (command) {
    case 'setup': {
      const lines = lineReader();
      try {
        await runSetup(
          { ask: lines.ask, print: (l = '') => console.log(l), color: !!process.stdout.isTTY && !process.env.NO_COLOR },
          { home: headsupHome(), version: VERSION, isolated: !!process.env.HEADSUP_HOME },
        );
      } finally {
        lines.close();
      }
      return 0;
    }
    case 'review':
      await runReview(store, config, headsupHome());
      return 0;
    case 'import': {
      if (rest[0] !== 'chatgpt' || !rest[1]) throw new Error('usage: headsup import chatgpt <export.zip>');
      const since = values.since ? new Date(values.since) : undefined;
      if (since && Number.isNaN(since.getTime())) throw new Error('--since should look like 2025-06-01');
      const lines = lineReader();
      const tty = !!process.stdout.isTTY;
      let midLine = false; // a progress line is showing and needs ending before the next print
      try {
        await importChatGPT(
          {
            ask: lines.ask,
            print: (l = '') => {
              if (midLine) process.stdout.write('\n');
              midLine = false;
              console.log(l);
            },
            // In a terminal the progress line rewrites itself; piped output gets a line per batch.
            progress: (l) => (tty ? ((midLine = true), process.stdout.write(`\r\x1b[2K${l}`)) : console.log(l)),
            color: tty && !process.env.NO_COLOR,
          },
          store,
          {
            path: rest[1],
            space: values.space ?? config.defaultSpace,
            ...(since ? { since } : {}),
            ...(values.limit ? { limit: Number(values.limit) } : {}),
            yes: !!values.yes,
          },
        );
        if (midLine) process.stdout.write('\n');
      } finally {
        lines.close();
      }
      return 0;
    }
    case 'native-host': {
      // Started by the browser. Every outcome, errors included, goes back as one framed reply.
      let reply: unknown;
      try {
        reply = handleWeb((await readMessage(process.stdin)) as WebRequest, store, config, VERSION);
      } catch (err) {
        reply = { type: 'error', message: err instanceof Error ? err.message : String(err) };
      }
      process.stdout.write(encode(reply));
      return 0;
    }
    case 'connect-browser': {
      const dirs = browserHostDirs();
      if (!dirs.length) throw new Error('no Chrome-family browser found (Chrome, Brave, Edge, Arc, Chromium)');
      const r = installNativeHost(headsupHome(), dirs);
      console.log(`connected ${r.manifests.length} browser${r.manifests.length === 1 ? '' : 's'} (extension ${EXTENSION_ID})`);
      for (const m of r.manifests) console.log(`  ${m}`);
      return 0;
    }
    case 'uninstall':
      console.log(uninstallClaudeHook() ? `removed the headsup hook from ${claudeSettingsPath()}` : 'no headsup hook found');
      console.log(`removed the browser connection from ${uninstallNativeHost()} browser(s)`);
      console.log(`notes are still in ${headsupHome()} — delete that folder to remove them too`);
      return 0;
    case 'add': {
      const type = values.type as NoteType;
      if (type !== 'how' && type !== 'fact') throw new Error('--type must be "how" or "fact"');
      const result = store.add({
        type,
        space: values.space ?? config.defaultSpace,
        source: values.source!,
        body: rest.join(' '),
        topics: values.topics?.split(',').map((t) => t.trim()).filter(Boolean),
      });
      if (result.dropped.length) console.log(`dropped ${result.dropped.join(', ')} — never written to disk`);
      console.log(result.note ? `saved ${result.note.id}` : 'nothing left to save');
      return 0;
    }
    case 'list':
      for (const n of store.list()) {
        console.log(`${n.id}  ${n.space.padEnd(9)} ${n.type.padEnd(5)} ${agentName(n.source).padEnd(12)} ${n.body}`);
      }
      return 0;
    case 'search':
      for (const h of new NoteIndex(store.list()).search(rest.join(' '), 10)) {
        console.log(`${h.score.toFixed(2).padStart(6)}  ${h.note.space.padEnd(9)} ${h.note.body}`);
      }
      return 0;
    case 'log':
      for (const e of store.readLog().slice(-20)) console.log(JSON.stringify(e));
      return 0;
    case 'hook': {
      if (rest[0] !== 'claude-code') throw new Error(`unknown hook target "${rest[0] ?? ''}"`);
      const input = JSON.parse(await readStdin()) as UserPromptSubmitInput & { hook_event_name?: string };
      // The summarizer's own `claude -p` session must not inject or capture.
      if (process.env[CAPTURING_ENV]) return 0;
      if (input.hook_event_name === 'SessionEnd') {
        // SessionEnd allows ~1.5s; summarizing takes longer, so it runs on after this process exits.
        if (input.transcript_path) {
          const args = ['capture', '--session', input.session_id, '--transcript', input.transcript_path, '--cwd', input.cwd];
          spawn(process.execPath, [process.argv[1]!, ...args], { detached: true, stdio: 'ignore' }).unref();
        }
        return 0;
      }
      const out = handleUserPromptSubmit(input, store, config);
      if (out) process.stdout.write(JSON.stringify(out));
      return 0;
    }
    case 'capture': {
      if (!values.session || !values.transcript || !values.cwd) throw new Error('capture needs --session, --transcript and --cwd');
      const base = { session: values.session, cwd: values.cwd };
      try {
        const r = await capture(
          { sessionId: values.session, transcriptPath: values.transcript, cwd: values.cwd, agent: 'claude-code' },
          store,
          config,
          claudeSummarizer(),
        );
        store.log({ event: 'captured', ...base, saved: r.saved.map((n) => n.id), skipped: r.skipped, ...(r.reason ? { reason: r.reason } : {}) });
        console.log(r.reason ?? `saved ${r.saved.length} notes, skipped ${r.skipped}`);
        for (const n of r.saved) console.log(`  ${n.id}  ${n.type.padEnd(4)} ${n.body}`);
      } catch (err) {
        store.log({ event: 'capture-failed', ...base, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      return 0;
    }
    default:
      console.log(HELP);
      return command && !values.help ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // A failing hook must never block the user's prompt: report on stderr and exit non-blocking.
    console.error(`headsup: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
