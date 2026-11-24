import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamText, type CoreMessage, type LanguageModel, type ToolResultPart } from 'ai';
import { getConfigDir } from '../config/store.js';
import { readFileTool, writeFileTool, editFileTool } from '../tools/fs.js';
import { globFilesTool, grepSearchTool } from '../tools/search.js';
import { createBashExecTool } from '../tools/shell.js';
import { gitStatusTool, gitDiffTool, gitLogTool } from '../tools/git.js';
import { isToolsUnsupportedError } from '../providers/ollama.js';
import { parseToolCalls, hasToolCalls, normalizeToolArguments } from './fallbackParser.js';
import { buildXmlToolInstructions } from './prompts.js';

export type SubagentSource = 'builtin' | 'project' | 'user';

export interface SubagentDefinition {
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  source: SubagentSource;
  path?: string;
  maxIterations?: number;
}

export const ALL_SUBAGENT_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'glob_files',
  'grep_search',
  'git_status',
  'git_diff',
  'git_log',
  'bash_exec',
] as const;

const READ_ONLY_TOOLS = [
  'read_file',
  'glob_files',
  'grep_search',
  'git_status',
  'git_diff',
  'git_log',
];

const BUILTIN_AGENTS: SubagentDefinition[] = [
  {
    name: 'general-purpose',
    description:
      'Full-capability agent for multi-step research and implementation. Can read, search, edit files, and run commands.',
    tools: [...ALL_SUBAGENT_TOOLS],
    maxIterations: 20,
    systemPrompt:
      'You are a general-purpose coding subagent. Investigate thoroughly, make the requested changes, and verify them. Do not stop at a plan: finish the work unless the instructions explicitly ask for analysis only.',
    source: 'builtin',
  },
  {
    name: 'explore',
    description:
      'Read-only search agent. Locates files, symbols, and answers questions about how the codebase works.',
    tools: [...READ_ONLY_TOOLS],
    maxIterations: 16,
    systemPrompt:
      'You are a read-only codebase explorer. Search broadly, read the relevant files, and answer the question with concrete file paths and line references. Never modify files. Prefer several targeted searches over one broad guess.',
    source: 'builtin',
  },
  {
    name: 'plan',
    description:
      'Read-only software architect. Produces a step-by-step implementation plan with file-level detail.',
    tools: [...READ_ONLY_TOOLS],
    maxIterations: 16,
    systemPrompt:
      'You are a software architect subagent. Inspect the code, identify the constraints, and return a concrete, ordered implementation plan. Name the files and functions that must change and call out risks. Never modify files.',
    source: 'builtin',
  },
  {
    name: 'review',
    description:
      'Read-only code reviewer. Checks a change for bugs, regressions, and missing tests.',
    tools: [...READ_ONLY_TOOLS],
    maxIterations: 16,
    systemPrompt:
      'You are a code reviewer subagent. Inspect the current working tree and review the requested change for correctness, edge cases, security issues, and missing tests. Report findings ordered by severity with file references. Never modify files.',
    source: 'builtin',
  },
];

function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

function parseFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) {
    return { meta: {}, body: raw.trim() };
  }

  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: raw.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key && value) meta[key] = value;
  }

  return { meta, body: raw.slice(end + 4).trim() };
}

function loadAgentFile(path: string, source: SubagentSource): SubagentDefinition | null {
  try {
    const { meta, body } = parseFrontmatter(readFileSync(path, 'utf-8'));
    const name = (meta['name'] ?? '').trim();
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      return null;
    }

    const tools = meta['tools'] ? parseList(meta['tools']) : [...ALL_SUBAGENT_TOOLS];
    const allowed = tools.filter((tool) =>
      (ALL_SUBAGENT_TOOLS as readonly string[]).includes(tool)
    );

    return {
      name,
      description: meta['description'] ?? `Custom subagent from ${path}`,
      tools: allowed.length > 0 ? allowed : [...READ_ONLY_TOOLS],
      systemPrompt: body || 'You are a focused coding subagent.',
      source,
      path,
      maxIterations: meta['max_iterations'] ? Number(meta['max_iterations']) : undefined,
    };
  } catch {
    return null;
  }
}

function loadAgentDir(dir: string, source: SubagentSource): SubagentDefinition[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => loadAgentFile(join(dir, entry), source))
      .filter((agent): agent is SubagentDefinition => agent !== null);
  } catch {
    return [];
  }
}

export function loadSubagents(cwd = process.cwd()): SubagentDefinition[] {
  const byName = new Map<string, SubagentDefinition>();
  for (const agent of BUILTIN_AGENTS) {
    byName.set(agent.name, agent);
  }
  for (const agent of loadAgentDir(join(cwd, '.cortex', 'agents'), 'project')) {
    byName.set(agent.name, agent);
  }
  for (const agent of loadAgentDir(join(getConfigDir(), 'agents'), 'user')) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type SubagentEvent =
  | { type: 'start'; runId?: string; name: string; description: string }
  | { type: 'text'; runId?: string; name: string; chunk: string }
  | { type: 'tool'; runId?: string; name: string; tool: string; detail: string }
  | { type: 'done'; runId?: string; name: string; summary: string }
  | { type: 'error'; runId?: string; name: string; error: string };

export interface RunSubagentOptions {
  definition: SubagentDefinition;
  prompt: string;
  model: LanguageModel;
  modelSupportsToolCalling: boolean;
  abortSignal: AbortSignal;
  /** Base system prompt WITHOUT XML instructions appended. */
  parentSystemPrompt: string;
  runId?: string;
  onEvent?: (event: SubagentEvent) => void;
}

function buildSubagentTools(definition: SubagentDefinition, abortSignal: AbortSignal) {
  const all = {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob_files: globFilesTool,
    grep_search: grepSearchTool,
    git_status: gitStatusTool,
    git_diff: gitDiffTool,
    git_log: gitLogTool,
    bash_exec: createBashExecTool(abortSignal),
  } as const;

  const selected: Record<string, (typeof all)[keyof typeof all]> = {};
  for (const name of definition.tools) {
    const tool = all[name as keyof typeof all];
    if (tool) selected[name] = tool;
  }
  return selected;
}

function toolDetail(toolName: string, args: Record<string, unknown>): string {
  const path = args['path'];
  if (typeof path === 'string') return path;
  const pattern = args['pattern'];
  if (typeof pattern === 'string') return pattern;
  const command = args['command'];
  if (typeof command === 'string') {
    const firstLine = command.split('\n')[0] ?? command;
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  }
  return toolName;
}

export async function runSubagent(options: RunSubagentOptions): Promise<string> {
  const { definition, abortSignal, onEvent, runId } = options;
  const messages: CoreMessage[] = [
    {
      role: 'user',
      content: `${options.prompt}\n\nReturn a concise final report of what you found or changed. Do not ask follow-up questions.`,
    },
  ];

  const tools = buildSubagentTools(definition, abortSignal);
  const toolNames = Object.keys(tools);
  const baseSystemPrompt = `${definition.systemPrompt}

## Subagent Context
You are the "${definition.name}" subagent, delegated by the main Cortex agent.
Available tools for this task: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}.
Work autonomously. When you are finished, reply with a compact summary that the main agent can act on: findings, file paths, and any changes made.

${options.parentSystemPrompt}`;

  const executeTool = async (name: string, rawArgs: Record<string, unknown>): Promise<string> => {
    const args = normalizeToolArguments(name, rawArgs);
    onEvent?.({
      type: 'tool',
      runId,
      name: definition.name,
      tool: name,
      detail: toolDetail(name, args),
    });

    const toolFn = tools[name as keyof typeof tools];
    if (!toolFn) {
      return `Tool "${name}" is not available to this subagent. Allowed: ${toolNames.join(', ')}.`;
    }
    try {
      const value = await (toolFn as any).execute(args, { abortSignal });
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch (err) {
      return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  let useNative = options.modelSupportsToolCalling;
  const maxIterations = definition.maxIterations ?? 16;
  let lastText = '';
  let iterations = 0;

  try {
    while (iterations < maxIterations) {
      iterations++;

      if (useNative) {
        let fullText = '';
        let toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];

        try {
          const result = streamText({
            model: options.model,
            system: baseSystemPrompt,
            messages,
            tools,
            maxSteps: 1,
            abortSignal,
          });

          for await (const chunk of result.textStream) {
            fullText += chunk;
            onEvent?.({ type: 'text', runId, name: definition.name, chunk });
          }

          const finalResult = await result;
          toolCalls = (await finalResult.toolCalls) ?? [];
        } catch (err) {
          if (isToolsUnsupportedError(err)) {
            useNative = false;
            iterations--;
            continue;
          }
          throw err;
        }

        if (toolCalls.length > 0) {
          lastText = fullText;
          const contentParts: Array<
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
          > = [];
          if (fullText.trim()) {
            contentParts.push({ type: 'text', text: fullText });
          }
          for (const call of toolCalls) {
            contentParts.push({
              type: 'tool-call',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              args: normalizeToolArguments(call.toolName, (call.args ?? {}) as Record<string, unknown>),
            });
          }
          messages.push({ role: 'assistant', content: contentParts });

          const results: ToolResultPart[] = [];
          for (const call of toolCalls) {
            const output = await executeTool(
              call.toolName,
              (call.args ?? {}) as Record<string, unknown>
            );
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: output,
            });
          }

          messages.push({ role: 'tool', content: results });
          continue;
        }

        // Hybrid fallback: model emitted XML/JSON tool calls in text despite native tools
        if (hasToolCalls(fullText)) {
          const parsed = parseToolCalls(fullText);
          if (parsed.length > 0) {
            messages.push({ role: 'assistant', content: fullText });
            const outputs: string[] = [];
            for (const call of parsed) {
              const output = await executeTool(call.name, call.arguments);
              outputs.push(`Tool result for "${call.name}":\n${output}`);
            }
            messages.push({ role: 'user', content: outputs.join('\n\n') });
            continue;
          }
        }

        lastText = fullText;
        break;
      }

      // XML/JSON fallback path
      const xmlSystem = `${baseSystemPrompt}\n\n${buildXmlToolInstructions(toolNames)}`;
      const result = streamText({
        model: options.model,
        system: xmlSystem,
        messages,
        abortSignal,
      });

      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
        onEvent?.({ type: 'text', runId, name: definition.name, chunk });
      }

      if (hasToolCalls(fullText)) {
        const parsed = parseToolCalls(fullText);
        if (parsed.length > 0) {
          messages.push({ role: 'assistant', content: fullText });
          const outputs: string[] = [];
          for (const call of parsed) {
            const output = await executeTool(call.name, call.arguments);
            outputs.push(`Tool result for "${call.name}":\n${output}`);
          }
          messages.push({ role: 'user', content: outputs.join('\n\n') });
          continue;
        }
      }

      lastText = fullText;
      break;
    }

    if (iterations >= maxIterations && !lastText.trim()) {
      lastText = `[Subagent "${definition.name}" reached its iteration limit without a final answer.]`;
    }

    const summary = lastText.trim() || '(subagent returned no text)';
    onEvent?.({ type: 'done', runId, name: definition.name, summary });
    return summary;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      onEvent?.({ type: 'error', runId, name: definition.name, error: 'Aborted' });
      return '[Subagent interrupted]';
    }
    const message = err instanceof Error ? err.message : String(err);
    onEvent?.({ type: 'error', runId, name: definition.name, error: message });
    return `[Subagent error: ${message}]`;
  }
}
