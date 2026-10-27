// Records the README's browser demo: Sam asks for a cover letter, headsup offers notes, Sam leaves the
// internal roadmap out and sends. Real extension and real native host, against scripts/demo/chat.html
// served as chatgpt.com in a throwaway Chrome for Testing profile; Sam's notes come from seed.ts.
//   pnpm build && pnpm build:ext
//   HEADSUP_E2E_CHROME="…/Google Chrome for Testing" node scripts/demo/record-browser.mjs docs/demo-browser.gif
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '../..');
const CHROME = process.env.HEADSUP_E2E_CHROME;
const OUT = resolve(process.argv[2] ?? 'demo-browser.gif');
if (!CHROME) throw new Error('set HEADSUP_E2E_CHROME to a Chrome for Testing binary');
const W = 1100, H = 700;
const T = mkdtempSync(join(tmpdir(), 'headsup-demo-')) + '/';
const HOME = T + 'sam', UDD = T + 'udd', FRAMES = T + 'frames/';
mkdirSync(FRAMES);
execFileSync(join(REPO, 'node_modules/.bin/tsx'), [HERE + 'seed.ts', HOME], { stdio: 'inherit' });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com', '-keyout', T + 'key.pem', '-out', T + 'cert.pem', '-days', '1'], { stdio: 'ignore' });
const script = HOME + '/native-host';
writeFileSync(script, `#!/bin/sh\nexport HEADSUP_HOME="${HOME}"\nexec "${process.execPath}" "${REPO}/dist/cli.js" native-host "$@"\n`); chmodSync(script, 0o755);
mkdirSync(UDD + '/NativeMessagingHosts', { recursive: true });
writeFileSync(UDD + '/NativeMessagingHosts/ai.headsup.host.json', JSON.stringify({ name: 'ai.headsup.host', description: 'demo', path: script, type: 'stdio', allowed_origins: ['chrome-extension://khpoiajpimicekhdejhjmfjaklbcgpkk/'] }));

const page = readFileSync(HERE + 'chat.html');
const server = https.createServer({ key: readFileSync(T + 'key.pem'), cert: readFileSync(T + 'cert.pem') }, (_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); }).listen(8444);
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${UDD}`, `--load-extension=${REPO}/extension/build`, `--disable-extensions-except=${REPO}/extension/build`,
  '--host-resolver-rules=MAP chatgpt.com 127.0.0.1:8444', '--ignore-certificate-errors', '--remote-debugging-port=9334', '--no-first-run', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { chrome.kill(); server.close(); process.exit(code); };

try {
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json/list')).json(); if (targets.some((t) => t.type === 'page')) break; } catch {} await sleep(250); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const frames = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Page.screencastFrame') {
      frames.push({ data: m.params.data, t: m.params.metadata.timestamp });
      ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
    }
  });
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shadow = `document.querySelector('headsup-root').shadowRoot`;
  // Moves the visible pointer to an element's center, then really clicks there.
  const click = async (expr) => {
    const r = await js(`(() => { const b = (${expr}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await js(`document.getElementById('cursor').style.transform = 'translate(${r.x - 4}px, ${r.y - 2}px)'`);
    await sleep(650);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };

  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'https://chatgpt.com/' });
  for (let i = 0; i < 60 && !(await js('window.__ready === true')); i++) await sleep(250);
  await sleep(1500); // the extension mounts its mark
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await sleep(900);

  await js(`document.querySelector('.ProseMirror').focus()`);
  for (const ch of 'Write a cover letter for a PM internship: my Northwind work, the roadmap I helped with, and Quorum') {
    await cdp('Input.insertText', { text: ch });
    await sleep(28);
  }
  await sleep(2200);
  await click(`${shadow}.querySelector('.chip')`);
  await sleep(1800);
  await click(`[...${shadow}.querySelectorAll('label.note')].find((l) => l.innerText.includes('roadmap')).querySelector('input')`);
  await sleep(1100);
  await click(`${shadow}.querySelector('[data-action=accept]')`);
  await sleep(1500);
  await click(`document.querySelector('button[aria-label="Send"]')`);
  await sleep(1800);
  await click(`document.querySelector('.headsup-pill')`);
  await sleep(3200);
  await cdp('Page.stopScreencast');

  const sent = JSON.parse(await js('JSON.stringify(window.__sentTexts)'))[0] ?? '';
  console.log('sent includes Quorum:', sent.includes('Quorum is a web app'), '| payouts:', sent.includes('payout'), '| roadmap left out:', !sent.includes('ledger'));

  // Frames arrive only when the page changes; hold each one until the next.
  const list = [];
  frames.forEach((f, i) => {
    const file = `${FRAMES}${String(i).padStart(5, '0')}.png`;
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.t ?? f.t + 1.5;
    list.push(`file '${file}'`, `duration ${Math.max(0.02, next - f.t).toFixed(3)}`);
  });
  list.push(`file '${FRAMES}${String(frames.length - 1).padStart(5, '0')}.png'`);
  writeFileSync(T + 'frames.txt', list.join('\n') + '\n');
  const filter = 'fps=15,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', T + 'frames.txt', '-vf', filter, '-loop', '0', OUT]);
  console.log(`${frames.length} frames → ${OUT}`);
  done(0);
} catch (e) { console.error(e); done(1); }
