// A note is one remembered fact, stored as a Markdown file with a small frontmatter block.

export type NoteType = 'how' | 'fact';

export interface Note {
  id: string;
  type: NoteType;
  space: string;
  source: string; // agent that produced it: claude-code, codex, chatgpt, ...
  project?: string; // repo or folder it was captured in, when known
  topics: string[];
  created: string; // ISO date
  share?: 'never' | 'always';
  internal?: true; // a way of working particular to their employer (approvals, internal tools), not a personal preference
  body: string;
}

const LIST_KEYS = new Set(['topics']);

export function serializeNote(note: Note): string {
  const lines = ['---', `id: ${note.id}`, `type: ${note.type}`, `space: ${note.space}`, `source: ${note.source}`];
  if (note.project) lines.push(`project: ${note.project}`);
  if (note.topics.length) lines.push(`topics: [${note.topics.join(', ')}]`);
  lines.push(`created: ${note.created}`);
  if (note.share) lines.push(`share: ${note.share}`);
  if (note.internal) lines.push('internal: true');
  lines.push('---', '', note.body.trim(), '');
  return lines.join('\n');
}

export function parseNote(text: string): Note {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error('note is missing its frontmatter block');
  const fields: Record<string, string | string[]> = {};
  for (const line of match[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    fields[key] = LIST_KEYS.has(key)
      ? raw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      : raw;
  }
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : '');
  const type = str('type');
  if (type !== 'how' && type !== 'fact') throw new Error(`unknown note type "${type}"`);
  const share = str('share');
  return {
    id: str('id'),
    type,
    space: str('space') || 'personal',
    source: str('source') || 'unknown',
    ...(str('project') ? { project: str('project') } : {}),
    topics: (fields.topics as string[] | undefined) ?? [],
    created: str('created'),
    ...(share === 'never' || share === 'always' ? { share } : {}),
    ...(str('internal') === 'true' ? { internal: true as const } : {}),
    body: match[2]!.trim(),
  };
}
