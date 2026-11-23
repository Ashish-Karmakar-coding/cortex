import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreMessage } from 'ai';
import { MessageItem, MessageList, type DisplayMessage } from './MessageList.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ModelSelector } from './ModelSelector.js';
import { PromptInput } from './PromptInput.js';
import { SessionSelector, type SessionSummary } from './SessionSelector.js';
import { SubagentPanel, type SubagentRun } from './SubagentPanel.js';
import { findSlashCommand, formatCommandHelp } from './commands.js';
import { palette } from './theme.js';
import { type Config, saveConfig, setApiKey, getConfigDir } from '../config/store.js';
import { type Provider, getModelInfo, listAvailableModels } from '../config/models.js';
import { createModelFromConfig } from '../providers/factory.js';
import { runAgentLoop, type AgentState, type ApprovalDecision } from '../agent/loop.js';
import { loadSubagents, type SubagentEvent } from '../agent/subagents.js';
import { SessionStore } from '../persistence/sessions.js';
import { compactMessages } from '../agent/compaction.js';
import { initProjectFile } from '../agent/init.js';
import { VERSION } from '../version.js';

export interface AppProps {
  initialConfig: Config;
  sessionId: string;
  initialMessages?: CoreMessage[];
  autoApprove?: boolean;
}

const CONFIRM_TOOLS = ['write_file', 'edit_file', 'bash_exec', 'task'];

function createWelcomeMessage(): DisplayMessage {
  return {
    id: 'welcome',
    role: 'system',
    variant: 'welcome',
    content: [
      '  ✻ Welcome to Cortex!',
      '',
      '  /help for commands · /model to pick a model · /resume a session',
      `  cwd: ${process.cwd()}`,
    ].join('\n'),
  };
}

function messageText(content: CoreMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n');
}

function mapCoreMessages(messages: CoreMessage[]): DisplayMessage[] {
  const output: DisplayMessage[] = [];
  messages.forEach((message, index) => {
    const id = `history-${index}`;

    if (message.role === 'user') {
      const text = messageText(message.content);
      if (!text.trim()) return;
      // Skip synthetic fallback tool-result messages in resumed transcripts.
      if (/^Tool (result|error) for "/.test(text)) return;
      output.push({ id, role: 'user', content: text });
      return;
    }

    if (message.role === 'assistant') {
      const text = messageText(message.content);
      if (text.trim()) {
        output.push({ id, role: 'assistant', content: text });
      }
      return;
    }

    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const raw = typeof part.result === 'string' ? part.result : JSON.stringify(part.result);
        output.push({
          id: `${id}-${part.toolCallId}`,
          role: 'tool',
          toolName: part.toolName,
          content: raw.slice(0, 300),
          status: /^(tool )?error/i.test(raw) ? 'error' : 'done',
        });
      }
    }
  });
  return output;
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export const App: React.FC<AppProps> = ({
  initialConfig,
  sessionId: initialSessionId,
  initialMessages = [],
  autoApprove = false,
}) => {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config>(initialConfig);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTool, setActiveTool] = useState<
    { name: string; args?: Record<string, unknown> } | undefined
  >();
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [sessionOptions, setSessionOptions] = useState<SessionSummary[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [autoApproveMode, setAutoApproveMode] = useState(autoApprove);
  const [queuedCount, setQueuedCount] = useState(0);
  const [subagentRuns, setSubagentRuns] = useState<SubagentRun[]>([]);

  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string;
    args: Record<string, unknown>;
    diff?: string;
    resolve: (decision: ApprovalDecision) => void;
  } | null>(null);

  // `Static` output is printed once and never repainted, so completed turns
  // live here and are only appended to. The current turn stays in `liveMessages`.
  const [staticMessages, setStaticMessages] = useState<DisplayMessage[]>(() => [
    createWelcomeMessage(),
    ...mapCoreMessages(initialMessages),
  ]);
  const [liveMessages, setLiveMessages] = useState<DisplayMessage[]>([]);
  // Remounts <Static> after /clear or /resume so new history is printed.
  const [staticEpoch, setStaticEpoch] = useState(0);

  const sessionStoreRef = useRef(new SessionStore());
  const sessionClosedRef = useRef(false);
  const busyRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const ctrlCCountRef = useRef(0);
  const liveMessagesRef = useRef<DisplayMessage[]>([]);
  const pendingApprovalRef = useRef(pendingApproval);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subagentSeqRef = useRef(0);
  const subagentIdsRef = useRef<Record<string, string>>({});
  const subagentTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const agentStateRef = useRef<AgentState>({
    messages: [...initialMessages],
    abortController: new AbortController(),
    isRunning: false,
    sessionApprovals: new Set(autoApprove ? CONFIRM_TOOLS : []),
    model: createModelFromConfig(initialConfig),
    config: initialConfig,
    modelInfo: getModelInfo(initialConfig.activeModel, initialConfig.activeProvider as Provider),
  });

  pendingApprovalRef.current = pendingApproval;

  /**
   * State wrapper that keeps the ref in sync synchronously. Stream flushing and
   * turn finalization need the latest value without waiting for a re-render.
   */
  const setLive = (next: React.SetStateAction<DisplayMessage[]>) => {
    const previous = liveMessagesRef.current;
    const value = typeof next === 'function' ? next(previous) : next;
    liveMessagesRef.current = value;
    setLiveMessages(value);
  };

  const flashStatus = (message: string, timeoutMs = 4000) => {
    setStatusMessage(message);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      statusTimerRef.current = null;
      setStatusMessage(null);
    }, timeoutMs);
  };

  const addSystemMessage = (
    content: string,
    variant: 'info' | 'error' = 'info'
  ) => {
    const message: DisplayMessage = {
      id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'system',
      variant,
      content,
    };
    if (busyRef.current) {
      setLive((prev) => [...prev, message]);
    } else {
      setStaticMessages((prev) => [...prev, message]);
    }
  };

  const closeStore = () => {
    if (sessionClosedRef.current) return;
    sessionClosedRef.current = true;
    try {
      sessionStoreRef.current.close();
    } catch {
      // Already closed.
    }
  };

  useEffect(() => {
    const approvals = agentStateRef.current.sessionApprovals;
    for (const tool of CONFIRM_TOOLS) {
      if (autoApproveMode) approvals.add(tool);
      else approvals.delete(tool);
    }
  }, [autoApproveMode]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      for (const timer of subagentTimersRef.current) clearTimeout(timer);
      closeStore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global shortcuts: Ctrl+C to interrupt/exit, Shift+Tab to toggle auto-approve.
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (busyRef.current || agentStateRef.current.isRunning) {
        const pending = pendingApprovalRef.current;
        if (pending) {
          pending.resolve({ decision: 'reject', feedback: 'Interrupted by user' });
          setPendingApproval(null);
        }
        agentStateRef.current.abortController.abort();
        agentStateRef.current.abortController = new AbortController();
        queueRef.current = [];
        setQueuedCount(0);
        setActiveTool(undefined);
        ctrlCCountRef.current = 0;
        flashStatus('Interrupting…');
      } else if (ctrlCCountRef.current >= 1) {
        closeStore();
        exit();
      } else {
        ctrlCCountRef.current = 1;
        flashStatus('Press Ctrl+C again to exit.', 2500);
        setTimeout(() => {
          ctrlCCountRef.current = 0;
        }, 2500);
      }
      return;
    }

    if (key.tab && key.shift) {
      setAutoApproveMode((current) => {
        const next = !current;
        flashStatus(next ? 'Auto-approve enabled.' : 'Auto-approve disabled.');
        return next;
      });
    }
  });

  const resumeSession = (id: string) => {
    const record = sessionStoreRef.current.load(id);
    if (!record) {
      setShowSessionSelector(false);
      addSystemMessage(`Session not found: ${id}`, 'error');
      return;
    }

    let messages: CoreMessage[] = [];
    try {
      messages = JSON.parse(record.messages) as CoreMessage[];
    } catch {
      addSystemMessage('That session is corrupted and could not be loaded.', 'error');
      return;
    }

    agentStateRef.current.messages = messages;
    agentStateRef.current.abortController = new AbortController();
    setSessionId(record.id);
    setStaticMessages([createWelcomeMessage(), ...mapCoreMessages(messages)]);
    setStaticEpoch((epoch) => epoch + 1);
    setLive([]);
    setShowSessionSelector(false);

    if (record.provider && record.model) {
      const updated: Config = {
        ...config,
        activeProvider: record.provider,
        activeModel: record.model,
      };
      try {
        const model = createModelFromConfig(updated);
        setConfig(updated);
        saveConfig(updated);
        agentStateRef.current.config = updated;
        agentStateRef.current.model = model;
        agentStateRef.current.modelInfo = getModelInfo(
          record.model,
          record.provider as Provider
        );
      } catch {
        // Keep the current model if the saved one is not usable anymore.
      }
    }

    flashStatus(`Resumed: ${record.title}`);
  };

  const exportConversation = (): string => {
    const filePath = join(process.cwd(), `cortex-export-${formatTimestamp()}.md`);
    const lines: string[] = [
      '# Cortex conversation',
      '',
      `- Exported: ${new Date().toISOString()}`,
      `- Provider: ${config.activeProvider}`,
      `- Model: ${config.activeModel}`,
      `- Session: ${sessionId}`,
      '',
    ];

    for (const message of [...staticMessages, ...liveMessages]) {
      if (message.role === 'user') {
        lines.push('## You', '', message.content, '');
      } else if (message.role === 'assistant') {
        lines.push('## Cortex', '', message.content, '');
      } else if (message.role === 'tool') {
        lines.push(`> Tool ${message.toolName ?? ''}: ${message.content}`, '');
      }
    }

    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  };

  const runDiagnostics = async (): Promise<string[]> => {
    const lines: string[] = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const nodeMinor = Number(process.versions.node.split('.')[1]);
    const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);
    lines.push(`${nodeOk ? '✓' : '✗'} Node.js ${process.versions.node} (need >= 22.13 for SQLite)`);

    const configDir = getConfigDir();
    lines.push(`${existsSync(configDir) ? '✓' : '✗'} Config directory: ${configDir}`);

    try {
      sessionStoreRef.current.list();
      lines.push('✓ Session database readable');
    } catch (err) {
      lines.push(`✗ Session database: ${String(err)}`);
    }

    const provider = config.activeProvider as Provider;
    if (provider === 'ollama' || provider === 'lmstudio') {
      const baseUrl =
        config.providers[provider]?.baseUrl ??
        (provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1');
      const url = provider === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/models`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        lines.push(
          `${response.ok ? '✓' : '✗'} ${provider} reachable at ${baseUrl}${
            response.ok ? '' : ` (HTTP ${response.status})`
          }`
        );
      } catch {
        lines.push(`✗ ${provider} not reachable at ${baseUrl}`);
      }
    } else {
      const key =
        config.providers[provider]?.apiKey ??
        process.env[
          `${provider.toUpperCase()}_API_KEY`
        ];
      lines.push(`${key ? '✓' : '✗'} ${provider} API key ${key ? 'configured' : 'missing'}`);
    }

    try {
      const models = await listAvailableModels(provider, config);
      lines.push(
        `${models.length > 0 ? '✓' : '✗'} ${models.length} model(s) available for ${provider}`
      );
    } catch {
      lines.push(`✗ Could not list models for ${provider}`);
    }

    return lines;
  };

  const handleSlashCommand = async (commandText: string): Promise<void> => {
    const parts = commandText.trim().split(/\s+/);
    const found = findSlashCommand(commandText);
    const command = found ? `/${found.name}` : parts[0]!.toLowerCase();

    // Commands that change agent state wait for the current turn to finish.
    if (busyRef.current && command !== '/help' && command !== '/status') {
      queueRef.current.push(commandText.trim());
      setQueuedCount(queueRef.current.length);
      flashStatus(`Queued command (${queueRef.current.length})`);
      return;
    }

    switch (command) {
      case '/help': {
        const shortcuts = [
          'Keyboard shortcuts:',
          '  Enter            Send the prompt',
          '  \\ + Enter        Insert a new line',
          '  ↑ / ↓            Prompt history (or palette navigation)',
          '  Tab              Complete a slash command',
          '  Shift+Tab        Toggle auto-approve',
          '  Ctrl+C           Interrupt, or press twice to exit',
        ].join('\n');
        addSystemMessage(`Slash commands:\n${formatCommandHelp()}\n\n${shortcuts}`);
        return;
      }

      case '/model':
      case '/provider':
        setShowModelSelector(true);
        return;

      case '/key': {
        const provider = parts[1];
        const apiKey = parts[2];
        if (!provider || !apiKey) {
          addSystemMessage('Usage: /key <provider> <api_key>', 'error');
          return;
        }
        setApiKey(provider, apiKey);
        const updated: Config = { ...config };
        if (!updated.providers[provider]) updated.providers[provider] = {};
        updated.providers[provider]!.apiKey = apiKey;
        setConfig(updated);
        agentStateRef.current.config = updated;
        try {
          agentStateRef.current.model = createModelFromConfig(updated);
          flashStatus(`Key saved for ${provider}.`);
        } catch (err) {
          addSystemMessage(`Key saved, but the model could not load: ${String(err)}`, 'error');
        }
        return;
      }

      case '/compact': {
        flashStatus('Compacting conversation…', 60_000);
        try {
          const compacted = await compactMessages(
            agentStateRef.current.messages,
            agentStateRef.current.model
          );
          agentStateRef.current.messages = compacted;
          addSystemMessage(`Conversation compacted. ${compacted.length} messages retained.`);
          flashStatus('Context compacted.');
        } catch (err) {
          addSystemMessage(`Compaction failed: ${String(err)}`, 'error');
          setStatusMessage(null);
        }
        return;
      }

      case '/sessions': {
        const sessions = sessionStoreRef.current.list();
        if (sessions.length === 0) {
          addSystemMessage('No saved sessions yet.');
          return;
        }
        const rows = sessions
          .map(
            (session, index) =>
              `${index + 1}. ${session.title} · ${session.model} · ${session.updatedAt.slice(
                0,
                19
              )}\n   /resume ${session.id}`
          )
          .join('\n');
        addSystemMessage(`Saved sessions:\n${rows}`);
        return;
      }

      case '/resume': {
        if (parts[1]) {
          resumeSession(parts[1]);
          return;
        }
        const sessions = sessionStoreRef.current.list();
        if (sessions.length === 0) {
          addSystemMessage('No saved sessions yet.');
          return;
        }
        setSessionOptions(sessions);
        setShowSessionSelector(true);
        return;
      }

      case '/new':
      case '/clear': {
        agentStateRef.current.messages = [];
        agentStateRef.current.abortController = new AbortController();
        setSessionId(sessionStoreRef.current.generateId());
        setStaticMessages([createWelcomeMessage()]);
        setStaticEpoch((epoch) => epoch + 1);
        setLive([]);
        flashStatus('Started a new conversation.');
        return;
      }

      case '/init': {
        try {
          const result = initProjectFile();
          addSystemMessage(
            result.created
              ? `Created ${result.path}. Cortex will load it into the system prompt.`
              : `${result.path} already exists — edit it to describe this project.`
          );
        } catch (err) {
          addSystemMessage(`Could not create CORTEX.md: ${String(err)}`, 'error');
        }
        return;
      }

      case '/agents': {
        const agents = loadSubagents();
        const rows = agents
          .map((agent) => {
            const source = agent.source === 'builtin' ? '' : ` · ${agent.source}`;
            return `  ${agent.name}${source}\n    ${agent.description}\n    tools: ${agent.tools.join(', ')}`;
          })
          .join('\n');
        addSystemMessage(
          `Subagents:\n${rows}\n\nAdd custom agents as Markdown files in .cortex/agents/<name>.md\nor ${join(getConfigDir(), 'agents')}. Frontmatter: name, description, tools.`
        );
        return;
      }

      case '/status': {
        const state = agentStateRef.current;
        addSystemMessage(
          [
            `Cortex ${VERSION}`,
            `Provider:     ${config.activeProvider}`,
            `Model:        ${config.activeModel}`,
            `Context:      ${state.modelInfo.contextWindow.toLocaleString()} tokens`,
            `Messages:     ${state.messages.length}`,
            `Session:      ${sessionId}`,
            `Auto-approve: ${autoApproveMode ? 'on' : 'off'}`,
            `Config:       ${getConfigDir()}`,
            `cwd:          ${process.cwd()}`,
          ].join('\n')
        );
        return;
      }

      case '/doctor': {
        flashStatus('Running diagnostics…', 30_000);
        const lines = await runDiagnostics();
        setStatusMessage(null);
        addSystemMessage(`Diagnostics:\n${lines.join('\n')}`);
        return;
      }

      case '/export': {
        try {
          const filePath = exportConversation();
          addSystemMessage(`Exported to ${filePath}`);
        } catch (err) {
          addSystemMessage(`Export failed: ${String(err)}`, 'error');
        }
        return;
      }

      case '/auto':
        setAutoApproveMode((current) => !current);
        return;

      case '/quit':
      case '/exit':
        closeStore();
        exit();
        return;

      default:
        addSystemMessage(
          `Unknown command: ${parts[0]}. Type /help to see all commands.`,
          'error'
        );
    }
  };

  const handleSubagentEvent = (event: SubagentEvent) => {
    if (event.type === 'start') {
      subagentSeqRef.current += 1;
      const id = `subagent-${Date.now()}-${subagentSeqRef.current}`;
      subagentIdsRef.current[event.name] = id;
      setSubagentRuns((prev) => [
        ...prev,
        {
          id,
          name: event.name,
          description: event.description,
          status: 'running',
        },
      ]);
      return;
    }

    const id = subagentIdsRef.current[event.name];
    if (!id) return;

    if (event.type === 'text' || event.type === 'tool') {
      const activity =
        event.type === 'tool'
          ? `${event.tool} ${event.detail}`.trim()
          : (event.chunk.split('\n').filter((line) => line.trim()).pop() ?? '')
              .trim()
              .slice(0, 90);
      if (!activity) return;
      setSubagentRuns((prev) =>
        prev.map((run) => (run.id === id ? { ...run, activity } : run))
      );
      return;
    }

    setSubagentRuns((prev) =>
      prev.map((run) =>
        run.id === id
          ? {
              ...run,
              status: event.type === 'done' ? 'done' : 'error',
              activity:
                event.type === 'done'
                  ? 'finished'
                  : event.error.length > 90
                    ? `${event.error.slice(0, 87)}...`
                    : event.error,
            }
          : run
      )
    );
    delete subagentIdsRef.current[event.name];

    // Keep the result visible for a moment, then return the space to the chat.
    const timer = setTimeout(() => {
      setSubagentRuns((prev) => prev.filter((run) => run.id !== id));
    }, 5000);
    subagentTimersRef.current.push(timer);
  };

  const finalizeLiveTurn = () => {
    const finished = liveMessagesRef.current;
    if (finished.length === 0) return;
    const completed = finished.map((message) =>
      message.isStreaming ? { ...message, isStreaming: false } : message
    );
    liveMessagesRef.current = [];
    setLiveMessages([]);
    // Printing the finished turn once keeps the dynamic area small and lets
    // Ink cache the output instead of repainting the whole answer every frame.
    setStaticMessages((prev) => [...prev, ...completed]);
  };

  const executeTurn = async (text: string) => {
    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;
    setLive([
      { id: userMsgId, role: 'user', content: text },
      { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true },
    ]);
    setIsStreaming(true);
    setStatusMessage(null);

    // Batch stream chunks so the UI repaints at most ~20x per second.
    let buffer = '';
    let currentAssistantId = assistantMsgId;
    let needsNewAssistant = false;
    const flushStream = () => {
      if (!buffer) return;
      const chunk = buffer;
      buffer = '';

      // After a tool call, start a fresh assistant message so text and tool
      // activity stay in chronological order.
      if (needsNewAssistant) {
        const previousId = currentAssistantId;
        const nextId = `assistant-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        currentAssistantId = nextId;
        needsNewAssistant = false;
        setLive((prev) => [
          ...prev.map((message) =>
            message.id === previousId ? { ...message, isStreaming: false } : message
          ),
          {
            id: nextId,
            role: 'assistant',
            content: chunk.replace(/^\s+/, ''),
            isStreaming: true,
          },
        ]);
        return;
      }

      setLive((prev) =>
        prev.map((message) =>
          message.id === currentAssistantId
            ? { ...message, content: message.content + chunk }
            : message
        )
      );
    };
    const streamTimer = setInterval(flushStream, 50);

    try {
      await runAgentLoop(agentStateRef.current, text, {
        onStream: (chunk) => {
          buffer += chunk;
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
        onSubagentEvent: handleSubagentEvent,
        onToolEnd: (name, result) => {
          flushStream();
          needsNewAssistant = true;
          setActiveTool(undefined);
          const status =
            /^(tool )?error/i.test(result) || result.includes('rejected')
              ? 'error'
              : 'done';
          setLive((prev) => [
            ...prev,
            {
              id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: 'tool',
              toolName: name,
              content: result,
              status,
            },
          ]);
        },
      });

      const now = new Date().toISOString();
      sessionStoreRef.current.save({
        id: sessionId,
        title: sessionStoreRef.current.generateTitle(text),
        provider: agentStateRef.current.config.activeProvider,
        model: agentStateRef.current.config.activeModel,
        messages: JSON.stringify(agentStateRef.current.messages),
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      const errorText = `\n\n[Error: ${
        err instanceof Error ? err.message : String(err)
      }]`;
      setLive((prev) => {
        if (needsNewAssistant) {
          return [
            ...prev,
            {
              id: `assistant-${Date.now()}-error`,
              role: 'assistant' as const,
              content: errorText,
            },
          ];
        }
        return prev.map((message) =>
          message.id === currentAssistantId
            ? { ...message, content: `${message.content}${errorText}` }
            : message
        );
      });
    } finally {
      clearInterval(streamTimer);
      flushStream();
      setLive((prev) =>
        prev.map((message) =>
          message.role === 'assistant' ? { ...message, isStreaming: false } : message
        )
      );
      setIsStreaming(false);
      setActiveTool(undefined);
      finalizeLiveTurn();
    }
  };

  const runPrompt = async (text: string) => {
    if (busyRef.current) {
      queueRef.current.push(text);
      setQueuedCount(queueRef.current.length);
      flashStatus(`Queued message (${queueRef.current.length})`);
      return;
    }

    busyRef.current = true;
    try {
      await executeTurn(text);
    } finally {
      busyRef.current = false;
      const next = queueRef.current.shift();
      setQueuedCount(queueRef.current.length);
      if (next) {
        setTimeout(() => {
          if (next.startsWith('/')) {
            void handleSlashCommand(next);
          } else {
            void runPrompt(next);
          }
        }, 0);
      }
    }
  };

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      void handleSlashCommand(trimmed);
      return;
    }
    void runPrompt(trimmed);
  };

  const handleModelChange = (newProvider: Provider, newModel: string, key?: string) => {
    setShowModelSelector(false);
    const updated: Config = {
      ...config,
      activeProvider: newProvider,
      activeModel: newModel,
    };
    if (key) {
      if (!updated.providers[newProvider]) updated.providers[newProvider] = {};
      updated.providers[newProvider]!.apiKey = key;
      setApiKey(newProvider, key);
    }
    setConfig(updated);
    saveConfig(updated);
    agentStateRef.current.config = updated;
    agentStateRef.current.modelInfo = getModelInfo(newModel, newProvider);

    try {
      agentStateRef.current.model = createModelFromConfig(updated);
      flashStatus(`Using ${newProvider} · ${newModel}`);
    } catch (err) {
      addSystemMessage(`Could not load ${newModel}: ${String(err)}`, 'error');
    }
  };

  const modeLabel = autoApproveMode ? 'auto-approve on' : 'manual approvals';

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} style={{ paddingX: 1 }} items={staticMessages}>
        {(message) => <MessageItem key={message.id} message={message} />}
      </Static>

      <MessageList messages={liveMessages.slice(-10)} activeTool={activeTool} />

      <SubagentPanel runs={subagentRuns} />

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

      {showModelSelector && (
        <ModelSelector
          config={config}
          onSelect={handleModelChange}
          onClose={() => setShowModelSelector(false)}
        />
      )}

      {showSessionSelector && (
        <SessionSelector
          sessions={sessionOptions}
          onSelect={resumeSession}
          onClose={() => setShowSessionSelector(false)}
        />
      )}

      {statusMessage && (
        <Box paddingX={1}>
          <Text color={palette.fg} backgroundColor={palette.bg}>
            {statusMessage}
          </Text>
        </Box>
      )}

      {!pendingApproval && !showModelSelector && !showSessionSelector && (
        <PromptInput
          onSubmit={handleSubmit}
          placeholder={
            isStreaming
              ? 'Response in progress — type to queue a message'
              : 'Ask anything, or type / for commands'
          }
        />
      )}

      <Box paddingX={1} marginTop={0}>
        <Text dimColor backgroundColor={palette.bg}>
          {config.activeModel} · {config.activeProvider} · {modeLabel} · / commands ·
          shift+tab toggle · ctrl+c {isStreaming ? 'interrupt' : 'exit'}
          {queuedCount > 0 ? ` · ${queuedCount} queued` : ''}
        </Text>
      </Box>
    </Box>
  );
};

export default App;
