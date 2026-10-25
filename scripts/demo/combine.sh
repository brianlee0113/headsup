#!/bin/sh
# Joins the two recorded demos into the README's hero GIF: the browser first, then Claude Code, each
# under a one-line label (rendered with headless Chrome, since ffmpeg here has no text filter).
#   sh scripts/demo/combine.sh docs/demo-terminal.gif docs/demo-browser.gif docs/headsup-demo.gif
set -e
TERM_GIF=$1 BROWSER_GIF=$2 OUT=$3
CHROME="${HEADSUP_E2E_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
label() { # $1 file, $2 tool, $3 rest
  cat > "$T/$1.html" <<HTML
<!doctype html><meta charset=utf-8><style>
@font-face{font-family:Geist;font-weight:100 900;src:url($REPO/assets/fonts/geist-latin.woff2)}
body{margin:0;width:900px;height:56px;background:#0a0a0a;color:#fafafa;font:500 18px Geist;display:flex;align-items:center;gap:12px;padding:0 24px;box-sizing:border-box}
b{font-weight:650} span{color:#a3a3a3}
</style><svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 18 12 10l8 8" fill="none" stroke="#fafafa" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="19.5" cy="4.5" r="3.5" fill="#FF3D8B"/></svg><b>$2</b><span>$3</span>
HTML
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=900,56 --screenshot="$T/$1.png" "file://$T/$1.html" 2>/dev/null
}
label l1 "In Claude Code" "your writing voice, learned in ChatGPT"
label l2 "In ChatGPT · claude.ai" "your projects from Claude Code, minus what you untick"
D1=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TERM_GIF")
D2=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BROWSER_GIF")
ffmpeg -y -loglevel error -i "$TERM_GIF" -i "$BROWSER_GIF" -loop 1 -t "$D1" -i "$T/l1.png" -loop 1 -t "$D2" -i "$T/l2.png" -filter_complex "
[0:v]fps=15,scale=900:-2:flags=lanczos,pad=900:704:0:(oh-ih)/2:color=0x0a0a0a,setsar=1[a];
[1:v]fps=15,scale=900:-2:flags=lanczos,pad=900:704:0:(oh-ih)/2:color=0x0a0a0a,setsar=1[b];
[2:v]fps=15,setsar=1[la];[3:v]fps=15,setsar=1[lb];
[la][a]vstack[s1];[lb][b]vstack[s2];
[s2][s1]concat=n=2:v=1,split[x][y];[x]palettegen=max_colors=160:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 "$OUT"
rm -rf "$T"
echo "$OUT"
