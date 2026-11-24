import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry } from '../storage/localStore.js';
import type { AgentPermissionMode } from '../tools/registry.js';
import { getConfigDir } from '../config/store.js';

const IGNORE_DIRS = new Set([
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
  '.tox',
  'vendor',
]);

const MAX_TREE_ENTRIES = 150;

function getGitBranch(): string {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getGitStatus(): string {
  try {
    const status = execFileSync('git', ['status', '--short'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!status) return 'Clean working tree';
    const lines = status.split('\n');
    if (lines.length > 20) {
      return lines.slice(0, 20).join('\n') + `\n... and ${lines.length - 20} more files`;
    }
    return status;
  } catch {
    return 'Not a git repository';
  }
}

function loadGitignorePatterns(): Set<string> {
  const patterns = new Set<string>();
  try {
    if (existsSync('.gitignore')) {
      const content = readFileSync('.gitignore', 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const dirName = trimmed.replace(/^\//, '').replace(/\/$/, '').replace(/\*/g, '');
          if (dirName) patterns.add(dirName);
        }
      }
    }
  } catch {
    // ignore
  }
  return patterns;
}

function buildDirectoryTree(rootDir: string, maxEntries: number): string {
  const gitignorePatterns = loadGitignorePatterns();
  const allIgnored = new Set([...IGNORE_DIRS, ...gitignorePatterns]);
  const entries: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (entries.length >= maxEntries || depth > 5) return;

    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }

    items = items.filter((item) => {
      if (item.startsWith('.') && item !== '.env.example') return false;
      return !allIgnored.has(item);
    });

    for (let i = 0; i < items.length; i++) {
      if (entries.length >= maxEntries) {
        entries.push(`${prefix}... (truncated)`);
        return;
      }

      const item = items[i]!;
      const fullPath = join(dir, item);
      const isLast = i === items.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        entries.push(`${prefix}${connector}${item}/`);
        walk(fullPath, nextPrefix, depth + 1);
      } else {
        entries.push(`${prefix}${connector}${item}`);
      }
    }
  }

  walk(rootDir, '', 0);
  return entries.join('\n');
}

function loadInstructionFile(filePath: string, title: string): string {
  if (!existsSync(filePath)) return '';
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return '';
    const truncated = raw.length > 10_000 ? `${raw.slice(0, 10_000)}\n... (truncated)` : raw;
    return `\n## ${title}\n${truncated}\n`;
  } catch {
    return '';
  }
}

export interface SystemPromptOptions {
  cwd?: string;
  permissionMode?: AgentPermissionMode;
  memoryEntries?: MemoryEntry[];
  mcpToolNames?: string[];
}

export async function buildSystemPrompt(options: SystemPromptOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const branch = getGitBranch();
  const gitStatus = getGitStatus();
  const tree = buildDirectoryTree(cwd, MAX_TREE_ENTRIES);

  const globalInstructions = loadInstructionFile(
    join(getConfigDir(), 'CORTEX.md'),
    'User Instructions (~/.cortex/CORTEX.md)'
  );
  const projectInstructions =
    loadInstructionFile(join(cwd, 'CORTEX.md'), 'Project Instructions (CORTEX.md)') ||
    loadInstructionFile(join(cwd, '.cortex', 'CORTEX.md'), 'Project Instructions (.cortex/CORTEX.md)');

  let storedMemory = '';
  if (options.memoryEntries && options.memoryEntries.length > 0) {
    const lines = options.memoryEntries
      .slice(0, 30)
      .map((m) => `- [${m.scope}] **${m.key}**: ${m.content}`);
    storedMemory = `\n## Persisted Memory\n${lines.join('\n')}\n`;
  }

  const modeNotice =
    options.permissionMode === 'plan'
      ? `\n## Mode: PLAN (Read-Only)\nPlan mode is active. File writes, edits, and shell commands are blocked. Use read_file, glob_files, grep_search, git_status, git_diff, git_log, and explore/plan subagents to investigate and present a detailed implementation plan.\n`
      : '';

  const mcpList =
    options.mcpToolNames && options.mcpToolNames.length > 0
      ? `\n- **MCP tools**: ${options.mcpToolNames.join(', ')}`
      : '';

  return `You are Cortex, an expert AI coding assistant operating directly in the user's terminal.
You have controlled access to the local filesystem, can search codebases, inspect git state, run shell commands, and make surgical file edits.
${globalInstructions}${projectInstructions}${storedMemory}${modeNotice}
## Environment
- **OS:** ${process.platform} (${process.arch})
- **CWD:** ${cwd}
- **Date:** ${new Date().toISOString()}
- **Git Branch:** ${branch}
- **Git Status:**
${gitStatus}

## Project Structure
\`\`\`
${tree}
\`\`\`

## Available Tools
- **read_file**: Read file contents with optional line range (start_line, end_line). Lines are numbered.
- **write_file**: Create or overwrite a file. Creates parent directories automatically.
- **edit_file**: Make surgical edits using SEARCH/REPLACE blocks (search_block, replace_block). Must match one location.
- **glob_files**: Find files matching glob patterns (pattern, optional cwd).
- **grep_search**: Search for regex patterns across files (pattern, optional path, optional include).
- **bash_exec**: Execute shell commands (command, optional cwd, optional timeout).
- **git_status / git_diff / git_log**: Read-only git inspection tools.
- **todo_write**: Create/update a structured task checklist (todos array) for multi-step work.
- **web_fetch**: Fetch text content from an http/https URL.
- **task**: Delegate a self-contained task to a subagent (general-purpose, explore, plan, review, or custom agent).${mcpList}

## Subagents
Use **task** when a job would flood your context with search results or when independent work can be delegated. Write a complete, self-contained prompt: the subagent cannot see this conversation.

## Guidelines
1. **Use tools instead of guessing.** Never fabricate file contents, symbol names, or command outputs — inspect them with tools first.
2. **Explore before editing.** Use read_file, grep_search, and glob_files before modifying files.
3. **Use surgical edits.** Prefer edit_file with focused SEARCH/REPLACE blocks (including 2-3 surrounding context lines) over write_file for existing files.
4. **Verify changes.** After editing, run relevant tests or build commands with bash_exec to verify correctness.
5. **Be concise.** Explain what you're doing clearly without unnecessary filler.
6. **Iterate until done.** Keep working through tool calls until the user's request is fully resolved.
`;
}

export interface ToolDocSpec {
  name: string;
  description: string;
  params: string;
}

const CORE_TOOL_DOCS: Record<string, ToolDocSpec> = {
  read_file: {
    name: 'read_file',
    description: 'Read numbered lines of a file or list a directory.',
    params: '{"path": "string (required)", "start_line": "number (optional)", "end_line": "number (optional)"}',
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file.',
    params: '{"path": "string (required)", "content": "string (required)"}',
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace exact search_block with replace_block in an existing file.',
    params: '{"path": "string (required)", "search_block": "string (required)", "replace_block": "string (required)"}',
  },
  glob_files: {
    name: 'glob_files',
    description: 'Find files matching a glob pattern.',
    params: '{"pattern": "string (required, e.g. \\"src/**/*.ts\\")", "cwd": "string (optional)"}',
  },
  grep_search: {
    name: 'grep_search',
    description: 'Search regex pattern across files.',
    params: '{"pattern": "string (required)", "path": "string (optional)", "include": "string (optional, e.g. \\"*.ts\\")"}',
  },
  bash_exec: {
    name: 'bash_exec',
    description: 'Execute a shell command.',
    params: '{"command": "string (required)", "cwd": "string (optional)", "timeout": "number (optional ms)"}',
  },
  git_status: {
    name: 'git_status',
    description: 'Show git branch and status.',
    params: '{"cwd": "string (optional)"}',
  },
  git_diff: {
    name: 'git_diff',
    description: 'Show git diff.',
    params: '{"staged": "boolean (optional)", "path": "string (optional)", "cwd": "string (optional)"}',
  },
  git_log: {
    name: 'git_log',
    description: 'Show recent git commits.',
    params: '{"limit": "number (optional)", "path": "string (optional)", "cwd": "string (optional)"}',
  },
  todo_write: {
    name: 'todo_write',
    description: 'Update the task checklist.',
    params: '{"todos": [{"id": "string", "content": "string", "status": "pending|in_progress|completed"}]}',
  },
  web_fetch: {
    name: 'web_fetch',
    description: 'Fetch text content from an HTTP/HTTPS URL.',
    params: '{"url": "string (required)"}',
  },
  task: {
    name: 'task',
    description: 'Delegate work to an isolated subagent.',
    params: '{"description": "string (required, 3-5 words)", "prompt": "string (required)", "agent_type": "explore|plan|review|general-purpose (optional)"}',
  },
};

export function buildXmlToolInstructions(
  toolNames: string[],
  extraToolDocs: ToolDocSpec[] = []
): string {
  const specs: string[] = [];
  const extraMap = new Map(extraToolDocs.map((d) => [d.name, d]));

  for (const name of toolNames) {
    const core = CORE_TOOL_DOCS[name];
    if (core) {
      specs.push(`- **${core.name}**: ${core.description}\n  arguments: ${core.params}`);
      continue;
    }
    const extra = extraMap.get(name);
    if (extra) {
      specs.push(`- **${extra.name}**: ${extra.description}\n  arguments: ${extra.params}`);
    }
  }

  return `## Tool Calling Format
When you need to inspect files, search, edit, or run commands, you MUST call tools using XML <tool_call> tags containing valid JSON with "name" and "arguments":

<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>

### Tool Schemas
${specs.join('\n')}

Rules:
- Emit ONLY valid JSON inside <tool_call>...</tool_call> (escape newlines in strings as \\n and quotes as \\").
- Never describe a tool call without actually emitting the <tool_call> tag.
- Wait for the tool result before making claims about file contents or command output.`;
}

export const XML_TOOL_INSTRUCTIONS = buildXmlToolInstructions(Object.keys(CORE_TOOL_DOCS));
