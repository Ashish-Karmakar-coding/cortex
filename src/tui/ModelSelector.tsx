import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { type Provider, listAvailableModels, type ModelInfo } from '../config/models.js';
import type { Config } from '../config/store.js';
import { palette, ThemedIndicator, ThemedItem } from './theme.js';

export interface ModelSelectorProps {
  config: Config;
  onSelect: (provider: Provider, model: string, apiKey?: string) => void;
  onClose: () => void;
}

type Step = 'provider' | 'key' | 'model' | 'custom_model';

interface ProviderItem {
  label: string;
  value: Provider;
}

const PROVIDERS: ProviderItem[] = [
  { label: 'Ollama (Local - http://localhost:11434)', value: 'ollama' },
  { label: 'LM Studio (Local - http://localhost:1234/v1)', value: 'lmstudio' },
  { label: 'Anthropic (Claude 3.5 Sonnet / Haiku)', value: 'anthropic' },
  { label: 'OpenAI (GPT-4o / o3-mini)', value: 'openai' },
  { label: 'Google Gemini (Gemini 2.5 Flash / Pro)', value: 'google' },
  { label: 'Groq (Llama 3.3 70B Fast Inference)', value: 'groq' },
  { label: 'OpenRouter (Multi-model Gateway)', value: 'openrouter' },
];

export const ModelSelector: React.FC<ModelSelectorProps> = ({ config, onSelect, onClose }) => {
  const [step, setStep] = useState<Step>('provider');
  const [selectedProvider, setSelectedProvider] = useState<Provider>(config.activeProvider as Provider);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
    }
  });

  const handleProviderSelect = async (item: ProviderItem) => {
    const prov = item.value;
    setSelectedProvider(prov);

    // If cloud provider and no API key is configured or in env
    const existingKey = config.providers[prov]?.apiKey;
    const isCloud = prov !== 'ollama' && prov !== 'lmstudio';

    if (isCloud && !existingKey) {
      setStep('key');
      return;
    }

    // Otherwise proceed to model selection
    await loadModelsForProvider(prov);
    setStep('model');
  };

  const loadModelsForProvider = async (prov: Provider) => {
    setLoadingModels(true);
    try {
      const fetched = await listAvailableModels(prov, config);
      setModels(fetched);
    } catch {
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleKeySubmit = async (keyInput: string) => {
    const trimmed = keyInput.trim();
    if (trimmed) {
      setApiKey(trimmed);
    }
    await loadModelsForProvider(selectedProvider);
    setStep('model');
  };

  const handleModelSelect = (item: { label: string; value: string }) => {
    if (item.value === '__custom__') {
      setStep('custom_model');
      return;
    }
    onSelect(selectedProvider, item.value, apiKey || undefined);
  };

  const handleCustomModelSubmit = (val: string) => {
    const trimmed = val.trim();
    if (trimmed) {
      onSelect(selectedProvider, trimmed, apiKey || undefined);
    }
  };

  const modelItems = [
    ...models.map((m) => ({
      label: `${m.name} (${m.id}) [${m.contextWindow.toLocaleString()} tokens]`,
      value: m.id,
    })),
    { label: '✏️ Enter custom model ID...', value: '__custom__' },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.fg}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Box marginBottom={1}>
        <Text bold color={palette.fg}>
          ⚙️ Model & Provider Configuration
        </Text>
        <Text dimColor> (Press Esc to cancel)</Text>
      </Box>

      {step === 'provider' && (
        <Box flexDirection="column">
          <Text bold color={palette.fg}>
            Select LLM Provider:
          </Text>
          <SelectInput
            items={PROVIDERS}
            onSelect={handleProviderSelect}
            indicatorComponent={ThemedIndicator}
            itemComponent={ThemedItem}
          />
        </Box>
      )}

      {step === 'key' && (
        <Box flexDirection="column">
          <Text bold color={palette.fg}>
            Enter API key for {selectedProvider}:
          </Text>
          <Text dimColor>Keys are stored securely with 0600 file permissions.</Text>
          <Box marginTop={1}>
            <Text color={palette.fg}>&gt; </Text>
            <TextInput
              value={apiKey}
              onChange={setApiKey}
              onSubmit={handleKeySubmit}
              placeholder="Paste API key here (or leave blank if using env var)"
              mask="*"
            />
          </Box>
        </Box>
      )}

      {step === 'model' && (
        <Box flexDirection="column">
          <Text bold color={palette.fg}>
            Select Model for {selectedProvider}:
          </Text>
          {loadingModels ? (
            <Text color={palette.muted}>Loading available models...</Text>
          ) : (
            <SelectInput
              items={modelItems}
              onSelect={handleModelSelect}
              indicatorComponent={ThemedIndicator}
              itemComponent={ThemedItem}
            />
          )}
        </Box>
      )}

      {step === 'custom_model' && (
        <Box flexDirection="column">
          <Text bold color={palette.fg}>
            Enter Custom Model ID for {selectedProvider}:
          </Text>
          <Box marginTop={1}>
            <Text color={palette.fg}>&gt; </Text>
            <TextInput
              value={customModelInput}
              onChange={setCustomModelInput}
              onSubmit={handleCustomModelSubmit}
              placeholder="e.g. qwen2.5-coder:14b or gpt-4o-2024-11-20"
            />
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default ModelSelector;
