// Draws the README's before/after comparison as two SVGs (light and dark), so the parts of the answer
// that came from notes can be shown in the accent color. GitHub Markdown can't color text.
//   node scripts/demo/compare.mjs        writes docs/compare-light.svg and docs/compare-dark.svg
import { writeFileSync } from 'node:fs';

const PROMPT = 'help me write a cover letter for a PM internship';
// A line is a list of [text, fromNote] runs.
const without = [
  [['● I’d be glad to help! To make it stand out,', false]],
  [['  tell me a bit about you:', false]],
  [['', false]],
  [['  1. What projects have you built?', false]],
  [['  2. Any results you can point to?', false]],
  [['  3. Which company is it for?', false]],
];
const withNotes = [
  [['● Dear hiring team,', false]],
  [['', false]],
  [['  This summer I interned on ', false], ['the payments', true]],
  [['  ', false], ['team at Northwind', true], [', where I ', false], ['shipped payout', true]],
  [['  ', false], ['retries that cut failed payouts by 30%', true], ['.', false]],
  [['  On the side I built ', false], ['Quorum, a web app that', true]],
  [['  ', false], ['finds a meeting time for student clubs', true]],
  [['  ', false], ['from everyone’s calendar', true], ['. ...', false]],
];

const THEMES = {
  light: { card: '#F6F6F6', line: '#E5E5E5', fg: '#0A0A0A', muted: '#6B6B6B', accent: '#E0186C' },
  dark: { card: '#141414', line: '#262626', fg: '#FAFAFA', muted: '#A3A3A3', accent: '#FF3D8B' },
};
const W = 900, COL = 438, GAP = W - 2 * COL, PAD = 22, LH = 22, FONT = 13;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function column(x, title, sub, headsup, lines, t) {
  const out = [];
  let y = PAD + 14;
  out.push(`<text x="${x + PAD}" y="${y}" fill="${t.fg}" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="14">${title}</text>`);
  out.push(`<text x="${x + COL - PAD}" y="${y}" fill="${t.muted}" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">${sub}</text>`);
  y += 34;
  out.push(`<text x="${x + PAD}" y="${y}" fill="${t.muted}">&gt; <tspan fill="${t.fg}">${esc(PROMPT)}</tspan></text>`);
  y += LH;
  if (headsup) {
    out.push(`<text x="${x + PAD}" y="${y}" fill="${t.muted}"><tspan fill="${t.accent}" font-weight="700">⌃ heads-up</tspan> · 3 notes from Claude Code</text>`);
  }
  y += LH + 8;
  for (const runs of lines) {
    const spans = runs.map(([s, note]) => (note
      ? `<tspan fill="${t.accent}" font-weight="700" text-decoration="underline">${esc(s)}</tspan>`
      : `<tspan>${esc(s)}</tspan>`)).join('');
    out.push(`<text x="${x + PAD}" y="${y}" fill="${t.fg}" xml:space="preserve">${spans}</text>`);
    y += LH;
  }
  return { svg: out.join('\n'), bottom: y };
}

for (const [name, t] of Object.entries(THEMES)) {
  const a = column(0, 'Without headsup', 'ChatGPT', false, without, t);
  const b = column(COL + GAP, 'With headsup', 'ChatGPT', true, withNotes, t);
  const H = Math.max(a.bottom, b.bottom) + PAD - 6;
  const card = (x) => `<rect x="${x + 0.5}" y="0.5" width="${COL - 1}" height="${H - 1}" rx="12" fill="${t.card}" stroke="${t.line}"/>`;
  writeFileSync(new URL(`../../docs/compare-${name}.svg`, import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${FONT}">
${card(0)}
${card(COL + GAP)}
${a.svg}
${b.svg}
</svg>
`);
}
console.log('wrote docs/compare-light.svg, docs/compare-dark.svg');
