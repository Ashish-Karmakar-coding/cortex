import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { palette } from './palette.js';
import { filterSlashCommands, type SlashCommand } from './commands.js';

export interface PromptInputProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Shown on the right side of the prompt border, e.g. the active model. */
  hint?: string;
}

const MAX_VISIBLE = 8;

function padTo(line: string, width: number): string {
  const length = stringWidth(line);
  if (length >= width) return line;
  return line + ' '.repeat(width - length);
}

function truncateTo(line: string, width: number): string {
  if (stringWidth(line) <= width) return line;
  let result = '';
  for (const char of line) {
    if (stringWidth(result + char) > width - 1) {
      return `${result}…`;
    }
    result += char;
  }
  return result;
}

interface SlashMenuProps {
  items: SlashCommand[];
  selectedIndex: number;
  query: string;
}

const SlashMenu: React.FC<SlashMenuProps> = ({ items, selectedIndex, query }) => {
  const columns = process.stdout.columns ?? 80;
  const width = Math.max(24, Math.min(columns - 2, 84));

  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE)
  );
  const visible = items.slice(start, start + MAX_VISIBLE);

  return (
    <Box flexDirection="column">
      <Text backgroundColor={palette.bg} color={palette.muted}>
        {padTo(
          `  ${query ? `/${query}` : 'Commands'}  ·  ↑↓ navigate  ·  Tab complete  ·  Enter run`,
          width
        )}
      </Text>

      {visible.map((command, index) => {
        const itemIndex = start + index;
        const selected = itemIndex === selectedIndex;
        const label = `  /${command.name}${command.args ? ` ${command.args}` : ''}`;
        const gap = Math.max(2, 24 - stringWidth(label));
        const line = truncateTo(
          `${label}${' '.repeat(gap)}${command.description}`,
          width
        );

        return (
          <Text
            key={command.name}
            backgroundColor={selected ? palette.fg : palette.bg}
            color={selected ? palette.bg : palette.fg}
            bold={selected}
          >
            {padTo(line, width)}
          </Text>
        );
      })}

      {items.length > MAX_VISIBLE && (
        <Text backgroundColor={palette.bg} color={palette.muted}>
          {padTo(
            `  ${start + visible.length < items.length ? '↓ more' : '↑ more'}`,
            width
          )}
        </Text>
      )}
    </Box>
  );
};

export const PromptInput: React.FC<PromptInputProps> = ({
  onSubmit,
  disabled = false,
  placeholder = '',
  hint,
}) => {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef('');

  const query =
    value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
      ? value.slice(1)
      : null;
  const matches = useMemo(
    () => (query === null ? [] : filterSlashCommands(query)),
    [query]
  );
  const menuOpen = !disabled && query !== null && !dismissed && matches.length > 0;

  useEffect(() => {
    setCursor((current) => Math.min(current, value.length));
  }, [value.length]);

  useEffect(() => {
    if (selectedIndex >= matches.length) {
      setSelectedIndex(Math.max(0, matches.length - 1));
    }
  }, [matches.length, selectedIndex]);

  useEffect(() => {
    setDismissed(false);
    setSelectedIndex(0);
  }, [query]);

  const replaceValue = (next: string, nextCursor = next.length) => {
    setValue(next);
    setCursor(nextCursor);
    historyIndexRef.current = null;
  };

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (historyRef.current[historyRef.current.length - 1] !== trimmed) {
      historyRef.current.push(trimmed);
      if (historyRef.current.length > 100) historyRef.current.shift();
    }
    historyIndexRef.current = null;
    draftRef.current = '';
    setValue('');
    setCursor(0);
    setDismissed(true);
    onSubmit(trimmed);
  };

  const completeCommand = (command: SlashCommand) => {
    const next = `/${command.name}${command.args ? ' ' : ''}`;
    setValue(next);
    setCursor(next.length);
    setDismissed(true);
  };

  useInput(
    (input, key) => {
      if (menuOpen) {
        if (key.upArrow) {
          setSelectedIndex((current) => (current - 1 + matches.length) % matches.length);
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((current) => (current + 1) % matches.length);
          return;
        }
        if (key.tab) {
          const command = matches[selectedIndex];
          if (command) completeCommand(command);
          return;
        }
        if (key.return) {
          const command = matches[selectedIndex];
          if (!command) return;
          if (command.args) {
            completeCommand(command);
          } else {
            submit(`/${command.name}`);
          }
          return;
        }
        if (key.escape) {
          setDismissed(true);
          return;
        }
      } else {
        if (key.escape) {
          if (value) {
            setValue('');
            setCursor(0);
          }
          return;
        }

        // Prompt history (up/down) when the command palette is closed.
        if (key.upArrow || key.downArrow) {
          const history = historyRef.current;
          if (history.length === 0) return;
          if (key.upArrow) {
            if (historyIndexRef.current === null) {
              draftRef.current = value;
              historyIndexRef.current = history.length - 1;
            } else if (historyIndexRef.current > 0) {
              historyIndexRef.current -= 1;
            }
          } else {
            if (historyIndexRef.current === null) return;
            historyIndexRef.current += 1;
            if (historyIndexRef.current >= history.length) {
              historyIndexRef.current = null;
              setValue(draftRef.current);
              setCursor(draftRef.current.length);
              return;
            }
          }
          const item = history[historyIndexRef.current!] ?? '';
          setValue(item);
          setCursor(item.length);
          return;
        }

        if (key.return) {
          // A trailing backslash turns Enter into a soft newline.
          if (value.endsWith('\\')) {
            const next = value.slice(0, -1) + '\n';
            replaceValue(next, next.length);
            return;
          }
          submit(value);
          return;
        }
      }

      if (key.tab) return;
      if (key.ctrl && input === 'j') {
        replaceValue(
          value.slice(0, cursor) + '\n' + value.slice(cursor),
          cursor + 1
        );
        return;
      }
      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(value.length, current + 1));
        return;
      }
      if (key.backspace) {
        if (cursor === 0) return;
        replaceValue(
          value.slice(0, cursor - 1) + value.slice(cursor),
          cursor - 1
        );
        return;
      }
      if (key.delete) {
        if (cursor >= value.length) return;
        replaceValue(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
        return;
      }

      // Ignore shortcuts and escape sequences; insert printable/pasted text.
      if (key.ctrl || key.meta || !input) return;
      const pasted = input.replace(/\r/g, '');
      if (!pasted) return;

      replaceValue(
        value.slice(0, cursor) + pasted + value.slice(cursor),
        cursor + pasted.length
      );
    },
    { isActive: !disabled }
  );

  const before = value.slice(0, cursor);
  const atCursor = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);

  return (
    <>
      {menuOpen && (
        <SlashMenu items={matches} selectedIndex={selectedIndex} query={query ?? ''} />
      )}

      <Box
        borderStyle="round"
        borderColor={palette.fg}
        paddingX={1}
        marginTop={1}
      >
        <Box flexGrow={1}>
          <Text bold color={palette.fg} backgroundColor={palette.bg}>
            ❯{' '}
          </Text>
          {value.length === 0 ? (
            <Text dimColor backgroundColor={palette.bg}>
              {placeholder}
            </Text>
          ) : null}
          {!disabled && (
            <>
              <Text color={palette.fg} backgroundColor={palette.bg}>
                {before}
              </Text>
              <Text
                inverse
                color={palette.bg}
                backgroundColor={palette.fg}
              >
                {atCursor || ' '}
              </Text>
              <Text color={palette.fg} backgroundColor={palette.bg}>
                {after}
              </Text>
            </>
          )}
          {disabled && value.length > 0 && (
            <Text color={palette.fg} backgroundColor={palette.bg}>
              {value}
            </Text>
          )}
        </Box>
        {hint ? (
          <Text dimColor backgroundColor={palette.bg}>
            {hint}
          </Text>
        ) : null}
      </Box>
    </>
  );
};

export default PromptInput;
