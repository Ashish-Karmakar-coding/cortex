import {
  APICallError,
  type LanguageModelV1,
  type LanguageModelV1CallOptions,
  type LanguageModelV1CallWarning,
  type LanguageModelV1FinishReason,
  type LanguageModelV1FunctionTool,
  type LanguageModelV1FunctionToolCall,
  type LanguageModelV1Prompt,
  type LanguageModelV1StreamPart,
} from '@ai-sdk/provider';
import { generateId } from '@ai-sdk/provider-utils';

export interface OllamaModelSettings {
  baseURL?: string;
  numCtx?: number;
  headers?: Record<string, string>;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{
    type: 'function';
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
  tool_name?: string;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model?: string;
  created_at?: string;
  done?: boolean;
  done_reason?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }>;
  };
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export function normalizeOllamaApiUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? 'http://localhost:11434').trim().replace(/\/+$/, '');
  if (raw.endsWith('/api')) return raw;
  if (raw.endsWith('/v1')) return `${raw.slice(0, -3)}/api`;
  return `${raw}/api`;
}

export function isToolsUnsupportedError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    const anyErr = err as { responseBody?: unknown; data?: unknown; cause?: unknown };
    if (typeof anyErr.responseBody === 'string') parts.push(anyErr.responseBody);
    if (anyErr.data) parts.push(JSON.stringify(anyErr.data));
    if (anyErr.cause instanceof Error) parts.push(anyErr.cause.message);
  } else {
    parts.push(String(err));
  }
  const combined = parts.join(' ').toLowerCase();
  return (
    combined.includes('does not support tools') ||
    combined.includes('tool use is not supported') ||
    combined.includes('tools is not supported') ||
    combined.includes('auto tool choice') ||
    combined.includes('tool calling is not supported')
  );
}

function safeParseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...schema };
  delete copy['$schema'];
  return copy;
}

function convertPrompt(prompt: LanguageModelV1Prompt): OllamaMessage[] {
  const messages: OllamaMessage[] = [];

  for (const msg of prompt) {
    if (msg.role === 'system') {
      messages.push({ role: 'system', content: msg.content });
      continue;
    }

    if (msg.role === 'user') {
      let text = '';
      const images: string[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          text += part.text;
        } else if (part.type === 'image' && part.image instanceof Uint8Array) {
          images.push(Buffer.from(part.image).toString('base64'));
        }
      }
      messages.push({
        role: 'user',
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const texts: string[] = [];
      const toolCalls: NonNullable<OllamaMessage['tool_calls']> = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          texts.push(part.text);
        } else if (part.type === 'tool-call') {
          toolCalls.push({
            type: 'function',
            function: {
              name: part.toolName,
              arguments: safeParseJsonObject(part.args),
            },
          });
        }
      }
      messages.push({
        role: 'assistant',
        content: texts.join('\n'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === 'tool') {
      for (const part of msg.content) {
        const content =
          typeof part.result === 'string'
            ? part.result
            : JSON.stringify(part.result ?? '');
        messages.push({
          role: 'tool',
          content,
          tool_name: part.toolName,
        });
      }
    }
  }

  return messages;
}

function mapFinishReason(
  doneReason: string | undefined,
  hasToolCalls: boolean
): LanguageModelV1FinishReason {
  if (hasToolCalls) return 'tool-calls';
  switch (doneReason) {
    case 'stop':
    case undefined:
      return 'stop';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}

function convertTools(
  tools?: Array<LanguageModelV1FunctionTool | { type: string }>
): { ollamaTools?: OllamaTool[]; warnings: LanguageModelV1CallWarning[] } {
  const warnings: LanguageModelV1CallWarning[] = [];
  if (!tools || tools.length === 0) {
    return { ollamaTools: undefined, warnings };
  }

  const ollamaTools: OllamaTool[] = [];
  for (const tool of tools) {
    if (tool.type !== 'function') {
      warnings.push({
        type: 'unsupported-tool',
        tool: tool as LanguageModelV1FunctionTool,
      });
      continue;
    }
    const fnTool = tool as LanguageModelV1FunctionTool;
    ollamaTools.push({
      type: 'function',
      function: {
        name: fnTool.name,
        description: fnTool.description,
        parameters: sanitizeSchema(fnTool.parameters as Record<string, unknown>),
      },
    });
  }

  return {
    ollamaTools: ollamaTools.length > 0 ? ollamaTools : undefined,
    warnings,
  };
}

function normalizeToolCall(
  raw: NonNullable<NonNullable<OllamaChatResponse['message']>['tool_calls']>[number]
): LanguageModelV1FunctionToolCall | null {
  const name = raw.function?.name;
  if (!name) return null;
  const rawArgs = raw.function?.arguments;
  const args =
    typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
  return {
    toolCallType: 'function',
    toolCallId: raw.id || generateId(),
    toolName: name,
    args,
  };
}

export class OllamaChatModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider = 'ollama';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = 'json' as const;
  readonly supportsImageUrls = false;
  private readonly apiUrl: string;
  private readonly settings: OllamaModelSettings;

  constructor(modelId: string, settings: OllamaModelSettings = {}) {
    this.modelId = modelId;
    this.settings = settings;
    this.apiUrl = normalizeOllamaApiUrl(settings.baseURL);
  }

  private buildRequestBody(options: LanguageModelV1CallOptions, stream: boolean) {
    const warnings: LanguageModelV1CallWarning[] = [];
    const messages = convertPrompt(options.prompt);
    let ollamaTools: OllamaTool[] | undefined;
    let format: unknown = undefined;

    if (options.mode.type === 'regular') {
      const converted = convertTools(options.mode.tools);
      ollamaTools = converted.ollamaTools;
      warnings.push(...converted.warnings);
      if (options.mode.toolChoice?.type === 'none') {
        ollamaTools = undefined;
      }
    } else if (options.mode.type === 'object-json') {
      format = options.mode.schema ?? 'json';
    } else if (options.mode.type === 'object-tool') {
      ollamaTools = [
        {
          type: 'function',
          function: {
            name: options.mode.tool.name,
            description: options.mode.tool.description,
            parameters: sanitizeSchema(options.mode.tool.parameters as Record<string, unknown>),
          },
        },
      ];
    }

    if (options.responseFormat?.type === 'json') {
      format = options.responseFormat.schema ?? 'json';
    }

    const modelOptions: Record<string, unknown> = {
      num_ctx: this.settings.numCtx ?? 16384,
    };
    if (options.temperature !== undefined) modelOptions['temperature'] = options.temperature;
    if (options.topP !== undefined) modelOptions['top_p'] = options.topP;
    if (options.topK !== undefined) modelOptions['top_k'] = options.topK;
    if (options.maxTokens !== undefined) modelOptions['num_predict'] = options.maxTokens;
    if (options.seed !== undefined) modelOptions['seed'] = options.seed;
    if (options.stopSequences !== undefined) modelOptions['stop'] = options.stopSequences;
    if (options.frequencyPenalty !== undefined) {
      modelOptions['frequency_penalty'] = options.frequencyPenalty;
    }
    if (options.presencePenalty !== undefined) {
      modelOptions['presence_penalty'] = options.presencePenalty;
    }

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      stream,
      options: modelOptions,
    };
    if (ollamaTools) body['tools'] = ollamaTools;
    if (format !== undefined) body['format'] = format;

    return { body, warnings };
  }

  private async postChat(
    body: Record<string, unknown>,
    options: LanguageModelV1CallOptions
  ): Promise<Response> {
    const url = `${this.apiUrl}/chat`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.settings.headers ?? {}),
    };
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (v !== undefined) headers[k] = v;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      let message = `Ollama request failed (${response.status} ${response.statusText})`;
      try {
        const parsed = JSON.parse(responseBody) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        if (responseBody) message = responseBody;
      }
      throw new APICallError({
        message,
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseBody,
        isRetryable: response.status >= 500,
      });
    }

    return response;
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    const { body, warnings } = this.buildRequestBody(options, false);
    const response = await this.postChat(body, options);
    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const toolCalls = (data.message?.tool_calls ?? [])
      .map(normalizeToolCall)
      .filter((tc): tc is LanguageModelV1FunctionToolCall => tc !== null);

    return {
      text: data.message?.content ?? undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: mapFinishReason(data.done_reason, toolCalls.length > 0),
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
      },
      rawCall: {
        rawPrompt: body['messages'],
        rawSettings: (body['options'] as Record<string, unknown>) ?? {},
      },
      rawResponse: {
        headers: Object.fromEntries(response.headers.entries()),
      },
      request: { body: JSON.stringify(body) },
      warnings,
    };
  }

  async doStream(options: LanguageModelV1CallOptions) {
    const { body, warnings } = this.buildRequestBody(options, true);
    const response = await this.postChat(body, options);

    if (!response.body) {
      throw new Error('Ollama returned an empty response stream.');
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let lineBuffer = '';
    let emittedToolCalls = false;
    let finished = false;

    const processLine = (
      line: string,
      controller: ReadableStreamDefaultController<LanguageModelV1StreamPart>
    ) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let chunk: OllamaChatResponse;
      try {
        chunk = JSON.parse(trimmed) as OllamaChatResponse;
      } catch {
        return;
      }

      if (chunk.error) {
        controller.enqueue({ type: 'error', error: new Error(chunk.error) });
        return;
      }

      const msg = chunk.message;
      if (msg) {
        if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
          controller.enqueue({ type: 'reasoning', textDelta: msg.thinking });
        }
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          controller.enqueue({ type: 'text-delta', textDelta: msg.content });
        }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          for (const rawCall of msg.tool_calls) {
            const tc = normalizeToolCall(rawCall);
            if (!tc) continue;
            emittedToolCalls = true;
            controller.enqueue({
              type: 'tool-call-delta',
              toolCallType: 'function',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              argsTextDelta: tc.args,
            });
            controller.enqueue({
              type: 'tool-call',
              ...tc,
            });
          }
        }
      }

      if (chunk.done) {
        finished = true;
        controller.enqueue({
          type: 'finish',
          finishReason: mapFinishReason(chunk.done_reason, emittedToolCalls),
          usage: {
            promptTokens: chunk.prompt_eval_count ?? 0,
            completionTokens: chunk.eval_count ?? 0,
          },
        });
      }
    };

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            if (lineBuffer.trim()) {
              processLine(lineBuffer, controller);
              lineBuffer = '';
            }
            if (!finished) {
              controller.enqueue({
                type: 'finish',
                finishReason: emittedToolCalls ? 'tool-calls' : 'stop',
                usage: { promptTokens: 0, completionTokens: 0 },
              });
            }
            controller.close();
            return;
          }

          lineBuffer += decoder.decode(value, { stream: true });
          let newlineIndex = lineBuffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = lineBuffer.slice(0, newlineIndex);
            lineBuffer = lineBuffer.slice(newlineIndex + 1);
            processLine(line, controller);
            newlineIndex = lineBuffer.indexOf('\n');
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            controller.close();
            return;
          }
          controller.enqueue({ type: 'error', error: err });
          controller.close();
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });

    return {
      stream,
      rawCall: {
        rawPrompt: body['messages'],
        rawSettings: (body['options'] as Record<string, unknown>) ?? {},
      },
      rawResponse: {
        headers: Object.fromEntries(response.headers.entries()),
      },
      request: { body: JSON.stringify(body) },
      warnings,
    };
  }
}

export function createOllamaModel(
  modelId: string,
  settings?: OllamaModelSettings
): LanguageModelV1 {
  return new OllamaChatModel(modelId, settings);
}
