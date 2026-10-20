// The toolbar popup: is headsup reachable, and is it on for the site in the current tab.

import type { Part } from './sites.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SITES = ['chatgpt.com', 'claude.ai'];

const BROKEN: Record<Part, string> = {
  composer: "headsup can't find the message box, so the ◆ mark and your notes are off on this page.",
  'send button': "headsup can't find the send button, so clicking Send goes out without your notes. Pressing Enter still adds them.",
  messages: "headsup can't read the conversation, so sent notes won't fold away and notes the AI already has may be added again.",
};

async function main(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null)) as
    | { type: 'status'; version: string; notes: number; preset: string }
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
  $('summary').textContent = `${status.notes} note${status.notes === 1 ? '' : 's'} on this computer · sharing: ${status.preset[0]!.toUpperCase()}${status.preset.slice(1)}`;
  $('connected').hidden = false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
  const missing = ((await chrome.storage.session.get(healthKey))[healthKey] ?? []) as Part[];
  if (missing.length) {
    $('broken-title').textContent = `${site} changed its page`;
    $('broken-lines').replaceChildren(...missing.map((part) => Object.assign(document.createElement('p'), { textContent: BROKEN[part] })));
    $('broken').hidden = false;
  }
}

void main();
