// Relays requests from the page and the popup to headsup on this computer (native messaging).
// Chrome starts the host per message, so there is nothing to keep alive here.

const HOST = 'ai.headsup.host';
const LOCK_MS = 10 * 60_000; // a tab that went away without unlocking stops holding the site

// One tab per site catches up at a time; two chatgpt.com tabs would read the same chats twice.
const syncing = new Map<string, { tabId: number; at: number }>();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'health') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;
    const missing = message.missing as string[];
    void chrome.storage.session.set({ [`health:${tabId}`]: missing });
    // Per tab, so the red "not connected" badge stays global; null hands the tab back to it.
    void chrome.action.setBadgeText({ tabId, text: missing.length ? '!' : (null as unknown as string) });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff3d8b' });
    reply({ type: 'ok' });
    return false;
  }
  if (message?.type === 'sync-lock' || message?.type === 'sync-unlock') {
    const tabId = sender.tab?.id ?? -1;
    const held = syncing.get(message.site);
    if (message.type === 'sync-unlock') {
      if (held?.tabId === tabId) syncing.delete(message.site);
      reply({ type: 'ok' });
    } else if (held && held.tabId !== tabId && Date.now() - held.at < LOCK_MS) {
      reply({ type: 'busy' });
    } else {
      syncing.set(message.site, { tabId, at: Date.now() });
      reply({ type: 'ok' });
    }
    return false;
  }
  if (message?.type === 'sync-progress') {
    // The popup reads this to show "Reading ChatGPT · 158 of 412".
    void chrome.storage.session.set({ [`progress:${message.site}`]: { done: message.done, total: message.total, at: Date.now() } });
    reply({ type: 'ok' });
    return false;
  }
  chrome.runtime
    .sendNativeMessage(HOST, message)
    .then((response) => {
      void chrome.action.setBadgeText({ text: '' });
      reply(response);
    })
    .catch((err: unknown) => {
      // Usually: headsup isn't installed, or `headsup connect-browser` hasn't run yet.
      void chrome.action.setBadgeText({ text: '!' });
      void chrome.action.setBadgeBackgroundColor({ color: '#ff7a7a' });
      reply({ type: 'error', message: err instanceof Error ? err.message : String(err), unreachable: true });
    });
  return true; // the reply comes asynchronously
});
