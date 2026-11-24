import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPatch } from 'diff';

const MAX_READ_LINES = 500;

export interface FileSnapshot {
  path: string;
  existedBefore: boolean;
  previousContent: string | null;
}

export function captureFileSnapshot(targetPath: string): FileSnapshot {
  const resolved = resolve(targetPath);
  if (!existsSync(resolved)) {
    return { path: resolved, existedBefore: false, previousContent: null };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > 2_000_000) {
      return { path: resolved, existedBefore: true, previousContent: null };
    }
    return {
      path: resolved,
      existedBefore: true,
      previousContent: readFileSync(resolved, 'utf-8'),
    };
  } catch {
    return { path: resolved, existedBefore: true, previousContent: null };
  }
}

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
      const stat = statSync(resolvedPath);
      if (stat.isDirectory()) {
        const entries = readdirSync(resolvedPath, { withFileTypes: true })
          .slice(0, 100)
          .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
        return `Directory listing for ${resolvedPath}:\n${entries.join('\n') || '(empty)'}`;
      }

      const buf = readFileSync(resolvedPath);
      // Simple binary guard: null byte in initial slice
      if (buf.subarray(0, 4096).includes(0)) {
        return `Error: Cannot display binary file (${buf.length} bytes): ${resolvedPath}`;
      }

      const content = buf.toString('utf-8');
      const allLines = content.split('\n');
      const start = Math.max(0, (start_line ?? 1) - 1);
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
    .replace(/\r\n/g, '\n')
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
      const usesCrlf = originalContent.includes('\r\n');
      const lfOriginal = originalContent.replace(/\r\n/g, '\n');
      const lfSearch = search_block.replace(/\r\n/g, '\n');
      const lfReplace = replace_block.replace(/\r\n/g, '\n');

      // 1. Try exact match first (preserving original line endings)
      const exactMatches = originalContent.split(search_block).length - 1;
      if (exactMatches === 1) {
        const newContent = originalContent.replace(search_block, replace_block);
        const diff = createPatch(resolvedPath, originalContent, newContent, 'original', 'modified');
        writeFileSync(resolvedPath, newContent, 'utf-8');
        return JSON.stringify({ diff, applied: true });
      }
      if (exactMatches > 1) {
        return JSON.stringify({
          error: `search_block matches ${exactMatches} locations. Include more surrounding context lines to make the match unique.`,
          applied: false,
        });
      }

      // 2. Try LF-normalized exact match (handles Windows CRLF files edited with LF blocks)
      const lfMatches = lfOriginal.split(lfSearch).length - 1;
      if (lfMatches === 1) {
        const replacedLf = lfOriginal.replace(lfSearch, lfReplace);
        const newContent = usesCrlf ? replacedLf.replace(/\n/g, '\r\n') : replacedLf;
        const diff = createPatch(resolvedPath, originalContent, newContent, 'original', 'modified');
        writeFileSync(resolvedPath, newContent, 'utf-8');
        return JSON.stringify({ diff, applied: true });
      }
      if (lfMatches > 1) {
        return JSON.stringify({
          error: `search_block matches ${lfMatches} locations. Include more surrounding context lines to make the match unique.`,
          applied: false,
        });
      }

      // 3. Try whitespace-normalized fallback
      const normalizedSearch = normalizeWhitespace(lfSearch);
      const lines = lfOriginal.split('\n');
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
            'search_block not found in file (even with line-ending and whitespace normalization). Verify the content matches the file exactly.',
          applied: false,
        });
      }

      if (matchCount > 1) {
        return JSON.stringify({
          error: `search_block matches ${matchCount} locations after whitespace normalization. Include more context lines.`,
          applied: false,
        });
      }

      const beforeLines = lines.slice(0, matchStart);
      const afterLines = lines.slice(matchStart + searchLines.length);
      const replacedLf = [...beforeLines, lfReplace, ...afterLines].join('\n');
      const newContent = usesCrlf ? replacedLf.replace(/\n/g, '\r\n') : replacedLf;
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
