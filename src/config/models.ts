import type { Config } from './store.js';

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

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    details?: {
      parameter_size?: string;
      family?: string;
    };
  }>;
}

export async function fetchOllamaModels(host?: string): Promise<ModelInfo[]> {
  const baseUrl = host ?? 'http://localhost:11434';
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    return data.models.map((m) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama' as Provider,
      contextWindow: 16384, // Conservative default; actual depends on model config
      supportsToolCalling: false, // Assume false; use XML fallback for safety
    }));
  } catch {
    // Ollama not running or unreachable
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
      // LM Studio uses OpenAI-compatible API; models vary by user installation
      return [
        {
          id: 'local-model',
          name: 'LM Studio Local Model',
          provider: 'lmstudio',
          contextWindow: 16384,
          supportsToolCalling: false,
        },
      ];
    }
    default:
      return CURATED_MODELS.filter((m) => m.provider === provider);
  }
}

export function getModelInfo(modelId: string, provider: Provider): ModelInfo {
  // Check curated models first
  const curated = CURATED_MODELS.find((m) => m.id === modelId && m.provider === provider);
  if (curated) return curated;

  // Default for unknown models (local models, custom model IDs)
  return {
    id: modelId,
    name: modelId,
    provider,
    contextWindow: 16384,
    supportsToolCalling: provider !== 'ollama' && provider !== 'lmstudio',
  };
}
