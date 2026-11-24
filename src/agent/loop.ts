import { streamText, type CoreMessage, type LanguageModel, type ToolResultPart } from 'ai';
import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createPatch } from 'diff';
import type { Config } from '../config/store.js';
import { resolveModelInfo, type ModelInfo, type Provider } from '../config/models.js';
import type { LocalStore } from '../storage/localStore.js';
import type { MCPManager } from '../mcp/client.js';
import { isToolsUnsupportedError } from '../providers/ollama.js';
import { buildSystemPrompt, buildXmlToolInstructions, type ToolDocSpec } from './prompts.js';
import { parseToolCalls, hasToolCalls, normalizeToolArguments } from './fallbackParser.js';
import { shouldCompact, compactMessages } from './compaction.js';
import { loadSubagents, runSubagent, type SubagentEvent } from './subagents.js';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  captureFileSnapshot,
} from '../tools/fs.js';
import { globFilesTool, grepSearchTool } from '../tools/search.js';
import { createBashExecTool } from '../tools/shell.js';
import { gitStatusTool, gitDiffTool, gitLogTool } from '../tools/git.js';
import { createTodoWriteTool, type TodoItem } from '../tools/todo.js';
import { webFetchTool } from '../tools/web.js';
import { createTaskTool } from '../tools/task.js';
import { evaluateToolPolicy, type AgentPermissionMode } from '../tools/registry.js';

export interface AgentState {
  messages: CoreMessage[];
  abortController: AbortController;
  isRunning: boolean;
  sessionApprovals: Set<string>;
  permissionMode: AgentPermissionMode;
  model: LanguageModel;
  config: Config;
  modelInfo: ModelInfo;
  sessionId?: string;
  turnCount?: number;
  localStore?: LocalStore;
  mcpManager?: MCPManager;
  todos?: TodoItem[];
}

export type ApprovalDecision =
  | 'allow'
  | 'allow_session'
  | 'reject'
  | { decision: 'allow' | 'allow_session' | 'reject'; feedback?: string };

export type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>,
  diff?: string
) => Promise<ApprovalDecision>;

function computePreviewDiff(toolName: string, args: Record<string, unknown>): string | undefined {
  try {
    if (toolName === 'edit_file') {
      const { path, search_block, replace_block } = args as {
        path?: string;
        search_block?: string;
        replace_block?: string;
      };
      if (path && search_block && replace_block !== undefined) {
        const resolved = resolve(path);
        if (existsSync(resolved)) {
          const original = readFileSync(resolved, 'utf-8');
          if (original.length > 400_000) return undefined;
          const lfOrig = original.replace(/\r\n/g, '\n');
          const lfSearch = search_block.replace(/\r\n/g, '\n');
          const lfReplace = replace_block.replace(/\r\n/g, '\n');
          const modified = original.includes(search_block)
            ? original.replace(search_block, replace_block)
            : lfOrig.includes(lfSearch)
              ? lfOrig.replace(lfSearch, lfReplace)
              : original;
          const displayPath = relative(process.cwd(), resolved) || resolved;
          return createPatch(displayPath, original, modified, 'original', 'modified');
        }
      }
    } else if (toolName === 'write_file') {
      const { path, content } = args as { path?: string; content?: string };
      if (path && content !== undefined) {
        const resolved = resolve(path);
        const original = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : '';
        if (original.length > 400_000 || content.length > 400_000) return undefined;
        const displayPath = relative(process.cwd(), resolved) || resolved;
        return createPatch(
          displayPath,
          original,
          content,
          original ? 'original' : '/dev/null',
          'new file'
        );
      }
    }
  } catch {
    // Ignore preview diff errors
  }
  return undefined;
}

export type StreamCallback = (chunk: string) => void;

export interface AgentLoopOptions {
  onStream: StreamCallback;
  onApproval: ApprovalCallback;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  onSubagentEvent?: (event: SubagentEvent) => void;
  onTodosChange?: (todos: TodoItem[]) => void;
  onContextCompacted?: (remainingMessages: number) => void;
}

function buildToolSet(
  abortSignal: AbortSignal,
  taskTool: ReturnType<typeof createTaskTool>,
  todoTool: ReturnType<typeof createTodoWriteTool>,
  mcpTools: Record<string, unknown>
) {
  return {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob_files: globFilesTool,
    grep_search: grepSearchTool,
    git_status: gitStatusTool,
    git_diff: gitDiffTool,
    git_log: gitLogTool,
    todo_write: todoTool,
    web_fetch: webFetchTool,
    bash_exec: createBashExecTool(abortSignal),
    task: taskTool,
    ...mcpTools,
  };
}

const MAX_ITERATIONS = 25;

export async function runAgentLoop(
  state: AgentState,
  userMessage: string,
  options: AgentLoopOptions
): Promise<string> {
  state.isRunning = true;
  state.turnCount = (state.turnCount ?? 0) + 1;
  const currentTurn = state.turnCount;

  state.messages.push({ role: 'user', content: userMessage });

  let lastAssistantText = '';
  let iterations = 0;

  try {
    // Inspect local Ollama model capabilities dynamically (cached in LocalStore)
    state.modelInfo = await resolveModelInfo(
      state.config.activeModel,
      state.config.activeProvider as Provider,
      state.config,
      state.localStore
    );

    const mcpTools = state.mcpManager ? state.mcpManager.buildToolSet() : {};
    const mcpDefs = state.mcpManager ? state.mcpManager.getTools() : [];
    const mcpExtraDocs: ToolDocSpec[] = mcpDefs.map((def) => ({
      name: def.name,
      description: def.description,
      params: JSON.stringify(def.parameters),
    }));

    const memoryEntries = state.localStore?.listMemory(process.cwd()) ?? [];
    const baseSystemPrompt = await buildSystemPrompt({
      permissionMode: state.permissionMode,
      memoryEntries,
      mcpToolNames: mcpDefs.map((d) => d.name),
    });

    const subagents = loadSubagents();
    const taskTool = createTaskTool({
      agents: subagents,
      onEvent: (event) => options.onSubagentEvent?.(event),
      run: (definition, prompt, onEvent, runId) =>
        runSubagent({
          definition,
          prompt,
          model: state.model,
          modelSupportsToolCalling: state.modelInfo.supportsToolCalling,
          abortSignal: state.abortController.signal,
          parentSystemPrompt: baseSystemPrompt,
          runId,
          onEvent,
        }),
    });

    const todoTool = createTodoWriteTool((todos) => {
      state.todos = todos;
      options.onTodosChange?.(todos);
    });

    const tools = buildToolSet(state.abortController.signal, taskTool, todoTool, mcpTools);
    const toolNames = Object.keys(tools);
    const getSystemPrompt = () =>
      state.modelInfo.supportsToolCalling
        ? baseSystemPrompt
        : `${baseSystemPrompt}\n\n${buildXmlToolInstructions(toolNames, mcpExtraDocs)}`;

    const executeSingleToolCall = async (
      rawName: string,
      rawArgs: Record<string, unknown>
    ): Promise<string> => {
      const toolName = rawName.trim();
      const args = normalizeToolArguments(toolName, rawArgs ?? {});
      const startedAt = Date.now();
      const argsSummary = JSON.stringify(args).slice(0, 300);

      options.onToolStart?.(toolName, args);

      const toolFn = tools[toolName as keyof typeof tools];
      if (!toolFn) {
        const msg = `Unknown tool: "${toolName}". Available tools: ${toolNames.join(', ')}.`;
        options.onToolEnd?.(toolName, msg);
        state.localStore?.logToolCall({
          sessionId: state.sessionId ?? 'unknown',
          toolName,
          argsSummary,
          status: 'error',
          durationMs: Date.now() - startedAt,
        });
        return msg;
      }

      const policy = evaluateToolPolicy(
        toolName,
        args,
        state.permissionMode,
        state.config.permissions
      );

      if (policy.permission === 'blocked') {
        const msg = `Tool "${toolName}" blocked: ${policy.reason ?? 'Policy restriction.'}`;
        options.onToolEnd?.(toolName, msg);
        state.localStore?.logToolCall({
          sessionId: state.sessionId ?? 'unknown',
          toolName,
          argsSummary,
          status: 'blocked',
          durationMs: Date.now() - startedAt,
        });
        return msg;
      }

      let approvalStatus = 'auto';
      if (policy.permission === 'confirm' && !state.sessionApprovals.has(toolName)) {
        const previewDiff = computePreviewDiff(toolName, args);
        const rawDecision = await options.onApproval(toolName, args, previewDiff);
        const decisionType =
          typeof rawDecision === 'string' ? rawDecision : rawDecision.decision;
        const feedback =
          typeof rawDecision === 'object' ? rawDecision.feedback : undefined;

        if (decisionType === 'reject') {
          const msg = feedback
            ? `Tool call rejected by user: ${feedback}`
            : 'Tool call rejected by user.';
          options.onToolEnd?.(toolName, msg);
          state.localStore?.logToolCall({
            sessionId: state.sessionId ?? 'unknown',
            toolName,
            argsSummary,
            status: 'rejected',
            durationMs: Date.now() - startedAt,
          });
          return msg;
        }

        if (decisionType === 'allow_session') {
          state.sessionApprovals.add(toolName);
        }
        approvalStatus = decisionType;
      }

      // Save file checkpoint before mutating a file so /rewind can undo it
      if ((toolName === 'write_file' || toolName === 'edit_file') && typeof args['path'] === 'string') {
        try {
          const snap = captureFileSnapshot(args['path']);
          state.localStore?.saveCheckpoint({
            sessionId: state.sessionId ?? 'default',
            turnIndex: currentTurn,
            cwd: process.cwd(),
            filePath: snap.path,
            existedBefore: snap.existedBefore,
            previousContent: snap.previousContent,
          });
        } catch {
          // Non-fatal if checkpoint fails
        }
      }

      try {
        const toolResult = await (toolFn as any).execute(args, {
          abortSignal: state.abortController.signal,
        });
        const resultStr =
          typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
        options.onToolEnd?.(toolName, resultStr);
        state.localStore?.logToolCall({
          sessionId: state.sessionId ?? 'unknown',
          toolName,
          argsSummary,
          status: approvalStatus,
          durationMs: Date.now() - startedAt,
        });
        return resultStr;
      } catch (err) {
        const errMsg = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        options.onToolEnd?.(toolName, errMsg);
        state.localStore?.logToolCall({
          sessionId: state.sessionId ?? 'unknown',
          toolName,
          argsSummary,
          status: 'error',
          durationMs: Date.now() - startedAt,
        });
        return errMsg;
      }
    };

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (shouldCompact(state.messages, state.modelInfo.contextWindow)) {
        state.messages = await compactMessages(state.messages, state.model);
        options.onContextCompacted?.(state.messages.length);
      }

      if (state.modelInfo.supportsToolCalling) {
        let fullText = '';
        let toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];

        try {
          const result = streamText({
            model: state.model,
            system: getSystemPrompt(),
            messages: state.messages,
            tools,
            maxSteps: 1,
            abortSignal: state.abortController.signal,
          });

          for await (const chunk of result.textStream) {
            fullText += chunk;
            options.onStream(chunk);
          }

          const finalResult = await result;
          toolCalls = (await finalResult.toolCalls) ?? [];
        } catch (err) {
          if (isToolsUnsupportedError(err)) {
            state.modelInfo = { ...state.modelInfo, supportsToolCalling: false };
            state.localStore?.setCachedModelCapabilities({
              provider: state.config.activeProvider,
              modelId: state.config.activeModel,
              supportsTools: false,
              contextWindow: state.modelInfo.contextWindow,
            });
            iterations--;
            continue;
          }
          throw err;
        }

        if (toolCalls.length > 0) {
          const assistantContent: Array<
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
          > = [];
          if (fullText.trim()) {
            assistantContent.push({ type: 'text', text: fullText });
          }
          for (const tc of toolCalls) {
            assistantContent.push({
              type: 'tool-call',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: normalizeToolArguments(tc.toolName, (tc.args ?? {}) as Record<string, unknown>),
            });
          }
          state.messages.push({ role: 'assistant', content: assistantContent });

          const toolResults: ToolResultPart[] = [];
          for (const tc of toolCalls) {
            const resultStr = await executeSingleToolCall(
              tc.toolName,
              (tc.args ?? {}) as Record<string, unknown>
            );
            toolResults.push({
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              result: resultStr,
            });
          }

          state.messages.push({ role: 'tool', content: toolResults });
          continue;
        }

        // Hybrid fallback: model emitted XML/JSON tool calls in text despite native tools
        if (hasToolCalls(fullText)) {
          const parsedCalls = parseToolCalls(fullText);
          if (parsedCalls.length > 0) {
            state.messages.push({ role: 'assistant', content: fullText });
            const outputs: string[] = [];
            for (const tc of parsedCalls) {
              const resultStr = await executeSingleToolCall(tc.name, tc.arguments);
              outputs.push(`Tool result for "${tc.name}":\n${resultStr}`);
            }
            state.messages.push({ role: 'user', content: outputs.join('\n\n') });
            continue;
          }
        }

        if (fullText) {
          lastAssistantText = fullText;
          state.messages.push({ role: 'assistant', content: fullText });
        }
        break;
      } else {
        // === XML / JSON fallback tool calling path ===
        const result = streamText({
          model: state.model,
          system: getSystemPrompt(),
          messages: state.messages,
          abortSignal: state.abortController.signal,
        });

        let fullText = '';
        for await (const chunk of result.textStream) {
          fullText += chunk;
          options.onStream(chunk);
        }

        if (hasToolCalls(fullText)) {
          const parsedCalls = parseToolCalls(fullText);
          if (parsedCalls.length > 0) {
            state.messages.push({ role: 'assistant', content: fullText });
            const outputs: string[] = [];
            for (const tc of parsedCalls) {
              const resultStr = await executeSingleToolCall(tc.name, tc.arguments);
              outputs.push(`Tool result for "${tc.name}":\n${resultStr}`);
            }
            state.messages.push({ role: 'user', content: outputs.join('\n\n') });
            continue;
          }
        }

        lastAssistantText = fullText;
        state.messages.push({ role: 'assistant', content: fullText });
        break;
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      const msg = '\n\n[Reached maximum iteration limit. Please provide further instructions.]';
      options.onStream(msg);
      lastAssistantText += msg;
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      lastAssistantText = '[Interrupted by user]';
      options.onStream('\n[Interrupted]');
    } else {
      const errMsg = `\n[Error: ${err instanceof Error ? err.message : String(err)}]`;
      options.onStream(errMsg);
      lastAssistantText = errMsg;
    }
  } finally {
    state.isRunning = false;
  }

  return lastAssistantText;
}
