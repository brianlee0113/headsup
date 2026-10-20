// Where things are on each chat site. Selectors change when the sites ship redesigns; every lookup
// has fallbacks, and a miss just means headsup stays out of the way on that page.

export interface Site {
  host: string;
  composer(): HTMLElement | null;
  anchor(composer: HTMLElement): HTMLElement; // the visible composer box the mark sits on
  sendButton(): HTMLButtonElement | null;
  userMessages(): HTMLElement[];
  conversationText(): string;
}

const first = <T extends Element>(selectors: string[]): T | null => {
  for (const s of selectors) {
    const el = document.querySelector<T>(s);
    if (el) return el;
  }
  return null;
};

const all = (selectors: string[]): HTMLElement[] => {
  for (const s of selectors) {
    const els = [...document.querySelectorAll<HTMLElement>(s)];
    if (els.length) return els;
  }
  return [];
};

// The last stretch of the visible conversation, so the core can skip what the AI already has.
const tail = (els: HTMLElement[]) => els.map((e) => e.innerText).join('\n').slice(-20_000);

const chatgpt: Site = {
  host: 'chatgpt.com',
  composer: () => first(['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]']),
  anchor: (c) => c.closest<HTMLElement>('form') ?? c,
  // 2026-10: no test id or id on the button any more, just aria-label="Send" and type="submit" in the composer form.
  sendButton: () =>
    first<HTMLButtonElement>(['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send"]', '#composer-submit-button']) ??
    chatgpt.composer()?.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"]') ??
    null,
  // 2026-10: data-message-author-role is gone; turns carry data-chatgpt-search-unit-key="…:user" / "…:assistant".
  userMessages: () => all(['[data-message-author-role="user"]', '[data-user-message-bubble="true"]']),
  conversationText: () => tail(all(['[data-message-author-role]', '[data-chatgpt-search-unit-key]'])),
};

const claude: Site = {
  host: 'claude.ai',
  composer: () => first(['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]']),
  anchor: (c) => c.closest<HTMLElement>('fieldset') ?? c.closest<HTMLElement>('form') ?? c,
  sendButton: () => first(['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[type="submit"]']),
  userMessages: () => all(['[data-testid="user-message"]']),
  conversationText: () => tail(all(['[data-testid="user-message"]', '.font-claude-message', '[data-is-streaming]'])),
};

export function siteFor(hostname: string): Site | null {
  if (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')) return chatgpt;
  if (hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) return claude;
  return null;
}
