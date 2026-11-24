export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi;
const XML_TOOL_CALL_REGEX = /<tool_call(?:\s+name=["']([^"']+)["'])?\s*>([\s\S]*?)<\/tool_call>/gi;
const QWEN_FUNCTION_REGEX = /<function=([a-zA-Z0-9_:-]+)>([\s\S]*?)<\/function>/gi;
const QWEN_PARAM_REGEX = /<parameter=([a-zA-Z0-9_:-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
const INVOKE_REGEX = /<invoke\s+name=["']([a-zA-Z0-9_:-]+)["']\s*>([\s\S]*?)<\/invoke>/gi;
const INVOKE_PARAM_REGEX = /<parameter\s+name=["']([a-zA-Z0-9_:-]+)["']\s*>([\s\S]*?)<\/parameter>/gi;
const CODE_BLOCK_REGEX = /```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)```/g;

function stripThinkBlocks(text: string): string {
  return text.replace(THINK_BLOCK_REGEX, '');
}

/**
 * Repair common LLM JSON formatting issues before parsing:
 * - Inner markdown fences inside <tool_call>
 * - Literal newlines/tabs inside JSON string values
 * - Trailing commas before } or ]
 */
function sanitizeJsonCandidate(raw: string): string {
  let s = raw.trim();
  const innerFence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (innerFence?.[1]) {
    s = innerFence[1].trim();
  }

  // Escape raw control characters (newlines/tabs/CR) inside double-quoted JSON strings.
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
    }
    out += ch;
  }

  // Remove trailing commas outside/inside objects and arrays.
  return out.replace(/,\s*([}\]])/g, '$1');
}

function parseLenientJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(sanitizeJsonCandidate(trimmed));
    } catch {
      return null;
    }
  }
}

function coerceToolCallObject(
  obj: unknown,
  fallbackName?: string
): ParsedToolCall | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;

  // Handle OpenAI-style { type: "function", function: { name, arguments } }
  if (record['function'] && typeof record['function'] === 'object') {
    return coerceToolCallObject(record['function'], fallbackName);
  }

  const rawName =
    record['name'] ??
    record['tool'] ??
    record['tool_name'] ??
    record['toolName'] ??
    fallbackName;
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return null;
  }

  const rawArgs =
    record['arguments'] ??
    record['args'] ??
    record['parameters'] ??
    record['params'] ??
    record['input'];

  let argsObj: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    const parsed = parseLenientJson(rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      argsObj = parsed as Record<string, unknown>;
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    argsObj = rawArgs as Record<string, unknown>;
  } else if (rawArgs === undefined && fallbackName && !('name' in record) && !('tool' in record)) {
    // <tool_call name="read_file">{"path": "foo.ts"}</tool_call>
    argsObj = { ...record };
  }

  return {
    name: rawName.trim(),
    arguments: argsObj,
  };
}

function extractCallsFromParsedValue(
  parsed: unknown,
  fallbackName?: string
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const call = coerceToolCallObject(item, fallbackName);
      if (call) calls.push(call);
    }
  } else {
    const call = coerceToolCallObject(parsed, fallbackName);
    if (call) calls.push(call);
  }
  return calls;
}

/**
 * Scan balanced `{ ... }` JSON objects from text when a model outputs bare JSON
 * or multiple JSON objects in a code block.
 */
function extractBalancedJsonObjects(text: string): unknown[] {
  const results: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        const parsed = parseLenientJson(candidate);
        if (parsed !== null) {
          results.push(parsed);
        }
        start = -1;
      }
    }
  }
  return results;
}

function parseParamValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw.replace(/^\n+|\n+$/g, '');
}

/**
 * Normalize common parameter aliases emitted by local models trained on
 * Claude Code / OpenAI / Qwen conventions.
 */
export function normalizeToolArguments(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };

  const copyAlias = (target: string, aliases: string[]) => {
    if (out[target] !== undefined) return;
    for (const alias of aliases) {
      if (out[alias] !== undefined) {
        out[target] = out[alias];
        return;
      }
    }
  };

  switch (toolName) {
    case 'read_file': {
      copyAlias('path', ['file_path', 'filepath', 'file', 'target_file', 'filename']);
      copyAlias('start_line', ['startLine', 'start', 'from_line', 'offset', 'line_start']);
      copyAlias('end_line', ['endLine', 'end', 'to_line', 'line_end']);
      if (out['end_line'] === undefined && typeof out['limit'] === 'number') {
        const start = typeof out['start_line'] === 'number' ? out['start_line'] : 1;
        out['end_line'] = start + out['limit'] - 1;
      }
      if (typeof out['start_line'] === 'string' && /^\d+$/.test(out['start_line'])) {
        out['start_line'] = Number(out['start_line']);
      }
      if (typeof out['end_line'] === 'string' && /^\d+$/.test(out['end_line'])) {
        out['end_line'] = Number(out['end_line']);
      }
      break;
    }

    case 'write_file': {
      copyAlias('path', ['file_path', 'filepath', 'file', 'target_file', 'filename']);
      copyAlias('content', ['text', 'contents', 'code', 'body', 'data']);
      break;
    }

    case 'edit_file': {
      copyAlias('path', ['file_path', 'filepath', 'file', 'target_file', 'filename']);
      copyAlias('search_block', ['old_string', 'old_text', 'search', 'old', 'find', 'target']);
      copyAlias('replace_block', ['new_string', 'new_text', 'replace', 'new', 'replacement']);
      break;
    }

    case 'glob_files': {
      copyAlias('pattern', ['glob', 'file_pattern', 'query']);
      copyAlias('cwd', ['directory', 'dir', 'root', 'path']);
      break;
    }

    case 'grep_search': {
      copyAlias('pattern', ['query', 'regex', 'search', 'text']);
      copyAlias('path', ['directory', 'dir', 'cwd', 'file_path']);
      copyAlias('include', ['glob', 'file_pattern', 'filter']);
      break;
    }

    case 'bash_exec': {
      copyAlias('command', ['cmd', 'shell', 'script', 'bash']);
      if (typeof out['timeout'] === 'string' && /^\d+$/.test(out['timeout'])) {
        out['timeout'] = Number(out['timeout']);
      }
      break;
    }

    case 'task': {
      copyAlias('agent_type', ['subagent_type', 'agent', 'type']);
      copyAlias('prompt', ['task', 'instructions', 'message']);
      copyAlias('description', ['title', 'summary']);
      if (!out['description'] && typeof out['prompt'] === 'string') {
        out['description'] = out['prompt'].split(/\s+/).slice(0, 5).join(' ') || 'Subagent task';
      }
      break;
    }
  }

  return out;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const cleaned = stripThinkBlocks(text);
  const calls: ParsedToolCall[] = [];

  // 1. <tool_call>...</tool_call> XML blocks
  const xmlRegex = new RegExp(XML_TOOL_CALL_REGEX.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = xmlRegex.exec(cleaned)) !== null) {
    const attrName = match[1];
    const body = (match[2] ?? '').trim();

    // Check if <function=...> or <invoke ...> is nested inside <tool_call>
    if (/<function=/.test(body) || /<invoke\s+name=/.test(body)) {
      calls.push(...parseXmlParamTags(body));
      continue;
    }

    const parsed = parseLenientJson(body);
    if (parsed !== null) {
      calls.push(...extractCallsFromParsedValue(parsed, attrName));
    } else {
      for (const obj of extractBalancedJsonObjects(body)) {
        calls.push(...extractCallsFromParsedValue(obj, attrName));
      }
    }
  }
  if (calls.length > 0) return calls;

  // 2. Qwen3/Hermes <function=name><parameter=k>v</parameter></function> or <invoke name="...">
  const xmlParamCalls = parseXmlParamTags(cleaned);
  if (xmlParamCalls.length > 0) return xmlParamCalls;

  // 3. Markdown code blocks (supports pretty-printed JSON, arrays, multiple JSON objects)
  const codeRegex = new RegExp(CODE_BLOCK_REGEX.source, 'g');
  while ((match = codeRegex.exec(cleaned)) !== null) {
    const block = (match[1] ?? '').trim();
    const parsed = parseLenientJson(block);
    if (parsed !== null) {
      calls.push(...extractCallsFromParsedValue(parsed));
    } else {
      for (const obj of extractBalancedJsonObjects(block)) {
        calls.push(...extractCallsFromParsedValue(obj));
      }
    }
  }
  if (calls.length > 0) return calls;

  // 4. Bare JSON tool call objects directly in text
  for (const obj of extractBalancedJsonObjects(cleaned)) {
    calls.push(...extractCallsFromParsedValue(obj));
  }

  return calls;
}

function parseXmlParamTags(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  const qwenRegex = new RegExp(QWEN_FUNCTION_REGEX.source, 'gi');
  while ((match = qwenRegex.exec(text)) !== null) {
    const name = match[1]!;
    const body = match[2] ?? '';
    const args: Record<string, unknown> = {};
    const paramRegex = new RegExp(QWEN_PARAM_REGEX.source, 'gi');
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      args[pMatch[1]!] = parseParamValue(pMatch[2] ?? '');
    }
    calls.push({ name, arguments: args });
  }
  if (calls.length > 0) return calls;

  const invokeRegex = new RegExp(INVOKE_REGEX.source, 'gi');
  while ((match = invokeRegex.exec(text)) !== null) {
    const name = match[1]!;
    const body = match[2] ?? '';
    const args: Record<string, unknown> = {};
    const paramRegex = new RegExp(INVOKE_PARAM_REGEX.source, 'gi');
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      args[pMatch[1]!] = parseParamValue(pMatch[2] ?? '');
    }
    calls.push({ name, arguments: args });
  }

  return calls;
}

export function extractTextBeforeToolCalls(text: string): string {
  const cleaned = stripThinkBlocks(text);
  const candidates = [
    cleaned.search(/<tool_call[\s>]/i),
    cleaned.search(/<function=[a-zA-Z0-9_:-]+>/i),
    cleaned.search(/<invoke\s+name=/i),
    cleaned.search(/```(?:json|tool_call)?\s*\n?\s*[\[{][\s\S]*?"(?:name|tool|function)"\s*:/i),
  ].filter((idx) => idx !== -1);

  if (candidates.length === 0) {
    // Check if there is a bare JSON tool call
    const bareMatch = /\{\s*"(?:name|tool|tool_name|function)"\s*:/.exec(cleaned);
    if (bareMatch) {
      return cleaned.slice(0, bareMatch.index).trim();
    }
    return cleaned.trim();
  }

  return cleaned.slice(0, Math.min(...candidates)).trim();
}

export function hasToolCalls(text: string): boolean {
  const cleaned = stripThinkBlocks(text);
  if (/<tool_call[\s>]/i.test(cleaned)) return true;
  if (/<function=[a-zA-Z0-9_:-]+>/i.test(cleaned)) return true;
  if (/<invoke\s+name=/i.test(cleaned)) return true;
  if (/```(?:json|tool_call)?\s*\n?\s*[\[{][\s\S]*?"(?:name|tool|function)"\s*:/i.test(cleaned)) {
    return true;
  }
  // Bare JSON tool call with arguments/parameters/args/input
  if (
    /\{\s*"(?:name|tool|tool_name)"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|args|parameters|params|input)"\s*:/.test(
      cleaned
    )
  ) {
    return true;
  }
  return false;
}
