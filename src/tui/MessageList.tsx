import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { highlight } from 'cli-highlight';
import { palette } from './theme.js';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  isStreaming?: boolean;
  status?: 'pending' | 'running' | 'done' | 'error';
}

export interface MessageListProps {
  messages: DisplayMessage[];
  activeTool?: { name: string; args?: Record<string, unknown> };
}

function renderContentWithHighlighting(content: string): React.ReactNode {
  // Simple markdown code block parser
  const parts: React.ReactNode[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  let blockIdx = 0;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index);
    if (textBefore) {
      parts.push(
        <Text key={`text-${blockIdx}`} color={palette.fg}>
          {textBefore}
        </Text>
      );
    }

    const lang = match[1] || 'typescript';
    const code = match[2] || '';

    let highlighted = code;
    try {
      highlighted = highlight(code, { language: lang, ignoreIllegals: true });
    } catch {
      highlighted = code;
    }

    parts.push(
      <Box
        key={`code-${blockIdx}`}
        borderStyle="round"
        borderColor={palette.border}
        paddingX={1}
        marginY={1}
        flexDirection="column"
      >
        {lang && (
          <Text dimColor bold color={palette.fg}>
            [{lang}]
          </Text>
        )}
        <Text color={palette.fg}>{highlighted}</Text>
      </Box>
    );

    lastIndex = match.index + match[0].length;
    blockIdx++;
  }

  const textAfter = content.slice(lastIndex);
  if (textAfter) {
    parts.push(
      <Text key={`text-end`} color={palette.fg}>
        {textAfter}
      </Text>
    );
  }

  return parts.length > 0 ? parts : <Text color={palette.fg}>{content}</Text>;
}

export const MessageList: React.FC<MessageListProps> = ({ messages, activeTool }) => {
  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return (
            <Box key={msg.id} marginY={1} flexDirection="column">
              <Box>
                <Text bold color={palette.fg}>
                  ❯ You:{' '}
                </Text>
              </Box>
              <Box paddingLeft={2}>
                <Text color={palette.fg}>{msg.content}</Text>
              </Box>
            </Box>
          );
        }

        if (msg.role === 'assistant') {
          return (
            <Box key={msg.id} marginY={1} flexDirection="column">
              <Box>
                <Text bold color={palette.fg}>
                  ✦ Assistant:{' '}
                </Text>
                {msg.isStreaming && (
                  <Text color={palette.fg}>
                    <Spinner type="dots" />
                  </Text>
                )}
              </Box>
              <Box paddingLeft={2} flexDirection="column">
                {renderContentWithHighlighting(msg.content)}
              </Box>
            </Box>
          );
        }

        if (msg.role === 'tool') {
          return (
            <Box key={msg.id} marginY={0} paddingLeft={2}>
              <Text dimColor>
                {msg.status === 'error' ? '❌' : '✓'} [{msg.toolName || 'tool'}]:{' '}
                {msg.content.slice(0, 150)}
                {msg.content.length > 150 ? '...' : ''}
              </Text>
            </Box>
          );
        }

        return null;
      })}

      {activeTool && (
        <Box marginY={1} paddingLeft={2}>
          <Text color={palette.fg}>
            <Spinner type="dots" /> Running tool:{' '}
            <Text bold color={palette.fg}>{activeTool.name}</Text>
            {activeTool.args ? ` (${Object.keys(activeTool.args).join(', ')})` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default MessageList;
