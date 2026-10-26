#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { agentName } from './agents.js';
import { capture, CAPTURING_ENV, claudeSummarizer } from './capture.js';
import { catchUp, catchUpDue, claudeProjectsDir, IDLE_MS } from './catchup.js';
import { buildCard, type CardData } from './card.js';
import { cardPage } from './card-page.js';
import { headsupHome, loadConfig, saveConfig } from './config.js';
import { learningOn, readBook, resting } from './learning.js';
import { handleUserPromptSubmit, type UserPromptSubmitInput } from './hooks/claude-code.js';
import { hooksPath, uninstallHook } from './install.js';
import { recheckSpaces, startRecheck } from './spaces.js';
import { browserHostDirs, encode, EXTENSION_ID, installNativeHost, readMessage, uninstallNativeHost } from './native.js';
import { handleWeb, type WebRequest } from './web.js';
import type { NoteType } from './note.js';
import { NoteIndex } from './search.js';
import { importChatGPT } from './import/flow.js';
import { runReview } from './review/tui.js';
import { runSetup } from './setup.js';
import { Store } from './store.js';
import { runSync } from './sync.js';
import { tidy, tidyDue } from './tidy.js';

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
  headsup sync-run              turn chats the extension read from your accounts into notes (runs on its own)
  headsup card                  make a card to share: which AI you use for what (opens in your browser)
  headsup recheck-spaces        move notes from web chats that are about your job into work (runs on its own once)
  headsup tidy                  merge notes that say the same thing, set aside ones a newer note replaced (runs on its own)
  headsup learning [on|off|reset]
                                see which notes are resting because you took them out or answers ignored them
  headsup capture --session <id> --transcript <path> --cwd <dir> [--agent codex]
                                save notes from a Claude Code or Codex session (SessionEnd runs this)
  headsup catch-up              save notes from Claude Code and Codex sessions that went quiet or never
                                ended, like tmux panes and reboots (runs on its own)
  headsup hook claude-code|codex
                                (reads a UserPromptSubmit or SessionEnd payload on stdin)

Memory lives in ${headsupHome()}`;

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
};

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
      agent: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
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
        startRecheck(store, config);
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
      for (const target of ['claude-code', 'codex'] as const) {
        if (uninstallHook(target)) console.log(`removed the headsup hook from ${hooksPath(target)}`);
      }
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
      const agent = rest[0];
      if (agent !== 'claude-code' && agent !== 'codex') throw new Error(`unknown hook target "${agent ?? ''}"`);
      const input = JSON.parse(await readStdin()) as UserPromptSubmitInput & { hook_event_name?: string };
      // The summarizer's own `claude -p` session must not inject or capture.
      if (process.env[CAPTURING_ENV]) return 0;
      if (input.hook_event_name === 'SessionEnd') {
        // SessionEnd allows ~1.5s; summarizing takes longer, so it runs on after this process exits.
        if (input.transcript_path) {
          const args = ['capture', '--session', input.session_id, '--transcript', input.transcript_path, '--cwd', input.cwd, '--agent', agent];
          spawn(process.execPath, [process.argv[1]!, ...args], { detached: true, stdio: 'ignore' }).unref();
        }
        return 0;
      }
      // A session idle this long is captured now; its new prompt may already be in the file, so
      // catch-up is told rather than left to judge by the file's time.
      const idle = !!input.transcript_path && Date.now() - mtime(input.transcript_path) >= IDLE_MS;
      if (idle || catchUpDue(store)) {
        const args = ['catch-up', ...(idle ? ['--session', input.session_id] : [])];
        spawn(process.execPath, [process.argv[1]!, ...args], { detached: true, stdio: 'ignore' }).unref();
      }
      startRecheck(store, config);
      const out = handleUserPromptSubmit(input, store, config, agent);
      if (out) process.stdout.write(JSON.stringify(out));
      return 0;
    }
    case 'capture': {
      if (!values.session || !values.transcript || !values.cwd) throw new Error('capture needs --session, --transcript and --cwd');
      const base = { session: values.session, cwd: values.cwd };
      try {
        const r = await capture(
          { sessionId: values.session, transcriptPath: values.transcript, cwd: values.cwd, agent: values.agent === 'codex' ? 'codex' : 'claude-code' },
          store,
          config,
          claudeSummarizer(),
        );
        store.log({ event: 'captured', ...base, saved: r.saved.map((n) => n.id), skipped: r.skipped, ...(r.reason ? { reason: r.reason } : {}) });
        console.log(r.reason ?? `saved ${r.saved.length} notes, skipped ${r.skipped}`);
        for (const n of r.saved) console.log(`  ${n.id}  ${n.type.padEnd(4)} ${n.body}`);
        if (r.saved.length && tidyDue(store)) await tidy(store, claudeSummarizer());
      } catch (err) {
        store.log({ event: 'capture-failed', ...base, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      return 0;
    }
    case 'catch-up': {
      const r = await catchUp(store, config, claudeSummarizer(), { include: values.session });
      if (r?.saved.length && tidyDue(store)) await tidy(store, claudeSummarizer());
      if (!r) console.log('a catch-up is already running');
      else console.log(`looked in ${claudeProjectsDir()} · summarized ${r.sessions} sessions · ${r.saved.length} notes${r.failed ? ` · ${r.failed} failed` : ''}`);
      for (const n of r?.saved ?? []) console.log(`  ${n.id}  ${n.type.padEnd(4)} ${n.body}`);
      return 0;
    }
    case 'card': {
      // A page on this computer only; it stops on its own after a while.
      const name = (() => {
        try {
          return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim().split(/\s+/)[0] ?? '';
        } catch {
          return '';
        }
      })();
      let card: Promise<CardData> | undefined;
      const server = createServer((req, res) => {
        if (req.url === '/data') {
          card ??= buildCard(store, config, claudeSummarizer());
          card.then(
            (d) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d)),
            (err: unknown) => res.writeHead(500).end(err instanceof Error ? err.message : String(err)),
          );
          return;
        }
        const fontFile = /^\/fonts\/([a-z-]+\.woff2)$/.exec(req.url ?? '')?.[1];
        if (fontFile) {
          // Both src/ and dist/ sit next to assets/.
          try {
            const body = readFileSync(new URL(`../assets/fonts/${fontFile}`, import.meta.url));
            res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=3600' }).end(body);
          } catch {
            res.writeHead(404).end();
          }
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(cardPage(name));
      });
      await new Promise<void>((r) => server.listen(Number(values.port ?? 0), '127.0.0.1', r));
      const url = `http://localhost:${(server.address() as { port: number }).port}/`;
      setTimeout(() => process.exit(0), 20 * 60_000).unref();
      if (!values['no-open']) spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
      console.log(`Your card is at ${url} (this page stops in 20 minutes; Ctrl-C to stop now)`);
      await new Promise(() => {}); // keep serving
      return 0;
    }
    case 'learning': {
      // Learning only rests notes for a while; it never deletes them or touches sharing rules.
      const arg = positionals[1];
      if (arg === 'on' || arg === 'off') {
        saveConfig({ ...config, learning: arg === 'on' });
        console.log(`learning is ${arg}`);
        return 0;
      }
      if (arg === 'reset') {
        mkdirSync(join(store.home, 'state'), { recursive: true });
        writeFileSync(join(store.home, 'state', 'learning.json'), '{}');
        console.log('learning reset: every note starts fresh');
        return 0;
      }
      const book = readBook(store.home);
      const rest = resting(store.home);
      const byId = new Map(store.list().map((n) => [n.id, n]));
      console.log(`learning is ${learningOn(config) ? 'on' : 'off'} · ${Object.keys(book).length} notes with evidence · ${rest.size} resting`);
      for (const [id, e] of rest) {
        const why = e.reason === 'removed' ? `taken out ${e.removed}×` : `answers drew on it ${e.used} of ${e.used + e.ignored}×`;
        console.log(`  ${id}  until ${e.restUntil!.slice(0, 10)}  ${why}  ${byId.get(id)?.body.slice(0, 80) ?? ''}`);
      }
      return 0;
    }
    case 'tidy': {
      // Normally runs on its own after new notes come in; this runs a pass now.
      const r = await tidy(store, claudeSummarizer());
      console.log(r ? `merged ${r.merged} notes · took out ${r.dropped} · moved to ${store.home}/archive${r.failed ? ` · ${r.failed} spaces failed` : ''}` : 'a tidy pass is already running');
      return 0;
    }
    case 'recheck-spaces': {
      // Normally runs once on its own when synced chats come in.
      const r = await recheckSpaces(store, config, claudeSummarizer());
      console.log(`looked at ${r.checked} notes from web chats · moved ${r.moved.length} to work${r.failed ? ` · ${r.failed} batches failed, try again` : ''}`);
      for (const n of r.moved) console.log(`  ${n.id}  ${n.body}`);
      return 0;
    }
    case 'sync-run': {
      // Started by the native host when the extension hands over chats; quiet unless run by hand.
      const r = await runSync(store, config, claudeSummarizer());
      if (r?.saved && tidyDue(store)) await tidy(store, claudeSummarizer());
      console.log(r ? `read ${r.chats} chats · ${r.saved} notes${r.failed ? ` · ${r.failed} batches failed, queued for next time` : ''}` : 'another sync is already running');
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
