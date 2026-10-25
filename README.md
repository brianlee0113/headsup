<p align="center">
  <img src="https://unpkg.com/headsup-ai/assets/brand/icon.svg" width="72" height="72" alt="headsup">
</p>

<h1 align="center">headsup</h1>

<p align="center">
  <strong>Gives your AI a heads-up before it answers.</strong><br>
  Shared memory between ChatGPT, Claude and your coding agents. It steps in only when a question is missing context, and only with what you allow.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#where-it-works">Where it works</a> ·
  <a href="#your-data">Your data</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/headsup-ai"><img src="https://img.shields.io/npm/v/headsup-ai?color=FF3D8B" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-MIT-0A0A0A" alt="license: MIT">
  <img src="https://img.shields.io/badge/runtime%20deps-0-0A0A0A" alt="zero runtime dependencies">
</p>

<p align="center">
  <img src="docs/demo.gif" width="900" alt="Two scenes. In the browser, a cover-letter request gets a side-project note and three work notes; the internal roadmap note is unticked before sending, and the sent message folds the added notes into a pill. In Claude Code, 'write the v2.3 release notes in my voice' gets a heads-up line saying one note was added from ChatGPT, and the answer comes back plain and short.">
  <br><sub>Context goes both ways: your Claude Code projects in a browser chat, your ChatGPT writing voice in Claude Code. Both recorded with the real app and extension and a fictional user's notes; the browser scene runs on a stand-in chat page.</sub>
</p>

---

You write in ChatGPT and build in Claude Code. Ask Claude Code for release notes "in my voice" and it has no idea what your voice is. ChatGPT knows, but that knowledge is stuck in ChatGPT. headsup notices the gap and passes the right note along before the answer is written:

<table>
<tr>
<th width="50%">Without headsup</th>
<th width="50%">With headsup</th>
</tr>
<tr>
<td valign="top">

```text
> write the v2.3 release notes in my voice

● # 🚀 v2.3 Release Notes
  We're excited to announce a range of
  improvements that make billing more
  robust than ever! ✨
  ## What's New
  - Enhanced webhook performance ...
```

</td>
<td valign="top">

```text
> write the v2.3 release notes in my voice

⌃ heads-up · added 1 note from ChatGPT
  · personal (how you work)

● ## v2.3
  Billing webhooks are faster. Retries no
  longer double-charge. Checkout errors now
  show a clear message, not a stack trace.
```

</td>
</tr>
</table>

<sub>Trimmed example output. Most of the time headsup does nothing at all — that's the point.</sub>

## Highlights

- **Steps in only when it helps.** It reads your prompt first and adds a note only when *this* AI is missing something *another* one knows. Unrelated prompts get nothing.
- **Knows what the AI already knows.** Anything already in `CLAUDE.md`, `AGENTS.md` or the current conversation is left out.
- **Work stays at work.** Notes live in a work or personal space. Facts that would cross over wait for your OK, and secrets are never stored.
- **Works where you chat.** Claude Code through hooks, chatgpt.com and claude.ai through a Chrome extension. Chats from the ChatGPT and Claude phone apps come in through your account.
- **Nothing to maintain.** Notes are collected as you work, repeats are merged, and outdated facts are set aside. No exports to redo, no lists to paste.
- **Yours, on your computer.** Plain Markdown in `~/.headsup`. No server, no account, no telemetry. Adds well under a second to a prompt, with zero runtime dependencies.

## Quick start

You need Node 22+ on macOS or Linux, and [Claude Code](https://claude.com/claude-code). headsup summarizes chats through your own `claude` login, so there's no API key to paste.

```sh
npm install -g headsup-ai
headsup setup
```

Just trying it? `npx headsup-ai setup` works too, but then every prompt starts headsup through npx, which is slower. Install it once you decide to keep it.

`headsup setup` asks five things:

1. **Agents.** Connect Claude Code. It adds its own hook entries to `~/.claude/settings.json` and backs up the file first.
2. **How you split your tools**, in your own words. For example: *"Claude for coding and side projects, ChatGPT for writing and everyday stuff."*
3. **Which folders are work.** Everything else is personal.
4. **Sharing preset.** Balanced unless you change it.
5. **Bring existing memory** (optional). Import your ChatGPT data export once. After that, the extension keeps up on its own.

**Chrome extension (chatgpt.com, claude.ai):** on its way to the Chrome Web Store. Until then, build it from a checkout of this repo:

```sh
pnpm install && pnpm build:ext
headsup connect-browser
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `extension/build`. It also works in Chrome Beta, Chromium, Brave, Edge and Arc.

## How it works

```mermaid
flowchart LR
  P[Your prompt] --> N{Does it need<br/>outside context?}
  N -- no --> Q[Stay quiet]
  N -- yes --> K{Does this AI<br/>already know it?}
  K -- yes --> Q
  K -- no --> S{Your sharing<br/>preset}
  S -- allowed --> I[Add the note<br/>+ one quiet line]
  S -- ask first --> A[Name the topic,<br/>wait for your OK]
  S -- blocked --> B[Count it, never send it]
```

1. **Does it need context?** Unresolved references like "my usual setup", "that project", "like last time", a question outside what you normally use this tool for, or a strong match with a note from another tool.
2. **Does this AI already know?** Notes that are already in `CLAUDE.md`, `AGENTS.md`, the current conversation, or came from this same tool and project are left out.
3. **May it cross over?** Notes live in a **work** or **personal** space. Your preset decides what may travel between them (below).
4. **Show what happened.** Every heads-up prints one line saying what was added and where it came from. `headsup review` shows the rest.

Notes are collected for you: when a Claude Code session ends or goes quiet, and when you open chatgpt.com or claude.ai with the extension installed. Chats you had in the phone and desktop apps sync through your account, so they come in too. In the background, notes that say the same thing are merged, and ones a newer fact replaced are set aside.

## Share how you work, not what you work on

Every note is either **how you work** (preferences, style, conventions) or a **fact** (people, companies, projects). Secrets are scrubbed before anything is written to disk.

| Preset | How you work | Facts | Secrets |
|---|---|---|---|
| Cautious | ask first | blocked | never stored |
| **Balanced** (default) | automatic | ask first | never stored |
| Open | automatic | automatic | never stored |

"Ask first" means headsup names the topic, not the content. In a terminal the agent asks you in the conversation, and nothing is sent until you say yes. In the browser, related notes appear pre-ticked and you untick the ones that should stay home:

```text
⌃ heads-up · 1 work note waiting for your OK (ci)
⌃ heads-up · 2 work notes stayed home (repo names, runner config) · preset: Cautious
```

## Where it works

| Where you use AI | How headsup connects | What you get |
|---|---|---|
| **Claude Code** | hooks | Checked on every prompt, notes added before the answer |
| **chatgpt.com · claude.ai** | Chrome extension | Notes attached as you hit send. Untick any first |
| **ChatGPT · Claude apps** (phone, desktop) | your account, through the extension | App chats are collected, and an "About me" block in your custom instructions is kept up to date (opt-in). No per-question notes |
| Codex CLI · Gemini CLI | hooks | Coming soon |
| Cursor · Claude Desktop · Windsurf | MCP | After launch. The AI decides when to call it, so it can miss |
| Phone only, no desktop Chrome | — | Not supported |

## Your data

- **Notes stay on your computer**, in `~/.headsup/notes/` as plain Markdown files. You can read, edit or delete them by hand.
- **Summaries use your own Claude login.** Turning a session or chat into notes runs `claude -p` with the haiku model on your account. headsup has no server, no account and no telemetry.
- **Health, relationships, money, legal matters, religion and politics** are skipped when ChatGPT history is imported. Secrets such as API keys and tokens are dropped before anything is written.
- **The extension only reads your own chats, on sites you have open, while you're signed in.** It only writes inside its own fenced block in your custom instructions, and only if you turn "About me" on. Turning it off removes the block.
- **Uninstall** with `headsup uninstall`. It removes the hook and the browser connection and keeps your notes.

## Commands

```text
headsup setup              connect Claude Code and choose what may be shared
headsup review             see what was shared where; edit, reclassify or delete notes
headsup connect-browser    let the Chrome extension reach headsup on this computer
headsup import chatgpt <export.zip>
                           turn your ChatGPT history into notes (last 12 months)
headsup card               make a shareable card: which AI you use for what
headsup add | list | search | log
headsup uninstall          remove the hook and browser connection (your notes stay)
```

Most of the work happens without a command. Capturing sessions, catching up on sessions that never ended (tmux panes, reboots), syncing chats from your accounts and tidying notes all run in the background.

## FAQ

**Isn't this just another memory MCP server?**
No. An MCP server waits for the model to decide to call it, and models often don't. headsup sits *before* the model. It reads your prompt, decides whether outside context is missing, and adds only that. Coding agents get it through hooks and web chats through the extension. MCP is planned only for tools that have no hook to use.

**Won't it stuff every prompt with notes?**
That's the failure it's built to avoid. A note is left out if this AI already has it in its context files or in the conversation. Weak matches are dropped too. The card made by `headsup card` shows how many of your prompts it actually stepped in on.

**What stops work information leaking into my personal AI?**
Spaces and presets. Facts that would cross from work to personal are held back until you approve them, or blocked entirely under Cautious. Notes can also be marked never-share.

**Does it use the ChatGPT or Claude APIs?**
The extension uses the same internal endpoints the sites use, from your own signed-in session. They can change without notice. When one does, the extension tells you in its popup instead of failing silently.

## Development

```sh
pnpm test                         # unit tests (vitest)
pnpm typecheck
pnpm tsx test/eval.ts             # retrieval eval set: recall / precision on English and Korean prompts
node scripts/e2e-extension/run.mjs   # extension end to end: Chrome for Testing + real native host + mock chatgpt.com
```

The code is TypeScript with no runtime dependencies. Search is BM25 plus a small concept dictionary (`src/concepts.ts`), so "cover letter" finds notes about your internship without an embedding model.

## Roadmap

- [x] Claude Code: add notes before each prompt, capture sessions when they end
- [x] Chrome extension for chatgpt.com and claude.ai
- [x] Account sync for app chats, "About me" block
- [x] Review TUI, ChatGPT import, background tidy, share card
- [ ] Tune when to step in, using simulated conversations
- [x] npm release
- [ ] Chrome Web Store release
- [ ] Codex CLI and Gemini CLI hooks
- [ ] gemini.google.com
- [ ] Thin MCP server for Cursor, Claude Desktop and Windsurf

## License

[MIT](LICENSE). Bundled fonts (Geist, JetBrains Mono) are under the SIL Open Font License. See `assets/fonts/`.
