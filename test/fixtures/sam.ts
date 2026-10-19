// Retrieval eval set. Sam (the fictional demo persona) codes in Claude Code and Codex — Quorum is the
// side project, Northwind the internship — and writes in ChatGPT. Most prompts below deliberately
// share few or no words with the note that answers them.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../../src/config.js';
import type { Note } from '../../src/note.js';

const n = (id: string, source: string, space: string, type: Note['type'], body: string, topics: string[] = []): Note => ({
  id, type, space, source, topics, body, created: '2026-10-01T00:00:00.000Z',
});

export const samNotes: Note[] = [
  n('quorum-what', 'claude-code', 'personal', 'fact', "Quorum is a web app that finds a meeting time for student clubs from everyone's calendar", ['quorum', 'side project']),
  n('quorum-traction', 'claude-code', 'personal', 'fact', 'Quorum has 140 weekly users across 9 clubs; built with Next.js and Supabase', ['quorum', 'users', 'stack']),
  n('vitest', 'codex', 'personal', 'how', 'Prefers Vitest with test files next to the source; never Jest', ['testing']),
  n('pnpm', 'codex', 'personal', 'how', 'Uses pnpm, never npm or yarn', ['package manager']),
  n('commits', 'codex', 'personal', 'how', 'Commit messages are short and imperative, with no prefixes like feat: or fix:', ['git']),
  n('nw-intern', 'claude-code', 'work', 'fact', 'Northwind internship on the payments team, summer 2026', ['northwind']),
  n('nw-payouts', 'claude-code', 'work', 'fact', 'Shipped payout retries at Northwind that cut failed payouts by 30%', ['northwind', 'payouts']),
  n('nw-ci', 'codex', 'work', 'fact', 'Northwind CI runs lint, typecheck and test as parallel jobs on self-hosted runners', ['ci']),
  n('nw-roadmap', 'claude-code', 'work', 'fact', 'Northwind Q4 roadmap: ledger migration before the Series C', ['roadmap']),
  n('tone', 'chatgpt', 'personal', 'how', "Writes in a plain, warm tone with short sentences; avoids words like 'thrilled' or 'excited to announce'", ['writing']),
  n('school', 'chatgpt', 'personal', 'fact', "Second-year master's student in HCI", ['education']),
  n('food', 'chatgpt', 'personal', 'fact', 'Vegetarian and allergic to peanuts', ['food']),
  n('jobsearch', 'chatgpt', 'personal', 'fact', 'Applying to product roles for summer 2027', ['job search']),
  n('bullets', 'chatgpt', 'personal', 'how', 'Likes bullet-point summaries over long paragraphs', ['format']),
];

export const samConfig: Config = {
  ...DEFAULT_CONFIG,
  spaces: [{ path: '~/work', space: 'work' }, { path: '~/side', space: 'personal' }],
  usage: [
    { agents: ['claude-code', 'claude-ai', 'codex'], topics: ['coding', 'side projects'] },
    { agents: ['chatgpt'], topics: ['writing', 'everyday'] },
  ],
};

export interface EvalCase {
  agent: string;
  cwd: string;
  prompt: string;
  expect: string[]; // note ids that should surface (injected or asked)
  ok?: string[]; // also reasonable to surface; neither required nor counted as noise
}

const quorum = join(homedir(), 'side', 'quorum');
const northwind = join(homedir(), 'work', 'northwind-api');

export const samCases: EvalCase[] = [
  // Cross-tool context that should surface
  { agent: 'chatgpt', cwd: '/', prompt: 'Write a LinkedIn post announcing my side project launch. Keep it short.', expect: ['quorum-what', 'quorum-traction'] },
  { agent: 'chatgpt', cwd: '/', prompt: "Help me write a cover letter for Fieldnote's product manager role", expect: ['nw-intern', 'nw-payouts'], ok: ['quorum-what', 'quorum-traction'] },
  { agent: 'chatgpt', cwd: '/', prompt: '이력서에 넣을 경력 요약 써줘', expect: ['nw-intern', 'nw-payouts'], ok: ['quorum-what', 'quorum-traction'] },
  { agent: 'chatgpt', cwd: '/', prompt: "Prep me for the interview question 'tell me about a project you're proud of'", expect: ['quorum-what', 'nw-payouts'], ok: ['quorum-traction', 'nw-intern'] },
  { agent: 'chatgpt', cwd: '/', prompt: 'Draft a short bio for the hackathon judges page', expect: ['quorum-what'], ok: ['quorum-traction', 'nw-intern', 'nw-payouts'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'add tests for the availability parser', expect: ['vitest'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'install date-fns and use it in the scheduler', expect: ['pnpm'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'write a commit message for these changes', expect: ['commits'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'write the release notes for v0.3', expect: ['tone'] },
  { agent: 'claude-code', cwd: northwind, prompt: 'set up GitHub Actions for this repo the way we do it at work', expect: ['nw-ci'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'suggest a restaurant for our club meetup tonight', expect: ['food'] },
  // Self-contained prompts: nothing should surface
  { agent: 'chatgpt', cwd: '/', prompt: "What's the time complexity of quicksort?", expect: [] },
  { agent: 'chatgpt', cwd: '/', prompt: 'Explain the difference between TCP and UDP', expect: [] },
  { agent: 'claude-code', cwd: quorum, prompt: 'how do I reverse a linked list in python', expect: [] },
  { agent: 'chatgpt', cwd: '/', prompt: 'Plan a 3-day trip to Kyoto in November', expect: [] },
  { agent: 'claude-code', cwd: quorum, prompt: 'why does this regex not match unicode letters', expect: [] },
];

// Written before tuning the gates and kept out of it: a check that the lexicon generalizes.
export const samHoldout: EvalCase[] = [
  { agent: 'chatgpt', cwd: '/', prompt: 'Write my LinkedIn headline', expect: ['quorum-what', 'nw-intern'], ok: ['quorum-traction', 'nw-payouts'] },
  { agent: 'chatgpt', cwd: '/', prompt: 'Help me answer "what was your biggest impact last summer?" for a recruiter screen', expect: ['nw-payouts'], ok: ['nw-intern'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'set up a test runner for this repo', expect: ['vitest'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'add zod as a dependency', expect: ['pnpm'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'draft an announcement email to club presidents about the new version', expect: ['tone'], ok: ['bullets'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'what should I cook for the club potluck?', expect: ['food'] },
  { agent: 'claude-code', cwd: quorum, prompt: 'summarize the open issues in this repo', expect: ['bullets'] },
  { agent: 'chatgpt', cwd: '/', prompt: 'Write a haiku about autumn', expect: [] },
  { agent: 'chatgpt', cwd: '/', prompt: 'How do vaccines train the immune system?', expect: [] },
  { agent: 'claude-code', cwd: quorum, prompt: 'fix the off-by-one error in the date range loop', expect: [] },
  { agent: 'claude-code', cwd: quorum, prompt: 'rename this variable to something clearer', expect: [] },
  { agent: 'chatgpt', cwd: '/', prompt: 'Convert 72 Fahrenheit to Celsius', expect: [] },
];
