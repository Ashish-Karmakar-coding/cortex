import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { TodoItem } from '../tools/todo.js';
import { palette } from './theme.js';

export interface TodoPanelProps {
  todos: TodoItem[];
}

export const TodoPanel: React.FC<TodoPanelProps> = ({ todos }) => {
  if (todos.length === 0) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.border}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={palette.fg} backgroundColor={palette.bg}>
        Tasks ({doneCount}/{todos.length})
      </Text>
      {todos.map((item) => {
        if (item.status === 'completed') {
          return (
            <Box key={item.id}>
              <Text color={palette.success} backgroundColor={palette.bg}>
                ✓{' '}
              </Text>
              <Text color={palette.muted} backgroundColor={palette.bg} strikethrough>
                {item.content}
              </Text>
            </Box>
          );
        }
        if (item.status === 'in_progress') {
          return (
            <Box key={item.id}>
              <Text color={palette.warning} backgroundColor={palette.bg}>
                <Spinner type="dots" />{' '}
              </Text>
              <Text bold color={palette.fg} backgroundColor={palette.bg}>
                {item.content}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={item.id}>
            <Text color={palette.muted} backgroundColor={palette.bg}>
              ○ {item.content}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

export default TodoPanel;
