// The interactive side of importing: say what will be sent where, ask, then show progress.
// Used by `headsup import chatgpt` and by step 5 of setup.

import { claudeSummarizer, type Summarize } from '../capture.js';
import type { Store } from '../store.js';
import { parseExport, planImport, readExport, runImport } from './chatgpt.js';

export interface ImportIO {
  ask(question: string): Promise<string>;
  print(line?: string): void;
  progress(line: string): void; // overwrites itself in a terminal
  color: boolean;
}

export interface ImportOptions {
  path: string;
  space: string;
  since?: Date; // default: one year back
  limit?: number;
  yes?: boolean; // skip the confirmation
  summarize?: Summarize; // tests pass a fake
  now?: Date;
}

const SECONDS_PER_BATCH = 8;
const CONCURRENCY = 3;

export async function importChatGPT(io: ImportIO, store: Store, opts: ImportOptions): Promise<number> {
  const on = io.color;
  const c = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  const [dim, green, orange] = [c('2'), c('32'), c('38;5;214')];

  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const chats = parseExport(readExport(opts.path));
  const plan = planImport(chats, { since, done: new Set(store.readImported('chatgpt')), limit: opts.limit });
  const day = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;

  io.print(`${orange('◆ headsup import')} · ChatGPT`);
  io.print(`  ${plan.total} chats in the export · ${plan.inRange} since ${day} · ${plan.todo.length} to read ${dim('(long enough, not imported before)')}`);
  if (!plan.todo.length) {
    io.print(dim('  Nothing new to import. Use --since to reach further back.'));
    return 0;
  }
  const minutes = Math.max(1, Math.round((Math.ceil(plan.batches.length / CONCURRENCY) * SECONDS_PER_BATCH) / 60));
  io.print(`  They go to Claude in ${plan.batches.length} batch${plan.batches.length === 1 ? '' : 'es'} through your own \`claude\` login (haiku) to pick out notes.`);
  io.print(dim('  Health, relationships, money, legal matters, religion and politics are left out; secrets are never stored.'));
  io.print(dim(`  Notes land in the ${opts.space} space. About ${minutes} min; you can stop and rerun, finished chats are skipped.`));
  if (!opts.yes && !/^(y|yes|응|네|예)/i.test((await io.ask('  Continue? [y/N] ')).trim())) {
    io.print(dim('  Nothing was sent.'));
    return 0;
  }

  let cost = 0;
  const summarize = opts.summarize ?? claudeSummarizer('haiku', (usd) => (cost += usd));
  const result = await runImport(plan, store, {
    space: opts.space,
    summarize,
    concurrency: CONCURRENCY,
    onProgress: (p) => io.progress(`  ▸ ${p.batch}/${p.batches} batches · ${p.saved.length} notes`),
  });

  io.print(
    `  ${green('✓')} Saved ${result.saved.length} notes from ChatGPT` +
      `${result.skipped ? dim(` (skipped ${result.skipped} duplicates)`) : ''}${cost ? dim(` · cost ${cost < 0.01 ? 'under $0.01' : `$${cost.toFixed(2)}`}`) : ''}.`,
  );
  if (result.failed) io.print(orange(`  ${result.failed} batches failed; run the same command again to retry them.`));
  for (const n of result.saved.slice(0, 5)) io.print(dim(`    ${n.type.padEnd(4)} ${n.body}`));
  if (result.saved.length > 5) io.print(dim(`    … and ${result.saved.length - 5} more`));
  io.print(dim('  Check or delete them anytime: headsup review → Notes'));
  return result.saved.length;
}
