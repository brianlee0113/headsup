// Which notes go in the "About me" block: how the person works, and facts from the space the web
// uses (personal by default). Never work facts, never notes marked never-share, and not what came
// from that same assistant, which already has it.

import type { Config } from './config.js';
import type { Note } from './note.js';
import { aboutBlock } from './shared/about.js';

const MAX_LINES = 12;
const MAX_NOTE_CHARS = 220; // a long note would crowd out several short ones

export function aboutLines(notes: Note[], config: Config, agent: string, room: number): { lines: string[]; ids: string[] } {
  const eligible = notes
    .filter((n) => n.share !== 'never' && n.source !== agent && n.body.length <= MAX_NOTE_CHARS)
    .filter((n) => n.type === 'how' || n.space === config.defaultSpace || n.share === 'always')
    // How-you-work first (that is what the apps miss most), newest first within each.
    .sort((a, b) => (a.type === b.type ? b.created.localeCompare(a.created) : a.type === 'how' ? -1 : 1));
  const picked: Note[] = [];
  for (const n of eligible) {
    if (picked.length === MAX_LINES) break;
    const lines = [...picked, n].map((p) => p.body.replace(/\s+/g, ' ').trim());
    if (aboutBlock(lines).length <= room) picked.push(n);
  }
  return { lines: picked.map((p) => p.body.replace(/\s+/g, ' ').trim()), ids: picked.map((p) => p.id) };
}
