import { build } from 'esbuild';
import { readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const outfile = join(root, 'dist', 'cortex.js');

rmSync(join(root, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: process.env.CORTEX_MINIFY === '1',
  legalComments: 'none',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cortexCreateRequire } from 'node:module';",
      'const require = __cortexCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    __CORTEX_VERSION__: JSON.stringify(pkg.version),
  },
  alias: {
    // Ink only loads this when DEV=true (React devtools debugging).
    'react-devtools-core': join(root, 'scripts', 'stub-devtools.mjs'),
  },
  logLevel: 'info',
});

// Make the bundle directly executable on macOS/Linux.
try {
  chmodSync(outfile, 0o755);
} catch {
  // Windows has no chmod — that's fine.
}

// Keep a tiny marker so the installer/`cortex upgrade` can detect a bundle.
writeFileSync(
  join(root, 'dist', 'version.txt'),
  `${pkg.version}\n`,
  'utf-8'
);

console.log(`Built dist/cortex.js (v${pkg.version})`);
