import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import fg from 'fast-glob';

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/.venv/**',
];

export function listProjectFiles(cwd = process.cwd(), limit = 400): string[] {
  try {
    const files = fg.sync('**/*', {
      cwd,
      ignore: IGNORE_PATTERNS,
      onlyFiles: true,
      dot: false,
      deep: 6,
    });
    return files.sort().slice(0, limit);
  } catch {
    return [];
  }
}

export interface MentionExpansionResult {
  expandedPrompt: string;
  attachedFiles: string[];
}

const MENTION_REGEX = /(?:^|\s)@([A-Za-z0-9_./\\:-]+)/g;
const MAX_MENTION_FILES = 5;
const MAX_MENTION_LINES = 250;

export function expandFileMentions(
  prompt: string,
  cwd = process.cwd()
): MentionExpansionResult {
  const attached: Array<{ displayPath: string; content: string }> = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  const regex = new RegExp(MENTION_REGEX.source, 'g');
  while ((match = regex.exec(prompt)) !== null) {
    if (attached.length >= MAX_MENTION_FILES) break;
    const rawRef = match[1]!;
    const resolved = resolve(cwd, rawRef);
    if (seen.has(resolved) || !existsSync(resolved)) continue;

    try {
      const stat = statSync(resolved);
      if (!stat.isFile() || stat.size > 500_000) continue;
      const buf = readFileSync(resolved);
      if (buf.subarray(0, 2048).includes(0)) continue;

      const lines = buf.toString('utf-8').split('\n');
      const truncated = lines.length > MAX_MENTION_LINES;
      const body = lines
        .slice(0, MAX_MENTION_LINES)
        .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
        .join('\n');

      const displayPath = relative(cwd, resolved) || rawRef;
      seen.add(resolved);
      attached.push({
        displayPath,
        content: truncated
          ? `${body}\n[... truncated at ${MAX_MENTION_LINES} lines]`
          : body,
      });
    } catch {
      // Ignore unreadable mention target
    }
  }

  if (attached.length === 0) {
    return { expandedPrompt: prompt, attachedFiles: [] };
  }

  const sections = attached.map(
    (f) => `### @${f.displayPath}\n\`\`\`\n${f.content}\n\`\`\``
  );
  return {
    expandedPrompt: `${prompt}\n\n## Referenced Files\n${sections.join('\n\n')}`,
    attachedFiles: attached.map((f) => f.displayPath),
  };
}
