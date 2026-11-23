import { z } from 'zod';

export type ToolPermission = 'auto' | 'confirm' | 'blocked';

export interface ToolMetadata {
  name: string;
  permission: ToolPermission;
  description: string;
}

export const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  read_file: 'auto',
  glob_files: 'auto',
  grep_search: 'auto',
  git_status: 'auto',
  git_diff: 'auto',
  git_log: 'auto',
  write_file: 'confirm',
  edit_file: 'confirm',
  bash_exec: 'confirm',
};

export const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-\s*rf\s+\//,
  /rm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /curl\s+.*\|\s*(sh|bash)/,
  /wget\s+.*\|\s*(sh|bash)/,
  /chmod\s+777\s+\//,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,
  /\bformat\s+[a-zA-Z]:/i,
  /del\s+\/[sfq]\s+/i,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function getPermission(toolName: string): ToolPermission {
  return TOOL_PERMISSIONS[toolName] ?? 'confirm';
}
