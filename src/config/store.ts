import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface Config {
  activeProvider: string;
  activeModel: string;
  numCtx: number;
  providers: Record<string, ProviderConfig>;
}

const ENV_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const ENV_HOST_MAP: Record<string, string> = {
  ollama: 'OLLAMA_HOST',
};

export function getConfigDir(): string {
  // CORTEX_HOME lets users (and the installer) relocate both config and data.
  const override = process.env['CORTEX_HOME'];
  if (override) {
    return override;
  }
  return join(homedir(), '.cortex');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

function createDefaultConfig(): Config {
  return {
    activeProvider: 'ollama',
    activeModel: 'llama3.2',
    numCtx: 16384,
    providers: {
      ollama: {
        baseUrl: 'http://localhost:11434',
      },
      lmstudio: {
        baseUrl: 'http://localhost:1234/v1',
      },
      openai: {},
      anthropic: {},
      google: {},
      groq: {},
      openrouter: {},
    },
  };
}

export function loadConfig(): Config {
  const configPath = getConfigPath();

  let config: Config;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as Config;
    } catch {
      config = createDefaultConfig();
    }
  } else {
    config = createDefaultConfig();
    saveConfig(config);
  }

  // Apply env var overrides
  for (const [provider, envVar] of Object.entries(ENV_KEY_MAP)) {
    const envValue = process.env[envVar];
    if (envValue) {
      if (!config.providers[provider]) {
        config.providers[provider] = {};
      }
      config.providers[provider]!.apiKey = envValue;
    }
  }

  for (const [provider, envVar] of Object.entries(ENV_HOST_MAP)) {
    const envValue = process.env[envVar];
    if (envValue) {
      if (!config.providers[provider]) {
        config.providers[provider] = {};
      }
      config.providers[provider]!.baseUrl = envValue;
    }
  }

  return config;
}

export function saveConfig(config: Config): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Set restrictive permissions (not effective on Windows, but good practice)
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // chmod may fail on Windows — that's acceptable
  }
}

export function getApiKey(provider: string): string | undefined {
  const config = loadConfig();
  const providerConfig = config.providers[provider];

  // Check config first
  if (providerConfig?.apiKey) {
    return providerConfig.apiKey;
  }

  // Then check env vars
  const envVar = ENV_KEY_MAP[provider];
  if (envVar) {
    return process.env[envVar];
  }

  return undefined;
}

export function setApiKey(provider: string, apiKey: string): void {
  const config = loadConfig();
  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
  config.providers[provider]!.apiKey = apiKey;
  saveConfig(config);
}
