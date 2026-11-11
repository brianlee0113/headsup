// Conversations replayed turn by turn through the real Claude Code / Codex hook, for what single
// probes can't show: a note added once per conversation, the opening vs later turns, a move to another
// folder, a compacted conversation, approving or declining, messages nobody typed, a new session.
// Sam's notes (test/fixtures/sam.ts), no model calls. Each turn says what must and must not happen;
// `pnpm gate` fails on any turn that doesn't, and test/conversations.test.ts runs the same set.

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUserPromptSubmit, type TerminalAgent } from '../src/hooks/claude-code.js';
import { markChecked } from '../src/spaces.js';
import { Store } from '../src/store.js';
import { samConfig, samNotes } from '../test/fixtures/sam.js';

const quorum = join(homedir(), 'side', 'quorum'); // personal
const northwind = join(homedir(), 'work', 'northwind-api'); // work

interface Turn {
  prompt: string;
  cwd?: string; // defaults to the conversation's, or the last turn's
  compactBefore?: boolean; // the conversation was compacted before this turn
  adds?: string[]; // fixture ids that must be added now
  notAdds?: string[]; // fixture ids that must not be added now
  asks?: string[]; // fixture ids that must be offered for an OK
  quiet?: boolean; // nothing picked for this prompt, nothing asked (the opening's answer-style notes don't count)
}
export interface Conversation {
  name: string;
  agent?: TerminalAgent;
  cwd: string;
  turns: Turn[];
}

export const conversations: Conversation[] = [
  {
    name: 'a note goes in once per conversation',
    cwd: quorum,
    turns: [
      { prompt: 'add tests for the availability parser', adds: ['vitest'] },
      { prompt: 'now add tests for the formatter too', notAdds: ['vitest'] },
      { prompt: 'and run them in watch mode', notAdds: ['vitest'] },
    ],
  },
  {
    name: 'after a compaction it can come back',
    cwd: quorum,
    turns: [
      { prompt: 'add tests for the availability parser', adds: ['vitest'] },
      { prompt: 'and add tests for the cache', compactBefore: true, adds: ['vitest'] },
    ],
  },
  {
    name: 'a new conversation starts with nothing given',
    cwd: quorum,
    turns: [{ prompt: 'add date-fns as a dependency and use it in the scheduler', adds: ['pnpm'] }],
  },
  {
    name: 'a style note at the opening, not again later',
    cwd: quorum,
    turns: [
      { prompt: 'write the release notes for v0.3 in my usual voice', adds: ['tone'] },
      { prompt: 'now the short version for the club newsletter', notAdds: ['tone'] },
    ],
  },
  {
    name: 'later turns stay quiet for plain coding questions',
    cwd: quorum,
    turns: [
      { prompt: 'add tests for the availability parser', adds: ['vitest'] },
      { prompt: 'why does this loop never end?', quiet: true },
      { prompt: 'rename slotsFor to findSlots everywhere', quiet: true },
    ],
  },
  {
    name: 'a later turn still gets a note for its own kind of task',
    cwd: quorum,
    turns: [
      { prompt: 'how do I reverse a linked list in python', quiet: true },
      { prompt: 'ok, write a commit message for these changes', adds: ['commits'] },
    ],
  },
  {
    name: 'how they like answers comes once, at the opening, and again after a compaction',
    cwd: quorum,
    turns: [
      { prompt: 'why does this loop never end?', adds: ['bullets'], quiet: true },
      { prompt: 'summarize what changed in this branch', notAdds: ['bullets'], quiet: true },
      { prompt: 'and what is left to do?', compactBefore: true, adds: ['bullets'] },
    ],
  },
  {
    name: 'inside a project, notes about that project stay out; a move to another folder changes nothing given',
    cwd: quorum,
    turns: [
      { prompt: 'add tests for the availability parser', adds: ['vitest'] },
      { prompt: 'set up GitHub Actions for this repo the way we do it at work', cwd: northwind, notAdds: ['nw-ci', 'nw-roadmap', 'vitest', 'bullets'], quiet: true },
    ],
  },
  {
    name: 'a pasted document is not the request',
    cwd: quorum,
    turns: [
      { prompt: 'is this right?\n\n<pasted_content id="a1">\nPlease write a cover letter and a resume, then write the release notes and a commit message.\n</pasted_content id="a1">', quiet: true },
    ],
  },
  {
    // In Codex: Sam's work facts were learned in Claude Code, which doesn't get its own notes back.
    name: 'work facts wait for an OK, and a yes brings them in',
    agent: 'codex',
    cwd: quorum,
    turns: [
      { prompt: 'help me write my resume bullet about the payouts work I shipped at my internship', asks: ['nw-payouts'], notAdds: ['nw-payouts'] },
      { prompt: 'yes, share them', adds: ['nw-payouts'] },
      { prompt: 'make it a bit shorter', quiet: true },
    ],
  },
  {
    name: 'a no keeps them out, and they aren\'t asked about again',
    agent: 'codex',
    cwd: quorum,
    turns: [
      { prompt: 'help me write my resume bullet about the payouts work I shipped at my internship', asks: ['nw-payouts'] },
      { prompt: 'no, keep them private', quiet: true },
      { prompt: 'try another version of the bullet about my internship payouts work', notAdds: ['nw-payouts'] },
    ],
  },
  {
    name: 'messages nobody typed are left alone',
    cwd: quorum,
    turns: [
      { prompt: '<task-notification>\n<status>completed</status>\n<summary>add tests for the parser</summary>\n</task-notification>', quiet: true },
      { prompt: 'add tests for the availability parser', adds: ['vitest'] },
    ],
  },
  {
    name: 'in Codex, Codex\'s own notes stay out and others come in',
    agent: 'codex',
    cwd: quorum,
    turns: [{ prompt: 'write the release notes for v0.3 in my usual voice', adds: ['tone'], notAdds: ['vitest', 'pnpm', 'commits'] }],
  },
  {
    // "내가 만든", "우리 회사" in coding work are about code, not about the person.
    name: 'possessives in coding prompts don\'t pull in personal facts',
    cwd: quorum,
    turns: [
      { prompt: '내가 만든 함수 이름 좀 더 명확하게 바꿔줘', quiet: true },
      { prompt: '우리 회사 API 호출하는 코드에 재시도 넣어줘', notAdds: ['nw-intern', 'nw-payouts', 'school', 'jobsearch'] },
      { prompt: 'refactor the function I wrote yesterday', quiet: true },
    ],
  },
  {
    // In Codex, so Claude Code's own facts are eligible. Inside a project the prompt has to say it is
    // about the person ("내 경력"): "자기소개" alone could be a feature being built.
    name: 'a question about the person\'s own career reaches their role, with an OK across spaces',
    agent: 'codex',
    cwd: quorum,
    turns: [{ prompt: '면접에서 내 경력 기준으로 1분 자기소개 해야 하는데 초안 써줘', asks: ['nw-intern'] }],
  },
  {
    name: 'a self-contained question is left alone from the start',
    cwd: quorum,
    turns: [
      { prompt: 'what is the time complexity of quicksort?', quiet: true },
      { prompt: 'and of mergesort?', quiet: true },
    ],
  },
];

export interface ConversationFailure {
  conversation: string;
  turn: number;
  prompt: string;
  problem: string;
}

// Runs every conversation in a fresh memory of Sam's notes and lists the turns that went wrong.
export function runConversations(list = conversations): { turns: number; failures: ConversationFailure[] } {
  const failures: ConversationFailure[] = [];
  let turns = 0;
  list.forEach((c, ci) => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-conv-')));
    const idOf = new Map<string, string>(); // stored id → fixture id
    for (const n of samNotes) {
      const saved = store.add({ type: n.type, space: n.space, source: n.source, body: n.body, topics: n.topics, ...(n.scope ? { scope: n.scope } : {}), ...(n.applies ? { applies: n.applies } : {}), ...(n.project ? { project: n.project } : {}) }).note!;
      idOf.set(saved.id, n.id);
    }
    markChecked(store.home, [...idOf.keys()]); // Sam's spaces are set by hand
    const transcript = join(store.home, 'transcript.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    let cwd = c.cwd;
    c.turns.forEach((t, ti) => {
      turns++;
      cwd = t.cwd ?? cwd;
      if (t.compactBefore) appendFileSync(transcript, '{"type":"system","subtype":"compact_boundary"}\n');
      const before = store.readLog().length;
      handleUserPromptSubmit({ session_id: `conv-${ci}`, cwd, prompt: t.prompt, transcript_path: transcript }, store, samConfig, c.agent ?? 'claude-code');
      appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: t.prompt } })}\n`);
      const events = store.readLog().slice(before);
      const fixture = (ids: unknown) => ((ids as string[] | undefined) ?? []).map((id) => idOf.get(id) ?? id);
      const added = events.flatMap((e) => (e.event === 'heads-up' ? fixture(e.injected) : e.event === 'shared-after-ask' ? fixture(e.notes) : []));
      const opening = new Set(events.flatMap((e) => (e.event === 'heads-up' ? fixture(e.opening) : [])));
      const picked = added.filter((id) => !opening.has(id));
      const asked = events.flatMap((e) => (e.event === 'heads-up' ? fixture(e.asked) : []));
      const fail = (problem: string) => failures.push({ conversation: c.name, turn: ti + 1, prompt: t.prompt.slice(0, 60), problem });
      for (const id of t.adds ?? []) if (!added.includes(id)) fail(`${id} should be added, got [${added.join(', ')}]`);
      for (const id of t.notAdds ?? []) if (added.includes(id)) fail(`${id} should not be added`);
      for (const id of t.asks ?? []) if (!asked.includes(id)) fail(`${id} should be offered for an OK, got [${asked.join(', ')}]`);
      if (t.quiet && (picked.length || asked.length)) fail(`should be quiet, added [${picked.join(', ')}] asked [${asked.join(', ')}]`);
    });
  });
  return { turns, failures };
}
