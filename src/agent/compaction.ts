import type { LanguageModel, CoreMessage } from 'ai';
import { generateText } from 'ai';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: CoreMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          total += estimateTokens(part.text);
        } else if (part.type === 'tool-call') {
          total += estimateTokens(part.toolName + JSON.stringify(part.args ?? {}));
        } else if (part.type === 'tool-result') {
          const val = typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? '');
          total += estimateTokens(part.toolName + val);
        }
      }
    }
  }
  return total;
}

export function shouldCompact(messages: CoreMessage[], contextLimit: number): boolean {
  const estimated = estimateMessagesTokens(messages);
  return estimated > contextLimit * 0.75;
}

export async function compactMessages(
  messages: CoreMessage[],
  model: LanguageModel
): Promise<CoreMessage[]> {
  if (messages.length <= 4) return messages;

  const keepCount = Math.max(Math.ceil(messages.length * 0.4), 2);
  const oldMessages = messages.slice(0, messages.length - keepCount);
  const recentMessages = messages.slice(messages.length - keepCount);

  const oldContent = oldMessages
    .map((msg) => {
      const role = msg.role;
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
      return `[${role}]: ${content.slice(0, 500)}`;
    })
    .join('\n\n');

  try {
    const result = await generateText({
      model,
      system:
        'You are a conversation summarizer. Create a dense technical summary of the conversation history below. Preserve: file paths, function names, error messages, decisions made, and pending tasks. Be concise but complete.',
      prompt: `Summarize the following conversation history:\n\n${oldContent}`,
      maxTokens: 1000,
    });

    const summaryMessage: CoreMessage = {
      role: 'assistant',
      content: `[Conversation Summary]\n${result.text}\n\n[End of summary — recent messages follow]`,
    };

    return [summaryMessage, ...recentMessages];
  } catch (err) {
    console.error('[compaction] Failed to summarize, dropping old messages:', err);
    const fallbackMessage: CoreMessage = {
      role: 'assistant',
      content:
        '[Context was compacted. Older conversation history is no longer available. Recent messages follow.]',
    };
    return [fallbackMessage, ...recentMessages];
  }
}
