// Replaced at build time by scripts/build.mjs (esbuild `define`).
// Falls back to "dev" when running the TypeScript sources directly.
declare const __CORTEX_VERSION__: string;

export const VERSION: string =
  typeof __CORTEX_VERSION__ === 'string' ? __CORTEX_VERSION__ : '0.0.0-dev';

export const REPO = process.env['CORTEX_REPO'] ?? 'Ashish-Karmakar-coding/cortex';
