// Which notes go in the "About me" block, the standing channel on the web: how the person likes answers
// whatever the task ("general" notes), and facts about them from the space the web uses (personal by
// default), within the sharing preset. Never work facts, never notes marked
// never-share, and not what came from that same assistant, which already has it.
//
// The block is short, so who gets a line matters. Notes answers actually drew on come first, then the
// ones added most often, then the newest: a new minor preference no longer pushes out an old note that
// keeps helping. Facts keep seats of their own, or a long list of style notes would leave none for who
// the person is. Notes learning has set aside stay out here too.

import type { Config } from './config.js';
import type { Book } from './learning.js';
import type { Note } from './note.js';
import { verdictFor } from './policy.js';
import { projectNames, scopeOf } from './scope.js';
import { aboutBlock } from './shared/about.js';

const MAX_LINES = 12;
const FACT_SEATS = 4; // of MAX_LINES, held for facts while there are any
const MAX_NOTE_CHARS = 220; // a long note would crowd out several short ones

export function aboutLines(notes: Note[], config: Config, agent: string, room: number, book: Book = {}, now = new Date()): { lines: string[]; ids: string[] } {
  const projects = projectNames(notes);
  const scope = (n: Note) => scopeOf(n, projects).scope;
  const eligible = notes
    .filter((n) => n.source !== agent && n.body.length <= MAX_NOTE_CHARS)
    // The block sits in the account and goes with every chat, so a note crosses into it only where the
    // preset would add it without asking (Cautious asks even for how-you-work notes from work).
    .filter((n) => verdictFor(n, config.defaultSpace, config.preset) === 'auto')
    .filter((n) => n.type === 'how' || n.space === config.defaultSpace || n.share === 'always')
    .filter((n) => !(book[n.id]?.restUntil && new Date(book[n.id]!.restUntil!) > now))
    // An employer's own process ("release needs a security review") would ride along in every chat of a
    // personal account; it still goes into a single request where it fits.
    .filter((n) => !n.internal)
    // The block rides along with every chat in the account, so it holds only what holds everywhere: how
    // the person likes answers ("general" notes) and who they are ("self" facts). A habit for one kind of
    // task, or anything about one project, comes in with the prompt it fits instead (gap.ts).
    .filter((n) => (n.type === 'how' ? scope(n) === 'general' : scope(n) === 'self'));
  const worth = (n: Note) => {
    const e = book[n.id];
    return e ? e.used * 3 + e.shown - e.removed * 5 : 0;
  };
  const ranked = (type: Note['type']) =>
    eligible.filter((n) => n.type === type).sort((a, b) => worth(b) - worth(a) || b.created.localeCompare(a.created));
  const how = ranked('how');
  const facts = ranked('fact');
  // Two how-you-work notes for every fact while both last, facts up to their seats, then the rest by rank.
  const order: Note[] = [];
  const firstHow = how.slice(0, MAX_LINES - Math.min(FACT_SEATS, facts.length));
  const firstFacts = facts.slice(0, FACT_SEATS);
  for (let h = 0, f = 0; h < firstHow.length || f < firstFacts.length; ) {
    if (h < firstHow.length) order.push(firstHow[h++]!);
    if (h < firstHow.length) order.push(firstHow[h++]!);
    if (f < firstFacts.length) order.push(firstFacts[f++]!);
  }
  order.push(...how.filter((n) => !order.includes(n)), ...facts.filter((n) => !order.includes(n)));

  const picked: Note[] = [];
  const line = (n: Note) => n.body.replace(/\s+/g, ' ').trim();
  for (const n of order) {
    if (picked.length === MAX_LINES) break;
    if (aboutBlock([...picked, n].map(line)).length <= room) picked.push(n);
  }
  // How-you-work first in the block itself: that is what the apps miss most.
  picked.sort((a, b) => (a.type === b.type ? order.indexOf(a) - order.indexOf(b) : a.type === 'how' ? -1 : 1));
  return { lines: picked.map(line), ids: picked.map((p) => p.id) };
}
