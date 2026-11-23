import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';

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

  // Handle single-key quick shortcuts: 'y', 'a', 'n' when not typing feedback
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      <Box marginBottom={1}>
        <Text bold color="yellow">
          ⚠️ Action Approval Required:{' '}
        </Text>
        <Text bold color="cyan">
          {toolName}
        </Text>
      </Box>

      {/* Bash Exec details */}
      {toolName === 'bash_exec' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Command to execute:</Text>
          <Box borderStyle="single" borderColor="gray" paddingX={1}>
            <Text color="cyan">{String(args['command'] ?? '')}</Text>
          </Box>
        </Box>
      )}

      {/* File Write/Edit path */}
      {(toolName === 'write_file' || toolName === 'edit_file') && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Target file: <Text color="cyan">{String(args['path'] ?? '')}</Text></Text>
        </Box>
      )}

      {/* Diff display */}
      {diff && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold dimColor>Unified Diff:</Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            {diff
              .split('\n')
              .slice(0, 35)
              .map((line, idx) => {
                if (line.startsWith('+') && !line.startsWith('+++')) {
                  return (
                    <Text key={idx} color="green">
                      {line}
                    </Text>
                  );
                }
                if (line.startsWith('-') && !line.startsWith('---')) {
                  return (
                    <Text key={idx} color="red">
                      {line}
                    </Text>
                  );
                }
                if (line.startsWith('@@')) {
                  return (
                    <Text key={idx} color="magenta">
                      {line}
                    </Text>
                  );
                }
                return (
                  <Text key={idx} dimColor>
                    {line}
                  </Text>
                );
              })}
            {diff.split('\n').length > 35 && (
              <Text dimColor>
                ... [{diff.split('\n').length - 35} more lines omitted]
              </Text>
            )}
          </Box>
        </Box>
      )}

      {/* Other tool arguments */}
      {toolName !== 'bash_exec' && !diff && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Arguments:</Text>
          <Text color="gray">{JSON.stringify(args, null, 2)}</Text>
        </Box>
      )}

      {/* Interactive Selection or Feedback Input */}
      {rejectMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">
            Provide rejection feedback to agent (or press Enter for default, Esc to cancel):
          </Text>
          <Box marginTop={1}>
            <Text color="red">&gt; </Text>
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
          <Text dimColor>Select an option (or press y / a / n):</Text>
          <SelectInput items={selectItems} onSelect={handleSelect} />
        </Box>
      )}
    </Box>
  );
};

export default ApprovalPrompt;
