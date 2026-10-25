// Zips extension/build for the Chrome Web Store. The store gives the item its own key, so the
// "key" that pins the extension ID for unpacked installs is left out of the uploaded manifest.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const build = join(root, 'extension', 'build');
const manifest = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'));
delete manifest.key;

const stage = mkdtempSync(join(tmpdir(), 'headsup-ext-'));
cpSync(build, stage, { recursive: true });
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const outDir = join(root, 'dist-ext');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `headsup-extension-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-qrX', out, '.', '-x', '.*'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`${out} (manifest ${manifest.version}, no "key")`);
