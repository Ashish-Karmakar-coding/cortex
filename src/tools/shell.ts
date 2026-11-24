import { tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { isDangerous } from './registry.js';

const MAX_OUTPUT_LINES = 300;
const HEAD_LINES = 50;
const TAIL_LINES = 200;
const DEFAULT_TIMEOUT = 60_000;

function truncateOutput(output: string): { text: string; truncated: boolean } {
  const lines = output.split('\n');
  if (lines.length <= MAX_OUTPUT_LINES) {
    return { text: output, truncated: false };
  }

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;

  return {
    text: [...head, `\n[... ${omitted} lines truncated ...]`, ...tail].join('\n'),
    truncated: true,
  };
}

function killProcessTree(pid: number | undefined, fallbackKill: () => void): void {
  if (!pid) {
    fallbackKill();
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        detached: true,
      });
      return;
    } catch {
      fallbackKill();
      return;
    }
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    fallbackKill();
  }
}

export function createBashExecTool(abortSignal?: AbortSignal) {
  return tool({
    description:
      'Execute a shell command and return its output. Commands have a default timeout of 60 seconds. Use this for running tests, builds, git commands, and other shell operations.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z.string().optional().describe('Working directory. Defaults to current directory.'),
      timeout: z
        .number()
        .optional()
        .describe('Timeout in milliseconds. Default: 60000'),
    }),
    execute: async ({ command, cwd, timeout }) => {
      if (isDangerous(command)) {
        return JSON.stringify({
          stdout: '',
          stderr: 'BLOCKED: This command matches a dangerous pattern and was not executed.',
          exitCode: 1,
          truncated: false,
        });
      }

      const timeoutMs = timeout ?? DEFAULT_TIMEOUT;
      const workDir = cwd ? resolve(cwd) : process.cwd();

      return new Promise<string>((resolvePromise) => {
        const isWindows = process.platform === 'win32';

        const child = spawn(command, {
          shell: true,
          cwd: workDir,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !isWindows,
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timer = setTimeout(() => {
          killed = true;
          killProcessTree(child.pid, () => child.kill('SIGKILL'));
        }, timeoutMs);

        const onAbort = () => {
          killed = true;
          killProcessTree(child.pid, () => child.kill('SIGKILL'));
        };

        abortSignal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', (exitCode) => {
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);

          const stdoutResult = truncateOutput(stdout);
          const stderrResult = truncateOutput(stderr);

          resolvePromise(
            JSON.stringify({
              stdout: stdoutResult.text,
              stderr: stderrResult.text,
              exitCode: killed ? null : exitCode,
              truncated: stdoutResult.truncated || stderrResult.truncated,
              ...(killed
                ? { killed: true, reason: abortSignal?.aborted ? 'aborted' : 'timeout' }
                : {}),
            })
          );
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
          resolvePromise(
            JSON.stringify({
              stdout: '',
              stderr: `Failed to execute command: ${err.message}`,
              exitCode: 1,
              truncated: false,
            })
          );
        });
      });
    },
  });
}
