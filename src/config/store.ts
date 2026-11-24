import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

export interface Config {
  activeProvider: string;
  activeModel: string;
  numCtx: number;
  storageDir?: string;
  providers: Record<string, ProviderConfig>;
  permissions?: PermissionConfig;
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
  if (override && override.trim()) {
    return resolve(override.trim());
  }
  return join(homedir(), '.cortex');
}

export function getStorageDir(config?: Config): string {
  const envOverride = process.env['CORTEX_STORAGE_DIR'];
  if (envOverride && envOverride.trim()) {
    return resolve(envOverride.trim());
  }
  if (config?.storageDir && config.storageDir.trim()) {
    return resolve(config.storageDir.trim());
  }
  // If config wasn't passed, read config.json silently if present so callers
  // (like SessionStore) respect a configured custom storageDir.
  if (!config) {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<Config>;
        if (parsed.storageDir && parsed.storageDir.trim()) {
          return resolve(parsed.storageDir.trim());
        }
      } catch {
        // Fall back to default path
      }
    }
  }
  return join(getConfigDir(), 'storage');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export function createDefaultConfig(customStorageDir?: string): Config {
  return {
    activeProvider: 'ollama',
    activeModel: 'qwen2.5-coder:14b',
    numCtx: 16384,
    storageDir: customStorageDir ? resolve(customStorageDir) : join(getConfigDir(), 'storage'),
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
    permissions: {
      allow: [],
      deny: [],
    },
  };
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  const defaults = createDefaultConfig();

  let config: Config;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Config>;
      config = {
        ...defaults,
        ...parsed,
        providers: {
          ...defaults.providers,
          ...(parsed.providers ?? {}),
        },
        permissions: {
          allow: parsed.permissions?.allow ?? [],
          deny: parsed.permissions?.deny ?? [],
        },
      };
    } catch {
      config = defaults;
    }
  } else {
    config = defaults;
    saveConfig(config);
  }

  // Apply env var overrides (env vars always override saved keys/hosts).
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

  const storageOverride = process.env['CORTEX_STORAGE_DIR'];
  if (storageOverride && storageOverride.trim()) {
    config.storageDir = resolve(storageOverride.trim());
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
  const envVar = ENV_KEY_MAP[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  const config = loadConfig();
  return config.providers[provider]?.apiKey;
}

export function setApiKey(provider: string, apiKey: string): void {
  const config = loadConfig();
  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
  config.providers[provider]!.apiKey = apiKey;
  saveConfig(config);
}
