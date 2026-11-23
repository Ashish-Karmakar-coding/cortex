export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const JSON_BLOCK_REGEX = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;

export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 1. Try <tool_call> XML blocks
  let match: RegExpExecArray | null;
  const xmlRegex = new RegExp(TOOL_CALL_REGEX.source, 'g');
  while ((match = xmlRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name && parsed.arguments) {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments,
        });
      }
    } catch {
      console.error('[fallbackParser] Failed to parse tool call JSON:', match[1]?.slice(0, 100));
    }
  }

  if (calls.length > 0) return calls;

  // 2. Fallback: Try JSON in markdown code blocks
  const jsonRegex = new RegExp(JSON_BLOCK_REGEX.source, 'g');
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name && parsed.arguments) {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments,
        });
      }
    } catch {
      // Not a tool call JSON block — skip
    }
  }

  return calls;
}

export function extractTextBeforeToolCalls(text: string): string {
  // Find the first occurrence of either format
  const xmlIndex = text.search(/<tool_call>/);
  const jsonIndex = text.search(/```(?:json)?\s*\n?\s*\{"name"/);

  let cutoff: number;
  if (xmlIndex === -1 && jsonIndex === -1) {
    return text;
  } else if (xmlIndex === -1) {
    cutoff = jsonIndex;
  } else if (jsonIndex === -1) {
    cutoff = xmlIndex;
  } else {
    cutoff = Math.min(xmlIndex, jsonIndex);
  }

  return text.slice(0, cutoff).trim();
}

export function hasToolCalls(text: string): boolean {
  return /<tool_call>/.test(text) || /```(?:json)?\s*\n?\s*\{"name"/.test(text);
}
