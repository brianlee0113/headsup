export interface Item {
  id: string;
  type: 'how' | 'fact';
  space: 'work' | 'personal';
  tool: string; // where the person reveals it
  key: boolean; // memory should hold it
  text: string;
  confidential?: boolean; // work detail that should not leave work without an OK
  sensitive?: 'health' | 'money';
  secret?: string; // a value that must never reach memory
  changes?: { week: number; text: string }; // replaces text from that week on (a fact, or a habit that changed)
  project?: string; // a habit that holds only in this project or context; elsewhere it should stay out
}

export interface Persona {
  id: string;
  split: 'tune' | 'holdout' | 'seen'; // seen: was a holdout, then its results guided a change (2026-10-27)
  language: 'en' | 'ko';
  who: string;
  tools: Record<string, { projects?: Record<string, string> }>;
  config: { spaces: Array<{ path: string; space: string }>; usage: Array<{ agents: string[]; topics: string[] }> };
  items: Item[];
}

export interface SessionBrief {
  id: string;
  tool: string;
  project?: string; // terminal tools only
  day: number; // 1..7 within the week
  topic: string;
  reveals: string[]; // item ids the person mentions in passing
}

export interface Session extends SessionBrief {
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export type ProbeKind = 'general' | 'needed' | 'known' | 'boundary' | 'changed' | 'sensitive' | 'injection';

export interface Probe {
  id: string;
  kind: ProbeKind;
  tool: string;
  project?: string;
  prompt: string;
  context?: string; // earlier turns of the same chat, for "known"
  needs: string[]; // item ids a good answer needs from memory
  forbid: string[]; // item ids that must not be added without an OK (or at all, for sensitive)
  why: string;
}
