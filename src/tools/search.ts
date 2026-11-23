import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import fg from 'fast-glob';

const MAX_RESULTS = 200;
const MAX_GREP_LINES = 300;

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  '__pycache__',
  '.venv',
  '.next',
  '.nuxt',
  'coverage',
  'build',
  '.cache',
];

export const globFilesTool = tool({
  description:
    'Find files matching a glob pattern. Useful for discovering project structure. Excludes common non-essential directories (node_modules, .git, dist, etc.).',
  parameters: z.object({
    pattern: z.string().describe('Glob pattern to match (e.g., "**/*.ts", "src/**/*.tsx")'),
    cwd: z
      .string()
      .optional()
      .describe('Working directory for the search. Defaults to current directory.'),
  }),
  execute: async ({ pattern, cwd }) => {
    const workDir = cwd ? resolve(cwd) : process.cwd();
    try {
      const files = await fg(pattern, {
        cwd: workDir,
        ignore: DEFAULT_IGNORE.map((d) => `**/${d}/**`),
        dot: false,
        onlyFiles: true,
        absolute: false,
      });

      if (files.length === 0) {
        return 'No files found matching the pattern.';
      }

      const sorted = files.sort();
      const truncated = sorted.length > MAX_RESULTS;
      const display = truncated ? sorted.slice(0, MAX_RESULTS) : sorted;

      let result = display.join('\n');
      if (truncated) {
        result += `\n\n[... ${sorted.length - MAX_RESULTS} more files. Narrow the pattern to see all.]`;
      }
      result = `Found ${sorted.length} files:\n${result}`;
      return result;
    } catch (err) {
      return `Error searching files: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

function jsGrep(
  pattern: string,
  searchPath: string,
  include?: string
): string[] {
  const results: string[] = [];
  const regex = new RegExp(pattern, 'i');
  const basePath = resolve(searchPath || '.');

  function walk(dir: string): void {
    if (results.length >= MAX_GREP_LINES) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_GREP_LINES) return;
      if (DEFAULT_IGNORE.includes(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        if (include) {
          const includeRegex = new RegExp(
            include.replace(/\*/g, '.*').replace(/\?/g, '.'),
            'i'
          );
          if (!includeRegex.test(entry)) continue;
        }

        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              const relPath = relative(basePath, fullPath);
              results.push(`${relPath}:${i + 1}: ${lines[i]!.trim()}`);
              if (results.length >= MAX_GREP_LINES) return;
            }
          }
        } catch {
          // Skip binary/unreadable files
        }
      }
    }
  }

  walk(basePath);
  return results;
}

export const grepSearchTool = tool({
  description:
    'Search for a regex pattern across files. Uses ripgrep (rg) if available, otherwise falls back to a built-in search. Returns matching lines with file paths and line numbers.',
  parameters: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z
      .string()
      .optional()
      .describe('Directory to search in. Defaults to current directory.'),
    include: z
      .string()
      .optional()
      .describe('File glob pattern to filter (e.g., "*.ts", "*.py")'),
  }),
  execute: async ({ pattern, path, include }) => {
    const searchPath = path ? resolve(path) : process.cwd();

    // Try ripgrep first
    try {
      const args = ['rg', '--line-number', '--no-heading', '--color=never'];
      if (include) {
        args.push(`--glob=${include}`);
      }
      for (const ig of DEFAULT_IGNORE) {
        args.push(`--glob=!${ig}`);
      }
      args.push(pattern, searchPath);

      const output = execSync(args.join(' '), {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      });

      const lines = output.trim().split('\n');
      if (lines.length > MAX_GREP_LINES) {
        const kept = [...lines.slice(0, 50), `\n[... ${lines.length - 250} lines truncated ...]`, ...lines.slice(-200)];
        return kept.join('\n');
      }
      return output.trim() || 'No matches found.';
    } catch {
      // ripgrep not available or failed — use JS fallback
    }

    // JS fallback
    try {
      const results = jsGrep(pattern, searchPath, include);
      if (results.length === 0) {
        return 'No matches found.';
      }

      let output = results.join('\n');
      if (results.length >= MAX_GREP_LINES) {
        output += `\n\n[... results capped at ${MAX_GREP_LINES} lines. Narrow the pattern or path.]`;
      }
      return output;
    } catch (err) {
      return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
