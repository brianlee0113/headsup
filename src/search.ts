// Dependency-free BM25 over notes. Small corpora (thousands of notes) index in milliseconds,
// which keeps the per-prompt hook fast without native modules.

import { CONCEPT_PREFIX, conceptTokens } from './concepts.js';
import type { Note } from './note.js';

const STOPWORDS = new Set(
  ('a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
    'me my of on or our please should so that the their them then there these this to us was we were what ' +
    'when where which who why will with would you your write make help let lets get give use using want need')
    .split(' '),
);

const HANGUL = /[가-힣]/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (HANGUL.test(raw)) {
      // No morphological analysis: index the word and its bigrams so particles don't break matches.
      out.push(raw);
      for (let i = 0; i + 2 <= raw.length; i++) out.push(raw.slice(i, i + 2));
      continue;
    }
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

export interface Hit {
  note: Note;
  score: number; // BM25, for ranking only: it is not comparable across corpora of different sizes
  matched: number; // distinct query terms found in the note, concepts included
  concepts: number; // of those, shared concepts (see concepts.ts)
}

export class NoteIndex {
  private docs: Array<{ note: Note; tf: Map<string, number>; len: number }> = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(notes: Note[]) {
    for (const note of notes) {
      // Topics are weighted by repeating them: they are the note's own summary of what it is about.
      const text = `${note.body} ${note.topics.join(' ')}`;
      const tokens = [...tokenize(`${text} ${note.topics.join(' ')}`), ...conceptTokens(text)];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ note, tf, len: tokens.length });
    }
    this.avgLen = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, limit = 5, filter?: (n: Note) => boolean): Hit[] {
    const terms = [...new Set([...tokenize(query), ...conceptTokens(query)])];
    const N = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const hits: Hit[] = [];
    for (const d of this.docs) {
      if (filter && !filter(d.note)) continue;
      let score = 0;
      let matched = 0;
      let concepts = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        if (t.startsWith(CONCEPT_PREFIX)) concepts++;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen));
      }
      if (matched > 0) hits.push({ note: d.note, score, matched, concepts });
    }
    return hits.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}
