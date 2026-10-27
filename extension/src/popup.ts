// The toolbar popup: is headsup reachable, is it on for the site in the current tab, and is each
// account catching up.

import { aboutBlock } from '../../src/shared/about.js';
import type { Part } from './sites.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SITES = ['chatgpt.com', 'claude.ai'];

type SiteSync = { since: string; lastCaught: string | null; queued: number; notesToday: number } | null;
type Pref = { on?: boolean; backfill?: boolean };
const NAMES: Record<string, string> = { 'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude' };

const BROKEN: Record<Exclude<Part, 'chat list'>, string> = {
  composer: "headsup can't find the message box, so the headsup mark and your notes are off on this page.",
  'send button': "headsup can't find the send button, so clicking Send goes out without your notes. Pressing Enter still adds them.",
  messages: "headsup can't read the conversation, so sent notes won't fold away and notes the AI already has may be added again.",
};

async function main(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null)) as
    | { type: 'status'; version: string; notes: number; preset: string; sync?: Record<string, SiteSync>; waiting?: number }
    | { type: 'error'; message: string }
    | null;

  if (!status || status.type !== 'status') {
    $('dot').className = 'dot bad';
    $('status').textContent = 'Not connected';
    $('unreachable').hidden = false;
    return;
  }
  $('dot').className = 'dot ok';
  $('status').textContent = 'Connected';
  $('summary').textContent = `${status.notes} note${status.notes === 1 ? '' : 's'} on this computer · sharing: ${status.preset[0]!.toUpperCase()}${status.preset.slice(1)}` +
    // Older chat notes are held back until sorted into work and personal; say so only if that got stuck.
    (status.waiting ? ` · ${status.waiting} older chat note${status.waiting === 1 ? '' : 's'} waiting to be sorted (headsup recheck-spaces)` : '');
  $('connected').hidden = false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await showSync(status.sync ?? {}, tab);
  await showAbout();
  $('card').hidden = false;
  $('card').onclick = async (e) => {
    e.preventDefault();
    const r = (await chrome.runtime.sendMessage({ type: 'card' }).catch(() => null)) as { type: string; url?: string } | null;
    // The page needs a moment to start listening.
    if (r?.url) setTimeout(() => void chrome.tabs.create({ url: r.url }), 600);
  };
  await showSite(tab);
}

const clock = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
};

async function showSync(sync: Record<string, SiteSync>, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const keys = SITES.map((s) => `sync:${s}`);
  const prefs = (await chrome.storage.local.get(keys)) as Record<string, Pref | undefined>;
  const progress = (await chrome.storage.session.get(SITES.map((s) => `progress:${s}`))) as Record<string, { done: number; total: number; at: number } | undefined>;

  // Asked once: nothing is read from either account before this is answered.
  const decided = SITES.some((s) => prefs[`sync:${s}`] !== undefined);
  $('first-run').hidden = decided;
  const decide = (backfill: boolean) => () =>
    void chrome.storage.local.set(Object.fromEntries(SITES.map((s) => [`sync:${s}`, { on: true, backfill }]))).then(() => location.reload());
  $('backfill-yes').onclick = decide(true);
  $('backfill-no').onclick = decide(false);

  for (const site of SITES) {
    const row = document.querySelector<HTMLElement>(`[data-sync="${site}"]`)!;
    const toggle = row.querySelector<HTMLInputElement>('input')!;
    const detail = row.querySelector<HTMLElement>('[data-detail]')!;
    const pref = prefs[`sync:${site}`];
    const state = sync[site];
    const p = progress[`progress:${site}`];
    toggle.checked = !!pref?.on;
    toggle.disabled = !decided;
    row.classList.toggle('off', !decided);
    toggle.onchange = () => void chrome.storage.local.set({ [`sync:${site}`]: { ...pref, on: toggle.checked } }).then(() => location.reload());
    const lead = site === 'chatgpt.com' ? 'Phone and desktop app chats too.' : 'claude.ai and the Claude apps.';
    let line: string;
    if (!pref?.on) line = `${lead} Off.`;
    else if (p && p.done < p.total && Date.now() - p.at < 60_000) line = `Reading ${NAMES[site]} · ${p.done} of ${p.total}. Keep a ${site} tab open; it picks up where it left off.`;
    else if (state?.lastCaught) line = `${lead} Caught up ${clock(state.lastCaught)}, when you opened ${site}${state.notesToday ? ` · ${state.notesToday} note${state.notesToday === 1 ? '' : 's'} today` : ''}.`;
    else line = `${lead} Catches up the next time you open ${site}.`;
    if (pref?.on && state?.queued) line += ` ${state.queued} waiting to be summarized.`;
    detail.textContent = line;
  }

  // The list API answered in a shape headsup doesn't know (reported per tab, like the page health).
  if (tab?.id === undefined) return;
  const healthKey = `health:${tab.id}`;
  const missing = ((await chrome.storage.session.get(healthKey))[healthKey] ?? []) as Part[];
  const host = tab.url ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
  if (missing.includes('chat list') && NAMES[host]) {
    $('sync-broken-title').textContent = `${host} changed how it lists chats`;
    $('sync-broken-line').textContent = `headsup can't read your new ${NAMES[host]} chats right now, so they aren't becoming notes. Adding context as you type still works.`;
    $('sync-broken').hidden = false;
  }
}

type AboutStatus = { at: number; on: boolean; lines?: number; error?: 'changed' | 'failed' };

async function showAbout(): Promise<void> {
  const keys = ['about', 'sync:chatgpt.com', 'sync:claude.ai', ...SITES.map((s) => `about:${s}`)];
  const got = (await chrome.storage.local.get(keys)) as Record<string, unknown>;
  const on = got.about as boolean | undefined;
  const toggle = $<HTMLInputElement>('about-toggle');
  const set = (value: boolean) => void chrome.storage.local.set({ about: value }).then(() => location.reload());

  // Asked once, after the chats question, and off until the person says yes.
  const syncDecided = got['sync:chatgpt.com'] !== undefined || got['sync:claude.ai'] !== undefined;
  $('about-ask').hidden = !syncDecided || on !== undefined;
  $('about-yes').onclick = () => set(true);
  $('about-no').onclick = () => set(false);
  toggle.checked = !!on;
  toggle.onchange = () => set(toggle.checked);

  let line = 'In ChatGPT and Claude, so their phone and desktop apps know how you work.';
  if (on) {
    const done = SITES.flatMap((s) => {
      const st = got[`about:${s}`] as AboutStatus | undefined;
      if (!st?.on) return [];
      if (st.error === 'changed') return [`${NAMES[s]}: ${s} changed its settings, so it can't be updated right now.`];
      if (st.error) return [`${NAMES[s]}: couldn't update; tries again next time.`];
      return [`${NAMES[s]} ${clock(new Date(st.at).toISOString())}`];
    });
    line = done.length ? `Updated ${done.join(' · ')}.` : 'Updates the next time you open chatgpt.com or claude.ai.';
  }
  $('about-detail').textContent = line;

  $('about-show').onclick = async (e) => {
    e.preventDefault();
    const pre = $('about-preview');
    if (!pre.hidden) return void (pre.hidden = true);
    const r = (await chrome.runtime.sendMessage({ type: 'about-me', site: 'chatgpt.com', room: 1200 }).catch(() => null)) as { type: string; lines?: string[] } | null;
    pre.textContent = r?.type === 'about-me' && r.lines?.length ? aboutBlock(r.lines) : 'Nothing to write yet: no how-you-work or personal notes.';
    pre.hidden = false;
  };
}

async function showSite(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const host = tab?.url ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
  const site = SITES.find((s) => host === s || host.endsWith(`.${s}`));
  const toggle = $<HTMLInputElement>('site-toggle');
  if (!site) {
    $('site-title').textContent = 'Works on chatgpt.com and claude.ai';
    toggle.disabled = true;
    return;
  }
  const key = `site:${site}`;
  $('site-title').textContent = `Add context on ${site}`;
  toggle.checked = (await chrome.storage.local.get(key))[key] !== false;
  toggle.addEventListener('change', () => void chrome.storage.local.set({ [key]: toggle.checked }));

  const healthKey = `health:${tab!.id}`;
  const missing = (((await chrome.storage.session.get(healthKey))[healthKey] ?? []) as Part[]).filter((p) => p !== 'chat list') as Array<keyof typeof BROKEN>;
  if (missing.length) {
    $('broken-title').textContent = `${site} changed its page`;
    $('broken-lines').replaceChildren(...missing.map((part) => Object.assign(document.createElement('p'), { textContent: BROKEN[part] })));
    $('broken').hidden = false;
  }
}

void main();
