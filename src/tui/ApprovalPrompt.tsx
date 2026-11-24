import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { palette, ThemedIndicator, ThemedItem } from './theme.js';

export interface ApprovalPromptProps {
  toolName: string;
  args: Record<string, unknown>;
  diff?: string;
  onDecision: (decision: 'allow' | 'allow_session' | 'reject', feedback?: string) => void;
}

interface SelectItem {
  label: string;
  value: 'allow' | 'allow_session' | 'reject_prompt';
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({
  toolName,
  args,
  diff,
  onDecision,
}) => {
  const [rejectMode, setRejectMode] = useState(false);
  const [feedback, setFeedback] = useState('');

  useInput((input, key) => {
    if (rejectMode) {
      if (key.escape) {
        setRejectMode(false);
      }
      return;
    }

    const lower = input.toLowerCase();
    if (lower === 'y') {
      onDecision('allow');
    } else if (lower === 'a') {
      onDecision('allow_session');
    } else if (lower === 'n') {
      setRejectMode(true);
    }
  });

  const selectItems: SelectItem[] = [
    { label: '[y] Allow once', value: 'allow' },
    { label: '[a] Allow for this session', value: 'allow_session' },
    { label: '[n] Reject with feedback', value: 'reject_prompt' },
  ];

  const handleSelect = (item: SelectItem) => {
    if (item.value === 'reject_prompt') {
      setRejectMode(true);
    } else {
      onDecision(item.value);
    }
  };

  const handleFeedbackSubmit = (value: string) => {
    onDecision('reject', value.trim() || undefined);
  };

  const MAX_DIFF_LINES = 22;
  const diffLines = diff ? diff.split('\n') : [];
  const visibleDiff = diffLines[0]?.startsWith('Index:')
    ? diffLines.slice(2)
    : diffLines;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.fg}
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      <Box marginBottom={1}>
        <Text bold color={palette.warning} backgroundColor={palette.bg}>
          ⚠️ Action Approval Required:{' '}
        </Text>
        <Text bold color={palette.fg} backgroundColor={palette.bg}>
          {toolName}
        </Text>
      </Box>

      {toolName === 'bash_exec' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            Command to execute:
          </Text>
          <Box borderStyle="single" borderColor={palette.border} paddingX={1}>
            <Text color={palette.fg} backgroundColor={palette.bg}>
              {String(args['command'] ?? '')}
            </Text>
          </Box>
        </Box>
      )}

      {toolName === 'task' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            Subagent:{' '}
            <Text color={palette.fg} backgroundColor={palette.bg}>
              {String(args['agent_type'] ?? 'general-purpose')}
            </Text>
          </Text>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            Task:{' '}
            <Text color={palette.fg} backgroundColor={palette.bg}>
              {String(args['description'] ?? '')}
            </Text>
          </Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={palette.border}
            paddingX={1}
            marginTop={1}
          >
            <Text color={palette.muted} backgroundColor={palette.bg}>
              {String(args['prompt'] ?? '')}
            </Text>
          </Box>
        </Box>
      )}

      {(toolName === 'write_file' || toolName === 'edit_file') && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            Target file:{' '}
            <Text color={palette.fg} backgroundColor={palette.bg}>
              {String(args['path'] ?? '')}
            </Text>
          </Text>
        </Box>
      )}

      {diff && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={palette.muted} backgroundColor={palette.bg}>
            Unified Diff:
          </Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={palette.border}
            paddingX={1}
          >
            {visibleDiff.slice(0, MAX_DIFF_LINES).map((line, idx) => {
              if (line.startsWith('+') && !line.startsWith('+++')) {
                return (
                  <Text key={idx} color={palette.success} backgroundColor={palette.bg}>
                    {line}
                  </Text>
                );
              }
              if (line.startsWith('-') && !line.startsWith('---')) {
                return (
                  <Text key={idx} color={palette.danger} backgroundColor={palette.bg}>
                    {line}
                  </Text>
                );
              }
              if (line.startsWith('@@')) {
                return (
                  <Text key={idx} color={palette.warning} backgroundColor={palette.bg}>
                    {line}
                  </Text>
                );
              }
              return (
                <Text key={idx} color={palette.muted} backgroundColor={palette.bg}>
                  {line}
                </Text>
              );
            })}
            {visibleDiff.length > MAX_DIFF_LINES && (
              <Text color={palette.muted} backgroundColor={palette.bg}>
                ... [{visibleDiff.length - MAX_DIFF_LINES} more lines omitted]
              </Text>
            )}
          </Box>
        </Box>
      )}

      {toolName !== 'bash_exec' && toolName !== 'task' && !diff && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            Arguments:
          </Text>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            {JSON.stringify(args, null, 2)}
          </Text>
        </Box>
      )}

      {rejectMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.danger} backgroundColor={palette.bg}>
            Provide rejection feedback to agent (or press Enter for default, Esc to cancel):
          </Text>
          <Box marginTop={1}>
            <Text color={palette.danger} backgroundColor={palette.bg}>
              &gt;{' '}
            </Text>
            <TextInput
              value={feedback}
              onChange={setFeedback}
              onSubmit={handleFeedbackSubmit}
              placeholder="e.g., Don't run tests yet, fix the config first"
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.muted} backgroundColor={palette.bg}>
            Select an option (or press y / a / n):
          </Text>
          <SelectInput
            items={selectItems}
            onSelect={handleSelect}
            indicatorComponent={ThemedIndicator}
            itemComponent={ThemedItem}
          />
        </Box>
      )}
    </Box>
  );
};

export default ApprovalPrompt;
