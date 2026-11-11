// Labels what the redesign would do differently, on a page served only on this computer: every prompt where
// the new logic steps in (from .local/redesign/replay.json), and every note it gives at a conversation's
// opening as the answer-style block. Labels save to the main repo's .local/redesign/replay-labels.json.
//   pnpm tsx sim/label-replay.ts      then open the printed address (keys 1–5 label the current card)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Replayed } from './replay-real.js';

const HERE = new URL('.', import.meta.url).pathname;
const REPLAY = join(HERE, '..', '.local', 'redesign', 'replay.json');
// The labels live in the main checkout's .local (a worktree has its own, empty one): point there with
// HEADSUP_LABELS_DIR when running from a worktree.
const LABELS_DIR = process.env.HEADSUP_LABELS_DIR ?? join(HERE, '..', '.local', 'redesign');
// Each round labels into its own file (`--out replay-labels-r2.json`); the round-1 file is shown for reference only.
const OUT = join(LABELS_DIR, process.argv.find((a, i) => process.argv[i - 1] === '--out') ?? 'replay-labels.json');
const R1 = join(LABELS_DIR, 'replay-labels.json');
const r1 = OUT !== R1 && existsSync(R1) ? (JSON.parse(readFileSync(R1, 'utf8')) as Record<string, { label: string }>) : {};
const EARLIER = join(LABELS_DIR, '..', 'real-labels.json');

const STEP = [
  ['needed', '필요했고 노트도 맞음'],
  ['partly', '일부만 도움'],
  ['wrong', '필요했지만 노트가 틀림'],
  ['noise', '필요 없었음'],
  ['harmful', '해로웠음'],
] as const;
const OPENING = [
  ['keep', '대화 시작에 항상 넣어도 됨'],
  ['project', '특정 프로젝트/상황에서만'],
  ['drop', '넣지 말아야 함'],
] as const;

type Shown = { id: string; body: string; why?: string; scope?: string; project?: string };
const prompts = (JSON.parse(readFileSync(REPLAY, 'utf8')) as { prompts: Record<string, Replayed> }).prompts;
const earlier = existsSync(EARLIER) ? (JSON.parse(readFileSync(EARLIER, 'utf8')) as Record<string, { label: string }>) : {};
const earlierFor = (key: string) => earlier[key]?.label ?? Object.entries(earlier).find(([k]) => k.replace(/#\d+$/, '') === key)?.[1].label;

const opening = new Map<string, { note: Shown; sessions: number }>();
for (const r of Object.values(prompts)) for (const n of (r.new.opening ?? []) as Shown[]) {
  const o = opening.get(n.id) ?? { note: n, sessions: 0 };
  o.sessions++;
  opening.set(n.id, o);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cards = [
  ...[...opening.values()].sort((a, b) => b.sessions - a.sessions).map(({ note, sessions }) => ({
    key: `opening:${note.id}`, kind: 'opening', head: `답변 스타일 블록 · ${sessions}개 대화 시작에 들어감`, prompt: '', lines: [note.body], was: '',
  })),
  ...Object.entries(prompts).filter(([, r]) => r.new.decision === 'stepped').sort(([, a], [, b]) => a.at.localeCompare(b.at)).map(([key, r]) => ({
    key, kind: 'step',
    head: `${r.at.slice(0, 10)} · ${r.agent} @${r.project} · ${r.fresh ? '대화 시작' : '대화 중간 (새 종류의 일)'} · ${r.logged ? '그때도 끼어듦' : '그때는 조용했음 → 새로 끼어듦'}`,
    prompt: r.prompt.slice(0, 900),
    lines: [...(r.new.added as Shown[]).map((n) => `+ [${n.why ?? ''}] ${n.body}`), ...(r.new.offered as Shown[]).map((n) => `? [${n.why ?? ''}] ${n.body}`)],
    was: [earlierFor(key) ? `그때 개입에 단 라벨: ${earlierFor(key)}` : '', r1[key] ? `1차 재설계 라벨: ${r1[key].label}` : ''].filter(Boolean).join(' · '),
  })),
];

const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>headsup 재설계 라벨링</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mute:#6b6b6b;--line:#e3e3e3;--acc:#2f6feb;--warn:#c0392b}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eaeaea;--mute:#9a9a9a;--line:#2c2c2c}}
body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px}
h1{font-size:20px} .count{color:var(--mute)} .item{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}
.item.cur{border-color:var(--acc)} .head{color:var(--mute);font-size:13px} pre{white-space:pre-wrap;font:inherit;margin:8px 0}
.note{border-left:3px solid var(--line);padding-left:10px;margin:6px 0} button{font:inherit;margin:4px 6px 0 0;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:none;color:inherit;cursor:pointer}
button.on{background:var(--acc);border-color:var(--acc);color:#fff} button[data-v=harmful].on,button[data-v=drop].on{background:var(--warn);border-color:var(--warn)}
input{font:inherit;width:100%;margin-top:6px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:none;color:inherit}
</style>
<h1>headsup 재설계: 새 구조가 다르게 하는 것</h1>
<p class="count" id="count"></p>
<p class="count">위쪽은 대화 시작마다 들어갈 답변 스타일 노트, 아래쪽은 새 구조가 끼어드는 프롬프트예요. 숫자키로 라벨, 메모칸은 선택.</p>
${cards.map((c) => `<section class="item" data-key="${esc(c.key)}" data-kind="${c.kind}">
<div class="head">${esc(c.head)}${c.was ? ` · ${esc(c.was)}` : ''}</div>
${c.prompt ? `<pre>${esc(c.prompt)}</pre>` : ''}
${c.lines.map((l) => `<div class="note">${esc(l)}</div>`).join('')}
<div>${(c.kind === 'opening' ? OPENING : STEP).map(([v, t], i) => `<button data-v="${v}">${i + 1} ${esc(t)}</button>`).join('')}</div>
<input class="why" placeholder="왜? (선택)">
</section>`).join('')}
<script>
let labels = ${JSON.stringify(existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {})};
const cards = [...document.querySelectorAll('.item')];
let current = cards.find(c => !labels[c.dataset.key]) || cards[0];
async function save(){ try { await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(labels)}); } catch {} paint(); }
function paint(){
  cards.forEach(c => { const l = labels[c.dataset.key]; c.classList.toggle('cur', c === current);
    c.querySelectorAll('button').forEach(b => b.classList.toggle('on', l?.label === b.dataset.v));
    const w = c.querySelector('.why'); if (document.activeElement !== w) w.value = l?.why || ''; });
  document.getElementById('count').textContent = Object.keys(labels).filter(k => labels[k]?.label).length + ' / ' + cards.length + ' 완료';
}
function next(c){ const i = cards.indexOf(c); current = cards.slice(i+1).find(x => !labels[x.dataset.key]) || cards[Math.min(i+1, cards.length-1)]; current.scrollIntoView({block:'center',behavior:'smooth'}); }
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; const c = b.closest('.item'); current = c;
  const k = c.dataset.key; if (labels[k]?.label === b.dataset.v) delete labels[k]; else labels[k] = { label: b.dataset.v, why: labels[k]?.why };
  save(); if (labels[k]) next(c);
});
document.addEventListener('change', e => { if (!e.target.matches('.why')) return; const k = e.target.closest('.item').dataset.key;
  labels[k] = { ...(labels[k] || {}), why: e.target.value || undefined }; save(); });
document.addEventListener('keydown', e => {
  if (e.target.matches('.why')) { if (e.key === 'Enter') { e.target.blur(); next(current); paint(); } return; }
  const b = current.querySelectorAll('button')[Number(e.key) - 1]; if (b) b.click();
});
paint(); current.scrollIntoView({block:'center'});
</script></html>`;

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/save') {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d));
    req.on('end', () => {
      const labels = JSON.parse(raw || '{}') as Record<string, { label?: string } | null>;
      writeFileSync(OUT, JSON.stringify(Object.fromEntries(Object.entries(labels).filter(([, v]) => v?.label)), null, 2));
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
}).listen(47411, '127.0.0.1', () => console.log(`${cards.length} cards (${opening.size} opening notes, ${cards.length - opening.size} step-ins)\n→ http://localhost:47411/   (labels save to ${OUT})`));
