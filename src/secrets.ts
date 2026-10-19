// Secrets are dropped before anything is written to disk. Detection errs on the side of redacting.

const PATTERNS: Array<[string, RegExp]> = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['stripe-key', /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/g],
  ['slack-token', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['assigned-secret', /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/gi],
];

export interface Redaction {
  text: string;
  dropped: string[]; // kinds of secrets removed, e.g. ["stripe-key"]
}

export function redactSecrets(input: string): Redaction {
  let text = input;
  const dropped: string[] = [];
  for (const [kind, re] of PATTERNS) {
    text = text.replace(re, () => {
      dropped.push(kind);
      return `[${kind} removed]`;
    });
  }
  return { text, dropped };
}
