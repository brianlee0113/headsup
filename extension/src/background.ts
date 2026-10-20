// Relays requests from the page and the popup to headsup on this computer (native messaging).
// Chrome starts the host per message, so there is nothing to keep alive here.

const HOST = 'ai.headsup.host';

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'health') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;
    const missing = message.missing as string[];
    void chrome.storage.session.set({ [`health:${tabId}`]: missing });
    // Per tab, so the red "not connected" badge stays global; null hands the tab back to it.
    void chrome.action.setBadgeText({ tabId, text: missing.length ? '!' : (null as unknown as string) });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#ffb224' });
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
