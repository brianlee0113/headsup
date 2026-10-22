// The "About me" block headsup keeps in ChatGPT's custom instructions and Claude's personal
// preferences, so their phone and desktop apps, which headsup can't reach, still know how the person
// works. Shared by the core and the extension (no Node APIs here). Only the fenced block is ever
// rewritten; the person's own text around it stays exactly as they wrote it.

export const ABOUT_START = '— From headsup · kept up to date automatically; change it in headsup —';
export const ABOUT_END = '— end of headsup block —';

export function aboutBlock(lines: string[]): string {
  return lines.length ? [ABOUT_START, ...lines.map((l) => `• ${l}`), ABOUT_END].join('\n') : '';
}

// The field without headsup's block.
export function ownText(field: string): string {
  const start = field.indexOf(ABOUT_START);
  if (start < 0) return field;
  const end = field.indexOf(ABOUT_END, start);
  const after = end < 0 ? '' : field.slice(end + ABOUT_END.length);
  return (field.slice(0, start).trimEnd() + (after.trim() ? `\n\n${after.trimStart()}` : '')).trimEnd();
}

// Puts the block at the end of the person's text, replacing the old one; an empty block removes it.
export function spliceAbout(field: string, block: string): string {
  const own = ownText(field);
  if (!block) return own;
  return own.trim() ? `${own}\n\n${block}` : block;
}
