import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveSpace, type Config } from '../src/config.js';
import { detect } from '../src/gap.js';
import { parseNote, serializeNote, type Note } from '../src/note.js';
import { verdictFor } from '../src/policy.js';
import { redactSecrets } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { handleWeb, type DetectReply } from '../src/web.js';

const note = (over: Partial<Note> & Pick<Note, 'body'>): Note => ({
  id: Math.random().toString(36).slice(2),
  type: 'fact',
  space: 'personal',
  source: 'claude-code',
  topics: [],
  created: '2026-10-19T00:00:00.000Z',
  ...over,
});

// Persona from the Figma demos: Sam codes in Claude Code (Quorum side project, Northwind internship)
// and writes in ChatGPT.
const config: Config = {
  ...DEFAULT_CONFIG,
  spaces: [{ path: '~/work', space: 'work' }, { path: '~/side', space: 'personal' }],
  usage: [
    { agents: ['claude-code', 'claude-ai'], topics: ['coding', 'side projects'] },
    { agents: ['chatgpt'], topics: ['writing', 'everyday'] },
  ],
};
const quorum = [
  note({ scope: 'project', applies: ['Quorum'], body: 'Quorum is a web app that finds a meeting time for student clubs from everyone\'s calendar', topics: ['quorum', 'side project', 'launch'] }),
  note({ scope: 'project', applies: ['Quorum'], body: 'Quorum has 140 weekly users across 9 clubs; built with Next.js and Supabase', topics: ['quorum', 'users', 'stack'] }),
];
const northwind = [
  note({ space: 'work', scope: 'self', applies: ['resume', 'cover letter', 'internship'], body: 'Northwind internship on the payments team, summer 2026', topics: ['northwind', 'internship'] }),
  note({ space: 'work', scope: 'self', applies: ['resume', 'cover letter'], body: 'Shipped payout retries at Northwind that cut failed payouts by 30%', topics: ['northwind', 'payouts', 'internship'] }),
];

describe('notes', () => {
  it('round-trips through Markdown with frontmatter', () => {
    const n = note({ body: 'Prefers named exports', type: 'how', topics: ['typescript', 'style'], share: 'never' });
    expect(parseNote(serializeNote(n))).toEqual(n);
  });

  it('keeps where a note holds, and drops a scope its type can\'t have', () => {
    const n = note({ body: 'Inquiry emails stay short', type: 'how', scope: 'task', applies: ['inquiry email', '문의 메일'] });
    expect(parseNote(serializeNote(n))).toEqual(n);
    expect(parseNote(serializeNote({ ...note({ body: 'Studies HCI' }), scope: 'general' })).scope).toBeUndefined(); // a fact is never "general"
  });
});

describe('secrets', () => {
  it('keeps the internal mark through a save', () => {
    const n = note({ type: 'how', body: 'Release needs a security review first', internal: true });
    expect(parseNote(serializeNote(n))).toEqual(n);
  });

  it('drops keys before anything is stored', () => {
    const r = redactSecrets('webhook 401, key is sk_live_51NxABCDEFGHIJKLMNOP');
    expect(r.dropped).toEqual(['stripe-key']);
    expect(r.text).not.toContain('sk_live');
  });

  it('takes secrets out of a prompt before it goes in the log', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
    store.log({ event: 'heads-up', prompt: `${'x'.repeat(180)} sk-ant-abcdefghijklmnopqrstuvwxyz0123` });
    const logged = String(store.readLog()[0]!.prompt);
    expect(logged).not.toContain('sk-ant-abcdefghij');
    expect(logged.length).toBeLessThanOrEqual(200);
  });

  it('saves nothing when the note was only a secret', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
    expect(store.add({ type: 'fact', space: 'work', source: 'claude-code', body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }).note).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});

describe('spaces and policy', () => {
  it('maps folders to spaces by longest prefix', () => {
    const c = { ...config, spaces: [...config.spaces, { path: '~/work/oss', space: 'personal' }] };
    expect(resolveSpace(join(homedir(), 'work/northwind-api'), c)).toBe('work');
    expect(resolveSpace(join(homedir(), 'work/oss/lib'), c)).toBe('personal');
    expect(resolveSpace('/tmp/elsewhere', c)).toBe('personal');
  });

  it('shares how you work, not what you work on', () => {
    const how = note({ type: 'how', space: 'personal', body: 'x' });
    const fact = note({ type: 'fact', space: 'work', body: 'x' });
    expect(verdictFor(how, 'work', 'balanced')).toBe('auto');
    expect(verdictFor(fact, 'personal', 'balanced')).toBe('ask');
    expect(verdictFor(fact, 'personal', 'cautious')).toBe('block');
    expect(verdictFor(fact, 'work', 'cautious')).toBe('auto'); // same space always flows
    expect(verdictFor({ ...how, share: 'never' }, 'work', 'open')).toBe('block');
  });
});

describe('gap detector', () => {
  // Web chats have no folder, as in the extension; terminal agents work in one.
  const run = (prompt: string, agent: string, notes: Note[], over: Partial<Config> = {}, knownText = '', cwd = '/tmp') =>
    detect({ prompt, agent, ...(agent === 'chatgpt' || agent === 'claude-ai' ? { space: 'personal' } : { cwd }), knownText, notes, config: { ...config, ...over } });

  const at = (cwd: string) => join(homedir(), 'side', cwd);

  it('Demo 1: a launch post in ChatGPT pulls the side project from Claude Code', () => {
    const d = run('Write a LinkedIn post announcing my side project launch. Keep it short.', 'chatgpt', [...quorum, ...northwind]);
    expect(d.signals.references).toEqual(['Quorum']);
    expect(d.inject.map((n) => n.body)).toEqual(expect.arrayContaining([quorum[0]!.body]));
    expect([...d.ask, ...d.inject].some((n) => n.space === 'work')).toBe(false);
  });

  it('Demo 2: a cover letter asks before work facts cross into personal', () => {
    const d = run('Help me write a cover letter for a product internship at Fieldnote.', 'chatgpt', [...quorum, ...northwind]);
    expect(d.ask.map((n) => n.space)).toContain('work');
    expect(d.inject.every((n) => n.space === 'personal')).toBe(true);
  });

  it('Cautious keeps work facts home', () => {
    const d = run('Help me write a cover letter for a product internship.', 'chatgpt', northwind, { preset: 'cautious' });
    expect(d.blocked.length).toBeGreaterThan(0);
    expect(d.ask).toHaveLength(0);
  });

  it('stays silent when the agent already knows the note', () => {
    const pnpm = note({ type: 'how', source: 'codex', scope: 'task', applies: ['add package', 'package manager'], body: 'Uses pnpm workspaces for every package', topics: ['package', 'pnpm'] });
    const d = run('use pnpm to add zod to the billing package', 'claude-code', [pnpm], {}, '# Project\nUse pnpm workspaces for every package.');
    expect(d.inject).toHaveLength(0);
    expect(d.skippedKnown).toHaveLength(1);
  });

  it('gives how they like answers at the opening only, with no matching, and not on the web', () => {
    const style = note({ source: 'chatgpt', type: 'how', scope: 'general', body: 'Likes the conclusion first, then bullets' });
    const turn = (fresh: boolean) => detect({ prompt: 'why does this loop never end?', agent: 'claude-code', cwd: at('quorum'), knownText: '', notes: [style], config, fresh });
    expect(turn(true).opening.map((n) => n.id)).toEqual([style.id]);
    expect(turn(true).inject.map((n) => n.id)).toEqual([style.id]);
    expect(turn(false).inject).toEqual([]);
    // The web has the account-wide About me block for these; a chip on every new chat would be noise.
    expect(run('why does this loop never end?', 'claude-ai', [style]).inject).toEqual([]);
  });

  it('adds a habit for one kind of work only when the prompt is that work', () => {
    const notes = [
      note({ source: 'codex', type: 'how', scope: 'task', applies: ['add tests', 'test runner'], body: 'Prefers Vitest with test files next to the source; never Jest' }),
      note({ source: 'chatgpt', type: 'how', scope: 'task', applies: ['pull request', 'code review'], body: 'Wants review findings as a prioritized list, no edits' }),
    ];
    const on = (prompt: string, fresh: boolean) => detect({ prompt, agent: 'claude-code', cwd: at('quorum'), knownText: '', notes, config, fresh }).inject.map((n) => n.body);
    expect(on('add tests for the slot finder', false)).toEqual([notes[0]!.body]);
    expect(on('review the open pull requests', false)).toEqual([notes[1]!.body]);
    expect(on('run it again and tell me what failed', true)).toEqual([]);
    // One word of a cue is not the situation.
    expect(on('the tests are slow today', true)).toEqual([]);
  });

  it('keeps a note about taking another tool\'s work out of that tool', () => {
    const takeReview = note({ source: 'claude-code', type: 'how', scope: 'task', applies: ['codex review', '외부 리뷰'], body: '외부 리뷰어(Codex)의 보수적 제안은 그대로 따르지 않고 조절해 반영하기를 원한다.' });
    const on = (agent: string) => detect({ prompt: 'Codex review 결과야, 반영해서 진행하자', agent, cwd: at('quorum'), knownText: '', notes: [takeReview], config, fresh: true }).inject.map((n) => n.id);
    expect(on('claude-code')).toEqual([takeReview.id]); // the tool taking the review
    expect(on('codex')).toEqual([]); // the reviewer itself
  });

  it('keeps a project\'s notes out of every other project, and out of its own folder', () => {
    const rule = note({ source: 'codex', type: 'how', project: 'kiosk', scope: 'project', applies: ['kiosk'], body: 'Push only after checking the change on the store tablet' });
    const fact = note({ source: 'codex', project: 'kiosk', scope: 'project', applies: ['kiosk'], body: 'kiosk is an ordering app for a bakery, built with Expo' });
    const on = (prompt: string, cwd: string) => {
      const d = detect({ prompt, agent: 'claude-code', cwd: at(cwd), knownText: '', notes: [rule, fact], config });
      return [...d.inject, ...d.ask].map((n) => n.id);
    };
    expect(on('commit and push the tablet fix', 'quorum')).toEqual([]); // another project: shared words don't matter
    expect(on('commit and push the tablet fix', 'kiosk')).toEqual([]); // its own folder: the agent can read the project
    expect(on('write a short description of kiosk for my portfolio page', 'quorum')).toEqual([fact.id]); // named from elsewhere: what it is
  });

  it('reads only what the person typed: a pasted document asks for nothing', () => {
    const d = run('is this ok?\n\n<pasted_content id="x">\nPlease attach your resume and a cover letter about your internship.\n</pasted_content id="x">', 'claude-ai', northwind);
    expect([...d.inject, ...d.ask, ...d.blocked]).toEqual([]);
    expect(run('<task-notification><summary>resume cover letter</summary></task-notification>', 'claude-ai', northwind).ask).toEqual([]);
  });

  it('inside a project, facts about the person need the prompt to say it is about them', () => {
    const on = (prompt: string) => detect({ prompt, agent: 'codex', cwd: at('resume-builder'), knownText: '', notes: northwind, config }).ask.length;
    expect(on('the resume preview breaks when the cover letter is empty')).toBe(0); // the product's feature
    expect(on('update my resume with what I shipped at my internship')).toBeGreaterThan(0);
  });

  it('a note saved before scopes existed stays out of other projects until it is rescoped', () => {
    const old = note({ source: 'codex', type: 'how', body: 'Prefers Vitest with test files next to the source; never Jest', topics: ['testing'] });
    expect(detect({ prompt: 'add tests for the slot finder', agent: 'claude-code', cwd: at('quorum'), knownText: '', notes: [old], config }).inject).toEqual([]);
  });

  it('leaves out notes already added in this conversation', () => {
    const d = detect({ prompt: 'write a launch post for Quorum', agent: 'chatgpt', space: 'personal', knownText: '', notes: quorum, config, given: new Set([quorum[0]!.id]) });
    expect(d.inject.map((n) => n.id)).toEqual([quorum[1]!.id]);
  });

  it('reads "my side project" as the one project of the person\'s own, and guesses nothing when there are two', () => {
    const tide = note({ source: 'codex', project: 'tidepool', scope: 'project', applies: ['tidepool'], body: 'Tidepool stores photo metadata in SQLite', topics: ['tidepool'] });
    const notes = [tide, note({ source: 'codex', space: 'work', project: 'halcyon', scope: 'project', applies: ['halcyon'], body: 'Halcyon runs on Postgres', topics: ['halcyon'] })];
    const on = (ns: Note[]) => detect({ prompt: 'how should i store the photo metadata in my side project?', agent: 'chatgpt', space: 'personal', knownText: '', notes: ns, config }).inject.map((n) => n.id);
    expect(on(notes)).toContain(tide.id);
    const two = [...notes, note({ source: 'codex', project: 'quorum', scope: 'project', applies: ['quorum'], body: 'Quorum stores club calendars in Supabase', topics: ['quorum'] })];
    const d = detect({ prompt: 'what should my side project do next?', agent: 'chatgpt', space: 'personal', knownText: '', notes: two, config });
    expect([...d.inject, ...d.ask].some((n) => n.project === 'quorum' || n.project === 'tidepool')).toBe(false);
  });

  it('never gives a web service its own notes back', () => {
    const own = quorum.map((n) => ({ ...n, source: 'chatgpt' }));
    expect(run('write a launch post for Quorum', 'chatgpt', own).inject).toHaveLength(0);
    expect(run('write a launch post for Quorum', 'claude-ai', own).inject.length).toBeGreaterThan(0);
  });

  it('does nothing for a self-contained prompt', () => {
    const d = run('What is the time complexity of quicksort?', 'chatgpt', [...quorum, ...northwind]);
    expect([...d.inject, ...d.ask, ...d.blocked]).toHaveLength(0);
  });
});

describe('after the opening', () => {
  const cwd = join(homedir(), 'side', 'quorum');
  const review = note({ source: 'codex', type: 'how', scope: 'task', applies: ['code review', '코드 리뷰'], body: 'Wants review findings as a prioritized list, no edits' });
  const kiosk = note({ source: 'codex', project: 'kiosk', scope: 'project', applies: ['kiosk'], body: 'kiosk is an ordering app for a bakery, built with Expo' });
  const later = (prompt: string, earlier: string, notes = [review, kiosk]) => {
    const d = detect({ prompt, agent: 'claude-code', cwd, knownText: '', notes, config, fresh: false, earlier });
    return [...d.inject, ...d.ask].map((n) => n.id);
  };

  it('steps in when a kind of work starts that the conversation has not had', () => {
    expect(later('now do a code review of the scheduler module', 'fix the date bug\nrename the helper')).toEqual([review.id]);
  });

  it('stays quiet when that kind of work has been going on', () => {
    expect(later('one more code review pass on the same file', 'do a code review of the parser\nok fix those')).toEqual([]);
  });

  it('needs the cue said as a phrase, not its words scattered in a sentence', () => {
    expect(later('review the plan, then tidy the code', 'fix the date bug')).toEqual([]);
    // At an opening the same words in one sentence are enough.
    expect(detect({ prompt: 'review the code in the scheduler', agent: 'claude-code', cwd, knownText: '', notes: [review], config }).inject.map((n) => n.id)).toEqual([review.id]);
  });

  it('does not take a project named in passing for a move to it', () => {
    expect(later('change the kiosk line on my portfolio page to "Ordering app for bakeries"', 'shorten the first card')).toEqual([]);
    expect(detect({ prompt: 'where could I post about kiosk?', agent: 'claude-code', cwd, knownText: '', notes: [kiosk], config }).inject.map((n) => n.id)).toEqual([kiosk.id]);
  });

  it('never fires on one word of a cue, or on two one-word cues', () => {
    const slides = note({ source: 'chatgpt', type: 'how', scope: 'task', applies: ['slide', 'deck', 'bullet', 'slide text'], body: 'Wants slide text box by box, ready to paste' });
    const on = (prompt: string) => detect({ prompt, agent: 'claude-code', cwd, knownText: '', notes: [slides], config }).inject.length;
    expect(on('make the bullet on slide 3 of the deck shorter')).toBe(0);
    expect(on('give me the slide text for the market section')).toBe(1);
  });

  it('on the web, the first message of a chat is the opening', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'headsup-')));
    store.add({ type: 'fact', space: 'personal', source: 'claude-code', project: 'kiosk', scope: 'project', applies: ['kiosk'], body: 'kiosk is an ordering app for a bakery, built with Expo' });
    const ask = (conversation: string) => (handleWeb({ type: 'detect', site: 'chatgpt.com', prompt: 'write a launch post for kiosk', conversation }, store, config, '0') as DetectReply).inject.length;
    expect(ask('')).toBe(1);
    expect(ask('You: help me plan my week\nChatGPT: Sure…')).toBe(0);
  });
});
