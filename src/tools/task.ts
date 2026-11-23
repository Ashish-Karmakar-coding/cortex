import { tool } from 'ai';
import { z } from 'zod';
import type { SubagentDefinition, SubagentEvent } from '../agent/subagents.js';

export interface TaskToolOptions {
  agents: SubagentDefinition[];
  /** Run the selected subagent and resolve with its final report. */
  run: (
    definition: SubagentDefinition,
    prompt: string,
    onEvent: (event: SubagentEvent) => void
  ) => Promise<string>;
  onEvent?: (event: SubagentEvent) => void;
}

const MAX_SUMMARY_CHARS = 12_000;

/**
 * The `task` tool. Delegating to a subagent keeps exploration noise out of the
 * parent context and lets the main agent focus on the actual edit.
 */
export function createTaskTool(options: TaskToolOptions) {
  const agentNames = options.agents.map((agent) => agent.name);
  const catalog = options.agents
    .map(
      (agent) =>
        `- ${agent.name}: ${agent.description} (tools: ${agent.tools.join(', ')})`
    )
    .join('\n');

  return tool({
    description: `Delegate a self-contained task to a specialized subagent. The subagent works in an isolated context and returns a final report, keeping your own context small. Use it for broad codebase exploration, independent research, or a focused implementation task.

Available subagents:
${catalog}

Guidelines:
- Write a complete, self-contained prompt; the subagent cannot see this conversation.
- Use "explore" or "plan" for read-only investigation, "general-purpose" for work that needs edits.
- Launch several independent delegations as separate task calls when the work can be split.
- Include the result you need back (files, line numbers, decisions, diffs).`,
    parameters: z.object({
      description: z
        .string()
        .describe('Short 3-5 word description of the delegated task, shown in the UI'),
      prompt: z
        .string()
        .describe(
          'Complete instructions for the subagent, including context, constraints, and the exact deliverable'
        ),
      agent_type: z
        .string()
        .optional()
        .describe(
          `Subagent to use. One of: ${agentNames.join(', ')}. Defaults to general-purpose.`
        ),
    }),
    execute: async ({ description, prompt, agent_type }) => {
      const wanted = (agent_type ?? 'general-purpose').toLowerCase();
      const definition =
        options.agents.find((agent) => agent.name.toLowerCase() === wanted) ??
        options.agents.find((agent) => agent.name === 'general-purpose') ??
        options.agents[0];

      if (!definition) {
        return 'Error: no subagents are configured.';
      }

      const emit = (event: SubagentEvent) => {
        options.onEvent?.(event);
      };

      emit({ type: 'start', name: definition.name, description });
      const report = await options.run(definition, prompt, emit);
      const summary =
        report.length > MAX_SUMMARY_CHARS
          ? `${report.slice(0, MAX_SUMMARY_CHARS)}\n... (truncated)`
          : report;

      return `Subagent "${definition.name}" (${description}) finished.\n\n${summary}`;
    },
  });
}
