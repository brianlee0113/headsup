#!/bin/sh
# Records the README's terminal demo with VHS: real Claude Code in a "quorum" folder, with only the
# headsup prompt hook attached (no personal settings, status line or MCP servers), reading Sam's notes.
# Variables from a surrounding Claude Code session are dropped so the recording looks like a fresh terminal.
#   pnpm build && sh scripts/demo/record-terminal.sh docs/demo-terminal.gif
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(cd "$(dirname "${1:-demo-terminal.gif}")" && pwd)/$(basename "${1:-demo-terminal.gif}")
T=$(mktemp -d)
"$REPO/node_modules/.bin/tsx" "$REPO/scripts/demo/seed.ts" "$T/sam"
# Outside the home folder, so the path Claude Code shows carries no user name.
DEMO="/Users/Shared/quorum"
[ -e "$DEMO" ] && { echo "$DEMO already exists; not touching it"; exit 1; }
mkdir -p "$DEMO"
trap 'rm -rf "$DEMO" "$T"' EXIT
cat > "$T/settings.json" <<JSON
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "HEADSUP_HOME='$T/sam' '$(command -v node)' '$REPO/dist/cli.js' hook claude-code" } ] } ] } }
JSON
cat > "$T/demo.tape" <<TAPE
Output "$OUT"
Set Shell "bash"
Set FontSize 15
Set Width 1100
Set Height 860
Set Padding 24
Set Theme { "background": "#0a0a0a", "foreground": "#fafafa", "black": "#262626", "red": "#ff6b6b", "green": "#4ade80", "yellow": "#facc15", "blue": "#7aa7ff", "magenta": "#ff3d8b", "cyan": "#67e8f9", "white": "#e5e5e5", "brightBlack": "#8f8f8f", "brightRed": "#ff8a8a", "brightGreen": "#86efac", "brightYellow": "#fde047", "brightBlue": "#a5c4ff", "brightMagenta": "#ff6ba6", "brightCyan": "#a5f3fc", "brightWhite": "#ffffff", "cursor": "#fafafa", "selection": "#262626" }
Set TypingSpeed 40ms
Hide
Type "unset \$(env | sed -n 's/^\\(CLAUDE[A-Z_]*\\)=.*/\\1/p') TMUX; export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; cd '$DEMO' && export PS1='quorum \$ ' && clear" Enter
Sleep 500ms
Type "claude --setting-sources '' --settings '$T/settings.json' --strict-mcp-config --model sonnet --permission-mode default" Enter
Sleep 6s
Down
Enter
Sleep 5s
Ctrl+L
Sleep 1s
Show
Sleep 1s
Type "write the v2.3 release notes in my voice: faster webhooks, no more double charges on retry, clearer checkout errors"
Sleep 600ms
Enter
Sleep 16s
Hide
Ctrl+C
Ctrl+C
TAPE
vhs "$T/demo.tape"
echo "$OUT"
