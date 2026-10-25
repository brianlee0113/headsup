# headsup privacy policy

_Last updated: October 24, 2026_

headsup is an open-source tool that carries context between the AI tools you use. It has two parts: the **headsup app**, which runs on your computer, and the **headsup browser extension** for chatgpt.com and claude.ai. This policy covers both.

**The short version:** your notes are stored on your computer. headsup has no server, no account system and no analytics. The developer never receives your data.

## What headsup reads

- **The message you are writing** on chatgpt.com or claude.ai, while you type, to decide whether any of your notes would help.
- **The conversation on screen**, to leave out notes the AI already has.
- **Your own chats on chatgpt.com and claude.ai**, if you turn on chat sync. The extension reads new or changed chats when you open the site, using your signed-in session. Temporary chats and chats marked not to be remembered are skipped.
- **Your Claude Code sessions** on your computer, when they end or go quiet.
- **Your ChatGPT data export**, only if you choose to import it.

## What headsup stores, and where

- **Notes**: short summaries such as how you like to work, your writing style, or facts about your projects. They are plain Markdown files in `~/.headsup` on your computer, which you can read, edit or delete.
- **A log** of which notes were added to which messages, in the same folder, so you can review it with `headsup review`.
- **Extension settings** (on/off per site, sync and "About me" choices), in your browser's extension storage.

headsup does not keep the full text of your chats. API keys, tokens and similar secrets are removed before anything is written. When importing ChatGPT history, conversations about health, relationships, money, legal matters, religion and politics are skipped.

## Who else sees your data

- **Anthropic, through your own Claude account.** To turn a chat or session into notes, the headsup app runs the Claude Code command line (`claude`) that you are signed in to. That text is processed under your agreement with Anthropic. headsup does not use its own API key or account.
- **OpenAI or Anthropic, as part of your messages.** When you send a message with notes attached, those notes go to the site you are chatting on as part of that message, exactly like text you typed. You see and can untick every note before sending.
- **OpenAI or Anthropic, in your settings, if you turn on "About me".** headsup keeps a short, marked block in your ChatGPT custom instructions or Claude personal preferences. It never changes the rest of what you wrote there, and turning the option off removes the block.

No one else. headsup does not sell, share or transfer your data, does not use it for advertising, and does not use it to determine creditworthiness or for lending.

## Your choices

- Turn headsup off on a site, or turn off chat sync or "About me", from the extension's popup.
- Mark any note as never-share, change it, or delete it with `headsup review`.
- Remove the Claude Code hook and the browser connection with `headsup uninstall`. To delete everything, delete the `~/.headsup` folder.

## Changes

If this policy changes, the new version will be posted at this address with a new date above.

## Contact

Questions: open an issue at https://github.com/brianlee0113/headsup/issues
