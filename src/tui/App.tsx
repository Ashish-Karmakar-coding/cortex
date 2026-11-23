import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { MessageList, type DisplayMessage } from './MessageList.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ModelSelector } from './ModelSelector.js';
import { type Config, saveConfig, setApiKey } from '../config/store.js';
import { type Provider, getModelInfo } from '../config/models.js';
import { createModelFromConfig } from '../providers/factory.js';
import { runAgentLoop, type AgentState, type ApprovalDecision } from '../agent/loop.js';
import { SessionStore } from '../persistence/sessions.js';
import { compactMessages } from '../agent/compaction.js';
import type { CoreMessage } from 'ai';
import { palette } from './theme.js';

export interface AppProps {
  initialConfig: Config;
  sessionId: string;
  initialMessages?: CoreMessage[];
  autoApprove?: boolean;
}

export const App: React.FC<AppProps> = ({
  initialConfig,
  sessionId,
  initialMessages = [],
  autoApprove = false,
}) => {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config>(initialConfig);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTool, setActiveTool] = useState<{ name: string; args?: Record<string, unknown> } | undefined>();
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [ctrlCCount, setCtrlCCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Approval state
  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string;
    args: Record<string, unknown>;
    diff?: string;
    resolve: (decision: ApprovalDecision) => void;
  } | null>(null);

  // Display messages
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(() => {
    return initialMessages.map((m, i) => ({
      id: `init-${i}`,
      role: m.role as any,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  });

  // Agent State ref to persist across renders
  const sessionStoreRef = useRef(new SessionStore());
  const agentStateRef = useRef<AgentState>({
    messages: [...initialMessages],
    abortController: new AbortController(),
    isRunning: false,
    sessionApprovals: new Set(autoApprove ? ['write_file', 'edit_file', 'bash_exec'] : []),
    model: createModelFromConfig(initialConfig),
    config: initialConfig,
    modelInfo: getModelInfo(initialConfig.activeModel, initialConfig.activeProvider as Provider),
  });

  // Handle Ctrl+C
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (agentStateRef.current.isRunning || isStreaming) {
        agentStateRef.current.abortController.abort();
        agentStateRef.current.abortController = new AbortController();
        setIsStreaming(false);
        setActiveTool(undefined);
        setPendingApproval(null);
        setStatusMessage('⚠️ Execution aborted by user.');
        setCtrlCCount(0);
      } else {
        if (ctrlCCount >= 1) {
          sessionStoreRef.current.close();
          exit();
        } else {
          setCtrlCCount(1);
          setStatusMessage('Press Ctrl+C again to exit.');
          setTimeout(() => {
            setCtrlCCount(0);
            setStatusMessage(null);
          }, 2500);
        }
      }
    }
  });

  const handleSlashCommand = async (cmdText: string): Promise<boolean> => {
    const parts = cmdText.trim().split(/\s+/);
    const cmd = parts[0]!.toLowerCase();

    switch (cmd) {
      case '/help':
        setDisplayMessages((prev) => [
          ...prev,
          {
            id: `help-${Date.now()}`,
            role: 'system',
            content:
              '**Available Slash Commands:**\n' +
              '- `/model` or `/provider` — Open interactive model & provider selector\n' +
              '- `/key <provider> <api_key>` — Save API key with 0600 file permissions\n' +
              '- `/compact` — Compress conversation context to free up tokens\n' +
              '- `/sessions` — List saved SQLite sessions\n' +
              '- `/clear` — Reset conversation history\n' +
              '- `/help` — Show this guide',
          },
        ]);
        return true;

      case '/provider':
      case '/model':
        setShowModelSelector(true);
        return true;

      case '/key': {
        const prov = parts[1];
        const key = parts[2];
        if (!prov || !key) {
          setStatusMessage('Usage: /key <provider> <api_key>');
        } else {
          setApiKey(prov, key);
          const updatedConfig = { ...config };
          if (!updatedConfig.providers[prov]) {
            updatedConfig.providers[prov] = {};
          }
          updatedConfig.providers[prov]!.apiKey = key;
          setConfig(updatedConfig);
          agentStateRef.current.config = updatedConfig;
          try {
            agentStateRef.current.model = createModelFromConfig(updatedConfig);
            setStatusMessage(`✓ Key saved and model reloaded for ${prov}`);
          } catch (err) {
            setStatusMessage(`Key saved, but model init failed: ${String(err)}`);
          }
        }
        return true;
      }

      case '/compact': {
        setStatusMessage('Compacting conversation context...');
        try {
          const compacted = await compactMessages(
            agentStateRef.current.messages,
            agentStateRef.current.model
          );
          agentStateRef.current.messages = compacted;
          setDisplayMessages((prev) => [
            ...prev,
            {
              id: `compact-${Date.now()}`,
              role: 'system',
              content: `✓ Conversation compacted. ${compacted.length} messages retained.`,
            },
          ]);
          setStatusMessage('✓ Conversation successfully compacted.');
        } catch (err) {
          setStatusMessage(`Compaction failed: ${String(err)}`);
        }
        return true;
      }

      case '/sessions': {
        const sessions = sessionStoreRef.current.list();
        const content =
          sessions.length === 0
            ? 'No saved sessions found.'
            : '**Saved Sessions:**\n' +
              sessions
                .map(
                  (s, idx) =>
                    `${idx + 1}. [${s.model}] ${s.title} (${s.updatedAt})\n   ID: \`${s.id}\``
                )
                .join('\n');
        setDisplayMessages((prev) => [
          ...prev,
          { id: `sess-${Date.now()}`, role: 'system', content },
        ]);
        return true;
      }

      case '/clear':
        agentStateRef.current.messages = [];
        setDisplayMessages([]);
        setStatusMessage('Conversation context cleared.');
        return true;

      default:
        return false;
    }
  };

  const handleSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput('');
    setStatusMessage(null);

    // Slash command check
    if (trimmed.startsWith('/')) {
      const handled = await handleSlashCommand(trimmed);
      if (handled) return;
    }

    // Add user message to UI
    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;

    setDisplayMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: trimmed },
      { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true },
    ]);

    setIsStreaming(true);

    try {
      await runAgentLoop(agentStateRef.current, trimmed, {
        onStream: (chunk) => {
          setDisplayMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? { ...msg, content: msg.content + chunk }
                : msg
            )
          );
        },
        onApproval: (toolName, args, diff) => {
          return new Promise<ApprovalDecision>((resolve) => {
            setPendingApproval({
              toolName,
              args,
              diff,
              resolve: (decision) => {
                setPendingApproval(null);
                resolve(decision);
              },
            });
          });
        },
        onToolStart: (name, args) => {
          setActiveTool({ name, args });
        },
        onToolEnd: (name, result) => {
          setActiveTool(undefined);
          setDisplayMessages((prev) => [
            ...prev,
            {
              id: `tool-${Date.now()}`,
              role: 'tool',
              toolName: name,
              content: result,
              status: result.includes('Error') || result.includes('rejected') ? 'error' : 'done',
            },
          ]);
        },
      });

      // Mark streaming as complete
      setDisplayMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId ? { ...msg, isStreaming: false } : msg
        )
      );

      // Auto-save session
      sessionStoreRef.current.save({
        id: sessionId,
        title: sessionStoreRef.current.generateTitle(trimmed),
        provider: config.activeProvider,
        model: config.activeModel,
        messages: JSON.stringify(agentStateRef.current.messages),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      setDisplayMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                isStreaming: false,
                content:
                  msg.content +
                  `\n\n[Error: ${err instanceof Error ? err.message : String(err)}]`,
              }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
      setActiveTool(undefined);
    }
  };

  const handleModelChange = (newProvider: Provider, newModel: string, key?: string) => {
    setShowModelSelector(false);
    const updated = { ...config, activeProvider: newProvider, activeModel: newModel };
    if (key) {
      if (!updated.providers[newProvider]) {
        updated.providers[newProvider] = {};
      }
      updated.providers[newProvider]!.apiKey = key;
      setApiKey(newProvider, key);
    }
    setConfig(updated);
    saveConfig(updated);

    agentStateRef.current.config = updated;
    agentStateRef.current.modelInfo = getModelInfo(newModel, newProvider);

    try {
      agentStateRef.current.model = createModelFromConfig(updated);
      setStatusMessage(`✓ Active provider: ${newProvider} | Model: ${newModel}`);
    } catch (err) {
      setStatusMessage(`⚠️ Failed to load model: ${String(err)}`);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Top Header */}
      <Box
        borderStyle="round"
        borderColor={palette.fg}
        paddingX={1}
        justifyContent="space-between"
      >
        <Box>
          <Text bold color={palette.fg}>
            🤖 Cortex{' '}
          </Text>
          <Text dimColor>| </Text>
          <Text dimColor>Provider: </Text>
          <Text bold color={palette.fg}>{config.activeProvider} </Text>
          <Text dimColor>| </Text>
          <Text dimColor>Model: </Text>
          <Text bold color={palette.fg}>{config.activeModel} </Text>
          <Text dimColor>
            ({agentStateRef.current.modelInfo.contextWindow.toLocaleString()} ctx)
          </Text>
        </Box>
        <Box>
          <Text dimColor>Type /help for commands</Text>
        </Box>
      </Box>

      {/* Message List */}
      <MessageList messages={displayMessages} activeTool={activeTool} />

      {/* Tool Approval Modal */}
      {pendingApproval && (
        <ApprovalPrompt
          toolName={pendingApproval.toolName}
          args={pendingApproval.args}
          diff={pendingApproval.diff}
          onDecision={(decision, feedback) => {
            if (decision === 'reject') {
              pendingApproval.resolve({ decision: 'reject', feedback });
            } else {
              pendingApproval.resolve(decision);
            }
          }}
        />
      )}

      {/* Model & Provider Selector Modal */}
      {showModelSelector && (
        <ModelSelector
          config={config}
          onSelect={handleModelChange}
          onClose={() => setShowModelSelector(false)}
        />
      )}

      {/* Status Bar / Notifications */}
      {statusMessage && (
        <Box marginY={0} paddingX={1}>
          <Text color={palette.fg}>{statusMessage}</Text>
        </Box>
      )}

      {/* User Input Prompt (hidden when modal active) */}
      {!pendingApproval && !showModelSelector && (
        <Box borderStyle="single" borderColor={palette.fg} paddingX={1} marginTop={1}>
          <Text bold color={palette.fg}>
            cortex&gt;{' '}
          </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={
              isStreaming
                ? 'Generating response... (Ctrl+C to interrupt)'
                : 'Ask a question, describe a coding task, or use /commands'
            }
            focus={!isStreaming}
          />
        </Box>
      )}

      {/* Footer Hotkeys */}
      <Box paddingX={1} marginTop={0}>
        <Text dimColor>
          [Ctrl+C] {isStreaming ? 'Abort operation' : 'Exit (press twice)'} • [/model] Switch model • [/compact] Summarize context
        </Text>
      </Box>
    </Box>
  );
};

export default App;
