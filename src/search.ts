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

// Everyday Korean that says nothing about what a note is for. Matched against the word and its stems.
const HANGUL_STOPWORDS = new Set(
  ('아직 지금 이제 일단 사실 근데 그리고 그래서 그런데 그럼 이거 그거 저거 이건 그건 여기 거기 ' +
    '하는 하고 하면 해줘 해야 했어 있는 있어 없는 없어 되어 되는 되면 아니 아닌 맞아 ' +
    '상태 진행 가능 완료 필요 다시 먼저 정도 경우 부분 내용 관련 확인 생각 문제')
    .split(' '),
);

const HANGUL = /[가-힣]/;

// Tokens per word, so a match can be counted once per word of the query.
export function tokenizeWords(text: string): string[][] {
  const out: string[][] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (HANGUL.test(raw)) {
      // No morphological analysis. Particles and endings go on the end of a Korean word, so the word
      // and its leading stems ("설정이" → 설정, 설정이) match; inner bigrams ("만료되어" → 되어) would
      // pair unrelated words through their endings.
      if (HANGUL_STOPWORDS.has(raw)) continue;
      const stems = [];
      for (let len = 2; len <= raw.length; len++) {
        const stem = raw.slice(0, len);
        if (!HANGUL_STOPWORDS.has(stem)) stems.push(stem);
      }
      if (stems.length) out.push(stems);
      continue;
    }
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push([raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw]);
  }
  return out;
}

export function tokenize(text: string): string[] {
  return tokenizeWords(text).flat();
}

export interface Hit {
  note: Note;
  score: number; // BM25, for ranking only: it is not comparable across corpora of different sizes
  matched: number; // query words (and concepts) found in the note; a word's stems count once
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
    const groups = [...tokenizeWords(query), ...conceptTokens(query).map((c) => [c])];
    const terms = [...new Set(groups.flat())];
    // One root in two forms ("배포하면", "배포하기") is still one word: group by the shortest stem.
    const words = [...new Map(groups.map((g) => [g[0]!, g])).values()];
    const N = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const hits: Hit[] = [];
    for (const d of this.docs) {
      if (filter && !filter(d.note)) continue;
      let score = 0;
      let matched = 0;
      let concepts = 0;
      for (const g of words) {
        if (!g.some((t) => d.tf.has(t))) continue;
        matched++;
        if (g[0]!.startsWith(CONCEPT_PREFIX)) concepts++;
      }
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen));
      }
      if (matched > 0) hits.push({ note: d.note, score, matched, concepts });
    }
    return hits.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}
