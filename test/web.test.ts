import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { encode, EXTENSION_ID, HOST_NAME, installNativeHost, readMessage, uninstallNativeHost } from '../src/native.js';
import { buildHeadsUps } from '../src/review/model.js';
import { BLOCK_MARKER, buildBlock, splitBlock, type WebNote } from '../src/shared/block.js';
import { Store } from '../src/store.js';
import { handleWeb, type DetectReply } from '../src/web.js';
import { samConfig, samNotes } from './fixtures/sam.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'headsup-'));
const note = (id: string, body: string): WebNote => ({ id, type: 'fact', body, topics: [], from: 'Claude Code (quorum)', space: 'personal' });

describe('context block', () => {
  it('reads back what the person typed and how many notes went with it', () => {
    const text = 'Write the release notes for Quorum v0.3' + buildBlock([note('a', 'v0.3 adds recurring meetings'), note('b', 'Quorum has 140 weekly users')]);
    expect(text).toContain(BLOCK_MARKER);
    expect(text).toContain('• (fact · Claude Code (quorum), personal) v0.3 adds recurring meetings');
    expect(splitBlock(text)).toEqual({ typed: 'Write the release notes for Quorum v0.3', count: 2 });
    expect(splitBlock('no block here')).toBeNull();
    expect(buildBlock([])).toBe('');
  });
});

describe('native messaging', () => {
  it('frames messages the way Chrome does', async () => {
    const framed = encode({ type: 'status', note: '평소처럼' });
    expect(framed.readUInt32LE(0)).toBe(framed.length - 4);
    // Chrome may deliver the frame in pieces.
    const pieces = Readable.from([framed.subarray(0, 3), framed.subarray(3, 10), framed.subarray(10)]);
    expect(await readMessage(pieces)).toEqual({ type: 'status', note: '평소처럼' });
  });

  it('trusts exactly the extension whose key is in the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../extension/manifest.json'), 'utf8')) as { key: string };
    const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
    const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    expect(id).toBe(EXTENSION_ID);
  });

  it('installs a launcher and a host manifest per browser, and removes them', () => {
    const home = tmp();
    const dirs = [join(tmp(), 'Chrome', 'NativeMessagingHosts'), join(tmp(), 'Arc', 'NativeMessagingHosts')];
    const r = installNativeHost(home, dirs);
    expect(r.manifests).toHaveLength(2);
    const m = JSON.parse(readFileSync(r.manifests[0]!, 'utf8'));
    expect(m).toMatchObject({ name: HOST_NAME, type: 'stdio', path: r.script, allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] });
    expect(statSync(r.script).mode & 0o111).toBeTruthy();
    expect(readFileSync(r.script, 'utf8')).toMatch(/native-host "\$@"/);
    expect(readFileSync(r.script, 'utf8')).toContain(`export HEADSUP_HOME='${home}'`); // Chrome starts it without our env
    expect(uninstallNativeHost(dirs)).toBe(2);
  });
});

describe('web requests', () => {
  const setup = () => {
    const store = new Store(tmp());
    mkdirSync(store.home, { recursive: true });
    for (const n of samNotes) store.add({ type: n.type, space: n.space, source: n.source, body: n.body, topics: n.topics, ...(n.project ? { project: n.project } : {}) });
    return store;
  };

  it('answers detect without logging, using the default space', () => {
    const store = setup();
    const r = handleWeb({ type: 'detect', site: 'chatgpt.com', prompt: "Help me write a cover letter for Fieldnote's product manager role" }, store, samConfig, '0.0.1') as DetectReply;
    expect(r.space).toBe('personal');
    expect(r.ask.map((n) => n.body)).toEqual(expect.arrayContaining(['Northwind internship on the payments team, summer 2026']));
    expect(r.ask[0]!.from).toBe('Claude Code');
    expect([...r.inject, ...r.ask].every((n) => n.from !== 'ChatGPT')).toBe(true); // ChatGPT's own notes stay out
    expect(store.readLog()).toEqual([]);
  });

  it('logs what was actually sent, so review shows it', () => {
    const store = setup();
    const r = handleWeb({ type: 'detect', site: 'chatgpt.com', prompt: "Help me write a cover letter for Fieldnote's product manager role" }, store, samConfig, '0.0.1') as DetectReply;
    const asked = r.ask.map((n) => n.id);
    handleWeb({ type: 'sent', site: 'chatgpt.com', prompt: 'cover letter', injected: r.inject.map((n) => n.id), offered: asked, included: asked.slice(0, 1), blocked: [] }, store, samConfig, '0.0.1');
    const [row] = buildHeadsUps(store.readLog(), store.list());
    expect(row).toMatchObject({ agent: 'chatgpt', outcome: 'shared', sharedCount: 1 });
  });

  it('reports status and refuses unknown sites', () => {
    const store = setup();
    expect(handleWeb({ type: 'status' }, store, samConfig, '0.0.1')).toMatchObject({ type: 'status', notes: samNotes.length, preset: 'balanced' });
    expect(handleWeb({ type: 'detect', site: 'example.com', prompt: 'hi there friend' }, store, samConfig, '0.0.1')).toMatchObject({ type: 'error' });
    expect(handleWeb({ type: 'nope' } as never, store, samConfig, '0.0.1')).toMatchObject({ type: 'error' });
  });
});
