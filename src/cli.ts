#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { agentName } from './agents.js';
import { headsupHome, loadConfig } from './config.js';
import { handleUserPromptSubmit, type UserPromptSubmitInput } from './hooks/claude-code.js';
import type { NoteType } from './note.js';
import { NoteIndex } from './search.js';
import { Store } from './store.js';

const HELP = `headsup — gives your AI a heads-up before it answers

  headsup add <text> --type how|fact --space <space> --source <agent> [--topics a,b]
  headsup list
  headsup search <query>
  headsup log
  headsup hook claude-code      (reads the UserPromptSubmit payload on stdin)

Memory lives in ${headsupHome()}`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  const store = new Store(headsupHome());
  const config = loadConfig();

  switch (command) {
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
      const input = JSON.parse(await readStdin()) as UserPromptSubmitInput;
      const out = handleUserPromptSubmit(input, store, config);
      if (out) process.stdout.write(JSON.stringify(out));
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
