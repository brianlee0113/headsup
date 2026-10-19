// `headsup setup`: the five steps from the Figma setup screen — agents, usage profile, spaces,
// sharing preset, existing memory — then the one change outside ~/.headsup, which it asks about.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentName } from './agents.js';
import { loadConfig, saveConfig, type Config, type Preset } from './config.js';
import { claudeSettingsPath, hookCommand, installClaudeHook } from './install.js';
import { parseUsage } from './usage.js';

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
}

const paint = (on: boolean) => {
  const c = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: c('1'), dim: c('2'), green: c('32'), blue: c('34'), orange: c('38;5;214') };
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

  io.print(`${c.orange('◆ headsup')} ${opts.version}  ${c.dim('gives your AI a heads-up before it answers')}`);
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
  let draft = '';
  for (;;) {
    // On [e] the previous answer comes back pre-typed, so a fix is a small edit, not a rewrite.
    const answer = (await io.ask(`  ${c.orange('›')} `, draft)).trim();
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
    if (!(await io.ask(`  ${c.orange('[enter]')} looks right   ${c.orange('[e]')} edit `)).trim().toLowerCase().startsWith('e')) {
      config.usage = usage;
      break;
    }
  }
  io.print();

  io.print(`Step 3/5 ${c.bold('Spaces')}  ${c.dim('which folders belong together?')}`);
  const currentWork = config.spaces.filter((s) => s.space === 'work').map((s) => s.path);
  const hint = currentWork.length ? currentWork.join(', ') : 'e.g. ~/work';
  const work = (await io.ask(`  Work folders, comma-separated ${c.dim(`(${hint}; enter to ${currentWork.length ? 'keep' : 'skip'})`)} `)).trim();
  if (work) {
    const paths = work.split(',').map((p) => p.trim()).filter(Boolean);
    config.spaces = [...config.spaces.filter((s) => s.space !== 'work'), ...paths.map((path) => ({ path, space: 'work' }))];
  }
  for (const s of config.spaces) io.print(`  ${s.path.padEnd(14)} → ${s.space === 'work' ? c.blue(s.space) : c.green(s.space)}`);
  io.print(`  ${c.dim('everything else →')} ${c.green(config.defaultSpace)}   ${c.dim(`(edit anytime: ${tilde(join(opts.home, 'config.json'))})`)}`);
  io.print();

  io.print(`Step 4/5 ${c.bold('Sharing preset')}  ${c.dim('what may travel between spaces?')}`);
  PRESETS.forEach((p, i) => {
    const name = p.id[0]!.toUpperCase() + p.id.slice(1);
    const current = p.id === config.preset;
    io.print(`  ${current ? c.orange('●') : '○'} ${i + 1} ${(current ? c.bold : String)(name.padEnd(9))} ${c.dim(`${p.rule} · secrets: never stored`)}${p.id === 'balanced' ? c.dim('  (recommended)') : ''}`);
  });
  io.print(`  ${c.dim('○   Custom    rules per space, repo or single note  (soon)')}`);
  io.print(`  ${c.orange('Share how you work, not what you work on.')}`);
  const pick = (await io.ask(`  Choose 1-3 ${c.dim(`(enter keeps ${config.preset})`)} `)).trim();
  const chosen = PRESETS[Number(pick) - 1];
  if (chosen) config.preset = chosen.id;
  io.print();

  io.print(`Step 5/5 ${c.bold('Bring existing memory')}  ${c.dim('(optional)')}`);
  io.print(c.dim('  ChatGPT / Claude / Gemini export import is coming soon. Add notes now with: headsup add "…"'));
  io.print();

  saveConfig(config, opts.home);

  const command = opts.command ?? hookCommand();
  io.print(`${c.bold('Connect Claude Code')}  ${c.dim(`adds one UserPromptSubmit hook to ${tilde(settingsPath)}`)}`);
  io.print(c.dim(`  command: ${command}`));
  io.print(c.dim('  Only headsup\'s own entry is touched; a backup is saved first. Undo with: headsup uninstall'));
  if (yes(await io.ask('  Add it? [Y/n] '), true)) {
    const result = installClaudeHook(command, settingsPath);
    io.print(`  ${c.green('✓')} hook ${result}`);
  } else {
    io.print(c.dim('  Skipped. Run headsup setup again whenever you\'re ready.'));
  }
  io.print();

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

