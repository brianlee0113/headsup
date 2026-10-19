// Parses the setup answer "which AI do you use for what?" into usage rules, locally and without a
// model: "Claude for coding and side projects, ChatGPT for writing" →
//   [{ agents: [claude-code, claude-ai], topics: [coding, side projects] }, { agents: [chatgpt], topics: [writing] }]

import type { UsageRule } from './config.js';

// Longest aliases first, so "claude code" is not read as "claude".
const AGENT_ALIASES: Array<[string, string[]]> = [
  ['claude code', ['claude-code']],
  ['claude.ai', ['claude-ai']],
  ['gemini cli', ['gemini-cli']],
  ['chatgpt', ['chatgpt']],
  ['챗지피티', ['chatgpt']],
  ['챗gpt', ['chatgpt']],
  ['gpt', ['chatgpt']],
  ['claude', ['claude-code', 'claude-ai']],
  ['클로드', ['claude-code', 'claude-ai']],
  ['codex', ['codex']],
  ['코덱스', ['codex']],
  ['cursor', ['cursor']],
  ['커서', ['cursor']],
  ['gemini', ['gemini', 'gemini-cli']],
  ['제미나이', ['gemini', 'gemini-cli']],
];

export const TOPIC_ALIASES: Record<string, string[]> = {
  coding: ['coding', 'code', 'programming', 'development', 'dev', '코딩', '개발', '코드'],
  'side projects': ['side project', 'side projects', 'projects', 'project', '사이드 프로젝트', '프로젝트'],
  writing: ['writing', 'write', 'emails', 'posts', 'essays', '글쓰기', '글', '작문'],
  everyday: ['everyday', 'daily', 'life', 'personal stuff', '일상', '생활'],
  career: ['career', 'job search', 'resume', 'job hunting', '취업', '커리어', '이력서'],
};

const HANGUL = /[가-힣]/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Latin aliases need word boundaries; Korean ones are followed by particles (클로드는, 글쓰기나).
const pattern = (alias: string) => (HANGUL.test(alias) ? escape(alias) : `(?<![\\p{L}\\p{N}])${escape(alias)}(?![\\p{L}\\p{N}])`);

const AGENT_RE = new RegExp(AGENT_ALIASES.map(([a]) => pattern(a)).join('|'), 'giu');
const TOPIC_RES: Array<[string, RegExp]> = Object.entries(TOPIC_ALIASES).map(([topic, aliases]) => [
  topic,
  new RegExp(aliases.map(pattern).join('|'), 'iu'),
]);

export function parseUsage(text: string): UsageRule[] {
  const mentions = [...text.matchAll(AGENT_RE)];
  const rules: UsageRule[] = [];
  let agents: string[] = [];
  mentions.forEach((m, i) => {
    const alias = m[0].toLowerCase();
    agents.push(...(AGENT_ALIASES.find(([a]) => a === alias)?.[1] ?? []));
    // Everything up to the next agent describes this one; agents with nothing in between share topics.
    const segment = text.slice(m.index + m[0].length, mentions[i + 1]?.index ?? text.length);
    const topics = TOPIC_RES.filter(([, re]) => re.test(segment)).map(([t]) => t);
    if (!topics.length) return;
    rules.push({ agents: [...new Set(agents)], topics });
    agents = [];
  });
  return rules;
}
