import { tool } from 'ai';
import { z } from 'zod';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export function createTodoWriteTool(onUpdate?: (todos: TodoItem[]) => void) {
  return tool({
    description:
      'Create or update a structured task checklist to track multi-step work. Call this when planning 3+ steps and update statuses as you progress.',
    parameters: z.object({
      todos: z
        .array(
          z.object({
            id: z.string().describe('Unique task identifier (e.g. "1", "fix-parser")'),
            content: z.string().describe('Short imperative task description'),
            status: z.enum(['pending', 'in_progress', 'completed']),
            priority: z.enum(['high', 'medium', 'low']).optional(),
          })
        )
        .describe('Full updated list of tasks'),
    }),
    execute: async ({ todos }) => {
      onUpdate?.(todos);
      const completed = todos.filter((t) => t.status === 'completed').length;
      const active = todos.filter((t) => t.status === 'in_progress').length;
      const pending = todos.filter((t) => t.status === 'pending').length;
      return `Updated task list (${todos.length} total: ${completed} completed, ${active} in_progress, ${pending} pending).`;
    },
  });
}
