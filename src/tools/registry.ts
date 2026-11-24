import type { PermissionConfig } from '../config/store.js';

export type ToolPermission = 'auto' | 'confirm' | 'blocked';
export type AgentPermissionMode = 'manual' | 'auto' | 'plan';

export interface ToolMetadata {
  name: string;
  permission: ToolPermission;
  description: string;
}

export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'glob_files',
  'grep_search',
  'git_status',
  'git_diff',
  'git_log',
  'todo_write',
]);

export const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'bash_exec',
  'web_fetch',
  'task',
]);

export const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  read_file: 'auto',
  glob_files: 'auto',
  grep_search: 'auto',
  git_status: 'auto',
  git_diff: 'auto',
  git_log: 'auto',
  todo_write: 'auto',
  web_fetch: 'confirm',
  task: 'confirm',
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

function matchesRule(rule: string, toolName: string, args: Record<string, unknown>): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  if (trimmed === toolName || trimmed === '*') return true;

  // Pattern form: toolName(argPattern) e.g. bash_exec(npm test*)
  const match = /^([a-zA-Z0-9_:-]+)\((.+)\)$/.exec(trimmed);
  if (!match) return false;
  const [, ruleTool, argGlob] = match;
  if (ruleTool !== toolName) return false;

  const target =
    typeof args['command'] === 'string'
      ? args['command']
      : typeof args['path'] === 'string'
        ? args['path']
        : JSON.stringify(args);

  const escaped = argGlob!.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(target);
}

export function evaluateToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
  mode: AgentPermissionMode,
  permissions?: PermissionConfig
): { permission: ToolPermission; reason?: string } {
  if (permissions?.deny?.some((rule) => matchesRule(rule, toolName, args))) {
    return { permission: 'blocked', reason: `Tool "${toolName}" is denied by configuration.` };
  }

  if (mode === 'plan') {
    if (toolName === 'task') {
      const agentType = String(args['agent_type'] ?? 'general-purpose').toLowerCase();
      if (agentType === 'explore' || agentType === 'plan' || agentType === 'review') {
        return { permission: 'auto' };
      }
      return {
        permission: 'blocked',
        reason: `Plan mode is active (read-only). Only explore/plan/review subagents are allowed.`,
      };
    }
    if (!READ_ONLY_TOOLS.has(toolName)) {
      return {
        permission: 'blocked',
        reason: `Plan mode is active (read-only). Mutating tool "${toolName}" is disabled until leaving plan mode.`,
      };
    }
    return { permission: 'auto' };
  }

  if (permissions?.allow?.some((rule) => matchesRule(rule, toolName, args))) {
    return { permission: 'auto' };
  }

  if (mode === 'auto') {
    return { permission: 'auto' };
  }

  return { permission: getPermission(toolName) };
}
