// The terminal side of `headsup review`: raw keys in, full-screen frames out, effects applied to
// the store and config. Everything it shows comes from model.ts and render.ts.

import { spawnSync } from 'node:child_process';
import { saveConfig, type Config } from '../config.js';
import type { Store } from '../store.js';
import { buildHeadsUps, handleKey, initialState, type Effect, type Key, type State } from './model.js';
import { render } from './render.js';

const KEYS: Record<string, Key> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\t': 'tab', '\x1b[Z': 'shift-tab', '\r': 'enter', '\n': 'enter', '\x1b': 'escape', '\x7f': 'backspace', '\x08': 'backspace',
};

export function runReview(store: Store, config: Config, home: string): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  if (!input.isTTY || !out.isTTY) throw new Error('headsup review needs an interactive terminal');

  const load = (s?: State): State => {
    const notes = store.list();
    const fresh = initialState(buildHeadsUps(store.readLog(), notes), notes, s?.config ?? config);
    return s ? { ...fresh, view: s.view, cursor: s.cursor, inner: s.inner, query: s.query, status: s.status } : fresh;
  };
  let state = load();
  const color = !process.env.NO_COLOR;

  const enter = () => {
    out.write('\x1b[?1049h\x1b[?25l');
    input.setRawMode(true);
    input.resume();
  };
  const leave = () => {
    input.setRawMode(false);
    input.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };
  const draw = () => {
    const lines = render(state, out.columns ?? 100, out.rows ?? 30, color);
    out.write('\x1b[H\x1b[2J' + lines.map((l) => ` ${l}`).join('\r\n'));
  };

  const apply = (effect: Effect): boolean => {
    switch (effect.kind) {
      case 'quit':
        return false;
      case 'delete':
        store.remove(effect.note.id);
        state = load({ ...state, status: 'deleted' });
        break;
      case 'update':
        store.update(effect.note);
        state = load({ ...state, status: 'saved' });
        break;
      case 'preset': {
        const next = { ...state.config, preset: effect.preset };
        saveConfig(next, home);
        state = load({ ...state, config: next, status: `preset: ${effect.preset}` });
        break;
      }
      case 'edit': {
        leave();
        spawnSync(process.env.VISUAL ?? process.env.EDITOR ?? 'vi', [store.filePath(effect.note)], { stdio: 'inherit' });
        enter();
        state = load({ ...state, status: 'reloaded' });
        break;
      }
    }
    return true;
  };

  return new Promise((resolve) => {
    const onKey = (buf: Buffer) => {
      const raw = buf.toString('utf8');
      if (raw === '\x03') return finish(); // ctrl-c
      const result = handleKey(state, KEYS[raw] ?? raw);
      state = result.state;
      if (result.effect && !apply(result.effect)) return finish();
      draw();
    };
    const finish = () => {
      input.off('data', onKey);
      out.off('resize', draw);
      leave();
      resolve();
    };
    enter();
    input.on('data', onKey);
    out.on('resize', draw);
    draw();
  });
}
