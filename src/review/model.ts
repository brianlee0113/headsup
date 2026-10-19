// State for `headsup review`, kept free of terminal I/O so it can be tested: the log becomes
// heads-up rows, and keys become a new state plus at most one effect for the runner to carry out.

import type { Config, Preset } from '../config.js';
import type { Note } from '../note.js';

// waiting: asked, no answer yet · unanswered: the user moved on without saying yes or no
export type Outcome = 'injected' | 'shared' | 'waiting' | 'declined' | 'unanswered' | 'blocked' | 'skipped';

export interface HeadsUp {
  at: Date;
  agent: string;
  targetSpace: string;
  prompt: string;
  signals: { references?: string[]; usageMismatch?: { topic: string; usualAgents: string[] } };
  outcome: Outcome;
  sharedCount?: number; // for "shared 2/3"
  notes: Array<{ id: string; status: 'injected' | 'asked' | 'shared' | 'blocked' | 'skipped'; note?: Note }>;
}

type LogEntry = Record<string, unknown>;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function buildHeadsUps(log: LogEntry[], notes: Note[]): HeadsUp[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const rows: HeadsUp[] = [];
  log.forEach((e, i) => {
    if (e.event !== 'heads-up') return;
    const asked = ids(e.asked);
    // The user's answer is the next shared/declined entry from the same session.
    const answer = asked.length
      ? log.slice(i + 1).find((a) => a.session === e.session && (a.event === 'shared-after-ask' || a.event === 'declined' || a.event === 'heads-up'))
      : undefined;
    const shared = answer?.event === 'shared-after-ask' ? ids(answer.notes) : [];
    const list: HeadsUp['notes'] = [
      ...ids(e.injected).map((id) => ({ id, status: 'injected' as const })),
      ...asked.map((id) => ({ id, status: shared.includes(id) ? ('shared' as const) : ('asked' as const) })),
      ...ids(e.blocked).map((id) => ({ id, status: 'blocked' as const })),
      ...ids(e.skippedKnown).map((id) => ({ id, status: 'skipped' as const })),
    ].map((x) => ({ ...x, note: byId.get(x.id) }));
    // Asking is the notable part of a heads-up, so its answer wins over notes that went in on their own.
    const outcome: Outcome = asked.length
      ? shared.length ? 'shared' : answer?.event === 'declined' ? 'declined' : answer ? 'unanswered' : 'waiting'
      : ids(e.injected).length ? 'injected' : ids(e.blocked).length ? 'blocked' : 'skipped';
    rows.push({
      at: new Date(String(e.at)),
      agent: String(e.agent ?? ''),
      targetSpace: String(e.targetSpace ?? ''),
      prompt: String(e.prompt ?? ''),
      signals: (e.signals as HeadsUp['signals']) ?? {},
      outcome,
      ...(asked.length ? { sharedCount: shared.length } : {}),
      notes: list,
    });
  });
  return rows.reverse(); // newest first
}

export const VIEWS = ['Heads-ups', 'Notes', 'Spaces', 'Usage', 'Preset'] as const;
export type View = (typeof VIEWS)[number];
export const PRESETS: Preset[] = ['cautious', 'balanced', 'open'];

export interface State {
  view: View;
  rows: HeadsUp[];
  notes: Note[]; // newest first
  config: Config;
  cursor: number; // row in the current list
  inner: number | null; // note index inside the selected heads-up, when focused
  query: string;
  searching: boolean;
  confirm: string | null; // note id waiting for delete confirmation
  status: string; // one-line feedback
}

export function initialState(rows: HeadsUp[], notes: Note[], config: Config): State {
  const sorted = [...notes].sort((a, b) => b.created.localeCompare(a.created));
  return { view: 'Heads-ups', rows, notes: sorted, config, cursor: 0, inner: null, query: '', searching: false, confirm: null, status: '' };
}

const matches = (q: string, text: string) => !q || text.toLowerCase().includes(q.toLowerCase());

export function visibleRows(s: State): HeadsUp[] {
  return s.rows.filter((r) => matches(s.query, `${r.prompt} ${r.outcome} ${r.notes.map((n) => n.note?.body ?? '').join(' ')}`));
}

export function visibleNotes(s: State): Note[] {
  return s.notes.filter((n) => matches(s.query, `${n.body} ${n.topics.join(' ')} ${n.source} ${n.space} ${n.project ?? ''}`));
}

// The note an action applies to: the focused one in a heads-up, or the selected one in Notes.
export function targetNote(s: State): Note | undefined {
  if (s.view === 'Notes') return visibleNotes(s)[s.cursor];
  if (s.view !== 'Heads-ups' || s.inner === null) return undefined;
  return visibleRows(s)[s.cursor]?.notes[s.inner]?.note;
}

export type Effect =
  | { kind: 'quit' }
  | { kind: 'delete'; note: Note }
  | { kind: 'update'; note: Note }
  | { kind: 'edit'; note: Note }
  | { kind: 'preset'; preset: Preset };

export type Key = 'up' | 'down' | 'left' | 'right' | 'tab' | 'shift-tab' | 'enter' | 'escape' | 'backspace' | string;

const listLength = (s: State) =>
  s.view === 'Heads-ups' ? visibleRows(s).length : s.view === 'Notes' ? visibleNotes(s).length : s.view === 'Preset' ? PRESETS.length : 0;

export function handleKey(s: State, key: Key): { state: State; effect?: Effect } {
  const next = { ...s, status: '' };

  if (s.searching) {
    if (key === 'enter' || key === 'escape') return { state: { ...next, searching: false, ...(key === 'escape' ? { query: '' } : {}) } };
    if (key === 'backspace') return { state: { ...next, query: s.query.slice(0, -1), cursor: 0 } };
    return key.length === 1 ? { state: { ...next, query: s.query + key, cursor: 0, inner: null } } : { state: next };
  }

  if (s.confirm) {
    const note = s.notes.find((n) => n.id === s.confirm);
    if (key === 'y' && note) return { state: { ...next, confirm: null, inner: null }, effect: { kind: 'delete', note } };
    return { state: { ...next, confirm: null, status: 'kept' } };
  }

  const move = (delta: number) => {
    if (s.inner !== null) {
      const count = visibleRows(s)[s.cursor]?.notes.length ?? 0;
      return { state: { ...next, inner: Math.max(0, Math.min(count - 1, s.inner + delta)) } };
    }
    return { state: { ...next, cursor: Math.max(0, Math.min(listLength(s) - 1, s.cursor + delta)) } };
  };
  const switchView = (delta: number) => {
    const i = (VIEWS.indexOf(s.view) + delta + VIEWS.length) % VIEWS.length;
    const view = VIEWS[i]!;
    return { state: { ...next, view, cursor: view === 'Preset' ? PRESETS.indexOf(s.config.preset) : 0, inner: null, query: '' } };
  };

  switch (key) {
    case 'q':
      return { state: next, effect: { kind: 'quit' } };
    case 'up': case 'k':
      return move(-1);
    case 'down': case 'j':
      return move(1);
    case 'tab':
      return switchView(1);
    case 'shift-tab':
      return switchView(-1);
    case 'right':
      return s.inner === null ? switchView(1) : { state: next };
    case 'left':
      return s.inner === null ? switchView(-1) : { state: next };
    case '/':
      return { state: { ...next, searching: true, inner: null } };
    case 'escape':
      return { state: { ...next, inner: null, query: s.inner === null ? '' : s.query } };
    case 'enter':
      if (s.view === 'Heads-ups' && s.inner === null && visibleRows(s)[s.cursor]?.notes.some((n) => n.note)) {
        return { state: { ...next, inner: 0 } };
      }
      if (s.view === 'Preset') return { state: next, effect: { kind: 'preset', preset: PRESETS[s.cursor]! } };
      break;
    case 'p': {
      const preset = PRESETS[(PRESETS.indexOf(s.config.preset) + 1) % PRESETS.length]!;
      return { state: next, effect: { kind: 'preset', preset } };
    }
  }

  const note = targetNote(s);
  if (!note) {
    return 'edrn'.includes(key) && key.length === 1
      ? { state: { ...next, status: s.view === 'Heads-ups' ? 'press enter to pick a note first' : '' } }
      : { state: next };
  }
  switch (key) {
    case 'd':
      return { state: { ...next, confirm: note.id } };
    case 'e':
      return { state: next, effect: { kind: 'edit', note } };
    case 'r':
      return { state: next, effect: { kind: 'update', note: { ...note, type: note.type === 'how' ? 'fact' : 'how' } } };
    case 'n': {
      const { share: _, ...rest } = note;
      return { state: next, effect: { kind: 'update', note: note.share === 'never' ? rest : { ...note, share: 'never' } } };
    }
  }
  return { state: next };
}
