// Chrome native messaging: the extension calls chrome.runtime.sendNativeMessage, Chrome starts this
// host, writes one length-prefixed JSON message to stdin and reads one reply from stdout. No server,
// no open port; the host exits after answering.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { writeLauncher } from './launcher.js';

export const HOST_NAME = 'ai.headsup.host';
// Fixed by the public key in extension/manifest.json, so the host can trust exactly this extension.
export const EXTENSION_ID = 'khpoiajpimicekhdejhjmfjaklbcgpkk'; // the Chrome Web Store's
// IDs the extension had before, still trusted so an existing install keeps working after a key change
// (the Chrome Web Store assigns its own key; see store/README.md).
export const EARLIER_EXTENSION_IDS: string[] = ['heomldlmknjaidfkfkdhjibppainocea']; // unpacked installs before the store

export function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export async function readMessage(input: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    const all = Buffer.concat(chunks, size);
    if (all.length >= 4) {
      const length = all.readUInt32LE(0);
      if (all.length >= 4 + length) return JSON.parse(all.subarray(4, 4 + length).toString('utf8'));
    }
  }
  throw new Error('the browser closed the connection before sending a message');
}

// Where Chrome-family browsers look for native host manifests. Only browsers that are installed
// (their profile folder exists) get one.
export function browserHostDirs(home = homedir(), os = platform()): string[] {
  const base = os === 'darwin'
    ? ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data']
        .map((p) => join(home, 'Library/Application Support', p))
    : os === 'linux'
      ? ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map((p) => join(home, '.config', p))
      : [];
  return base.filter((dir) => existsSync(dir)).map((dir) => join(dir, 'NativeMessagingHosts'));
}

export function installNativeHost(headsupHome: string, dirs = browserHostDirs()): { script: string; manifests: string[] } {
  const script = join(headsupHome, 'native-host');
  mkdirSync(dirname(script), { recursive: true });
  // Chrome runs the host path with no arguments and without our environment, so this goes through
  // the launcher (launcher.ts), which names the home, keeps this shell's PATH so account sync can find
  // `claude`, and finds Node again on every run.
  writeFileSync(script, `#!/bin/sh\nexec "${writeLauncher(headsupHome)}" native-host "$@"\n`);
  chmodSync(script, 0o755);
  const manifest = {
    name: HOST_NAME,
    description: 'headsup — shared memory across your AI tools',
    path: script,
    type: 'stdio',
    allowed_origins: [EXTENSION_ID, ...EARLIER_EXTENSION_IDS].map((id) => `chrome-extension://${id}/`),
  };
  const manifests: string[] = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${HOST_NAME}.json`);
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    manifests.push(file);
  }
  return { script, manifests };
}

export function uninstallNativeHost(dirs = browserHostDirs()): number {
  let removed = 0;
  for (const dir of dirs) {
    const file = join(dir, `${HOST_NAME}.json`);
    if (existsSync(file)) {
      rmSync(file);
      removed++;
    }
  }
  return removed;
}
