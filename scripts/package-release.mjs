import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const bundle = join(root, 'dist', 'cortex.js');

if (!existsSync(bundle)) {
  console.error('dist/cortex.js not found — run `npm run build` first.');
  process.exit(1);
}

const releaseRoot = join(root, 'release');
const stage = join(releaseRoot, 'cortex');

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });

cpSync(bundle, join(stage, 'bin', 'cortex.js'));
cpSync(join(root, 'README.md'), join(stage, 'README.md'));
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

console.log(`Staged Cortex v${pkg.version} in release/cortex`);
console.log('Archive it with:');
console.log('  tar -czf cortex.tar.gz -C release/cortex .');
console.log('  zip -qr cortex.zip .            # from inside release/cortex');
