// Runs on chatgpt.com and claude.ai. Watches the draft, shows the ◆ mark by the composer, adds the
// ticked notes at the end of the message when it is sent, and folds that block in sent messages.

import { BLOCK_MARKER, buildBlock, splitBlock, type WebNote } from '../../src/shared/block.js';
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
    if (!state.enabled) return ['paused', '◆ paused on this site'];
    if (state.unreachable) return ['paused', '◆ not connected'];
    const d = state.detect;
    if (!d || (!d.inject.length && !d.ask.length && !d.blocked.count)) return ['quiet', '◆'];
    const going = d.inject.filter((n) => !state.unchecked.has(n.id)).length;
    const asking = d.ask.length && !state.askAccepted ? d.ask.length : 0;
    if (asking) return ['needs', going ? `◆ ${plural(going, 'note')} · ${asking} need${asking === 1 ? 's' : ''} your OK` : `◆ ${asking} ${d.ask[0]!.space} note${asking === 1 ? ' needs' : 's need'} your OK`];
    const sending = included();
    if (!sending.length) return ['quiet', '◆'];
    const sources = [...new Set(sending.map((n) => n.from.replace(/ \(.*\)$/, '')))];
    return ['attached', `◆ ${plural(sending.length, 'note')} · ${sources.length === 1 ? sources[0] : `${sources.length} tools`}`];
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
    parts.push(`<div class="head"><b>◆ heads-up</b><span>${sending.length ? `${plural(sending.length, 'note')} will go in with this message` : 'Nothing to add for this message'}</span></div>`);
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
        <button class="chip ${kind}" data-action="toggle" title="headsup">${esc(label)}</button>
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
    pill.textContent = `◆ ${plural(count, 'note')}`;
    pill.title = 'Added by headsup — click to show';
    pill.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;font:11px/16px ui-monospace,Menlo,monospace;color:#ffb224;background:rgba(255,178,36,.14);cursor:pointer;vertical-align:middle;';
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
.light { --bg:#ffffff; --chrome:#ecebe5; --border:#d9d7cf; --fg:#1b1c1f; --muted:#6b6d73; --amber:#a85f00; --amber-bg:#fff1d6;
  --how:#1f7a3e; --how-bg:#e3f5e9; --fact:#1d5fd1; --fact-bg:#e4ecfb; }
.dark { --bg:#212121; --chrome:#1a1b20; --border:#2a2c33; --fg:#e6e6e3; --muted:#8c8f96; --amber:#ffb224; --amber-bg:#2e2209;
  --how:#4ade80; --how-bg:#0f2a19; --fact:#7aa7ff; --fact-bg:#14203a; }
.wrap { font: 13px/18px ui-sans-serif, -apple-system, system-ui, sans-serif; color: var(--fg); }
.chip { position: fixed; border: 1px solid transparent; border-radius: 999px; padding: 3px 10px; cursor: pointer;
  font: 12px/16px ui-monospace, Menlo, monospace; background: transparent; color: var(--muted); }
.chip.quiet { padding: 3px 7px; opacity: .7; }
.chip.attached { background: var(--amber-bg); color: var(--amber); }
.chip.needs { background: var(--fact-bg); color: var(--fact); }
.chip.paused { border-color: var(--border); }
.pop { position: fixed; width: 440px; max-width: calc(100vw - 16px); background: var(--chrome); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 12px 32px rgba(0,0,0,.35); }
.head { display: flex; gap: 8px; align-items: baseline; }
.head b { font: 700 13px/18px ui-monospace, Menlo, monospace; color: var(--amber); }
.note { display: grid; grid-template-columns: 16px auto 1fr; gap: 4px 8px; align-items: baseline; cursor: pointer; }
.note input { margin: 0; accent-color: var(--amber); }
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
.actions button.primary { background: var(--amber); border-color: var(--amber); color: #111; }
code { font: 12px/16px ui-monospace, Menlo, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
`;
