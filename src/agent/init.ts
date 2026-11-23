import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
}

const IGNORED_ENTRIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  '__pycache__',
]);

function readPackageJson(cwd: string): PackageJson {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf-8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return {};
  }
}

function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

function listTopLevel(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !IGNORED_ENTRIES.has(entry.name))
      .slice(0, 40)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
  } catch {
    return [];
  }
}

export interface InitProjectResult {
  path: string;
  created: boolean;
}

/**
 * Create a starter CORTEX.md that Cortex loads into its system prompt.
 * Existing files are never overwritten.
 */
export function initProjectFile(cwd = process.cwd()): InitProjectResult {
  const target = join(cwd, 'CORTEX.md');
  if (existsSync(target)) {
    return { path: target, created: false };
  }

  const pkg = readPackageJson(cwd);
  const packageManager = detectPackageManager(cwd);
  const scripts = pkg.scripts ?? {};

  const installCommand =
    packageManager === 'npm' ? 'npm install' : `${packageManager} install`;

  const commandLines = Object.entries(scripts)
    .slice(0, 12)
    .map(([name, script]) => `- \`${packageManager} run ${name}\` — ${script}`)
    .join('\n');

  const topLevel = listTopLevel(cwd);
  const layout = topLevel.length > 0 ? topLevel.join('\n') : '(empty or unreadable)';

  const content = `# CORTEX.md

This file gives Cortex project-specific guidance. Edit it freely; it is loaded
into the system prompt for every conversation in this repository.

## Project
- Name: ${pkg.name ?? 'unnamed'}
- Description: ${pkg.description ?? 'No description provided.'}
- Package manager: ${packageManager}

## Commands
- \`${installCommand}\` — install dependencies
${commandLines || '- No package.json scripts detected.'}

## Layout
\`\`\`
${layout}
\`\`\`

## Guidelines
- Explore the relevant files before making changes.
- Prefer small, surgical edits over rewrites.
- Match the existing code style, naming, and structure.
- Run the build and tests after changing behavior.
- Keep unrelated files untouched.
`;

  writeFileSync(target, content, 'utf-8');
  return { path: target, created: true };
}
