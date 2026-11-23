import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamText, type CoreMessage, type LanguageModel, type ToolResultPart } from 'ai';
import { getConfigDir } from '../config/store.js';
import { readFileTool, writeFileTool, editFileTool } from '../tools/fs.js';
import { globFilesTool, grepSearchTool } from '../tools/search.js';
import { createBashExecTool } from '../tools/shell.js';
import { parseToolCalls, hasToolCalls } from './fallbackParser.js';

/**
 * Subagents are isolated agent loops that the main agent delegates to through
 * the `task` tool. Each one has its own message history, tool allowlist, and
 * instructions, so investigation work never bloats the parent conversation.
 */

export type SubagentSource = 'builtin' | 'project' | 'user';

export interface SubagentDefinition {
  /** Unique identifier used by the `agent_type` tool argument. */
  name: string;
  description: string;
  /** Tool names this agent may call. `task` is never allowed (no recursion). */
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
  'bash_exec',
] as const;

const READ_ONLY_TOOLS = ['read_file', 'glob_files', 'grep_search'];

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

/** Minimal YAML frontmatter parser for `key: value` agent files. */
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

/**
 * Resolve subagents from built-ins, then the project (`.cortex/agents`), then
 * the user config directory. Later definitions override earlier ones by name.
 */
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
  | { type: 'start'; name: string; description: string }
  | { type: 'text'; name: string; chunk: string }
  | { type: 'tool'; name: string; tool: string; detail: string }
  | { type: 'done'; name: string; summary: string }
  | { type: 'error'; name: string; error: string };

export interface RunSubagentOptions {
  definition: SubagentDefinition;
  /** Self-contained instructions written by the main agent. */
  prompt: string;
  model: LanguageModel;
  modelSupportsToolCalling: boolean;
  abortSignal: AbortSignal;
  /** Parent system prompt, reused so the subagent sees the same project context. */
  parentSystemPrompt: string;
  onEvent?: (event: SubagentEvent) => void;
}

function buildSubagentTools(definition: SubagentDefinition, abortSignal: AbortSignal) {
  const all = {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob_files: globFilesTool,
    grep_search: grepSearchTool,
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

/**
 * Run one subagent to completion and return its final report. Tool calls are
 * executed without prompting: the user already approved the delegation when
 * they approved the `task` tool call, and the allowlist bounds what it can do.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<string> {
  const { definition, abortSignal, onEvent } = options;
  const messages: CoreMessage[] = [
    {
      role: 'user',
      content: `${options.prompt}\n\nReturn a concise final report of what you found or changed. Do not ask follow-up questions.`,
    },
  ];

  const tools = buildSubagentTools(definition, abortSignal);
  const toolNames = Object.keys(tools);
  const systemPrompt = `${definition.systemPrompt}

## Subagent Context
You are the "${definition.name}" subagent, delegated by the main Cortex agent.
Available tools for this task: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}.
Work autonomously. When you are finished, reply with a compact summary that the main agent can act on: findings, file paths, and any changes made.

${options.parentSystemPrompt}`;

  const maxIterations = definition.maxIterations ?? 16;
  let lastText = '';
  let iterations = 0;

  try {
    while (iterations < maxIterations) {
      iterations++;

      if (options.modelSupportsToolCalling) {
        const result = streamText({
          model: options.model,
          system: systemPrompt,
          messages,
          tools,
          maxSteps: 1,
          abortSignal,
        });

        let fullText = '';
        for await (const chunk of result.textStream) {
          fullText += chunk;
          onEvent?.({ type: 'text', name: definition.name, chunk });
        }

        const finalResult = await result;
        const toolCalls = await finalResult.toolCalls;

        if (toolCalls && toolCalls.length > 0) {
          lastText = fullText;
          messages.push({
            role: 'assistant',
            content: toolCalls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              args: call.args,
            })),
          });

          const results: ToolResultPart[] = [];
          for (const call of toolCalls) {
            const args = call.args as Record<string, unknown>;
            onEvent?.({
              type: 'tool',
              name: definition.name,
              tool: call.toolName,
              detail: toolDetail(call.toolName, args),
            });

            const toolFn = tools[call.toolName as keyof typeof tools];
            let output: string;
            if (!toolFn) {
              output = `Tool "${call.toolName}" is not available to this subagent.`;
            } else {
              try {
                const value = await (toolFn as any).execute(args, { abortSignal });
                output = typeof value === 'string' ? value : JSON.stringify(value);
              } catch (err) {
                output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
              }
            }

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

        lastText = fullText;
        break;
      }

      // XML fallback for models without native tool calling.
      const result = streamText({
        model: options.model,
        system: `${systemPrompt}\n\n${XML_TOOL_INSTRUCTIONS_FOR_SUBAGENTS(toolNames)}`,
        messages,
        abortSignal,
      });

      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
        onEvent?.({ type: 'text', name: definition.name, chunk });
      }

      if (hasToolCalls(fullText)) {
        messages.push({ role: 'assistant', content: fullText });
        for (const call of parseToolCalls(fullText)) {
          onEvent?.({
            type: 'tool',
            name: definition.name,
            tool: call.name,
            detail: toolDetail(call.name, call.arguments),
          });

          const toolFn = tools[call.name as keyof typeof tools];
          let output: string;
          if (!toolFn) {
            output = `Tool "${call.name}" is not available to this subagent.`;
          } else {
            try {
              const value = await (toolFn as any).execute(call.arguments, { abortSignal });
              output = typeof value === 'string' ? value : JSON.stringify(value);
            } catch (err) {
              output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          messages.push({ role: 'user', content: `Tool result for "${call.name}":\n${output}` });
        }
        continue;
      }

      lastText = fullText;
      break;
    }

    if (iterations >= maxIterations && !lastText.trim()) {
      lastText = `[Subagent "${definition.name}" reached its iteration limit without a final answer.]`;
    }

    const summary = lastText.trim() || '(subagent returned no text)';
    onEvent?.({ type: 'done', name: definition.name, summary });
    return summary;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      onEvent?.({ type: 'error', name: definition.name, error: 'Aborted' });
      return '[Subagent interrupted]';
    }
    const message = err instanceof Error ? err.message : String(err);
    onEvent?.({ type: 'error', name: definition.name, error: message });
    return `[Subagent error: ${message}]`;
  }
}

function XML_TOOL_INSTRUCTIONS_FOR_SUBAGENTS(toolNames: string[]): string {
  return `## Tool Calling Format
You do not have native tool calling. To call a tool, emit a JSON object wrapped
in <tool_call> tags, exactly like this:

<tool_call>{"name": "read_file", "arguments": {"path": "src/main.ts"}}</tool_call>

Available tools: ${toolNames.join(', ')}.
You may write an explanation before a tool call. Wait for the tool result before
deciding what to do next.`;
}
