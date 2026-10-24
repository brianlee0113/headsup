// The local page `headsup card` serves: the card drawn on a canvas, a tick box for every line, and
// Save PNG / Copy image. Everything runs in the browser on this computer, fonts included: they ship
// in the package (assets/fonts) and the same local server hands them out.

export function cardPage(defaultName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>headsup card</title>
<style>
  @font-face { font-family: Geist; font-weight: 100 900; font-display: block; src: url(/fonts/geist-latin.woff2) format('woff2'); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  @font-face { font-family: Geist; font-weight: 100 900; font-display: block; src: url(/fonts/geist-latin-ext.woff2) format('woff2'); unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
  @font-face { font-family: "JetBrains Mono"; font-weight: 100 900; font-display: block; src: url(/fonts/jetbrains-mono-latin.woff2) format('woff2'); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  @font-face { font-family: "JetBrains Mono"; font-weight: 100 900; font-display: block; src: url(/fonts/jetbrains-mono-latin-ext.woff2) format('woff2'); unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
  :root { --bg:#09090b; --panel:#141518; --fg:#f2f2f0; --muted:#9a9ca3; --border:#26282e; --amber:#ffb224; --amber-bg:#2e2209; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 Geist, system-ui, sans-serif; }
  main { display: flex; gap: 40px; padding: 32px; flex-wrap: wrap; justify-content: center; }
  .preview { display: flex; flex-direction: column; gap: 10px; }
  canvas { width: 540px; height: auto; border-radius: 6px; border: 1px solid var(--border); }
  canvas.landscape { width: 600px; }
  .hint { color: var(--muted); font-size: 12px; margin: 0; }
  aside { width: 420px; max-width: 100%; display: flex; flex-direction: column; gap: 18px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0; }
  .group { display: flex; flex-direction: column; gap: 10px; }
  .label { font: 11px JetBrains Mono, monospace; letter-spacing: .08em; color: var(--muted); }
  label.row { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; font-size: 13px; }
  label.row input { margin: 2px 0 0; accent-color: var(--amber); }
  label.row.off span { color: var(--muted); }
  input[type=text] { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; color: var(--fg); font: inherit; padding: 6px 10px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; align-self: flex-start; }
  .seg button { background: transparent; border: 0; color: var(--muted); font: 500 12px Geist, sans-serif; padding: 6px 12px; cursor: pointer; }
  .seg button.on { background: var(--amber-bg); color: var(--amber); }
  .actions { display: flex; gap: 8px; }
  .btn { font: 500 13px Geist, sans-serif; border-radius: 999px; padding: 7px 16px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--fg); }
  .btn.primary { background: var(--amber); border-color: var(--amber); color: #111; }
  #status { color: var(--muted); font-size: 12px; min-height: 18px; }
</style>
</head>
<body>
<main>
  <div class="preview">
    <canvas id="card" width="1080" height="1350"></canvas>
    <p class="hint" id="size">Saved as 1080 × 1350.</p>
  </div>
  <aside>
    <h1>Pick what goes on your card</h1>
    <p class="hint">Nothing leaves this computer until you post it. Untick anything you'd rather keep to yourself.</p>
    <div class="seg"><button id="fmt-p" class="on">Portrait 1080 × 1350</button><button id="fmt-l">Landscape 1200 × 630</button></div>
    <div class="group"><span class="label">NAME</span><input type="text" id="name" placeholder="Leave empty for “How I use AI”" value="${defaultName.replace(/[&<>"]/g, '')}"></div>
    <div id="groups"><p class="hint">Reading your notes and writing your style lines…</p></div>
    <div class="actions"><button class="btn primary" id="save">Save PNG</button><button class="btn" id="copy">Copy image</button></div>
    <div id="status"></div>
  </aside>
</main>
<script>
const C = { bg:'#0e0f12', fg:'#e6e6e3', muted:'#8c8f96', amber:'#ffb224', track:'#1a1b20', border:'#2a2c33' };
const SANS = 'Geist, system-ui, sans-serif', MONO = '"JetBrains Mono", ui-monospace, monospace';
const canvas = document.getElementById('card'), ctx = canvas.getContext('2d');
let data = null, fmt = 'portrait';
const off = new Set();

const font = (w, size, mono) => (ctx.font = w + ' ' + size + 'px ' + (mono ? MONO : SANS));
function text(s, x, y, color, w, size, mono, spacing) {
  font(w, size, mono); ctx.fillStyle = color; ctx.letterSpacing = (spacing || 0) + 'px'; ctx.fillText(s, x, y); ctx.letterSpacing = '0px';
  return ctx.measureText(s).width;
}
function rightText(s, x, y, color, w, size, mono) { font(w, size, mono); ctx.fillStyle = color; const m = ctx.measureText(s).width; ctx.fillText(s, x - m, y); }
function wrap(s, width) {
  const out = [];
  for (const part of s.split(/(?<=\\.)\\s+/)) {
    let line = '';
    for (const word of part.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}
const bar = (x, y, w, h, share) => { ctx.fillStyle = C.track; round(x, y, w, h); ctx.fillStyle = C.amber; round(x, y, Math.max(h, w * share), h); };
function round(x, y, w, h) { ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill(); }

function pick() {
  const name = document.getElementById('name').value.trim();
  return {
    who: name ? 'HOW ' + name.toUpperCase() + ' USES AI' : 'HOW I USE AI',
    tools: data.tools.filter((_, i) => !off.has('t' + i)),
    flows: data.flows.filter((_, i) => !off.has('f' + i)),
    style: data.style.filter((_, i) => !off.has('s' + i)),
    numbers: !off.has('n'),
  };
}

function drawPortrait(p) {
  canvas.width = 1080; canvas.height = 1350;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1080, 1350);
  const X = 72, W = 936;
  // Blocks are laid out top to bottom with the spare height shared between them.
  const blocks = [];
  blocks.push({ h: 34, draw: (y) => { text('◆ headsup', X, y + 26, C.amber, 700, 26, true); rightText(data.month, X + W, y + 26, C.muted, 400, 22, true); } });
  font(600, 64); const head = wrap(data.headline, W);
  blocks.push({ h: 40 + head.length * 72, draw: (y) => { text(p.who, X, y + 22, C.amber, 700, 22, true, 2); head.forEach((l, i) => text(l, X, y + 40 + 58 + i * 72, C.fg, 600, 64)); } });
  if (p.tools.length) blocks.push({ h: 40 + p.tools.length * 66, draw: (y) => {
    text('WHERE EACH AI FITS', X, y + 20, C.muted, 400, 20, true, 1.6);
    p.tools.forEach((t, i) => { const ty = y + 40 + i * 66 + 30; const w = text(t.name, X, ty, C.fg, 600, 30);
      text(t.topics.join(' · '), X + w + 16, ty, C.muted, 400, 24); rightText(Math.round(t.share * 100) + '%', X + W, ty, C.muted, 400, 24, true); bar(X, ty + 14, W, 10, t.share); });
  } });
  if (p.flows.length) blocks.push({ h: 40 + p.flows.length * 46, draw: (y) => {
    text('CONTEXT THAT CROSSED OVER', X, y + 20, C.muted, 400, 20, true, 1.6);
    p.flows.forEach((f, i) => { const fy = y + 40 + i * 46 + 32; const w = text(f.from + ' → ' + f.to, X, fy, C.fg, 500, 28);
      text(f.what, X + w + 16, fy, C.muted, 400, 24); rightText(f.times + '×', X + W, fy, C.amber, 700, 26, true); });
  } });
  if (p.style.length) blocks.push({ h: 40 + p.style.length * 48, draw: (y) => {
    text('MY AI STYLE', X, y + 20, C.muted, 400, 20, true, 1.6);
    p.style.forEach((s, i) => { const sy = y + 40 + i * 48 + 34; text('◆', X, sy - 4, C.amber, 700, 20, true); text(s, X + 36, sy, C.fg, 400, 30); });
  } });
  if (p.numbers) blocks.push({ h: 84, draw: (y) => {
    const n = data.numbers, cells = [[String(n.tools), 'AI tools'], [String(n.notes), 'notes kept']];
    if (n.prompts) cells.push([n.steppedIn + ' of ' + n.prompts, 'prompts it stepped in']);
    cells.forEach(([a, b], i) => { const cx = X + i * (W / 3); text(a, cx, y + 48, C.fg, 600, 48); text(b, cx, y + 80, C.muted, 400, 22); });
  } });
  blocks.push({ h: 48, draw: (y) => { ctx.fillStyle = C.border; ctx.fillRect(X, y, W, 1); text('Made on my computer. It only steps in when it helps.', X, y + 44, C.muted, 400, 20); rightText('npx headsup-ai', X + W, y + 44, C.amber, 400, 20, true); } });
  const used = blocks.reduce((s, b) => s + b.h, 0), gap = Math.max(24, (1350 - 144 - used) / (blocks.length - 1));
  let y = 72; for (const b of blocks) { b.draw(y); y += b.h + gap; }
}

function drawLandscape(p) {
  canvas.width = 1200; canvas.height = 630;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1200, 630);
  const X = 56, LW = 480, RX = 592, RW = 552;
  text('◆ headsup', X, 76, C.amber, 700, 20, true);
  text(p.who, X, 110, C.amber, 700, 16, true, 1.6);
  font(600, 44); const head = wrap(data.headline, LW);
  head.forEach((l, i) => text(l, X, 160 + i * 50, C.fg, 600, 44));
  let y = 160 + head.length * 50 + 30;
  if (p.style.length) {
    text('MY AI STYLE', X, y, C.muted, 400, 14, true, 1.2);
    p.style.slice(0, 2).forEach((s, i) => { text('◆', X, y + 32 + i * 32 - 3, C.amber, 700, 14, true); text(s, X + 24, y + 32 + i * 32, C.fg, 400, 20); });
  }
  text('npx headsup-ai', X, 574, C.amber, 400, 16, true);
  y = 76;
  if (p.tools.length) {
    text('WHERE EACH AI FITS', RX, y, C.muted, 400, 14, true, 1.2); y += 14;
    p.tools.slice(0, 3).forEach((t) => { y += 30; const w = text(t.name, RX, y, C.fg, 600, 19);
      text(t.topics.join(' · '), RX + w + 10, y, C.muted, 400, 14); rightText(Math.round(t.share * 100) + '%', RX + RW, y, C.muted, 400, 14, true); bar(RX, y + 9, RW, 6, t.share); y += 14; });
    y += 34;
  }
  if (p.flows.length) {
    text('CONTEXT THAT CROSSED OVER', RX, y, C.muted, 400, 14, true, 1.2); y += 6;
    p.flows.slice(0, 3).forEach((f) => { y += 30; const w = text(f.from + ' → ' + f.to, RX, y, C.fg, 500, 19);
      text(f.what, RX + w + 10, y, C.muted, 400, 15); rightText(f.times + '×', RX + RW, y, C.amber, 700, 17, true); });
  }
}

function draw() {
  if (!data) return;
  const p = pick();
  (fmt === 'portrait' ? drawPortrait : drawLandscape)(p);
  canvas.className = fmt;
  document.getElementById('size').textContent = 'Saved as ' + canvas.width + ' × ' + canvas.height + '.';
}

function groups() {
  const el = document.getElementById('groups'); el.innerHTML = ''; el.className = 'group'; el.style.gap = '18px';
  const group = (title, rows, note) => {
    if (!rows.length) return;
    const g = document.createElement('div'); g.className = 'group';
    g.innerHTML = '<span class="label">' + title + '</span>';
    for (const [key, textLine] of rows) {
      const l = document.createElement('label'); l.className = 'row';
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !off.has(key);
      const span = document.createElement('span'); span.textContent = textLine;
      box.onchange = () => { box.checked ? off.delete(key) : off.add(key); l.classList.toggle('off', !box.checked); draw(); };
      l.append(box, span); g.append(l);
    }
    if (note) { const n = document.createElement('p'); n.className = 'hint'; n.textContent = note; g.append(n); }
    el.append(g);
  };
  group('WHERE EACH AI FITS', data.tools.map((t, i) => ['t' + i, t.name + ' · ' + (t.topics.join(' · ') || 'no topics yet')]));
  group('CONTEXT THAT CROSSED OVER', data.flows.map((f, i) => ['f' + i, f.from + ' → ' + f.to + ' · ' + f.what + ' · ' + f.times + '×']));
  group('MY AI STYLE', data.style.map((s, i) => ['s' + i, s]), 'Reworded from your how-you-work notes. Facts, work notes and never-share notes are never used.');
  const n = data.numbers;
  group('NUMBERS', [['n', n.tools + ' AI tools · ' + n.notes + ' notes kept' + (n.prompts ? ' · stepped in on ' + n.steppedIn + ' of ' + n.prompts + ' prompts' : '')]]);
}

const status = (s) => (document.getElementById('status').textContent = s);
const blob = () => new Promise((r) => canvas.toBlob(r, 'image/png'));
document.getElementById('save').onclick = async () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(await blob()); a.download = 'headsup-card-' + fmt + '.png'; a.click(); status('Saved.');
};
document.getElementById('copy').onclick = async () => {
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob() })]); status('Copied. Paste it into your post.'); }
  catch { status('This browser would not copy the image. Use Save PNG instead.'); }
};
document.getElementById('name').oninput = draw;
for (const [id, f] of [['fmt-p', 'portrait'], ['fmt-l', 'landscape']]) document.getElementById(id).onclick = () => {
  fmt = f; document.getElementById('fmt-p').classList.toggle('on', f === 'portrait'); document.getElementById('fmt-l').classList.toggle('on', f === 'landscape'); draw();
};

(async () => {
  await Promise.all(['600 64px Geist', '400 24px Geist', '500 28px Geist', '700 22px "JetBrains Mono"', '400 20px "JetBrains Mono"'].map((f) => document.fonts.load(f).catch(() => {})));
  data = await fetch('/data').then((r) => r.json());
  groups();
  draw();
})();
</script>
</body>
</html>`;
}
