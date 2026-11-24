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
            <Text color={palette.warning} backgroundColor={palette.bg}>
              <Spinner type="dots" />
            </Text>
          ) : run.status === 'done' ? (
            <Text color={palette.success} backgroundColor={palette.bg}>
              ✓
            </Text>
          ) : (
            <Text color={palette.danger} backgroundColor={palette.bg}>
              ✗
            </Text>
          );

        return (
          <Box key={run.id}>
            {icon}
            <Text bold color={palette.fg} backgroundColor={palette.bg}>
              {' '}
              {run.name}
            </Text>
            <Text color={palette.muted} backgroundColor={palette.bg}>
              {' '}
              · {run.description}
            </Text>
            {run.activity ? (
              <Text color={palette.muted} backgroundColor={palette.bg}>
                {' '}
                — {run.activity}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
};

export default SubagentPanel;
