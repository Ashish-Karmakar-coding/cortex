import type { LanguageModel } from 'ai';
import type { Config } from '../config/store.js';
import type { Provider } from '../config/models.js';
import { ollama } from 'ollama-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface ProviderOptions {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  numCtx?: number;
}

export function createModel(options: ProviderOptions): LanguageModel {
  switch (options.provider) {
    case 'ollama': {
      return ollama(options.model, {
        numCtx: options.numCtx ?? 16384,
      }) as LanguageModel;
    }

    case 'lmstudio': {
      const lmstudio = createOpenAICompatible({
        name: 'lmstudio',
        baseURL: options.baseUrl ?? 'http://localhost:1234/v1',
        apiKey: 'lm-studio',
      });
      return lmstudio.chatModel(options.model) as LanguageModel;
    }

    case 'openai': {
      if (!options.apiKey) {
        throw new Error('OpenAI API key is required. Set it via OPENAI_API_KEY env var or /key openai <key>');
      }
      const openai = createOpenAI({
        apiKey: options.apiKey,
        compatibility: 'strict',
      });
      return openai(options.model) as LanguageModel;
    }

    case 'anthropic': {
      if (!options.apiKey) {
        throw new Error('Anthropic API key is required. Set it via ANTHROPIC_API_KEY env var or /key anthropic <key>');
      }
      const anthropic = createAnthropic({
        apiKey: options.apiKey,
      });
      return anthropic(options.model) as LanguageModel;
    }

    case 'google': {
      if (!options.apiKey) {
        throw new Error('Google API key is required. Set it via GOOGLE_API_KEY env var or /key google <key>');
      }
      const google = createGoogleGenerativeAI({
        apiKey: options.apiKey,
      });
      return google(options.model) as LanguageModel;
    }

    case 'groq': {
      if (!options.apiKey) {
        throw new Error('Groq API key is required. Set it via GROQ_API_KEY env var or /key groq <key>');
      }
      const groq = createOpenAICompatible({
        name: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: options.apiKey,
      });
      return groq.chatModel(options.model) as LanguageModel;
    }

    case 'openrouter': {
      if (!options.apiKey) {
        throw new Error('OpenRouter API key is required. Set it via OPENROUTER_API_KEY env var or /key openrouter <key>');
      }
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: options.apiKey,
      });
      return openrouter.chatModel(options.model) as LanguageModel;
    }

    default: {
      const _exhaustive: never = options.provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}

export function createModelFromConfig(config: Config): LanguageModel {
  const provider = config.activeProvider as Provider;
  const providerConfig = config.providers[provider];

  return createModel({
    provider,
    model: config.activeModel,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
    numCtx: config.numCtx,
  });
}
