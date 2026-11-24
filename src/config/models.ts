import type { Config } from './store.js';
import type { LocalStore } from '../storage/localStore.js';

export type Provider = 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter';

export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
  contextWindow: number;
  supportsToolCalling: boolean;
}

export const CURATED_MODELS: ModelInfo[] = [
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, supportsToolCalling: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextWindow: 128000, supportsToolCalling: true },
  { id: 'o3-mini', name: 'o3-mini', provider: 'openai', contextWindow: 200000, supportsToolCalling: true },
  // Anthropic
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, supportsToolCalling: true },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', contextWindow: 200000, supportsToolCalling: true },
  // Google
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1048576, supportsToolCalling: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', contextWindow: 1048576, supportsToolCalling: true },
  // Groq
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', provider: 'groq', contextWindow: 131072, supportsToolCalling: true },
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (Groq)', provider: 'groq', contextWindow: 131072, supportsToolCalling: true },
  // OpenRouter (popular picks)
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (OpenRouter)', provider: 'openrouter', contextWindow: 200000, supportsToolCalling: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o (OpenRouter)', provider: 'openrouter', contextWindow: 128000, supportsToolCalling: true },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (OpenRouter)', provider: 'openrouter', contextWindow: 65536, supportsToolCalling: true },
];

const TOOL_CAPABLE_LOCAL_PATTERNS: RegExp[] = [
  /qwen2\.5/i,
  /qwen3/i,
  /qwq/i,
  /llama3\.[123]/i,
  /llama-3\.[123]/i,
  /mistral/i,
  /ministral/i,
  /devstral/i,
  /mixtral/i,
  /command-r/i,
  /deepseek-v3/i,
  /deepseek-r1/i,
  /granite3/i,
  /hermes/i,
  /firefunction/i,
  /nemotron/i,
  /gpt-oss/i,
  /gemma3/i,
  /phi4/i,
  /cogito/i,
  /olmo2/i,
];

export function inferLocalToolCallingSupport(modelId: string): boolean {
  return TOOL_CAPABLE_LOCAL_PATTERNS.some((pattern) => pattern.test(modelId));
}

function normalizeOllamaBase(host?: string): string {
  return (host ?? 'http://localhost:11434').trim().replace(/\/+$/, '').replace(/\/(api|v1)$/, '');
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    size: number;
    details?: {
      parameter_size?: string;
      family?: string;
    };
  }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
  template?: string;
  model_info?: Record<string, unknown>;
}

interface OpenAIModelsResponse {
  data?: Array<{
    id: string;
  }>;
}

export async function inspectOllamaModel(
  modelId: string,
  host?: string,
  store?: LocalStore
): Promise<{ supportsToolCalling: boolean; contextWindow: number; capabilities: string[] }> {
  const cached = store?.getCachedModelCapabilities('ollama', modelId);
  if (cached) {
    return {
      supportsToolCalling: cached.supportsTools,
      contextWindow: cached.contextWindow,
      capabilities: cached.capabilities,
    };
  }

  const baseUrl = normalizeOllamaBase(host);
  let supportsTools = inferLocalToolCallingSupport(modelId);
  let contextWindow = 16384;
  let capabilities: string[] = [];

  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(2500),
    });

    if (response.ok) {
      const data = (await response.json()) as OllamaShowResponse;
      if (Array.isArray(data.capabilities) && data.capabilities.length > 0) {
        capabilities = data.capabilities;
        supportsTools = data.capabilities.includes('tools');
      } else if (typeof data.template === 'string') {
        const tmpl = data.template;
        if (tmpl.includes('.Tools') || tmpl.includes('tool_call') || tmpl.includes('tools')) {
          supportsTools = true;
        }
      }

      if (data.model_info && typeof data.model_info === 'object') {
        for (const [key, value] of Object.entries(data.model_info)) {
          if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
            contextWindow = value;
            break;
          }
        }
      }

      store?.setCachedModelCapabilities({
        provider: 'ollama',
        modelId,
        supportsTools,
        contextWindow,
        capabilities,
      });
    }
  } catch {
    // Ollama unreachable or older API — rely on heuristic fallback
  }

  return {
    supportsToolCalling: supportsTools,
    contextWindow,
    capabilities,
  };
}

export async function fetchOllamaModels(host?: string): Promise<ModelInfo[]> {
  const baseUrl = normalizeOllamaBase(host);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama' as Provider,
      contextWindow: 16384,
      supportsToolCalling: inferLocalToolCallingSupport(m.name),
    }));
  } catch {
    return [];
  }
}

export async function fetchOpenAICompatibleModels(
  provider: Provider,
  baseUrl: string,
  apiKey?: string
): Promise<ModelInfo[]> {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  try {
    const response = await fetch(`${cleanBase}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as OpenAIModelsResponse;
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.id,
      provider,
      contextWindow: 16384,
      supportsToolCalling: true,
    }));
  } catch {
    return [];
  }
}

export async function listAvailableModels(provider: Provider, config: Config): Promise<ModelInfo[]> {
  switch (provider) {
    case 'ollama': {
      const host = config.providers['ollama']?.baseUrl;
      return fetchOllamaModels(host);
    }
    case 'lmstudio': {
      const baseUrl = config.providers['lmstudio']?.baseUrl ?? 'http://localhost:1234/v1';
      const apiKey = config.providers['lmstudio']?.apiKey;
      const liveModels = await fetchOpenAICompatibleModels('lmstudio', baseUrl, apiKey);
      if (liveModels.length > 0) return liveModels;
      return [
        {
          id: 'local-model',
          name: 'LM Studio Local Model',
          provider: 'lmstudio',
          contextWindow: 16384,
          supportsToolCalling: true,
        },
      ];
    }
    default:
      return CURATED_MODELS.filter((m) => m.provider === provider);
  }
}

export function getModelInfo(modelId: string, provider: Provider, numCtx?: number): ModelInfo {
  const curated = CURATED_MODELS.find((m) => m.id === modelId && m.provider === provider);
  if (curated) return curated;

  if (provider === 'ollama') {
    return {
      id: modelId,
      name: modelId,
      provider,
      contextWindow: numCtx ?? 16384,
      supportsToolCalling: inferLocalToolCallingSupport(modelId),
    };
  }

  if (provider === 'lmstudio') {
    return {
      id: modelId,
      name: modelId,
      provider,
      contextWindow: numCtx ?? 16384,
      supportsToolCalling: true,
    };
  }

  return {
    id: modelId,
    name: modelId,
    provider,
    contextWindow: numCtx ?? 16384,
    supportsToolCalling: true,
  };
}

export async function resolveModelInfo(
  modelId: string,
  provider: Provider,
  config: Config,
  store?: LocalStore
): Promise<ModelInfo> {
  const base = getModelInfo(modelId, provider, config.numCtx);
  if (provider === 'ollama') {
    const inspected = await inspectOllamaModel(modelId, config.providers['ollama']?.baseUrl, store);
    return {
      ...base,
      supportsToolCalling: inspected.supportsToolCalling,
      contextWindow: config.numCtx ? Math.min(config.numCtx, inspected.contextWindow) : inspected.contextWindow,
    };
  }
  return base;
}
