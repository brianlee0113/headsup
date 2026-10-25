# Chrome Web Store listing

Copy for the developer dashboard. Field names follow the dashboard's tabs.

## Store listing

**Name:** headsup

**Summary** (132 characters max, this is 104):

> Gives your AI a heads-up before it answers: context from your other AI tools, added only when it helps.

**Category:** Productivity → Tools

**Language:** English

**Description:**

> You write in ChatGPT and build with Claude. Each one only knows what you told it. headsup carries what one AI learned about you to the other, at the moment a question needs it.
>
> As you type in chatgpt.com or claude.ai, headsup checks whether the question is missing context that another of your AI tools has: your writing voice, the project you mean by "my side project", how you like answers formatted. If it is, a small mark by the message box shows which notes would go along. Untick any you'd rather keep out, then send as usual. If nothing is missing, it stays quiet.
>
> WHAT IT DOES
> • Adds a short context block to your message, only when it helps, and only with notes you can see and untick first
> • Keeps work and personal apart: facts that would cross from one to the other wait for your OK
> • Leaves out what the AI already knows from the conversation
> • Picks up chats you had in the ChatGPT and Claude phone apps the next time you open the site (optional)
> • Keeps a short "About me" block in your ChatGPT and Claude settings, so their apps know how you work too (optional, off until you turn it on; turning it off removes the block)
>
> YOUR DATA STAYS ON YOUR COMPUTER
> Notes live in plain Markdown files on your computer, managed by the free headsup app. The extension talks only to that app (through Chrome's native messaging) and to the chat site you have open. There is no headsup server, no account and no analytics.
>
> REQUIRES THE HEADSUP APP
> The extension needs the free, open-source headsup app on the same computer (macOS or Linux, Node 22+). Install it with one command: npx headsup-ai setup. Turning chats into notes uses your own Claude Code login.
>
> Open source (MIT): https://github.com/brianlee0113/headsup

**Images:** `store/assets/`
- Icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800: `screenshot-1-composer.png`, `screenshot-2-popup.png`, `screenshot-3-before-after.png`
- Small promo tile 440×280: `promo-small.png`

**Official URL / homepage:** https://github.com/brianlee0113/headsup (once the repo is public)

## Privacy practices

**Single purpose:**

> Adds relevant context from the user's other AI tools to the messages they write on chatgpt.com and claude.ai, and keeps that context, which is stored on the user's own computer, up to date from the same accounts.

**Permission justifications:**

| Permission | Why |
|---|---|
| `nativeMessaging` | The user's notes and the decision about which notes help are in the headsup app on the same computer. The extension sends the draft message to that app and receives the notes to show. Nothing leaves the computer this way. |
| `storage` | Remembers the user's choices: on/off per site, whether chat sync and the "About me" block are on, and when each site was last caught up. |
| Host permission `https://chatgpt.com/*` | Shows the headsup mark by the message box, adds the context block the user approved when they send, folds that block in sent messages, reads the user's own new chats to keep notes current (optional), and updates the headsup block in custom instructions (optional). |
| Host permission `https://claude.ai/*` | Same as chatgpt.com, for claude.ai and Claude's personal preferences. |

**Remote code:** No. All JavaScript is in the package.

**Data usage** (tick these in the dashboard):

- [x] Personal communications: the draft message and, if chat sync is on, the user's own chats on these two sites. Used only to find relevant notes and to write new notes on the user's computer.
- [x] Website content: the visible conversation, to leave out notes the AI already has.
- [ ] Everything else (personally identifiable info, health, financial, authentication, location, web history, user activity): not collected.

Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** the published copy of `store/privacy.md` (see `store/README.md`).

## Test instructions for the reviewer

> headsup needs its companion app. On macOS or Linux with Node 22+: run `npx headsup-ai setup`, accept the browser connection step, then reload chatgpt.com. Type "write a LinkedIn post about my side project in my usual voice" (no need to send): the headsup mark by the message box shows the notes that would be added. With no notes saved yet, the mark stays quiet; `headsup add "Writes short, plain posts without emoji" --type how --space personal --source chatgpt` adds one to try.
