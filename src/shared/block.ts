// The context block appended to a chat message. Shared by the core and the extension (no Node
// APIs here): the extension builds it from the notes the user left ticked, and finds it again in
// sent messages to fold it into a "◆ n notes" pill.

export interface WebNote {
  id: string;
  type: 'how' | 'fact';
  body: string;
  topics: string[];
  from: string; // display name of the tool it came from, e.g. "Claude Code (quorum)"
  space: string;
}

export const BLOCK_MARKER = '◆ headsup — context from my other AI tools';

export function buildBlock(notes: WebNote[]): string {
  if (!notes.length) return '';
  const lines = notes.map((n) => `• (${n.type === 'how' ? 'how I work' : 'fact'} · ${n.from}, ${n.space}) ${n.body}`);
  return `\n\n---\n${BLOCK_MARKER} (added automatically; use it if it helps, no need to mention it):\n${lines.join('\n')}`;
}

// Splits a sent message into what the person typed and the block headsup added.
export function splitBlock(text: string): { typed: string; count: number } | null {
  const at = text.indexOf(BLOCK_MARKER);
  if (at < 0) return null;
  const start = text.lastIndexOf('---', at);
  const typed = text.slice(0, start >= 0 && at - start < 8 ? start : at).trimEnd();
  const count = text.slice(at).split('\n').filter((l) => l.trimStart().startsWith('•')).length;
  return { typed, count };
}
