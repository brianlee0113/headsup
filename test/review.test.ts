import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import type { Note } from '../src/note.js';
import { buildHeadsUps, handleKey, initialState, type State } from '../src/review/model.js';
import { fit, render, width } from '../src/review/render.js';

const config: Config = { ...DEFAULT_CONFIG, spaces: [{ path: '~/work', space: 'work' }] };
const note = (id: string, over: Partial<Note> = {}): Note => ({
  id, type: 'how', space: 'personal', source: 'codex', topics: [id], created: '2026-10-18T10:00:00.000Z', body: `note ${id}`, ...over,
});
const notes = [note('pnpm', { topics: ['packages'] }), note('vitest'), note('ci', { type: 'fact', space: 'work' }), note('roadmap', { type: 'fact', space: 'work' })];

const at = (h: number) => `2026-10-19T${String(h).padStart(2, '0')}:00:00.000Z`;
const log = [
  { at: at(9), event: 'heads-up', agent: 'claude-code', session: 'a', targetSpace: 'personal', prompt: 'set up CI like at work', signals: { references: ['at work'] }, injected: ['vitest'], asked: ['ci', 'roadmap'], blocked: [], skippedKnown: [] },
  { at: at(9), event: 'shared-after-ask', session: 'a', notes: ['ci'] },
  { at: at(10), event: 'heads-up', agent: 'claude-code', session: 'b', targetSpace: 'personal', prompt: 'what about the roadmap', signals: {}, injected: [], asked: ['roadmap'], blocked: [], skippedKnown: [] },
  { at: at(10), event: 'declined', session: 'b', notes: ['roadmap'] },
  { at: at(11), event: 'heads-up', agent: 'claude-code', session: 'c', targetSpace: 'personal', prompt: 'add pnpm', signals: {}, injected: [], asked: [], blocked: [], skippedKnown: ['pnpm'] },
  { at: at(12), event: 'heads-up', agent: 'claude-code', session: 'd', targetSpace: 'personal', prompt: 'roadmap again', signals: {}, injected: [], asked: ['roadmap'], blocked: [], skippedKnown: [] },
  { at: at(12), event: 'captured', session: 'd', saved: [] },
];

describe('review model', () => {
  it('turns the log into heads-ups with their outcomes, newest first', () => {
    const rows = buildHeadsUps(log, notes);
    expect(rows.map((r) => r.outcome)).toEqual(['waiting', 'skipped', 'declined', 'shared']);
    expect(rows[3]!.notes.map((n) => `${n.id}:${n.status}`)).toEqual(['vitest:injected', 'ci:shared', 'roadmap:asked']);
    expect(rows[3]!.sharedCount).toBe(1);
  });

  it('picks a note inside a heads-up, then acts on it', () => {
    let s: State = initialState(buildHeadsUps(log, notes), notes, config);
    s = handleKey(s, 'down').state;
    s = handleKey(s, 'down').state;
    s = handleKey(s, 'down').state; // the CI heads-up
    expect(handleKey(s, 'r').state.status).toBe('press enter to pick a note first');
    s = handleKey(s, 'enter').state;
    s = handleKey(s, 'down').state; // ci
    expect(handleKey(s, 'r').effect).toEqual({ kind: 'update', note: { ...notes[2], type: 'how' } });
    expect(handleKey(s, 'n').effect).toEqual({ kind: 'update', note: { ...notes[2], share: 'never' } });
    const asking = handleKey(s, 'd').state;
    expect(asking.confirm).toBe('ci');
    expect(handleKey(asking, 'y').effect).toEqual({ kind: 'delete', note: notes[2] });
    expect(handleKey(asking, 'n').effect).toBeUndefined();
  });

  it('searches, switches views and changes the preset', () => {
    let s: State = initialState(buildHeadsUps(log, notes), notes, config);
    for (const k of ['/', 'p', 'n', 'p', 'm', 'enter']) s = handleKey(s, k).state;
    expect(s.query).toBe('pnpm');
    s = handleKey(s, 'tab').state;
    expect(s.view).toBe('Notes');
    expect(handleKey(s, 'p').effect).toEqual({ kind: 'preset', preset: 'open' });
    expect(handleKey(s, 'q').effect).toEqual({ kind: 'quit' });
  });
});

describe('review screen', () => {
  it('measures Korean as two columns per character', () => {
    expect(width('평소처럼')).toBe(8);
    expect(width(fit('평소처럼 해줘', 6))).toBe(6);
  });

  it('draws the Figma layout', () => {
    const s = initialState(buildHeadsUps(log, notes), notes, config);
    const screen = render(s, 120, 30, false, new Date(at(13))).join('\n');
    expect(screen).toContain('headsup review   preset: Balanced   spaces: work · personal   notes: 4   heads-ups this week: 4');
    expect(screen).toContain('[ Heads-ups ]');
    expect(screen).toMatch(/TIME\s+FROM\s+TO\s+TYPE\s+OUTCOME\s+WHAT/);
    expect(screen).toContain('shared 1/2');
    expect(screen).toContain('Selected · ');
    expect(screen).toContain('[e] edit   [d] delete');
  });
});
