// Fills a throwaway headsup home with Sam, the fictional demo persona (test/fixtures/sam.ts), for
// recording the README demos. Usage: pnpm tsx scripts/demo/seed.ts <home>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig } from '../../src/config.js';
import { markChecked } from '../../src/spaces.js';
import { Store } from '../../src/store.js';
import { samConfig, samNotes } from '../../test/fixtures/sam.js';

const home = process.argv[2];
if (!home) throw new Error('usage: seed.ts <home>');
const store = new Store(home);
for (const n of samNotes) store.add({ type: n.type, space: n.space, source: n.source, body: n.body, topics: n.topics, project: n.project });
// Sam's spaces are set by hand, so the web notes need no sorting look (spaces.ts) before they're used.
markChecked(home, store.list().map((n) => n.id));
saveConfig(samConfig, home);
// The demo must not summarize the recorder's own Claude Code sessions into Sam's memory.
mkdirSync(join(home, 'state'), { recursive: true });
writeFileSync(join(home, 'state', 'catch-up.json'), JSON.stringify({ at: Date.now() + 10 * 365 * 86_400_000 }));
console.log(`seeded ${samNotes.length} notes into ${home}`);
