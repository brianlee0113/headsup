// What the extension asks the core, through the native host. Typing only asks ("detect"); the log
// is written once the message is actually sent ("sent"), so review shows real heads-ups only.

import { spawn } from 'node:child_process';
import { aboutLines } from './about.js';
import { agentName } from './agents.js';
import type { Config } from './config.js';
import { detect } from './gap.js';
import { learningOn, recordRemoved, recordShown, resting } from './learning.js';
import type { Note } from './note.js';
import type { WebNote } from './shared/block.js';
import type { Store } from './store.js';
import { handleSync, syncStatus, type SyncRequest } from './sync.js';

export const SITES: Record<string, string> = { 'chatgpt.com': 'chatgpt', 'claude.ai': 'claude-ai' };

export type WebRequest =
  | { type: 'status' }
  | { type: 'detect'; site: string; prompt: string; conversation?: string }
  | { type: 'sent'; site: string; prompt: string; injected: string[]; offered: string[]; included: string[]; blocked: string[]; removed?: string[] }
  | { type: 'about-me'; site: string; room: number }
  | { type: 'about-written'; site: string; ids: string[] }
  | { type: 'card' }
  | SyncRequest;

export interface DetectReply {
  type: 'detect';
  inject: WebNote[];
  ask: WebNote[];
  blocked: { count: number; topics: string[]; ids: string[] };
  space: string;
}

const view = (n: Note): WebNote => ({
  id: n.id,
  type: n.type,
  body: n.body,
  topics: n.topics,
  from: n.project && n.source === 'claude-code' ? `${agentName(n.source)} (${n.project})` : agentName(n.source),
  space: n.space,
});

export function handleWeb(req: WebRequest, store: Store, config: Config, version: string): unknown {
  switch (req.type) {
    case 'status': {
      const notes = store.list();
      return { type: 'status', version, notes: notes.length, preset: config.preset, space: config.defaultSpace, sync: syncStatus(store) };
    }
    case 'sync-start':
    case 'sync-chats':
      return handleSync(req, store);
    case 'about-me': {
      const agent = SITES[req.site];
      if (!agent) return { type: 'error', message: `headsup doesn't know ${req.site}` };
      return { type: 'about-me', ...aboutLines(store.list(), config, agent, req.room) };
    }
    case 'about-written':
      store.log({ event: 'about-me', agent: SITES[req.site] ?? req.site, notes: req.ids });
      return { type: 'ok' };
    case 'card': {
      // The popup's "Share my card": the native host must answer at once, so the page runs on its own.
      const port = 41000 + Math.floor(Math.random() * 1000);
      spawn(process.execPath, [process.argv[1]!, 'card', '--port', String(port), '--no-open'], { detached: true, stdio: 'ignore' }).unref();
      return { type: 'card', url: `http://localhost:${port}/` };
    }
    case 'detect': {
      const agent = SITES[req.site];
      if (!agent) return { type: 'error', message: `headsup doesn't know ${req.site}` };
      const d = detect({
        prompt: req.prompt, agent, space: config.defaultSpace, knownText: req.conversation ?? '', notes: store.list(), config,
        ...(learningOn(config) ? { resting: new Set(resting(store.home).keys()) } : {}),
      });
      const reply: DetectReply = {
        type: 'detect',
        inject: d.inject.map(view),
        ask: d.ask.map(view),
        blocked: { count: d.blocked.length, topics: [...new Set(d.blocked.flatMap((n) => n.topics))].slice(0, 4), ids: d.blocked.map((n) => n.id) },
        space: d.targetSpace,
      };
      return reply;
    }
    case 'sent': {
      const agent = SITES[req.site] ?? req.site;
      store.countPrompt();
      if (!req.injected.length && !req.offered.length && !req.blocked.length) return { type: 'ok' };
      const session = `web-${Date.now()}`;
      store.log({
        event: 'heads-up', agent, session, targetSpace: config.defaultSpace, prompt: req.prompt.slice(0, 200), signals: {},
        injected: req.injected, asked: req.offered, blocked: req.blocked, skippedKnown: [],
      });
      // On the web the answer comes before sending: ticked notes count as shared, the rest as declined.
      if (req.offered.length) {
        const declined = req.offered.filter((id) => !req.included.includes(id));
        store.log(req.included.length
          ? { event: 'shared-after-ask', agent, session, notes: req.included }
          : { event: 'declined', agent, session, notes: declined });
      }
      if (learningOn(config)) {
        // On the web the person sees the notes before sending: an unticked note or a declined offer was taken out.
        recordRemoved(store.home, [...(req.removed ?? []), ...req.offered.filter((id) => !req.included.includes(id))]);
        recordShown(store.home, [...req.injected, ...req.included]);
      }
      return { type: 'ok' };
    }
    default:
      return { type: 'error', message: `unknown request "${(req as { type?: string }).type ?? ''}"` };
  }
}
