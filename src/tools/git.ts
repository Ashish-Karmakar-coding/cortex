import { tool } from 'ai';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const MAX_DIFF_LINES = 300;

function runGit(args: string[], cwd?: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync('git', args, {
      cwd: cwd ? resolve(cwd) : process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out.trim() };
  } catch (err) {
    const anyErr = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr = anyErr.stderr ? String(anyErr.stderr).trim() : '';
    const stdout = anyErr.stdout ? String(anyErr.stdout).trim() : '';
    return {
      ok: false,
      output: stderr || stdout || anyErr.message || 'Git command failed',
    };
  }
}

export const gitStatusTool = tool({
  description: 'Show current git branch and working tree status (read-only).',
  parameters: z.object({
    cwd: z.string().optional().describe('Repository directory. Defaults to current directory.'),
  }),
  execute: async ({ cwd }) => {
    const res = runGit(['status', '--short', '--branch'], cwd);
    if (!res.ok) return `Git error: ${res.output}`;
    return res.output || 'Clean working tree.';
  },
});

export const gitDiffTool = tool({
  description: 'Inspect uncommitted git changes (unstaged by default, or staged=true).',
  parameters: z.object({
    staged: z.boolean().optional().describe('Set true to view staged changes (--cached).'),
    path: z.string().optional().describe('Optional file path to scope the diff.'),
    cwd: z.string().optional().describe('Repository directory. Defaults to current directory.'),
  }),
  execute: async ({ staged, path, cwd }) => {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (path) args.push('--', path);

    const res = runGit(args, cwd);
    if (!res.ok) return `Git error: ${res.output}`;
    if (!res.output) return staged ? 'No staged changes.' : 'No unstaged changes.';

    const lines = res.output.split('\n');
    if (lines.length > MAX_DIFF_LINES) {
      return [
        ...lines.slice(0, MAX_DIFF_LINES),
        `\n[... truncated ${lines.length - MAX_DIFF_LINES} lines. Pass a specific path to narrow the diff.]`,
      ].join('\n');
    }
    return res.output;
  },
});

export const gitLogTool = tool({
  description: 'Show recent git commits in the repository (read-only).',
  parameters: z.object({
    limit: z.number().optional().describe('Number of commits to return (default 15, max 50).'),
    path: z.string().optional().describe('Optional file path to filter commit history.'),
    cwd: z.string().optional().describe('Repository directory. Defaults to current directory.'),
  }),
  execute: async ({ limit, path, cwd }) => {
    const count = Math.min(Math.max(1, Math.floor(limit ?? 15)), 50);
    const args = ['log', '--oneline', '--decorate', '-n', String(count)];
    if (path) args.push('--', path);

    const res = runGit(args, cwd);
    if (!res.ok) return `Git error: ${res.output}`;
    return res.output || 'No commits found.';
  },
});
