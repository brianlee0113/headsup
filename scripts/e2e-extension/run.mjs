// End-to-end check of the extension: the built extension and the real native host, against a mock
// chatgpt.com (real ProseMirror) served locally, in a throwaway Chrome for Testing profile.
//   pnpm build && pnpm build:ext
//   npx @puppeteer/browsers install chrome@stable --path /tmp/cft   (branded Chrome can't load extensions)
//   HEADSUP_E2E_CHROME="/tmp/cft/…/Google Chrome for Testing" node scripts/e2e-extension/run.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '../..');
const CHROME = process.env.HEADSUP_E2E_CHROME;
if (!CHROME) throw new Error('set HEADSUP_E2E_CHROME to a Chrome for Testing binary');
const H = mkdtempSync(join(tmpdir(), 'headsup-e2e-')) + '/';
const HOME = H + 'hs', UDD = H + 'udd';
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com', '-keyout', H + 'key.pem', '-out', H + 'cert.pem', '-days', '1'], { stdio: 'ignore' });
const env = { ...process.env, HEADSUP_HOME: HOME };
const add = (args) => execFileSync('node', [REPO + '/dist/cli.js', 'add', ...args], { env });
add(['--type', 'fact', '--space', 'personal', '--source', 'claude-code', '--topics', 'quorum,release', 'Quorum v0.3 adds recurring meetings and Google Calendar sync']);
add(['--type', 'fact', '--space', 'personal', '--source', 'claude-code', '--topics', 'quorum,users', 'Quorum finds a meeting time for student clubs; 140 weekly users']);
add(['--type', 'fact', '--space', 'work', '--source', 'claude-code', '--topics', 'northwind,internship', 'Northwind internship on the payments team, summer 2026']);
add(['--type', 'fact', '--space', 'work', '--source', 'claude-code', '--topics', 'internship,payouts', 'Shipped payout retries at the internship that cut failed payouts by 30%']);
// Native host registered inside the throwaway profile only.
const script = HOME + '/native-host';
writeFileSync(script, `#!/bin/sh\nexport HEADSUP_HOME="${HOME}"\nexec "${process.execPath}" "${REPO}/dist/cli.js" native-host "$@"\n`); chmodSync(script, 0o755);
mkdirSync(UDD + '/NativeMessagingHosts', { recursive: true });
writeFileSync(UDD + '/NativeMessagingHosts/ai.headsup.host.json', JSON.stringify({ name: 'ai.headsup.host', description: 'test', path: script, type: 'stdio', allowed_origins: ['chrome-extension://heomldlmknjaidfkfkdhjibppainocea/'] }));

const page = readFileSync(HERE + 'mock-chatgpt.html');
const server = https.createServer({ key: readFileSync(H + 'key.pem'), cert: readFileSync(H + 'cert.pem') }, (_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); }).listen(8443);
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${UDD}`, `--load-extension=${REPO}/extension/build`, `--disable-extensions-except=${REPO}/extension/build`,
  '--host-resolver-rules=MAP chatgpt.com 127.0.0.1:8443', '--ignore-certificate-errors', '--remote-debugging-port=9333', '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { chrome.kill(); server.close(); process.exit(code); };
try {
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (targets.some(t => t.type === 'page')) break; } catch {} await sleep(250); }
  const target = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const key = async (k, code, vk, text) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
  const chip = () => js(`document.querySelector('headsup-root')?.shadowRoot?.querySelector('.chip')?.textContent ?? '(no chip)'`);
  const type = async (s) => { await js(`document.querySelector('.ProseMirror').focus()`); await cdp('Input.insertText', { text: s }); };

  await cdp('Page.navigate', { url: 'https://chatgpt.com/' });
  for (let i = 0; i < 40 && !(await js('window.__ready === true')); i++) await sleep(250);
  await sleep(800);
  console.log('mounted:', await js(`!!document.querySelector('headsup-root')`), '| idle chip:', JSON.stringify(await chip()));

  // 1) Same-space notes ride along
  await type('Write the release notes for Quorum v0.3');
  await sleep(1800);
  console.log('typing chip:', JSON.stringify(await chip()));
  await js(`document.querySelector('headsup-root').shadowRoot.querySelector('.chip').click()`);
  await sleep(200);
  writeFileSync(H + 'shot-popover.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  console.log('popover:', JSON.stringify(await js(`document.querySelector('headsup-root').shadowRoot.querySelector('.pop')?.innerText`)));
  await key('Enter', 'Enter', 13, '\r');
  await sleep(1500);
  const sent = await js('JSON.stringify(window.__sentTexts)');
  console.log('sent text:', sent);
  console.log('bubble shows:', JSON.stringify(await js(`document.querySelector('[data-user-message-bubble="true"]').innerText`)));
  writeFileSync(H + 'shot-sent.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  console.log('pill:', JSON.stringify(await js(`document.querySelector('.headsup-pill')?.textContent`)));

  // 2) A work fact needs an OK; sending without it leaves it out
  await type('Help me write a cover letter for a product internship');
  await sleep(1800);
  console.log('ask chip:', JSON.stringify(await chip()));
  await key('Enter', 'Enter', 13, '\r');
  await sleep(1500);
  console.log('second sent:', JSON.stringify(JSON.parse(await js('JSON.stringify(window.__sentTexts)'))[1]));

  // 3) Same again, but include the work note from the list
  await type('Help me write a cover letter for a product internship');
  await sleep(1800);
  await js(`document.querySelector('headsup-root').shadowRoot.querySelector('.chip').click()`); await sleep(150);
  // Untick one work note with a real click (a JS click() skips the change event ordering that broke this).
  const box = await js(`(() => { const b = [...document.querySelector('headsup-root').shadowRoot.querySelectorAll('label.note')].find((l) => l.innerText.includes('Northwind')).querySelector('input').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(200);
  await js(`document.querySelector('headsup-root').shadowRoot.querySelector('[data-action=accept]').click()`); await sleep(150);
  console.log('after include chip:', JSON.stringify(await chip()));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('button[aria-label="Send"]').click()` });
  await sleep(1500);
  console.log('third sent has block:', JSON.parse(await js('JSON.stringify(window.__sentTexts)'))[2]?.includes('payout retries'));

  const sentTexts = JSON.parse(await js('JSON.stringify(window.__sentTexts)'));
  const checks = {
    'same-space note added at send': sentTexts[0]?.includes('Quorum v0.3 adds recurring meetings'),
    'block folded into a pill': (await js(`document.querySelector('.headsup-pill')?.textContent`)) === '1 note',
    'work note left out without an OK': !sentTexts[1]?.includes('Northwind'),
    'work note added after including it': !!sentTexts[2]?.includes('payout retries'),
    'unticked work note left out': !sentTexts[2]?.includes('Northwind internship'),
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (Object.values(checks).some((ok) => !ok)) done(1);
  console.log('\nlog:'); for (const l of readFileSync(HOME + '/log.jsonl', 'utf8').trim().split('\n')) { const e = JSON.parse(l); console.log(' ', e.event, e.agent, JSON.stringify({ injected: e.injected?.length, asked: e.asked?.length, notes: e.notes?.length })); }
  done(0);
} catch (e) { console.error(e); done(1); }
