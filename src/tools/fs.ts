import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPatch } from 'diff';

const MAX_READ_LINES = 500;

export const readFileTool = tool({
  description:
    'Read the contents of a file. Returns numbered lines. Use start_line and end_line to read specific ranges for large files.',
  parameters: z.object({
    path: z.string().describe('Absolute or relative path to the file'),
    start_line: z
      .number()
      .optional()
      .describe('1-based start line (inclusive). Omit to start from beginning.'),
    end_line: z
      .number()
      .optional()
      .describe('1-based end line (inclusive). Omit to read to end.'),
  }),
  execute: async ({ path, start_line, end_line }) => {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
      return `Error: File not found: ${resolvedPath}`;
    }
    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      const allLines = content.split('\n');
      const start = (start_line ?? 1) - 1;
      const end = end_line ?? allLines.length;
      let lines = allLines.slice(start, end);

      let truncated = false;
      if (lines.length > MAX_READ_LINES) {
        lines = lines.slice(0, MAX_READ_LINES);
        truncated = true;
      }

      const numbered = lines.map(
        (line, i) => `${String(start + i + 1).padStart(5)} | ${line}`
      );

      let result = numbered.join('\n');
      if (truncated) {
        result += `\n\n[... truncated at ${MAX_READ_LINES} lines. Total lines: ${allLines.length}. Use start_line/end_line to read more.]`;
      }

      return result;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const writeFileTool = tool({
  description:
    'Write content to a file. Creates the file and any parent directories if they do not exist. Use this for creating new files.',
  parameters: z.object({
    path: z.string().describe('Absolute or relative path to the file'),
    content: z.string().describe('The full content to write to the file'),
  }),
  execute: async ({ path, content }) => {
    const resolvedPath = resolve(path);
    try {
      mkdirSync(dirname(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, content, 'utf-8');
      const lineCount = content.split('\n').length;
      return `Successfully wrote ${lineCount} lines to ${resolvedPath}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

function normalizeWhitespace(s: string): string {
  return s
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export const editFileTool = tool({
  description:
    'Make a surgical edit to a file by specifying a SEARCH block (the exact existing text to find) and a REPLACE block (the new text to substitute). The search block must match exactly one location in the file. Include 2-3 surrounding context lines if the search block is ambiguous.',
  parameters: z.object({
    path: z.string().describe('Absolute or relative path to the file'),
    search_block: z.string().describe('The exact text to search for in the file'),
    replace_block: z.string().describe('The replacement text'),
  }),
  execute: async ({ path, search_block, replace_block }) => {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
      return JSON.stringify({
        error: `File not found: ${resolvedPath}`,
        applied: false,
      });
    }

    try {
      const originalContent = readFileSync(resolvedPath, 'utf-8');

      // Try exact match first
      const exactMatches = originalContent.split(search_block).length - 1;

      if (exactMatches === 1) {
        // Exact single match — apply
        const newContent = originalContent.replace(search_block, replace_block);
        const diff = createPatch(resolvedPath, originalContent, newContent, 'original', 'modified');
        // Write the file
        writeFileSync(resolvedPath, newContent, 'utf-8');
        return JSON.stringify({ diff, applied: true });
      }

      if (exactMatches > 1) {
        return JSON.stringify({
          error: `search_block matches ${exactMatches} locations. Include more surrounding context lines to make the match unique.`,
          applied: false,
        });
      }

      // No exact match — try whitespace-normalized fallback
      const normalizedSearch = normalizeWhitespace(search_block);
      const lines = originalContent.split('\n');
      const searchLines = normalizedSearch.split('\n');
      let matchStart = -1;
      let matchCount = 0;

      for (let i = 0; i <= lines.length - searchLines.length; i++) {
        const candidate = lines
          .slice(i, i + searchLines.length)
          .map((l) => l.trimEnd())
          .join('\n')
          .trim();
        if (candidate === normalizedSearch) {
          matchStart = i;
          matchCount++;
        }
      }

      if (matchCount === 0) {
        return JSON.stringify({
          error:
            'search_block not found in file (even with whitespace normalization). Verify the content matches the file exactly.',
          applied: false,
        });
      }

      if (matchCount > 1) {
        return JSON.stringify({
          error: `search_block matches ${matchCount} locations after whitespace normalization. Include more context lines.`,
          applied: false,
        });
      }

      // Single whitespace-normalized match
      const beforeLines = lines.slice(0, matchStart);
      const afterLines = lines.slice(matchStart + searchLines.length);
      const newContent = [...beforeLines, replace_block, ...afterLines].join('\n');
      const diff = createPatch(resolvedPath, originalContent, newContent, 'original', 'modified');
      writeFileSync(resolvedPath, newContent, 'utf-8');
      return JSON.stringify({ diff, applied: true });
    } catch (err) {
      return JSON.stringify({
        error: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        applied: false,
      });
    }
  },
});
