// Relays requests from the page and the popup to headsup on this computer (native messaging).
// Chrome starts the host per message, so there is nothing to keep alive here.

const HOST = 'ai.headsup.host';

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
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
