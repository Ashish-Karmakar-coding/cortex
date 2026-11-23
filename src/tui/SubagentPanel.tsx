import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { palette } from './theme.js';

export interface SubagentRun {
  id: string;
  name: string;
  description: string;
  activity?: string;
  status: 'running' | 'done' | 'error';
}

export interface SubagentPanelProps {
  runs: SubagentRun[];
}

/** Compact live status for delegated subagents. */
export const SubagentPanel: React.FC<SubagentPanelProps> = ({ runs }) => {
  if (runs.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {runs.map((run) => {
        const icon =
          run.status === 'running' ? (
            <Spinner type="dots" />
          ) : run.status === 'done' ? (
            <Text color={palette.success}>✓</Text>
          ) : (
            <Text color={palette.danger}>✗</Text>
          );

        return (
          <Box key={run.id}>
            {icon}
            <Text bold color={palette.fg}>
              {' '}
              {run.name}
            </Text>
            <Text color={palette.muted}> · {run.description}</Text>
            {run.activity ? (
              <Text dimColor> — {run.activity}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
};

export default SubagentPanel;
