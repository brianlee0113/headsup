import type { Preset } from './config.js';
import type { Note } from './note.js';

export type Verdict = 'auto' | 'ask' | 'block';

// "Share how you work, not what you work on." Notes never leave their space unless the preset allows it.
const CROSS_SPACE: Record<Preset, Record<Note['type'], Verdict>> = {
  cautious: { how: 'ask', fact: 'block' },
  balanced: { how: 'auto', fact: 'ask' },
  open: { how: 'auto', fact: 'auto' },
};

export function verdictFor(note: Note, targetSpace: string, preset: Preset): Verdict {
  if (note.share === 'never') return 'block';
  if (note.space === targetSpace || note.share === 'always') return 'auto';
  return CROSS_SPACE[preset][note.type];
}
