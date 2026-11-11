export const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude.ai',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  gemini: 'Gemini',
  chatgpt: 'ChatGPT',
};

export const agentName = (id: string): string => AGENT_NAMES[id] ?? id;

// What the person calls each tool in their own words, for telling whether a note is about that tool as
// another party ("Codex's review suggestions", "a request to give Codex"). Bare "Claude" names two tools.
const AGENT_ALIASES: Record<string, RegExp> = {
  'claude-code': /claude[\s-]?code|클로드\s*코드/i,
  'claude-ai': /claude\.ai/i,
  codex: /codex|코덱스/i,
  cursor: /\bcursor\b/i,
  'gemini-cli': /gemini|제미나이/i,
  gemini: /gemini|제미나이/i,
  chatgpt: /chat\s?gpt|챗\s?gpt|챗지피티/i,
};
export const namesAgent = (agent: string, text: string): boolean => !!AGENT_ALIASES[agent]?.test(text);
