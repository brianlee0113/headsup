// Shows which of the demo notes the browser extension would offer for a prompt, to pick demo prompts.
//   HEADSUP_HOME=<seeded home> pnpm tsx scripts/demo/probe.mts "<prompt>" ...
import { handleWeb } from '../../src/web.js';
import { Store } from '../../src/store.js';
import { loadConfig } from '../../src/config.js';
const home = process.env.HEADSUP_HOME!;
const store = new Store(home), config = loadConfig(home);
for (const p of process.argv.slice(2)) {
  const r = handleWeb({ type: 'detect', site: 'chatgpt.com', prompt: p }, store, config, '0') as any;
  console.log('\n' + p);
  for (const k of ['inject', 'ask']) for (const n of r[k]) console.log(` ${k.padEnd(6)} ${n.space} ${n.type} ${n.body}`);
  console.log(' blocked', r.blocked.count);
}
