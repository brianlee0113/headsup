// `headsup setup`: the five steps from the Figma setup screen — agents, usage profile, spaces,
// sharing preset, existing memory — then the one change outside ~/.headsup, which it asks about.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { agentName } from './agents.js';
import type { Summarize } from './capture.js';
import { expandHome, loadConfig, saveConfig, type Config, type Preset } from './config.js';
import { importChatGPT } from './import/flow.js';
import { browserHostDirs, installNativeHost } from './native.js';
import { Store } from './store.js';
import { claudeSettingsPath, hookCommand, installClaudeHook } from './install.js';
import { parseUsage, TOPIC_ALIASES } from './usage.js';

// Shown under the question; a test keeps it parseable.
export const USAGE_EXAMPLE = 'Claude Code - coding, side projects · ChatGPT - writing, everyday';
export const SPACES_EXAMPLE = '~/work, ~/Developer/acme-api';

export interface SetupIO {
  ask(question: string, prefill?: string): Promise<string>; // prefill: editable starting text
  print(line?: string): void;
  color: boolean;
}

export interface SetupOptions {
  home: string; // headsup home
  settingsPath?: string; // Claude Code settings.json
  userHome?: string; // where agents are looked for
  command?: string; // hook command to register
  version: string;
  importSummarize?: Summarize; // tests replace the model
  browserDirs?: string[]; // where browsers look for native hosts; tests pass []
  isolated?: boolean; // HEADSUP_HOME is set: changes outside it default to no, so a trial run stays a trial
}

// Until the extension is in the Chrome Web Store, it is loaded from the checkout.
const EXTENSION_HINT = 'chrome://extensions → Developer mode → Load unpacked → extension/build';

// Paths dragged into a terminal arrive quoted or with escaped spaces.
function unquotePath(raw: string): string {
  const p = raw.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\ /g, ' ');
  return expandHome(p);
}

const paint = (on: boolean) => {
  const c = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: c('1'), dim: c('2'), green: c('32'), blue: c('34'), accent: c('38;5;205') };
};

// Phase 1 connects Claude Code only; the rest are listed so people see where headsup is going.
const AGENTS: Array<{ id: string; dir: string; via: string; ready: boolean }> = [
  { id: 'claude-code', dir: '.claude', via: 'hooks · UserPromptSubmit', ready: true },
  { id: 'codex', dir: '.codex', via: 'hooks', ready: false },
  { id: 'cursor', dir: '.cursor', via: 'MCP server', ready: false },
  { id: 'gemini-cli', dir: '.gemini', via: 'MCP server', ready: false },
];

const PRESETS: Array<{ id: Preset; rule: string }> = [
  { id: 'cautious', rule: 'how-you-work: ask  · facts: blocked' },
  { id: 'balanced', rule: 'how-you-work: auto · facts: ask    ' },
  { id: 'open', rule: 'how-you-work: auto · facts: auto   ' },
];

const yes = (answer: string, fallback: boolean) => (answer.trim() ? /^(y|yes|응|네|예)/i.test(answer.trim()) : fallback);
const tilde = (p: string) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p);

export async function runSetup(io: SetupIO, opts: SetupOptions): Promise<Config> {
  const c = paint(io.color);
  const config = loadConfig(opts.home);
  const settingsPath = opts.settingsPath ?? claudeSettingsPath();
  const userHome = opts.userHome ?? homedir();

  io.print(`${c.accent('⌃ headsup')} ${opts.version}  ${c.dim('gives your AI a heads-up before it answers')}`);
  io.print();

  io.print(`Step 1/5 ${c.bold('Agents found')}`);
  for (const a of AGENTS) {
    const found = existsSync(join(userHome, a.dir));
    if (!found && !a.ready) continue;
    const mark = found ? c.green('✓') : c.dim('·');
    const note = a.ready ? (found ? '' : c.dim('  not found — install Claude Code first')) : c.dim('  (soon)');
    io.print(`  ${mark} ${agentName(a.id).padEnd(12)} ${c.dim(a.via)}${note}`);
  }
  io.print();

  io.print(`Step 2/5 ${c.bold('How do you split your AI tools?')}  ${c.dim('(optional, recommended)')}`);
  io.print(c.dim('  In your own words — which AI do you use for what?'));
  io.print(c.dim(`  e.g. ${USAGE_EXAMPLE}`));
  io.print(c.dim(`  topics it knows: ${Object.keys(TOPIC_ALIASES).join(' · ')}`));
  let draft = '';
  for (;;) {
    // On [e] the previous answer comes back pre-typed, so a fix is a small edit, not a rewrite.
    const answer = (await io.ask(`  ${c.accent('›')} `, draft)).trim();
    draft = answer;
    if (!answer) break;
    const usage = parseUsage(answer);
    if (!usage.length) {
      io.print(c.dim('  Couldn\'t tell which AI goes with what. Try "Claude for coding, ChatGPT for writing" — or press enter to skip.'));
      continue;
    }
    io.print('  Got it:');
    for (const rule of usage) {
      io.print(`    ${rule.agents.map(agentName).join(' · ').padEnd(24)} ${c.blue(rule.topics.join(', '))}`);
    }
    io.print(c.dim('  headsup uses this to notice when a question lands in the "other" tool.'));
    if (!(await io.ask(`  ${c.accent('[enter]')} looks right   ${c.accent('[e]')} edit `)).trim().toLowerCase().startsWith('e')) {
      config.usage = usage;
      break;
    }
  }
  io.print();

  io.print(`Step 3/5 ${c.bold('Which folders are work?')}  ${c.dim('(optional)')}`);
  io.print(c.dim(`  Notes stay in the space they came from: work or ${config.defaultSpace}.`));
  io.print(c.dim(`  Name your work folders (job, clients, school). Everything else is ${config.defaultSpace}.`));
  const currentWork = config.spaces.filter((s) => s.space === 'work').map((s) => s.path);
  io.print(c.dim(currentWork.length ? `  enter keeps these; clear the line to make it all ${config.defaultSpace}` : `  e.g. ${SPACES_EXAMPLE}   (enter if it's all ${config.defaultSpace})`));
  const editAnytime = `Edit anytime: ${tilde(join(opts.home, 'config.json'))}`;
  let spaceDraft = currentWork.join(', ');
  for (;;) {
    const answer = (await io.ask(`  ${c.accent('›')} `, spaceDraft)).trim();
    spaceDraft = answer;
    const paths = answer.split(',').map((p) => p.trim()).filter(Boolean);
    const spaces = [...config.spaces.filter((s) => s.space !== 'work'), ...paths.map((path) => ({ path, space: 'work' }))];
    if (!spaces.length && !config.spaces.length) {
      io.print(c.dim(`  Everything stays ${config.defaultSpace}. ${editAnytime}`));
      break;
    }
    // Web chats have no folder, so they always land in the default space (see web.ts).
    const rows = [
      ...spaces.map((s) => [s.path, s.space === 'work' ? c.blue(s.space) : c.green(s.space), '']),
      ['everything else', c.green(config.defaultSpace), ''],
      ['ChatGPT · Claude.ai', c.green(config.defaultSpace), c.dim('   browser chats have no folder')],
    ];
    const width = Math.max(...rows.map((r) => r[0]!.length)) + 3;
    io.print('  Got it:');
    for (const [label, space, note] of rows) io.print(`    ${label!.padEnd(width)}${c.dim('→')} ${space}${note}`);
    io.print(c.dim(`  Step 4 decides what may cross between them. ${editAnytime}`));
    if (!(await io.ask(`  ${c.accent('[enter]')} looks right   ${c.accent('[e]')} edit `)).trim().toLowerCase().startsWith('e')) {
      config.spaces = spaces;
      break;
    }
  }
  io.print();

  io.print(`Step 4/5 ${c.bold('Sharing preset')}  ${c.dim('what may travel between spaces?')}`);
  PRESETS.forEach((p, i) => {
    const name = p.id[0]!.toUpperCase() + p.id.slice(1);
    const current = p.id === config.preset;
    io.print(`  ${current ? c.accent('●') : '○'} ${i + 1} ${(current ? c.bold : String)(name.padEnd(9))} ${c.dim(`${p.rule} · secrets: never stored`)}${p.id === 'balanced' ? c.dim('  (recommended)') : ''}`);
  });
  io.print(`  ${c.dim('○   Custom    rules per space, repo or single note  (soon)')}`);
  io.print(`  ${c.accent('Share how you work, not what you work on.')}`);
  const pick = (await io.ask(`  Choose 1-3 ${c.dim(`(enter keeps ${config.preset})`)} `)).trim();
  const chosen = PRESETS[Number(pick) - 1];
  if (chosen) config.preset = chosen.id;
  io.print();

  io.print(`Step 5/5 ${c.bold('Bring existing memory')}  ${c.dim('(optional)')}`);
  io.print(c.dim('  ChatGPT: Settings → Data controls → Export data, then drop the .zip from the email here.'));
  io.print(c.dim('  Claude and Gemini exports: soon.'));
  const exportPath = unquotePath(await io.ask(`  chatgpt export .zip ${c.dim('(enter to skip)')} `));
  if (exportPath) {
    try {
      await importChatGPT({ ...io, progress: (l) => io.print(l) }, new Store(opts.home), {
        path: exportPath,
        space: config.defaultSpace,
        ...(opts.importSummarize ? { summarize: opts.importSummarize } : {}),
      });
    } catch (err) {
      io.print(c.dim(`  Couldn't import: ${err instanceof Error ? err.message : String(err)}. Try later with: headsup import chatgpt <file>`));
    }
  }
  io.print();

  saveConfig(config, opts.home);

  const command = opts.command ?? hookCommand();
  io.print(`${c.bold('Connect Claude Code')}  ${c.dim(`adds UserPromptSubmit + SessionEnd hooks to ${tilde(settingsPath)}`)}`);
  io.print(c.dim(`  command: ${command}`));
  io.print(c.dim('  At the end of a session headsup saves a few notes, summarized by your own `claude` login.'));
  io.print(c.dim('  Only headsup\'s own entries are touched; a backup is saved first. Undo with: headsup uninstall'));
  if (opts.isolated) io.print(c.dim(`  HEADSUP_HOME is set, so this defaults to no: it changes your real ${tilde(settingsPath)}.`));
  if (yes(await io.ask(`  Add it? ${opts.isolated ? '[y/N]' : '[Y/n]'} `), !opts.isolated)) {
    const result = installClaudeHook(command, settingsPath);
    io.print(`  ${c.green('✓')} hook ${result}`);
  } else {
    io.print(c.dim('  Skipped. Run headsup setup again whenever you\'re ready.'));
  }
  io.print();

  const browsers = opts.browserDirs ?? browserHostDirs();
  if (browsers.length) {
    const names = browsers.map((d) => basename(dirname(d)).replace(/^User Data$/, 'Arc'));
    io.print(`${c.bold('Connect your browser')}  ${c.dim(`lets the headsup extension reach this computer (${names.join(', ')})`)}`);
    io.print(c.dim('  Adds a small native-messaging entry; no server, no open port. Undo with: headsup uninstall'));
    if (opts.isolated) io.print(c.dim('  HEADSUP_HOME is set, so this defaults to no: your browsers would point here instead.'));
    if (yes(await io.ask(`  Connect? ${opts.isolated ? '[y/N]' : '[Y/n]'} `), !opts.isolated)) {
      installNativeHost(opts.home, browsers);
      io.print(`  ${c.green('✓')} connected · then add the extension: ${EXTENSION_HINT}`);
    } else {
      io.print(c.dim('  Skipped. Later: headsup connect-browser'));
    }
    io.print();
  }

  io.print(`${c.green('✓ Ready.')} Memory lives in ${tilde(opts.home)} — plain Markdown you can read and edit.`);
  const writer = config.usage.find((r) => !r.agents.includes('claude-code'));
  io.print(
    c.dim(
      writer
        ? `  Try it: ask Claude Code to do something you usually do in ${agentName(writer.agents[0]!)}.`
        : '  Try it: save a note with headsup add, then ask Claude Code about it.',
    ),
  );
  return config;
}

