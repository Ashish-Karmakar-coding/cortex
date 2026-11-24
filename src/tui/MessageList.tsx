import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import { palette } from './theme.js';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  isStreaming?: boolean;
  status?: 'pending' | 'running' | 'done' | 'error';
  variant?: 'welcome' | 'info' | 'error';
}

export interface MessageListProps {
  messages: DisplayMessage[];
  activeTool?: { name: string; args?: Record<string, unknown> };
}

/** Keep syntax highlighting inside the solid Cortex palette. */
const CODE_THEME = {
  keyword: chalk.hex(palette.warning),
  built_in: chalk.hex(palette.fg),
  type: chalk.hex(palette.success),
  literal: chalk.hex(palette.warning),
  number: chalk.hex(palette.warning),
  regexp: chalk.hex(palette.success),
  string: chalk.hex(palette.success),
  class: chalk.hex(palette.fg),
  function: chalk.hex(palette.fg),
  title: chalk.hex(palette.fg),
  comment: chalk.hex(palette.muted),
  doctag: chalk.hex(palette.muted),
  meta: chalk.hex(palette.muted),
  tag: chalk.hex(palette.muted),
  name: chalk.hex(palette.fg),
  attr: chalk.hex(palette.success),
  addition: chalk.hex(palette.success),
  deletion: chalk.hex(palette.danger),
};

const highlightCache = new Map<string, string>();

function highlightCode(code: string, language: string): string {
  const key = `${language}\u0000${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;

  let result: string;
  try {
    result = highlight(code, {
      language,
      ignoreIllegals: true,
      theme: CODE_THEME,
    });
  } catch {
    result = code;
  }

  if (highlightCache.size > 200) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  highlightCache.set(key, result);
  return result;
}

/**
 * XML/JSON tool-call syntax and internal thinking scratchpads should never be
 * shown directly in the transcript. Tool activity is rendered as its own item.
 */
export function stripToolCallMarkup(content: string, streaming = false): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '');

  if (streaming) {
    const thinkOpen = text.lastIndexOf('<think>');
    const thinkClose = text.lastIndexOf('</think>');
    if (thinkOpen > thinkClose) {
      text = text.slice(0, thinkOpen);
    }

    const open = text.lastIndexOf('<tool_call');
    const close = text.lastIndexOf('</tool_call>');
    if (open > close) {
      text = text.slice(0, open);
    }

    const fnOpen = text.lastIndexOf('<function=');
    const fnClose = text.lastIndexOf('</function>');
    if (fnOpen > fnClose) {
      text = text.slice(0, fnOpen);
    }

    const fence = text.lastIndexOf('```');
    if (fence !== -1) {
      const tail = text.slice(fence);
      if (
        /^```(?:json|tool_call)?\s*\n?\s*[\[{][\s\S]*"(?:name|tool|function)"/i.test(tail) &&
        !tail.trimEnd().endsWith('```')
      ) {
        text = text.slice(0, fence);
      }
    }
  }

  return text
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function=[\s\S]*?<\/function>/gi, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    .replace(
      /```(?:json|tool_call)?\s*\n?\s*[\[{][\s\S]*?"(?:name|tool|function)"[\s\S]*?"(?:arguments|args|parameters|params|input)"[\s\S]*?[\]}]\s*\n?\s*```/gi,
      ''
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderContent(
  rawContent: string,
  streaming: boolean
): React.ReactNode {
  const content = stripToolCallMarkup(rawContent, streaming);
  if (!content) return null;

  const parts: React.ReactNode[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_+#.-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let blockIdx = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index);
    if (textBefore.trim()) {
      parts.push(
        <Text key={`text-${blockIdx}`} color={palette.fg} backgroundColor={palette.bg}>
          {textBefore}
        </Text>
      );
    }

    const language = match[1] || 'typescript';
    const code = match[2] ?? '';
    const rendered = streaming ? code : highlightCode(code, language);

    parts.push(
      <Box
        key={`code-${blockIdx}`}
        borderStyle="round"
        borderColor={palette.border}
        paddingX={1}
        marginY={1}
        flexDirection="column"
      >
        {language ? (
          <Text bold color={palette.muted} backgroundColor={palette.bg}>
            [{language}]
          </Text>
        ) : null}
        <Text color={palette.fg} backgroundColor={palette.bg}>
          {rendered}
        </Text>
      </Box>
    );

    lastIndex = match.index + match[0].length;
    blockIdx++;
  }

  const textAfter = content.slice(lastIndex);
  if (textAfter.trim()) {
    parts.push(
      <Text key="text-end" color={palette.fg} backgroundColor={palette.bg}>
        {textAfter}
      </Text>
    );
  }

  if (parts.length === 0) {
    return (
      <Text color={palette.fg} backgroundColor={palette.bg}>
        {content}
      </Text>
    );
  }
  return parts;
}

export interface MessageItemProps {
  message: DisplayMessage;
}

export const MessageItem = React.memo<MessageItemProps>(({ message }) => {
  const { role, content } = message;

  if (role === 'user') {
    return (
      <Box key={message.id} marginY={1} flexDirection="column">
        <Box>
          <Text bold color={palette.fg} backgroundColor={palette.bg}>
            ❯ You
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color={palette.fg} backgroundColor={palette.bg}>
            {content}
          </Text>
        </Box>
      </Box>
    );
  }

  if (role === 'assistant') {
    const streaming = Boolean(message.isStreaming);
    let visible = stripToolCallMarkup(content, streaming);
    if (!visible && !streaming) {
      return null;
    }

    if (streaming) {
      const maxLines = Math.max(6, Math.min(16, (process.stdout.rows ?? 30) - 20));
      const lines = visible.split('\n');
      if (lines.length > maxLines) {
        visible = `… ${lines.length - maxLines} earlier lines\n${lines
          .slice(-maxLines)
          .join('\n')}`;
      }
    }

    return (
      <Box key={message.id} marginY={1} flexDirection="column">
        <Box>
          <Text bold color={palette.fg} backgroundColor={palette.bg}>
            ✻ Cortex
          </Text>
          {message.isStreaming ? (
            <Text color={palette.fg} backgroundColor={palette.bg}>
              {' '}
              <Spinner type="dots" />
            </Text>
          ) : null}
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          {renderContent(visible, streaming)}
        </Box>
      </Box>
    );
  }

  if (role === 'tool') {
    const status = message.status === 'error' ? '✗' : '✓';
    const color = message.status === 'error' ? palette.danger : palette.muted;
    return (
      <Box key={message.id} marginY={0} paddingLeft={2}>
        <Text color={color} backgroundColor={palette.bg}>
          {status} [{message.toolName || 'tool'}] {message.content.slice(0, 160)}
          {message.content.length > 160 ? '…' : ''}
        </Text>
      </Box>
    );
  }

  const isWelcome = message.variant === 'welcome';
  const isError = message.variant === 'error';

  if (isWelcome) {
    const [title, ...rest] = content.split('\n');
    return (
      <Box key={message.id} flexDirection="column" marginY={1}>
        <Text bold color={palette.fg} backgroundColor={palette.bg}>
          {title}
        </Text>
        {rest.map((line, index) => (
          <Text key={index} color={palette.muted} backgroundColor={palette.bg}>
            {line || ' '}
          </Text>
        ))}
      </Box>
    );
  }

  const color = isError ? palette.danger : palette.muted;

  return (
    <Box key={message.id} marginY={0} paddingLeft={1}>
      <Text color={color} backgroundColor={palette.bg}>
        {`ℹ ${content}`}
      </Text>
    </Box>
  );
});
MessageItem.displayName = 'MessageItem';

export const MessageList: React.FC<MessageListProps> = ({ messages, activeTool }) => {
  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg) => (
        <MessageItem key={msg.id} message={msg} />
      ))}

      {activeTool && (
        <Box marginY={1} paddingLeft={2}>
          <Text color={palette.fg} backgroundColor={palette.bg}>
            <Spinner type="dots" /> Running{' '}
            <Text bold color={palette.fg} backgroundColor={palette.bg}>
              {activeTool.name}
            </Text>
            {activeTool.args
              ? ` (${Object.keys(activeTool.args).slice(0, 4).join(', ')})`
              : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default MessageList;
