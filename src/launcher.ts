// One file that Claude Code, Codex and the browser all start headsup through: <home>/bin/headsup.
// Hook entries used to name a Node binary by its full path (~/.nvm/versions/node/v23.6.1/bin/node), so
// switching or removing that Node version, or reinstalling headsup under another one, quietly broke
// every hook. The launcher looks for Node and headsup again on each run instead: the copy it was
// written by, then whatever Node is on the path (or the newest under nvm), then the `headsup` command,
// then npx.

import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shellQuote } from './config.js';

export const launcherPath = (home: string) => join(home, 'bin', 'headsup');

export function launcherScript(home: string, node: string, cli: string, path: string | undefined): string {
  return `#!/bin/sh
# Written by headsup: Claude Code, Codex and the browser start headsup through this file. It finds Node
# and headsup again on every run, so changing Node versions or reinstalling headsup doesn't break them.
export HEADSUP_HOME=${shellQuote(home)}
export PATH=${shellQuote([path, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'))}
NODE=${shellQuote(node)}
CLI=${shellQuote(cli)}
[ -x "$NODE" ] || NODE=$(command -v node)
if [ -z "$NODE" ]; then for n in "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$n" ] && NODE=$n; done; fi
if [ -n "$NODE" ] && [ -n "$CLI" ] && [ -f "$CLI" ]; then exec "$NODE" "$CLI" "$@"; fi
if command -v headsup >/dev/null 2>&1; then exec headsup "$@"; fi
if [ -n "$NODE" ] && [ -x "$(dirname "$NODE")/npx" ]; then exec "$(dirname "$NODE")/npx" -y headsup-ai "$@"; fi
exec npx -y headsup-ai "$@"
`;
}

// The copy of headsup running now, unless it runs from npx's cache, which can be cleared at any time.
function currentCli(): string {
  const self = process.argv[1] ? realpathSync(process.argv[1]) : '';
  return self && !self.includes('/_npx/') ? self : '';
}

export function writeLauncher(home: string): string {
  const file = launcherPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, launcherScript(home, process.execPath, currentCli(), process.env.PATH));
  chmodSync(file, 0o755);
  return file;
}
