// Labels headsup's real decisions, from the person's own log, on a page served only on this computer.
// Each time headsup stepped in: were the added notes needed? A sample of times it stayed quiet: was
// something missing? Labels are saved to .local/real-labels.json (never committed); the prompts never
// leave the machine. This is the check that generated personas can't give: real, messy prompts.
//   pnpm tsx sim/label-real.ts            then open the printed address
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { headsupHome } from '../src/config.js';
import { parseNote, type Note } from '../src/note.js';
import { Store } from '../src/store.js';

const HERE = new URL('.', import.meta.url).pathname;
const OUT = join(HERE, '..', '.local', 'real-labels.json');
const QUIET_SAMPLE = 20;

const home = headsupHome();
const notes = new Map<string, Note>(new Store(home).list().map((n) => [n.id, n]));
const archive = join(home, 'archive');
if (existsSync(archive)) {
  for (const day of readdirSync(archive)) {
    for (const f of readdirSync(join(archive, day))) {
      try {
        const n = parseNote(readFileSync(join(archive, day, f), 'utf8'));
        if (!notes.has(n.id)) notes.set(n.id, n);
      } catch {
        /* unreadable archived note: shown by id only */
      }
    }
  }
}

interface Entry { at: string; event: string; agent?: string; prompt?: string; injected?: string[]; asked?: string[] }
const log = readFileSync(join(home, 'log.jsonl'), 'utf8').split('\n').flatMap((l) => {
  try {
    return [JSON.parse(l) as Entry];
  } catch {
    return [];
  }
}).filter((e) => e.event === 'heads-up' && e.prompt);

const body = (id: string) => notes.get(id)?.body ?? `(note ${id} no longer exists)`;
const stepped = log.filter((e) => (e.injected?.length ?? 0) + (e.asked?.length ?? 0) > 0);
// Quiet decisions are many; an even spread over time, not just the latest.
const quietAll = log.filter((e) => !((e.injected?.length ?? 0) + (e.asked?.length ?? 0)));
const quiet = quietAll.filter((_, i) => i % Math.max(1, Math.floor(quietAll.length / QUIET_SAMPLE)) === 0).slice(0, QUIET_SAMPLE);
const items = [...stepped, ...quiet].map((e, i) => ({
  key: `${e.at}#${i}`, at: e.at.slice(0, 16).replace('T', ' '), agent: e.agent ?? '', prompt: e.prompt!.slice(0, 600),
  added: (e.injected ?? []).map(body), offered: (e.asked ?? []).map(body), quiet: !((e.injected?.length ?? 0) + (e.asked?.length ?? 0)),
}));
const saved = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, string>) : {};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>headsup 실제 기록 표시</title>
<style>
:root{--bg:#fff;--fg:#0a0a0a;--muted:#6b6b6b;--line:#e5e5e5;--soft:#f6f6f6;--accent:#e0186c}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--line:#262626;--soft:#141414;--accent:#ff3d8b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 80px;display:flex;flex-direction:column;gap:14px}
h1{font-size:24px;margin:0}.muted{color:var(--muted);font-size:14px;margin:0}
.item{border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.item.done{opacity:.55}.meta{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}
.prompt{white-space:pre-wrap;background:var(--soft);border-radius:8px;padding:10px 12px}
ul{margin:0;padding-left:18px;font-size:14px}.k{font:11px ui-monospace,Menlo,monospace;color:var(--muted);letter-spacing:.05em}
.btns{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;font-size:14px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:5px 14px;cursor:pointer}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.bar{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
</style><main>
<h1>headsup 실제 기록 표시</h1>
<p class="muted">이 컴퓨터에서만 열리는 페이지입니다. 표시하면 바로 <code>.local/real-labels.json</code>에 저장되고, 어디로도 보내지 않습니다.</p>
<div class="bar" id="bar"></div>
${items.map((it) => `<section class="item" data-key="${esc(it.key)}">
<div class="meta">${esc(it.at)} · ${esc(it.agent)} · ${it.quiet ? '조용히 넘어감' : '끼어듦'}</div>
<div class="prompt">${esc(it.prompt)}</div>
${it.added.length ? `<div><div class="k">붙인 노트</div><ul>${it.added.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
${it.offered.length ? `<div><div class="k">넣을지 물어본 노트</div><ul>${it.offered.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
<div class="btns">${(it.quiet
    ? [['fine', '괜찮음 (필요한 게 없었음)'], ['missing', '빠진 게 있었음']]
    : [['needed', '필요했음'], ['partly', '일부만 필요'], ['noise', '필요 없었음']]
  ).map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div></section>`).join('\n')}
</main><script>
const labels = ${JSON.stringify(saved)};
const bar = document.getElementById('bar');
function paint(){
  let n=0; document.querySelectorAll('.item').forEach(s=>{const v=labels[s.dataset.key]; if(v) n++; s.classList.toggle('done',!!v); s.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));});
  bar.textContent = n + ' / ' + document.querySelectorAll('.item').length + ' 표시함';
}
document.addEventListener('click', async e=>{
  const b=e.target.closest('button'); if(!b) return;
  const key=b.closest('.item').dataset.key; labels[key]=labels[key]===b.dataset.v?undefined:b.dataset.v;
  paint();
  try{ await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(labels)}); }
  catch{ bar.textContent='저장하지 못했습니다. 터미널의 label-real.ts가 아직 실행 중인지 확인해 주세요.'; }
});
paint();
</script></html>`;

mkdirSync(join(HERE, '..', '.local'), { recursive: true });
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/save') {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d));
    req.on('end', () => {
      const labels = JSON.parse(raw || '{}') as Record<string, string | null>;
      writeFileSync(OUT, JSON.stringify(Object.fromEntries(Object.entries(labels).filter(([, v]) => v)), null, 2));
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
});
server.listen(Number(process.env.PORT ?? 47410), '127.0.0.1', () => {
  console.log(`${stepped.length} times headsup stepped in, ${quiet.length} quiet ones sampled → http://localhost:${process.env.PORT ?? 47410}/`);
  console.log(`labels save to ${OUT}; Ctrl-C to stop`);
});
