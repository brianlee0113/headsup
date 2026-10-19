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
