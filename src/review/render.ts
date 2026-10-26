// Draws one frame of `headsup review` as plain lines, following the Figma review screen: header,
// tabs, a list, the selected item's details, its actions and the key hints.

import { agentName } from '../agents.js';
import type { Note } from '../note.js';
import { PRESETS, VIEWS, targetNote, visibleNotes, visibleRows, type HeadsUp, type Outcome, type State } from './model.js';

interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  accent(s: string): string;
  green(s: string): string;
  blue(s: string): string;
  red(s: string): string;
  selected(s: string): string;
  badge(s: string): string;
}

export function paint(on: boolean): Paint {
  const c = (open: string, close = '\x1b[0m') => (s: string) => (on ? `\x1b[${open}m${s}${close}` : s);
  return {
    bold: c('1'), dim: c('2'), accent: c('38;5;205'), green: c('32'), blue: c('34'), red: c('31'),
    selected: c('48;5;58'), badge: c('30;42'),
  };
}

// Terminal columns: Hangul and other wide characters take two.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
export function width(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

export function fit(s: string, w: number): string {
  if (w <= 0) return '';
  const flat = s.replace(/\s+/g, ' ');
  if (width(flat) <= w) return flat + ' '.repeat(w - width(flat));
  let out = '';
  for (const ch of flat) {
    if (width(out + ch) > w - 1) break;
    out += ch;
  }
  return out + '…' + ' '.repeat(Math.max(0, w - 1 - width(out)));
}

// A table cell: the text fitted to one column narrower, then a space before the next column.
const cell = (s: string, w: number) => `${fit(s, w - 1)} `;

const spaceColor = (p: Paint, space: string) => (space === 'work' ? p.blue(space) : p.green(space));
const agent = (id: string) => agentName(id).toLowerCase();

function when(d: Date, now: Date): string {
  const days = Math.floor((now.getTime() - d.getTime()) / 864e5);
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ago(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 864e5);
  return days <= 0 ? 'today' : days < 7 ? `${days}d ago` : days < 60 ? `${Math.floor(days / 7)}w ago` : `${Math.floor(days / 30)}mo ago`;
}

const from = (n: Note) => `${agent(n.source)}${n.project ? ` (${n.project})` : ''} · ${n.space}`;

function outcomeText(r: HeadsUp): string {
  return r.outcome === 'shared' ? `shared ${r.sharedCount}/${r.notes.filter((n) => n.status === 'asked' || n.status === 'shared').length}` : r.outcome;
}

function outcomeColor(p: Paint, o: Outcome, s: string): string {
  return o === 'injected' ? p.green(s) : o === 'shared' ? p.blue(s) : o === 'blocked' ? p.red(s) : o === 'waiting' ? p.accent(s) : p.dim(s);
}

function what(r: HeadsUp): string {
  const topics = [...new Set(r.notes.flatMap((n) => n.note?.topics ?? []))];
  const body = r.notes.find((n) => n.note)?.note?.body ?? '(deleted note)';
  const label = topics.length ? topics.slice(0, 4).join(', ') : body;
  return r.notes.length > 1 ? `${r.notes.length} notes: ${label}` : label;
}

function why(r: HeadsUp): string {
  const parts: string[] = [];
  if (r.signals.references?.length) parts.push(`gap: "${r.signals.references[0]}"`);
  if (r.signals.usageMismatch) parts.push(`${r.signals.usageMismatch.topic} is usually ${r.signals.usageMismatch.usualAgents.map(agentName).join('/')}`);
  if (!parts.length) parts.push('strong match, no gap signal');
  const count = (status: string) => r.notes.filter((n) => n.status === status).length;
  for (const [status, label] of [['injected', 'added'], ['shared', 'shared after OK'], ['asked', 'not shared'], ['blocked', 'blocked by preset'], ['skipped', 'already known']] as const) {
    if (count(status)) parts.push(`${count(status)} ${label}`);
  }
  return parts.join(' · ');
}

const STATUS_LABEL = { injected: 'added', shared: 'shared', asked: 'not shared', blocked: 'blocked', skipped: 'known' } as const;

function noteLine(p: Paint, n: Note | undefined, w: number, focused: boolean, status: string, now: Date): string {
  if (!n) return `  ${p.dim(fit('(deleted note)', w - 2))}`;
  const badge = n.type === 'how' ? ' how you work ' : ' fact ';
  const tail = `${from(n)} · ${ago(n.created, now)}${n.share === 'never' ? ' · never shared' : ''}${status ? ` · ${status}` : ''}`;
  const room = w - 4 - width(badge) - width(tail) - 2;
  const line = `${focused ? p.accent('›') : ' '} ${n.type === 'how' ? p.badge(badge) : p.blue(badge)} ${fit(n.body, Math.max(10, room))}  ${p.dim(tail)}`;
  return line;
}

export function render(s: State, cols: number, rows: number, color: boolean, now = new Date()): string[] {
  const p = paint(color);
  const w = Math.max(60, cols - 2);
  const weekAgo = now.getTime() - 7 * 864e5;
  const spaces = [...new Set([...s.config.spaces.map((x) => x.space), s.config.defaultSpace])];
  const out: string[] = [];

  out.push(
    `${p.bold('headsup review')}   preset: ${p.accent(s.config.preset[0]!.toUpperCase() + s.config.preset.slice(1))}   spaces: ${spaces.map((x) => spaceColor(p, x)).join(' · ')}   ` +
      `notes: ${s.notes.length}   heads-ups this week: ${s.rows.filter((r) => r.at.getTime() >= weekAgo).length}`,
  );
  out.push('');
  out.push(VIEWS.map((v) => (v === s.view ? p.accent(`[ ${v} ]`) : p.dim(v))).join('   '));
  out.push(p.dim('─'.repeat(w)));

  const detail: string[] = [];
  const listHeight = Math.max(3, rows - 4 - 12);
  const window = <T>(items: T[]) => {
    const start = Math.max(0, Math.min(s.cursor - Math.floor(listHeight / 2), items.length - listHeight));
    return { start, items: items.slice(start, start + listHeight) };
  };

  if (s.view === 'Heads-ups') {
    const list = visibleRows(s);
    const cw = { time: 6, from: 30, to: 27, type: 6, outcome: 12 };
    const whatW = w - 2 - Object.values(cw).reduce((a, b) => a + b, 0);
    out.push(p.dim(`  ${cell('TIME', cw.time)}${cell('FROM', cw.from)}${cell('TO', cw.to)}${cell('TYPE', cw.type)}${cell('OUTCOME', cw.outcome)}WHAT`));
    if (!list.length) out.push(p.dim(s.query ? '  nothing matches' : '  no heads-ups yet — they appear here once headsup adds context to a prompt'));
    const { start, items } = window(list);
    items.forEach((r, i) => {
      const sources = [...new Set(r.notes.map((n) => (n.note ? from(n.note) : '?')))];
      const types = [...new Set(r.notes.map((n) => n.note?.type).filter(Boolean))];
      const type = types.length === 1 ? types[0]! : 'mixed';
      const line =
        `  ${cell(when(r.at, now), cw.time)}${cell(sources.length === 1 ? sources[0]! : `${sources.length} sources`, cw.from)}` +
        `${cell(`→ ${agent(r.agent)} · ${r.targetSpace}`, cw.to)}${(type === 'how' ? p.green : p.blue)(cell(type, cw.type))}` +
        `${outcomeColor(p, r.outcome, cell(outcomeText(r), cw.outcome))}${fit(what(r), whatW)}`;
      out.push(start + i === s.cursor ? p.selected(line) : line);
    });
    const r = list[s.cursor];
    if (r) {
      const src = r.notes.find((n) => n.note)?.note;
      detail.push(p.bold(`Selected · ${when(r.at, now)} · ${src ? `${agentName(src.source)}${src.project && src.source === r.agent ? ` · ${src.project}` : ''} (${src.space})` : 'deleted notes'} → ${agentName(r.agent)} (${r.targetSpace})`));
      detail.push(`  ${p.dim('prompt')}   ${fit(`"${r.prompt}"`, w - 11)}`);
      detail.push(`  ${p.dim('why')}      ${fit(why(r), w - 11)}`);
      r.notes.slice(0, 5).forEach((n, i) => detail.push(noteLine(p, n.note, w, s.inner === i, STATUS_LABEL[n.status], now)));
      if (r.notes.length > 5) detail.push(p.dim(`  … ${r.notes.length - 5} more`));
    }
  } else if (s.view === 'Notes') {
    const list = visibleNotes(s);
    const cw = { created: 8, from: 26, type: 6, share: 8 };
    const bodyW = w - 2 - Object.values(cw).reduce((a, b) => a + b, 0);
    out.push(p.dim(`  ${cell('SAVED', cw.created)}${cell('FROM', cw.from)}${cell('TYPE', cw.type)}${cell('SHARE', cw.share)}NOTE`));
    if (!list.length) out.push(p.dim(s.query ? '  nothing matches' : '  no notes yet — they are saved when a Claude Code session ends'));
    const { start, items } = window(list);
    items.forEach((n, i) => {
      const line =
        `  ${cell(ago(n.created, now), cw.created)}${cell(from(n), cw.from)}${(n.type === 'how' ? p.green : p.blue)(cell(n.type, cw.type))}` +
        `${cell(n.share ?? 'preset', cw.share)}${fit(n.body, bodyW)}`;
      out.push(start + i === s.cursor ? p.selected(line) : line);
    });
    const n = list[s.cursor];
    if (n) {
      detail.push(p.bold(`Selected · ${n.id} · ${from(n)}`));
      detail.push(noteLine(p, n, w, false, '', now));
      detail.push(`  ${p.dim('topics')}   ${n.topics.join(', ') || '—'}`);
      detail.push(`  ${p.dim('sharing')}  ${n.share === 'never' ? 'never leaves its space' : n.share === 'always' ? 'always shared' : `follows the ${s.config.preset} preset`}`);
    }
  } else if (s.view === 'Spaces') {
    out.push('  Folders and the space their notes belong to (longest match wins).');
    for (const sp of s.config.spaces) out.push(`  ${fit(sp.path, 24)} → ${spaceColor(p, sp.space)}`);
    out.push(`  ${fit('everything else', 24)} → ${spaceColor(p, s.config.defaultSpace)}`);
    out.push('');
    out.push(p.dim('  Change these in ~/.headsup/config.json or with headsup setup.'));
  } else if (s.view === 'Usage') {
    out.push('  Which AI you use for what. A question that lands in the "other" tool counts as a gap.');
    if (!s.config.usage.length) out.push(p.dim('  (not set — run headsup setup)'));
    for (const u of s.config.usage) out.push(`  ${fit(u.agents.map(agentName).join(' · '), 30)} ${p.blue(u.topics.join(', '))}`);
    out.push('');
    out.push(p.dim('  Change this with headsup setup.'));
  } else {
    const rules = { cautious: 'how-you-work: ask  · facts: blocked', balanced: 'how-you-work: auto · facts: ask', open: 'how-you-work: auto · facts: auto' };
    PRESETS.forEach((preset, i) => {
      const current = preset === s.config.preset;
      const line = `  ${current ? p.accent('●') : '○'} ${fit(preset[0]!.toUpperCase() + preset.slice(1), 10)} ${p.dim(`${rules[preset]} · secrets: never stored`)}`;
      out.push(i === s.cursor ? p.selected(line) : line);
    });
    out.push('');
    out.push(p.accent('  Share how you work, not what you work on.'));
  }

  while (out.length < 4 + listHeight + 1) out.push('');
  out.push(p.dim('─'.repeat(w)));
  out.push(...detail);
  out.push('');

  const note = targetNote(s);
  if (s.view === 'Heads-ups' || s.view === 'Notes') {
    const act = (k: string, label: string) => `${note ? p.accent(`[${k}]`) : p.dim(`[${k}]`)} ${note ? label : p.dim(label)}`;
    const never = note?.share === 'never' ? 'allow sharing' : 'never share this note';
    out.push(`${act('e', 'edit')}   ${act('d', 'delete')}   ${act('r', note ? `reclassify as ${note.type === 'how' ? 'fact' : 'how'}` : 'reclassify')}   ${act('n', never)}   ${p.accent('[p]')} change preset`);
  }
  out.push('');
  if (s.confirm) out.push(p.accent(`Delete this note for good? y / n`));
  else if (s.searching) out.push(`/${s.query}${p.dim('▏  enter keep · esc clear')}`);
  else if (s.status) out.push(p.accent(s.status));
  else {
    const enter = s.view === 'Heads-ups' ? (s.inner === null ? 'enter pick a note' : 'esc back') : s.view === 'Preset' ? 'enter choose' : '';
    out.push(p.dim(`↑↓ move   ${enter ? `${enter}   ` : ''}/ search${s.query ? ` (${s.query})` : ''}   tab switch view   q quit`));
  }
  return out;
}
