import React from 'react';
import { Box, Text } from 'ink';
import type { IndicatorProps, ItemProps } from 'ink-select-input';
import { palette } from './palette.js';

export { palette, applyTerminalTheme } from './palette.js';

/** Selection pointer for ink-select-input lists. */
export const ThemedIndicator: React.FC<IndicatorProps> = ({ isSelected }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? palette.fg : palette.muted} backgroundColor={palette.bg}>
      {isSelected ? '❯' : ' '}
    </Text>
  </Box>
);

/** Selected item gets an inverted chip using only the two solid theme colors. */
export const ThemedItem: React.FC<ItemProps> = ({ isSelected, label }) => (
  <Text
    bold={isSelected}
    color={isSelected ? palette.bg : palette.fg}
    backgroundColor={isSelected ? palette.fg : palette.bg}
  >
    {label}
  </Text>
);
