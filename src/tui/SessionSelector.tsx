import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { palette, ThemedIndicator, ThemedItem } from './theme.js';

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  model: string;
}

export interface SessionSelectorProps {
  sessions: SessionSummary[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export const SessionSelector: React.FC<SessionSelectorProps> = ({
  sessions,
  onSelect,
  onClose,
}) => {
  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  const items = sessions.map((session) => ({
    label: `${session.title}  ·  ${session.model}  ·  ${session.updatedAt.slice(0, 16).replace('T', ' ')}`,
    value: session.id,
  }));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.fg}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Box marginBottom={1}>
        <Text bold color={palette.fg} backgroundColor={palette.bg}>
          ⏪ Resume a Session
        </Text>
        <Text color={palette.muted} backgroundColor={palette.bg}>
          {' '}
          (Press Esc to cancel)
        </Text>
      </Box>

      {items.length === 0 ? (
        <Text color={palette.muted} backgroundColor={palette.bg}>
          No saved sessions yet.
        </Text>
      ) : (
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
          indicatorComponent={ThemedIndicator}
          itemComponent={ThemedItem}
          limit={8}
        />
      )}
    </Box>
  );
};

export default SessionSelector;
