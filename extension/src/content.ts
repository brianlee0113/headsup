// Runs on chatgpt.com and claude.ai. Watches the draft, shows the headsup mark by the composer, adds the
// ticked notes at the end of the message when it is sent, and folds that block in sent messages.

import { aboutBlock, ownText, spliceAbout } from '../../src/shared/about.js';
import { BLOCK_MARKER, buildBlock, splitBlock, type WebNote } from '../../src/shared/block.js';
import { accountFor, ShapeError } from './account.js';
import { ACCENT, glyph } from './brand.js';
import { siteFor, type Part, type Site } from './sites.js';

interface Detect {
  type: 'detect';
  inject: WebNote[];
  ask: WebNote[];
  blocked: { count: number; topics: string[]; ids: string[] };
  space: string;
}
type Reply = Detect | { type: 'error'; message: string; unreachable?: boolean } | { type: string };

const DEBOUNCE_MS = 450;
const MIN_PROMPT = 8;
const HEALTH_GRACE_MS = 8000;
const SYNC_DELAY_MS = 5000; // let the page load its own requests first
const SYNC_GAP_MS = 1000; // between chat fetches, so a backfill reads like a person scrolling, not a burst
const SYNC_AGAIN_MS = 30 * 60_000; // a tab left open catches up again when it comes back to the front
const SYNC_BATCH = 5;
const ABOUT_ROOM = 1200; // the block stays short even where the site allows far more

const site = siteFor(location.hostname);
if (site) start(site);

function start(site: Site): void {
  const state = {
    enabled: true,
    detect: null as Detect | null,
    unreachable: false,
    unchecked: new Set<string>(),
    askAccepted: false,
    open: false,
  };
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bypass = false; // our own re-submit must pass through untouched
  const storageKey = `site:${site.host}`;

  // ---------- UI (shadow DOM, so the page's CSS can't reach it and ours can't leak) ----------
  const host = document.createElement('headsup-root');
  host.style.cssText = 'position:fixed;inset:auto;z-index:2147483000;top:0;left:0;';
  const root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const dark = () =>
    document.documentElement.classList.contains('dark') ||
    document.documentElement.dataset.mode === 'dark' ||
    (!document.documentElement.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches);

  const included = (): WebNote[] => {
    const d = state.detect;
    if (!d) return [];
    return [...d.inject, ...(state.askAccepted ? d.ask : [])].filter((n) => !state.unchecked.has(n.id));
  };

  function chipLabel(): [string, string] {
    if (!state.enabled) return ['paused', 'paused on this site'];
    if (state.unreachable) return ['paused', 'not connected'];
    const d = state.detect;
    if (!d || (!d.inject.length && !d.ask.length && !d.blocked.count)) return ['quiet', ''];
    const going = d.inject.filter((n) => !state.unchecked.has(n.id)).length;
    const asking = d.ask.length && !state.askAccepted ? d.ask.length : 0;
    if (asking) return ['needs', going ? `${plural(going, 'note')} · ${asking} need${asking === 1 ? 's' : ''} your OK` : `${asking} ${d.ask[0]!.space} note${asking === 1 ? ' needs' : 's need'} your OK`];
    const sending = included();
    if (!sending.length) return ['quiet', ''];
    const sources = [...new Set(sending.map((n) => n.from.replace(/ \(.*\)$/, '')))];
    return ['attached', `${plural(sending.length, 'note')} · ${sources.length === 1 ? sources[0] : `${sources.length} tools`}`];
  }

  const noteRow = (n: WebNote, checked: boolean) => `
    <label class="note">
      <input type="checkbox" data-id="${esc(n.id)}" ${checked ? 'checked' : ''}>
      <span class="tag ${n.type}">${n.type === 'how' ? 'how you work' : 'fact'}</span>
      <span class="body">${esc(n.body)}</span>
      <span class="origin">${esc(n.from)}</span>
    </label>`;

  function popover(): string {
    if (!state.enabled) {
      return `<p class="line">headsup is paused on ${site.host}.</p><div class="actions"><button class="primary" data-action="resume">Resume</button></div>`;
    }
    if (state.unreachable) {
      return `<p class="line">headsup isn't running on this computer, so nothing is being added.</p>
        <code>npx headsup-ai connect-browser</code>
        <p class="muted">Setup finds Chrome and connects this extension by itself.</p>`;
    }
    const d = state.detect;
    const parts: string[] = [];
    const sending = included();
    parts.push(`<div class="head"><b>${glyph(true)}heads-up</b><span>${sending.length ? `${plural(sending.length, 'note')} will go in with this message` : 'Nothing to add for this message'}</span></div>`);
    if (d?.inject.length) parts.push(d.inject.map((n) => noteRow(n, !state.unchecked.has(n.id))).join(''));
    if (d?.ask.length) {
      parts.push(`<p class="section">From your ${esc(d.ask[0]!.space)} space — ${state.askAccepted ? 'included' : 'needs your OK'}</p>`);
      parts.push(d.ask.map((n) => noteRow(n, !state.unchecked.has(n.id))).join(''));
      parts.push(state.askAccepted
        ? `<div class="actions"><span class="muted">Ticked ones go in with this message.</span><button data-action="unaccept">Leave them out</button></div>`
        : `<div class="actions"><button class="primary" data-action="accept">Include ticked</button><span class="muted">Left out unless you include them.</span></div>`);
    }
    if (d?.blocked.count) parts.push(`<p class="muted">${plural(d.blocked.count, 'note')} stayed home${d.blocked.topics.length ? ` (${esc(d.blocked.topics.join(', '))})` : ''} · your sharing preset</p>`);
    parts.push(`<p class="muted foot">Goes at the end of your message as a short context block · untick to leave one out · <a data-action="pause">pause on this site</a></p>`);
    return parts.join('');
  }

  function render(): void {
    const [kind, label] = chipLabel();
    root.innerHTML = `<style>${css}</style>
      <div class="wrap ${dark() ? 'dark' : 'light'}">
        ${state.open ? `<div class="pop">${popover()}</div>` : ''}
        <button class="chip ${kind}" data-action="toggle" title="headsup">${glyph(kind === 'attached' || kind === 'needs')}${label ? `<span>${esc(label)}</span>` : ''}</button>
      </div>`;
    place();
  }

  // Follows the composer as the page scrolls, resizes and remounts it, without redrawing.
  function place(): void {
    const composer = site.composer();
    host.style.display = composer ? '' : 'none';
    if (!composer) return;
    const r = site.anchor(composer).getBoundingClientRect();
    const right = `${Math.max(8, innerWidth - r.right + 12)}px`;
    const chip = root.querySelector<HTMLElement>('.chip');
    const pop = root.querySelector<HTMLElement>('.pop');
    if (chip) Object.assign(chip.style, { right, top: `${Math.max(4, r.top - 34)}px` });
    if (pop) Object.assign(pop.style, { right, bottom: `${innerHeight - r.top + 44}px` });
  }

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'toggle') state.open = !state.open;
    if (action === 'accept') state.askAccepted = true;
    if (action === 'unaccept') state.askAccepted = false;
    if (action === 'pause' || action === 'resume') {
      state.enabled = action === 'resume';
      void chrome.storage.local.set({ [storageKey]: state.enabled });
      if (state.enabled) void ask();
    }
    render();
  });
  root.addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    const id = box.dataset.id;
    if (!id) return;
    if (box.checked) state.unchecked.delete(id);
    else state.unchecked.add(id);
    render();
  });

  // ---------- Noticing when the site changed under us ----------
  // A selector that stops matching fails silently: the send button goes out without notes, folding
  // and the already-known check stop. The popup and the toolbar icon say so instead.
  const missing = new Set<Part>();
  const reportHealth = () => void send({ type: 'health', site: site.host, missing: [...missing] }).catch(() => {});
  function check(part: Part, found: boolean): void {
    if (found === !missing.has(part)) return;
    if (found) missing.delete(part);
    else missing.add(part);
    reportHealth();
  }
  let path = location.pathname;
  let since = Date.now();
  function checkPage(): void {
    if (location.pathname !== path) [path, since] = [location.pathname, Date.now()];
    // Give a conversation time to load before calling anything missing.
    if (!site.chatPage(path) || Date.now() - since < HEALTH_GRACE_MS || document.hidden) return;
    check('composer', !!site.composer());
    check('messages', site.userMessages().length > 0);
  }

  // ---------- Catching up on the account ----------
  // Only while this site is open, and only once the person said yes in the popup. Chats from the
  // phone and desktop apps are in the same account lists, so they come in this way too.
  const syncKey = `sync:${site.host}`;
  let syncing = false;
  let lastSync = 0;
  async function catchUp(): Promise<void> {
    if (syncing || document.hidden) return;
    const pref = (await chrome.storage.local.get(syncKey))[syncKey] as { on?: boolean; backfill?: boolean } | undefined;
    const account = accountFor(site.host);
    if (!pref?.on || !account) return;
    const lock = await send({ type: 'sync-lock', site: site.host }).catch(() => null);
    if (lock?.type !== 'ok') return; // another tab of this site is already on it
    syncing = true;
    lastSync = Date.now();
    const hand = async (chats: unknown[], done: boolean) => {
      const r = await send({ type: 'sync-chats', site: site.host, chats, done });
      // The core refuses a chat shape it doesn't know; that is the site changing, not a hiccup.
      if (r.type === 'error') throw 'unreachable' in r && r.unreachable ? new Error((r as { message: string }).message) : new ShapeError((r as { message: string }).message);
    };
    try {
      const start = (await send({ type: 'sync-start', site: site.host, backfill: !!pref.backfill })) as { type: string; since?: string; seen?: Record<string, string> };
      if (start.type !== 'sync-start') return;
      const ids = await account.changed(new Date(start.since!).getTime(), start.seen ?? {});
      const progress = (done: number) => void send({ type: 'sync-progress', site: site.host, done, total: ids.length }).catch(() => {});
      progress(0);
      let batch: unknown[] = [];
      for (const [i, id] of ids.entries()) {
        batch.push(await account.chat(id));
        if (batch.length === SYNC_BATCH || i === ids.length - 1) {
          await hand(batch, false);
          batch = [];
        }
        progress(i + 1);
        await new Promise((r) => setTimeout(r, SYNC_GAP_MS));
      }
      await hand([], true);
      check('chat list', true);
    } catch (err) {
      if (err instanceof ShapeError) check('chat list', false);
      // Anything else (signed out, rate limited, offline) waits for the next time the site is opened.
    } finally {
      syncing = false;
      void send({ type: 'sync-unlock', site: site.host }).catch(() => {});
    }
  }

  // ---------- Keeping "About me" current ----------
  // The phone and desktop apps can't see headsup, but they read ChatGPT's custom instructions and
  // Claude's personal preferences. headsup keeps one fenced block there; turning it off removes it.
  const aboutStatus = `about:${site.host}`;
  let lastAbout = 0;
  async function keepAbout(): Promise<void> {
    if (document.hidden) return;
    lastAbout = Date.now();
    const on = (await chrome.storage.local.get('about')).about as boolean | undefined;
    const account = accountFor(site.host);
    if (on === undefined || !account) return; // not asked yet: the field is never touched
    try {
      const field = await account.about();
      let lines: string[] = [];
      let ids: string[] = [];
      if (on) {
        const room = Math.min(ABOUT_ROOM, field.limit - ownText(field.text).length - 2);
        const r = (await send({ type: 'about-me', site: site.host, room })) as { type: string; lines?: string[]; ids?: string[] };
        if (r.type !== 'about-me') return; // headsup unreachable: try again next time
        [lines, ids] = [r.lines ?? [], r.ids ?? []];
      }
      const next = spliceAbout(field.text, aboutBlock(lines));
      if (next !== field.text) {
        await field.write(next);
        if (lines.length) void send({ type: 'about-written', site: site.host, ids }).catch(() => {});
      }
      await chrome.storage.local.set({ [aboutStatus]: { at: Date.now(), on, lines: lines.length } });
    } catch (err) {
      // "changed": the settings API answered in a shape headsup doesn't know.
      await chrome.storage.local.set({ [aboutStatus]: { at: Date.now(), on, error: err instanceof ShapeError ? 'changed' : 'failed' } });
    }
  }

  setTimeout(() => {
    void catchUp();
    void keepAbout();
  }, SYNC_DELAY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (Date.now() - lastSync > SYNC_AGAIN_MS) void catchUp();
    if (Date.now() - lastAbout > SYNC_AGAIN_MS) void keepAbout();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (syncKey in changes) void catchUp(); // turned on in the popup while this tab was open
    if ('about' in changes) {
      lastAbout = 0; // a background tab skips this run, so it runs again as soon as the tab is seen
      void keepAbout();
    }
  });

  // ---------- Asking the core ----------
  const send = (message: unknown) => chrome.runtime.sendMessage(message) as Promise<Reply>;
  const draft = () => (site.composer()?.innerText ?? '').trim();

  async function ask(): Promise<void> {
    const prompt = draft();
    const mine = ++seq;
    if (!state.enabled || prompt.length < MIN_PROMPT) {
      state.detect = null;
      render();
      return;
    }
    check('send button', !!site.sendButton()); // the sites show it once there is a draft
    const reply = await send({ type: 'detect', site: site.host, prompt, conversation: site.conversationText() }).catch(() => null);
    if (mine !== seq) return; // the draft changed while we waited
    state.unreachable = !!reply && reply.type === 'error' && 'unreachable' in reply && !!reply.unreachable;
    if (reply && reply.type === 'detect') {
      const d = reply as Detect;
      // Keep the user's unticks for notes that are still suggested.
      const ids = new Set([...d.inject, ...d.ask].map((n) => n.id));
      for (const id of state.unchecked) if (!ids.has(id)) state.unchecked.delete(id);
      if (!d.ask.length) state.askAccepted = false;
      state.detect = d;
    }
    render();
  }

  document.addEventListener('input', (e) => {
    const composer = site.composer();
    if (!composer || !composer.contains(e.target as Node) || bypass) return;
    clearTimeout(timer);
    timer = setTimeout(() => void ask(), DEBOUNCE_MS);
  }, true);

  // ---------- Sending ----------
  function appendBlock(composer: HTMLElement, text: string): void {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(composer, composer.value + text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // Rich editors (ProseMirror) take pasted text as real paragraphs; insertText is the fallback.
    const data = new DataTransfer();
    data.setData('text/plain', text);
    composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    if (!composer.innerText.includes(BLOCK_MARKER)) document.execCommand('insertText', false, text);
  }

  function submit(composer: HTMLElement): void {
    bypass = true;
    const button = site.sendButton();
    if (button && !button.disabled) button.click();
    else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    setTimeout(() => (bypass = false), 0);
  }

  function report(prompt: string, notes: WebNote[]): void {
    const d = state.detect;
    if (!d) return;
    const ids = new Set(notes.map((n) => n.id));
    void send({
      type: 'sent',
      site: site.host,
      prompt,
      injected: d.inject.filter((n) => ids.has(n.id)).map((n) => n.id),
      offered: d.ask.map((n) => n.id),
      included: d.ask.filter((n) => ids.has(n.id)).map((n) => n.id),
      blocked: d.blocked.ids,
    });
    state.detect = null;
    state.unchecked.clear();
    state.askAccepted = false;
    state.open = false;
    render();
  }

  // Returns true when the send was taken over to add notes first.
  function onSend(e: Event): boolean {
    const composer = site.composer();
    if (!composer || !state.enabled) return false;
    clearTimeout(timer);
    const prompt = draft();
    const notes = included();
    if (!notes.length || composer.innerText.includes(BLOCK_MARKER)) {
      report(prompt, []);
      return false;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    appendBlock(composer, buildBlock(notes));
    report(prompt, notes);
    setTimeout(() => submit(composer), 60); // let the editor settle before the real send
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (bypass || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const composer = site.composer();
    if (composer && composer.contains(e.target as Node)) onSend(e);
  }, true);

  document.addEventListener('click', (e) => {
    if (bypass) return;
    const button = site.sendButton();
    if (button && button.contains(e.target as Node)) onSend(e);
  }, true);

  // ---------- Folding the block in sent messages ----------
  function fold(message: HTMLElement): void {
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let at = nodes.findIndex((n) => n.data.includes(BLOCK_MARKER));
    if (at < 0) return;
    let offset = nodes[at]!.data.indexOf(BLOCK_MARKER);
    const mark = /[◆⌃] ?$/.exec(nodes[at]!.data.slice(0, offset));
    if (mark) offset -= mark[0].length;
    const dash = nodes[at]!.data.lastIndexOf('---', offset);
    if (dash >= 0 && offset - dash < 8) offset = dash;
    else if (at > 0 && nodes[at - 1]!.data.trim() === '---') {
      at--;
      offset = 0;
    }
    // The line break before the block goes too, so the pill sits right after the typed text.
    while (offset > 0 && /\s/.test(nodes[at]!.data[offset - 1]!)) offset--;
    const start = offset > 0 ? nodes[at]!.splitText(offset) : nodes[at]!;
    const hidden = [start, ...nodes.slice(at + 1)];
    const count = splitBlock(message.innerText)?.count ?? 0;
    const spans = hidden.map((n) => {
      const span = document.createElement('span');
      span.className = 'headsup-folded';
      span.style.display = 'none';
      n.parentNode!.insertBefore(span, n);
      span.appendChild(n);
      return span;
    });
    const pill = document.createElement('span');
    pill.className = 'headsup-pill';
    pill.innerHTML = `${glyph(true)}${plural(count, 'note')}`;
    pill.title = 'Added by headsup — click to show';
    pill.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;font:11px/16px ui-monospace,Menlo,monospace;color:inherit;background:rgba(255,61,139,.14);cursor:pointer;vertical-align:middle;';
    const dot = pill.querySelector<SVGElement>('.dot');
    if (dot) dot.style.fill = dark() ? ACCENT.dark : ACCENT.light;
    pill.querySelector<SVGElement>('.glyph')!.style.cssText = 'vertical-align:-1px;margin-right:5px;';
    pill.addEventListener('click', () => {
      const show = spans[0]!.style.display === 'none';
      for (const s of spans) s.style.display = show ? '' : 'none';
    });
    spans[0]!.parentNode!.insertBefore(pill, spans[0]!);
    message.dataset.headsupFolded = '1';
  }

  let folding: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(folding);
    folding = setTimeout(() => {
      for (const m of site.userMessages()) {
        // The site may re-render a message and drop our pill; fold it again when that happens.
        if (m.querySelector('.headsup-pill') || !m.innerText.includes(BLOCK_MARKER)) continue;
        fold(m);
      }
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- Start ----------
  void chrome.storage.local.get(storageKey).then((v) => {
    state.enabled = v[storageKey] !== false;
    render();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!(storageKey in changes)) return;
    state.enabled = changes[storageKey]!.newValue !== false;
    if (state.enabled) void ask();
    else render();
  });
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  setInterval(place, 500); // the composer moves and remounts as the page navigates
  setInterval(checkPage, 2000);
  reportHealth(); // a fresh page starts healthy; clears what the tab showed before a reload
}

const css = `
.light { --bg:#ffffff; --chrome:#ffffff; --border:#e5e5e5; --fg:#0a0a0a; --muted:#6b6b6b; --accent:#e0186c; --accent-bg:#fde7f0;
  --how:#1f7a3e; --how-bg:#e3f5e9; --fact:#1d5fd1; --fact-bg:#e4ecfb; }
.dark { --bg:#0a0a0a; --chrome:#141414; --border:#262626; --fg:#fafafa; --muted:#8f8f8f; --accent:#ff3d8b; --accent-bg:#33101f;
  --how:#4ade80; --how-bg:#0f2a19; --fact:#7aa7ff; --fact-bg:#14203a; }
.wrap { font: 13px/18px ui-sans-serif, -apple-system, system-ui, sans-serif; color: var(--fg); }
.glyph { flex: none; }
.glyph .dot { fill: var(--accent); }
.head b { display: inline-flex; gap: 6px; align-items: center; }
.chip { display: inline-flex; gap: 6px; align-items: center; position: fixed; border: 1px solid transparent; border-radius: 999px; padding: 3px 10px; cursor: pointer;
  font: 12px/16px ui-monospace, Menlo, monospace; background: transparent; color: var(--muted); }
.chip.quiet { padding: 3px 7px; opacity: .7; }
.chip.attached { background: var(--accent-bg); color: var(--fg); }
.chip.needs { background: var(--fact-bg); color: var(--fact); }
.chip.paused { border-color: var(--border); }
.pop { position: fixed; width: 440px; max-width: calc(100vw - 16px); background: var(--chrome); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 12px 32px rgba(0,0,0,.35); }
.head { display: flex; gap: 8px; align-items: baseline; }
.head b { font: 700 13px/18px ui-monospace, Menlo, monospace; color: var(--accent); }
.note { display: grid; grid-template-columns: 16px auto 1fr; gap: 4px 8px; align-items: baseline; cursor: pointer; }
.note input { margin: 0; accent-color: var(--accent); }
.note .origin { grid-column: 3; color: var(--muted); font-size: 12px; }
.tag { font: 11px/16px ui-monospace, Menlo, monospace; padding: 0 6px; border-radius: 4px; white-space: nowrap; }
.tag.how { color: var(--how); background: var(--how-bg); }
.tag.fact { color: var(--fact); background: var(--fact-bg); }
.section { margin: 4px 0 0; color: var(--fact); font-size: 12px; }
.muted { color: var(--muted); font-size: 12px; margin: 0; }
.foot a { color: var(--muted); text-decoration: underline; cursor: pointer; }
.line { margin: 0; }
.actions { display: flex; gap: 8px; align-items: center; }
button { font: inherit; }
.actions button { border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
code { font: 12px/16px ui-monospace, Menlo, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
`;
