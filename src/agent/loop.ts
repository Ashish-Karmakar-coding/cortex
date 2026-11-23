import { streamText, type CoreMessage, type LanguageModel, type ToolResultPart } from 'ai';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPatch } from 'diff';
import type { Config } from '../config/store.js';
import type { ModelInfo } from '../config/models.js';
import { buildSystemPrompt, XML_TOOL_INSTRUCTIONS } from './prompts.js';
import { parseToolCalls, extractTextBeforeToolCalls, hasToolCalls } from './fallbackParser.js';
import { shouldCompact, compactMessages } from './compaction.js';
import { readFileTool, writeFileTool, editFileTool } from '../tools/fs.js';
import { globFilesTool, grepSearchTool } from '../tools/search.js';
import { createBashExecTool } from '../tools/shell.js';
import { getPermission } from '../tools/registry.js';

export interface AgentState {
  messages: CoreMessage[];
  abortController: AbortController;
  isRunning: boolean;
  sessionApprovals: Set<string>;
  model: LanguageModel;
  config: Config;
  modelInfo: ModelInfo;
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
          const modified = original.includes(search_block)
            ? original.replace(search_block, replace_block)
            : original;
          return createPatch(resolved, original, modified, 'original', 'modified');
        }
      }
    } else if (toolName === 'write_file') {
      const { path, content } = args as { path?: string; content?: string };
      if (path && content !== undefined) {
        const resolved = resolve(path);
        const original = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : '';
        return createPatch(
          resolved,
          original,
          content,
          original ? 'original' : '/dev/null',
          'new file'
        );
      }
    }
  } catch {
    // Ignore error in preview diff generation
  }
  return undefined;
}

export type StreamCallback = (chunk: string) => void;

export interface AgentLoopOptions {
  onStream: StreamCallback;
  onApproval: ApprovalCallback;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
}

function buildToolSet(abortSignal: AbortSignal) {
  return {
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob_files: globFilesTool,
    grep_search: grepSearchTool,
    bash_exec: createBashExecTool(abortSignal),
  };
}

const MAX_ITERATIONS = 25;

export async function runAgentLoop(
  state: AgentState,
  userMessage: string,
  options: AgentLoopOptions
): Promise<string> {
  state.isRunning = true;

  // Append user message
  state.messages.push({ role: 'user', content: userMessage });

  let lastAssistantText = '';
  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Check compaction
      if (shouldCompact(state.messages, state.modelInfo.contextWindow)) {
        state.messages = await compactMessages(state.messages, state.model);
      }

      // Build system prompt
      let systemPrompt = await buildSystemPrompt();
      if (!state.modelInfo.supportsToolCalling) {
        systemPrompt += '\n\n' + XML_TOOL_INSTRUCTIONS;
      }

      const tools = buildToolSet(state.abortController.signal);

      if (state.modelInfo.supportsToolCalling) {
        // === Native tool calling path ===
        const result = streamText({
          model: state.model,
          system: systemPrompt,
          messages: state.messages,
          tools,
          maxSteps: 1, // We manage the loop ourselves
          abortSignal: state.abortController.signal,
        });

        let fullText = '';
        let toolCallsMade = false;

        for await (const chunk of result.textStream) {
          fullText += chunk;
          options.onStream(chunk);
        }

        // Wait for the full result
        const finalResult = await result;
        const toolCalls = await finalResult.toolCalls;

        // Check for tool calls in the response
        if (toolCalls && toolCalls.length > 0) {
          toolCallsMade = true;

          // Add assistant message with tool calls
          state.messages.push({
            role: 'assistant',
            content: toolCalls.map((tc) => ({
              type: 'tool-call' as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            })),
          });

          // Process each tool call
          const toolResults: ToolResultPart[] = [];

          for (const tc of toolCalls) {
            const permission = getPermission(tc.toolName);
            options.onToolStart?.(tc.toolName, tc.args as Record<string, unknown>);

            let approved = true;
            if (
              permission === 'confirm' &&
              !state.sessionApprovals.has(tc.toolName)
            ) {
              const previewDiff = computePreviewDiff(tc.toolName, tc.args as Record<string, unknown>);
              const rawDecision = await options.onApproval(
                tc.toolName,
                tc.args as Record<string, unknown>,
                previewDiff
              );
              const decisionType =
                typeof rawDecision === 'string' ? rawDecision : rawDecision.decision;
              const feedback =
                typeof rawDecision === 'object' ? rawDecision.feedback : undefined;

              if (decisionType === 'reject') {
                approved = false;
                toolResults.push({
                  type: 'tool-result',
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  result: feedback
                    ? `Tool call rejected by user: ${feedback}`
                    : 'Tool call rejected by user.',
                });
              } else if (decisionType === 'allow_session') {
                state.sessionApprovals.add(tc.toolName);
              }
            }

            if (approved) {
              // Execute the tool
              const toolFn = tools[tc.toolName as keyof typeof tools];
              if (toolFn) {
                try {
                  // The tool.execute function from AI SDK
                  const toolResult = await (toolFn as any).execute(tc.args, { abortSignal: state.abortController.signal });
                  const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                  options.onToolEnd?.(tc.toolName, resultStr);
                  toolResults.push({
                    type: 'tool-result',
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    result: resultStr,
                  });
                } catch (err) {
                  const errMsg = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
                  options.onToolEnd?.(tc.toolName, errMsg);
                  toolResults.push({
                    type: 'tool-result',
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    result: errMsg,
                  });
                }
              }
            }
          }

          // Add tool results to messages
          state.messages.push({
            role: 'tool',
            content: toolResults,
          });

          // Continue the loop for the model to process tool results
          continue;
        }

        // No tool calls — this is the final answer
        if (fullText) {
          lastAssistantText = fullText;
          state.messages.push({ role: 'assistant', content: fullText });
        }
        break;
      } else {
        // === XML fallback tool calling path ===
        const result = streamText({
          model: state.model,
          system: systemPrompt,
          messages: state.messages,
          abortSignal: state.abortController.signal,
        });

        let fullText = '';
        for await (const chunk of result.textStream) {
          fullText += chunk;
          options.onStream(chunk);
        }

        if (hasToolCalls(fullText)) {
          const textBefore = extractTextBeforeToolCalls(fullText);
          const parsedCalls = parseToolCalls(fullText);

          // Add assistant text to messages
          state.messages.push({ role: 'assistant', content: fullText });

          // Process parsed tool calls
          for (const tc of parsedCalls) {
            options.onToolStart?.(tc.name, tc.arguments);

            const permission = getPermission(tc.name);
            let approved = true;

            if (
              permission === 'confirm' &&
              !state.sessionApprovals.has(tc.name)
            ) {
              const previewDiff = computePreviewDiff(tc.name, tc.arguments);
              const rawDecision = await options.onApproval(
                tc.name,
                tc.arguments,
                previewDiff
              );
              const decisionType =
                typeof rawDecision === 'string' ? rawDecision : rawDecision.decision;
              const feedback =
                typeof rawDecision === 'object' ? rawDecision.feedback : undefined;

              if (decisionType === 'reject') {
                approved = false;
                state.messages.push({
                  role: 'user',
                  content: feedback
                    ? `Tool "${tc.name}" was rejected by user with feedback: ${feedback}`
                    : `Tool "${tc.name}" was rejected by user. Please try a different approach.`,
                });
              } else if (decisionType === 'allow_session') {
                state.sessionApprovals.add(tc.name);
              }
            }

            if (approved) {
              const toolSet = tools;
              const toolFn = toolSet[tc.name as keyof typeof toolSet];
              if (toolFn) {
                try {
                  const toolResult = await (toolFn as any).execute(tc.arguments, { abortSignal: state.abortController.signal });
                  const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                  options.onToolEnd?.(tc.name, resultStr);
                  state.messages.push({
                    role: 'user',
                    content: `Tool result for "${tc.name}":\n${resultStr}`,
                  });
                } catch (err) {
                  const errMsg = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
                  options.onToolEnd?.(tc.name, errMsg);
                  state.messages.push({
                    role: 'user',
                    content: `Tool error for "${tc.name}": ${errMsg}`,
                  });
                }
              } else {
                state.messages.push({
                  role: 'user',
                  content: `Unknown tool: "${tc.name}". Available tools: read_file, write_file, edit_file, glob_files, grep_search, bash_exec.`,
                });
              }
            }
          }

          // Continue loop for model to see tool results
          continue;
        }

        // No tool calls — final answer
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
