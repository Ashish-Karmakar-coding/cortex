import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { CoreMessage } from 'ai';
import { MessageItem, MessageList, type DisplayMessage } from './MessageList.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ModelSelector } from './ModelSelector.js';
import { PromptInput } from './PromptInput.js';
import { SessionSelector, type SessionSummary } from './SessionSelector.js';
import { SubagentPanel, type SubagentRun } from './SubagentPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { findSlashCommand, formatCommandHelp } from './commands.js';
import { palette } from './theme.js';
import { type Config, saveConfig, setApiKey, getConfigDir } from '../config/store.js';
import {
  type Provider,
  getModelInfo,
  listAvailableModels,
  resolveModelInfo,
} from '../config/models.js';
import { createModelFromConfig } from '../providers/factory.js';
import { runAgentLoop, type AgentState, type ApprovalDecision } from '../agent/loop.js';
import { loadSubagents, type SubagentEvent } from '../agent/subagents.js';
import { expandFileMentions } from '../agent/mentions.js';
import { SessionStore } from '../persistence/sessions.js';
import { compactMessages, estimateMessagesTokens } from '../agent/compaction.js';
import { initProjectFile } from '../agent/init.js';
import { MCPManager, loadMCPConfig } from '../mcp/client.js';
import { createBashExecTool } from '../tools/shell.js';
import type { TodoItem } from '../tools/todo.js';
import type { AgentPermissionMode } from '../tools/registry.js';
import { VERSION } from '../version.js';

export interface AppProps {
  initialConfig: Config;
  sessionId: string;
  initialMessages?: CoreMessage[];
  autoApprove?: boolean;
}

const CONFIRM_TOOLS = ['write_file', 'edit_file', 'bash_exec', 'web_fetch', 'task'];

function createWelcomeMessage(): DisplayMessage {
  return {
    id: 'welcome',
    role: 'system',
    variant: 'welcome',
    content: [
      '  ✻ Welcome to Cortex!',
      '',
      '  /help commands · /model pick model · @file attach · !cmd bash · /rewind undo',
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
          status: /^(tool )?error|blocked|rejected/i.test(raw) ? 'error' : 'done',
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
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    autoApprove ? 'auto' : 'manual'
  );
  const [queuedCount, setQueuedCount] = useState(0);
  const [subagentRuns, setSubagentRuns] = useState<SubagentRun[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [toolCapableBadge, setToolCapableBadge] = useState<boolean>(
    getModelInfo(initialConfig.activeModel, initialConfig.activeProvider as Provider).supportsToolCalling
  );
  const [tokenCount, setTokenCount] = useState<number>(() =>
    estimateMessagesTokens(initialMessages)
  );
  const [contextWindow, setContextWindow] = useState<number>(
    getModelInfo(initialConfig.activeModel, initialConfig.activeProvider as Provider, initialConfig.numCtx)
      .contextWindow
  );

  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string;
    args: Record<string, unknown>;
    diff?: string;
    resolve: (decision: ApprovalDecision) => void;
  } | null>(null);

  const [staticMessages, setStaticMessages] = useState<DisplayMessage[]>(() => [
    createWelcomeMessage(),
    ...mapCoreMessages(initialMessages),
  ]);
  const [liveMessages, setLiveMessages] = useState<DisplayMessage[]>([]);
  const [staticEpoch, setStaticEpoch] = useState(0);

  const sessionStoreRef = useRef(new SessionStore());
  const mcpManagerRef = useRef(new MCPManager());
  const sessionClosedRef = useRef(false);
  const busyRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const ctrlCCountRef = useRef(0);
  const liveMessagesRef = useRef<DisplayMessage[]>([]);
  const pendingApprovalRef = useRef(pendingApproval);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subagentTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const sessionMetaRef = useRef<{ title?: string; createdAt: string }>({
    title: undefined,
    createdAt: new Date().toISOString(),
  });

  const initialHistoryRef = useRef<string[]>(
    sessionStoreRef.current.rawStore.getPromptHistory(100)
  );

  const agentStateRef = useRef<AgentState>({
    messages: [...initialMessages],
    abortController: new AbortController(),
    isRunning: false,
    sessionApprovals: new Set(autoApprove ? CONFIRM_TOOLS : []),
    permissionMode: autoApprove ? 'auto' : 'manual',
    model: createModelFromConfig(initialConfig),
    config: initialConfig,
    modelInfo: getModelInfo(
      initialConfig.activeModel,
      initialConfig.activeProvider as Provider,
      initialConfig.numCtx
    ),
    sessionId: initialSessionId,
    localStore: sessionStoreRef.current.rawStore,
    mcpManager: mcpManagerRef.current,
  });

  pendingApprovalRef.current = pendingApproval;

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

  const closeResources = () => {
    if (sessionClosedRef.current) return;
    sessionClosedRef.current = true;
    void mcpManagerRef.current.disconnect().catch(() => {});
    try {
      sessionStoreRef.current.close();
    } catch {
      // Already closed.
    }
  };

  useEffect(() => {
    agentStateRef.current.permissionMode = permissionMode;
    const approvals = agentStateRef.current.sessionApprovals;
    for (const tool of CONFIRM_TOOLS) {
      if (permissionMode === 'auto') approvals.add(tool);
      else approvals.delete(tool);
    }
  }, [permissionMode]);

  useEffect(() => {
    agentStateRef.current.sessionId = sessionId;
  }, [sessionId]);

  // Connect MCP servers and inspect local model capabilities on mount
  useEffect(() => {
    let active = true;
    void (async () => {
      const mcpConfigs = await loadMCPConfig();
      if (mcpConfigs.length > 0 && active) {
        await mcpManagerRef.current.connect(mcpConfigs);
      }

      const resolved = await resolveModelInfo(
        initialConfig.activeModel,
        initialConfig.activeProvider as Provider,
        initialConfig,
        sessionStoreRef.current.rawStore
      );
      if (active) {
        agentStateRef.current.modelInfo = resolved;
        setToolCapableBadge(resolved.supportsToolCalling);
        setContextWindow(resolved.contextWindow);
      }
    })();

    return () => {
      active = false;
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      for (const timer of subagentTimersRef.current) clearTimeout(timer);
      closeResources();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global shortcuts: Ctrl+C to interrupt/exit, Shift+Tab to cycle permission modes.
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
        closeResources();
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
      setPermissionMode((current) => {
        const next: AgentPermissionMode =
          current === 'manual' ? 'auto' : current === 'auto' ? 'plan' : 'manual';
        const label =
          next === 'auto'
            ? 'Auto-approve enabled.'
            : next === 'plan'
              ? 'Plan mode enabled (read-only).'
              : 'Manual approval mode.';
        flashStatus(label);
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
    sessionMetaRef.current = {
      title: record.title,
      createdAt: record.createdAt,
    };
    setSessionId(record.id);
    setTokenCount(estimateMessagesTokens(messages));
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
        const info = getModelInfo(record.model, record.provider as Provider, updated.numCtx);
        agentStateRef.current.modelInfo = info;
        setToolCapableBadge(info.supportsToolCalling);
        setContextWindow(info.contextWindow);
      } catch {
        // Keep current model if saved one is unavailable.
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

    const stats = sessionStoreRef.current.rawStore.getStats();
    lines.push(
      `${existsSync(stats.storageDir) ? '✓' : '✗'} Storage partition: ${stats.storageDir}`
    );
    lines.push(
      `✓ Local DB: ${(stats.dbBytes / 1024).toFixed(1)} KB (${stats.sessionsCount} sessions, ${stats.checkpointsCount} checkpoints)`
    );

    const provider = config.activeProvider as Provider;
    if (provider === 'ollama' || provider === 'lmstudio') {
      const baseUrl =
        config.providers[provider]?.baseUrl ??
        (provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1');
      const url = provider === 'ollama' ? `${baseUrl.replace(/\/+$/, '')}/api/tags` : `${baseUrl.replace(/\/+$/, '')}/models`;
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
        process.env[`${provider.toUpperCase()}_API_KEY`];
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

    const mcpServers = mcpManagerRef.current.connectedServers;
    lines.push(
      `ℹ MCP servers connected: ${mcpServers.length > 0 ? mcpServers.join(', ') : 'none'}`
    );

    return lines;
  };

  const handleShellEscape = async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    setStaticMessages((prev) => [
      ...prev,
      { id: `user-bash-${Date.now()}`, role: 'user', content: `! ${trimmed}` },
    ]);
    const bash = createBashExecTool(agentStateRef.current.abortController.signal);
    const raw = await (bash as any).execute({ command: trimmed }, {});
    let formatted = String(raw);
    try {
      const parsed = JSON.parse(formatted) as {
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
      };
      const parts: string[] = [];
      if (parsed.stdout?.trim()) parts.push(parsed.stdout.trim());
      if (parsed.stderr?.trim()) parts.push(`[stderr]\n${parsed.stderr.trim()}`);
      if (parts.length === 0) parts.push(`(exit code ${parsed.exitCode ?? 0})`);
      formatted = parts.join('\n');
    } catch {
      // keep raw string
    }
    addSystemMessage(formatted);
  };

  const handleSlashCommand = async (commandText: string): Promise<void> => {
    const parts = commandText.trim().split(/\s+/);
    const found = findSlashCommand(commandText);
    const command = found ? `/${found.name}` : parts[0]!.toLowerCase();

    if (busyRef.current && command !== '/help' && command !== '/status' && command !== '/context') {
      queueRef.current.push(commandText.trim());
      setQueuedCount(queueRef.current.length);
      flashStatus(`Queued command (${queueRef.current.length})`);
      return;
    }

    switch (command) {
      case '/help': {
        const shortcuts = [
          'Keyboard shortcuts & prefixes:',
          '  Enter            Send prompt or run command',
          '  \\ + Enter        Insert a new line (or Ctrl+J)',
          '  ↑ / ↓            Persistent prompt history (or palette navigation)',
          '  Tab              Complete slash command or @file mention',
          '  Shift+Tab        Cycle mode: manual -> auto-approve -> plan',
          '  @path/to/file    Attach local file contents into prompt',
          '  !command         Run shell command directly',
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
          setTokenCount(estimateMessagesTokens(compacted));
          addSystemMessage(`Conversation compacted. ${compacted.length} messages retained.`);
          flashStatus('Context compacted.');
        } catch (err) {
          addSystemMessage(`Compaction failed: ${String(err)}`, 'error');
          setStatusMessage(null);
        }
        return;
      }

      case '/context': {
        const est = estimateMessagesTokens(agentStateRef.current.messages);
        const pct = Math.min(100, Math.round((est / Math.max(1, contextWindow)) * 100));
        addSystemMessage(
          [
            `Context usage: ~${est.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct}%)`,
            `Messages in history: ${agentStateRef.current.messages.length}`,
            `Auto-compaction threshold: 75% (~${Math.round(contextWindow * 0.75).toLocaleString()} tokens)`,
            `Tool mode: ${toolCapableBadge ? 'native tool calls + fallback' : 'XML/JSON fallback'}`,
          ].join('\n')
        );
        return;
      }

      case '/diff': {
        try {
          const status = execFileSync('git', ['status', '--short', '--branch'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          const diff = execFileSync('git', ['diff'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          const preview = diff
            ? diff.split('\n').slice(0, 60).join('\n')
            : '(no unstaged diff)';
          addSystemMessage(`${status}\n\n${preview}`);
        } catch (err) {
          addSystemMessage(`Git diff unavailable: ${String(err)}`, 'error');
        }
        return;
      }

      case '/rewind': {
        const store = sessionStoreRef.current.rawStore;
        const checkpoints = store.listCheckpoints(sessionId, 20);
        if (checkpoints.length === 0) {
          addSystemMessage('No file checkpoints recorded for this session yet.');
          return;
        }

        const arg = parts[1];
        if (!arg) {
          const latestTurn = checkpoints[0]!.turnIndex;
          const latestTurnCps = checkpoints.filter((c) => c.turnIndex === latestTurn);
          const restored: string[] = [];
          for (const cp of latestTurnCps) {
            try {
              if (!cp.existedBefore) {
                if (existsSync(cp.filePath)) unlinkSync(cp.filePath);
                restored.push(`Removed new file ${cp.filePath}`);
              } else if (cp.previousContent !== null) {
                mkdirSync(dirname(cp.filePath), { recursive: true });
                writeFileSync(cp.filePath, cp.previousContent, 'utf-8');
                restored.push(`Restored ${cp.filePath}`);
              }
              store.deleteCheckpoint(cp.id);
            } catch (err) {
              restored.push(`Failed ${cp.filePath}: ${String(err)}`);
            }
          }
          addSystemMessage(
            `Rewound turn ${latestTurn} (${restored.length} file(s)):\n${restored.join('\n')}`
          );
          return;
        }

        const targetId = Number(arg);
        const target = checkpoints.find((c) => c.id === targetId);
        if (!target) {
          const list = checkpoints
            .slice(0, 10)
            .map((c) => `  #${c.id} [turn ${c.turnIndex}] ${c.filePath} (${c.createdAt.slice(0, 19)})`)
            .join('\n');
          addSystemMessage(`Recent checkpoints (run /rewind <id> or /rewind to undo last turn):\n${list}`);
          return;
        }
        if (!target.existedBefore) {
          if (existsSync(target.filePath)) unlinkSync(target.filePath);
          store.deleteCheckpoint(target.id);
          addSystemMessage(`Removed newly created file: ${target.filePath}`);
        } else if (target.previousContent !== null) {
          writeFileSync(target.filePath, target.previousContent, 'utf-8');
          store.deleteCheckpoint(target.id);
          addSystemMessage(`Restored: ${target.filePath}`);
        }
        return;
      }

      case '/memory': {
        const store = sessionStoreRef.current.rawStore;
        const rest = commandText.trim().slice('/memory'.length).trim();
        if (rest.startsWith('add ')) {
          const body = rest.slice(4).trim();
          const eq = body.indexOf('=');
          if (eq === -1) {
            addSystemMessage('Usage: /memory add <key>=<note>', 'error');
            return;
          }
          const key = body.slice(0, eq).trim();
          const note = body.slice(eq + 1).trim();
          if (!key || !note) {
            addSystemMessage('Usage: /memory add <key>=<note>', 'error');
            return;
          }
          store.setMemory('project', key, note, process.cwd());
          addSystemMessage(`Saved project memory "${key}": ${note}`);
          return;
        }
        const entries = store.listMemory(process.cwd());
        const globalFile = join(getConfigDir(), 'CORTEX.md');
        const projectFile = join(process.cwd(), 'CORTEX.md');
        const lines = [
          `Global instructions: ${existsSync(globalFile) ? globalFile : 'none'}`,
          `Project instructions: ${existsSync(projectFile) ? projectFile : 'none (run /init)'}`,
          '',
          entries.length > 0
            ? entries.map((e) => `  [${e.scope}] ${e.key}: ${e.content}`).join('\n')
            : '  No stored memory entries yet. Use: /memory add <key>=<note>',
        ];
        addSystemMessage(`Memory:\n${lines.join('\n')}`);
        return;
      }

      case '/mcp': {
        const sub = parts[1];
        if (sub === 'reload') {
          await mcpManagerRef.current.disconnect();
          const configs = await loadMCPConfig();
          await mcpManagerRef.current.connect(configs);
          flashStatus(`Reloaded MCP (${mcpManagerRef.current.connectedServers.length} connected).`);
        }
        const servers = mcpManagerRef.current.connectedServers;
        const mcpTools = mcpManagerRef.current.getTools();
        addSystemMessage(
          servers.length === 0
            ? `No MCP servers connected. Configure ${join(getConfigDir(), 'mcp.json')} or .cortex/mcp.json and run /mcp reload.`
            : `Connected MCP servers (${servers.join(', ')}):\n${mcpTools
                .map((t) => `  ${t.name} — ${t.description}`)
                .join('\n')}`
        );
        return;
      }

      case '/storage': {
        const stats = sessionStoreRef.current.rawStore.getStats();
        addSystemMessage(
          [
            `Local Storage Partition:`,
            `  Storage dir:    ${stats.storageDir}`,
            `  Database:       ${stats.dbPath} (${(stats.dbBytes / 1024).toFixed(1)} KB)`,
            `  Manifest:       ${stats.manifestPath}`,
            `  Sessions:       ${stats.sessionsCount}`,
            `  Checkpoints:    ${stats.checkpointsCount}`,
            `  Memory entries: ${stats.memoryCount}`,
            `  Prompt history: ${stats.promptHistoryCount}`,
            `  Tool audit log: ${stats.auditLogsCount}`,
          ].join('\n')
        );
        return;
      }

      case '/config': {
        const key = parts[1];
        const value = parts[2];
        if (!key) {
          addSystemMessage(
            [
              'Current Configuration:',
              `  activeProvider: ${config.activeProvider}`,
              `  activeModel:    ${config.activeModel}`,
              `  numCtx:         ${config.numCtx}`,
              `  storageDir:     ${config.storageDir ?? join(getConfigDir(), 'storage')}`,
              `  ollama.baseUrl: ${config.providers['ollama']?.baseUrl ?? 'http://localhost:11434'}`,
              `  lmstudio.baseUrl: ${config.providers['lmstudio']?.baseUrl ?? 'http://localhost:1234/v1'}`,
              '',
              'Update with: /config numCtx 32768  or  /config ollama.baseUrl http://localhost:11434',
            ].join('\n')
          );
          return;
        }
        if (!value) {
          addSystemMessage('Usage: /config <key> <value>', 'error');
          return;
        }
        const updated: Config = { ...config, providers: { ...config.providers } };
        if (key === 'numCtx') {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1024) {
            addSystemMessage('numCtx must be a number >= 1024', 'error');
            return;
          }
          updated.numCtx = parsed;
        } else if (key === 'ollama.baseUrl' || key === 'lmstudio.baseUrl') {
          const [prov] = key.split('.');
          updated.providers[prov!] = { ...(updated.providers[prov!] ?? {}), baseUrl: value };
        } else if (key === 'storageDir') {
          updated.storageDir = value;
        } else {
          addSystemMessage(`Unknown config key: ${key}`, 'error');
          return;
        }
        saveConfig(updated);
        setConfig(updated);
        agentStateRef.current.config = updated;
        try {
          agentStateRef.current.model = createModelFromConfig(updated);
        } catch {
          // ignore
        }
        flashStatus(`Updated ${key} = ${value}`);
        return;
      }

      case '/permissions': {
        addSystemMessage(
          [
            `Permission mode: ${permissionMode}`,
            `Session auto-approved tools: ${[...agentStateRef.current.sessionApprovals].join(', ') || 'none'}`,
            `Allow rules: ${config.permissions?.allow?.join(', ') || 'none'}`,
            `Deny rules:  ${config.permissions?.deny?.join(', ') || 'none'}`,
          ].join('\n')
        );
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
        sessionMetaRef.current = {
          title: undefined,
          createdAt: new Date().toISOString(),
        };
        setSessionId(sessionStoreRef.current.generateId());
        setTokenCount(0);
        setTodos([]);
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
            `Model:        ${config.activeModel} (${state.modelInfo.supportsToolCalling ? 'native tools' : 'xml fallback'})`,
            `Context:      ${contextWindow.toLocaleString()} tokens`,
            `Messages:     ${state.messages.length}`,
            `Session:      ${sessionId}`,
            `Mode:         ${permissionMode}`,
            `Config:       ${getConfigDir()}`,
            `Storage:      ${sessionStoreRef.current.rawStore.storageDir}`,
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
        setPermissionMode((current) => (current === 'auto' ? 'manual' : 'auto'));
        return;

      case '/plan':
        setPermissionMode((current) => (current === 'plan' ? 'manual' : 'plan'));
        return;

      case '/quit':
      case '/exit':
        closeResources();
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
    const key = event.runId ?? event.name;
    if (event.type === 'start') {
      setSubagentRuns((prev) => [
        ...prev,
        {
          id: key,
          name: event.name,
          description: event.description,
          status: 'running',
        },
      ]);
      return;
    }

    if (event.type === 'text' || event.type === 'tool') {
      const activity =
        event.type === 'tool'
          ? `${event.tool} ${event.detail}`.trim()
          : (event.chunk.split('\n').filter((line) => line.trim()).pop() ?? '')
              .trim()
              .slice(0, 90);
      if (!activity) return;
      setSubagentRuns((prev) =>
        prev.map((run) => (run.id === key ? { ...run, activity } : run))
      );
      return;
    }

    setSubagentRuns((prev) =>
      prev.map((run) =>
        run.id === key
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

    const timer = setTimeout(() => {
      setSubagentRuns((prev) => prev.filter((run) => run.id !== key));
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
    setStaticMessages((prev) => [...prev, ...completed]);
  };

  const executeTurn = async (rawText: string) => {
    const { expandedPrompt, attachedFiles } = expandFileMentions(rawText);
    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;
    const initialLive: DisplayMessage[] = [
      { id: userMsgId, role: 'user', content: rawText },
      ...(attachedFiles.length > 0
        ? [
            {
              id: `attach-${Date.now()}`,
              role: 'system' as const,
              variant: 'info' as const,
              content: `Attached ${attachedFiles.map((f) => `@${f}`).join(', ')}`,
            },
          ]
        : []),
      { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true },
    ];
    setLive(initialLive);
    setIsStreaming(true);
    setStatusMessage(null);

    if (!sessionMetaRef.current.title) {
      sessionMetaRef.current.title = sessionStoreRef.current.generateTitle(rawText);
    }

    let buffer = '';
    let currentAssistantId = assistantMsgId;
    let needsNewAssistant = false;
    const flushStream = () => {
      if (!buffer) return;
      const chunk = buffer;
      buffer = '';

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
      await runAgentLoop(agentStateRef.current, expandedPrompt, {
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
        onTodosChange: (nextTodos) => {
          setTodos(nextTodos);
        },
        onContextCompacted: (remaining) => {
          flashStatus(`Context compacted (${remaining} messages kept).`);
        },
        onToolEnd: (name, result) => {
          flushStream();
          needsNewAssistant = true;
          setActiveTool(undefined);
          const status =
            /^(tool )?error|blocked|rejected/i.test(result)
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

      const est = estimateMessagesTokens(agentStateRef.current.messages);
      setTokenCount(est);
      setToolCapableBadge(agentStateRef.current.modelInfo.supportsToolCalling);
      setContextWindow(agentStateRef.current.modelInfo.contextWindow);

      const now = new Date().toISOString();
      sessionStoreRef.current.save({
        id: sessionId,
        title: sessionMetaRef.current.title ?? sessionStoreRef.current.generateTitle(rawText),
        provider: agentStateRef.current.config.activeProvider,
        model: agentStateRef.current.config.activeModel,
        cwd: process.cwd(),
        messages: JSON.stringify(agentStateRef.current.messages),
        tokenEstimate: est,
        createdAt: sessionMetaRef.current.createdAt,
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
          } else if (next.startsWith('!')) {
            void handleShellEscape(next.slice(1));
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
    sessionStoreRef.current.rawStore.addPromptHistory(trimmed, process.cwd());

    if (trimmed.startsWith('/')) {
      void handleSlashCommand(trimmed);
      return;
    }
    if (trimmed.startsWith('!') && trimmed.length > 1) {
      void handleShellEscape(trimmed.slice(1));
      return;
    }
    void runPrompt(trimmed);
  };

  const handleModelChange = async (newProvider: Provider, newModel: string, key?: string) => {
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

    try {
      agentStateRef.current.model = createModelFromConfig(updated);
      const resolved = await resolveModelInfo(
        newModel,
        newProvider,
        updated,
        sessionStoreRef.current.rawStore
      );
      agentStateRef.current.modelInfo = resolved;
      setToolCapableBadge(resolved.supportsToolCalling);
      setContextWindow(resolved.contextWindow);
      flashStatus(
        `Using ${newProvider} · ${newModel} (${resolved.supportsToolCalling ? 'native tools' : 'xml fallback'})`
      );
    } catch (err) {
      addSystemMessage(`Could not load ${newModel}: ${String(err)}`, 'error');
    }
  };

  const modeLabel =
    permissionMode === 'auto'
      ? 'auto-approve'
      : permissionMode === 'plan'
        ? 'plan (read-only)'
        : 'manual';
  const ctxPct = Math.min(100, Math.round((tokenCount / Math.max(1, contextWindow)) * 100));

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} style={{ paddingX: 1 }} items={staticMessages}>
        {(message) => <MessageItem key={message.id} message={message} />}
      </Static>

      <MessageList messages={liveMessages} activeTool={activeTool} />

      <TodoPanel todos={todos} />

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
          onSelect={(prov, mod, key) => {
            void handleModelChange(prov, mod, key);
          }}
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
          initialHistory={initialHistoryRef.current}
          placeholder={
            isStreaming
              ? 'Response in progress — type to queue a message'
              : 'Ask anything · / commands · @ files · ! bash'
          }
        />
      )}

      <Box paddingX={1} marginTop={0}>
        <Text color={palette.muted} backgroundColor={palette.bg}>
          {config.activeModel} · {config.activeProvider} [{toolCapableBadge ? 'tools' : 'xml'}] ·{' '}
          {modeLabel} · {ctxPct}% ctx · shift+tab mode · ctrl+c{' '}
          {isStreaming ? 'interrupt' : 'exit'}
          {queuedCount > 0 ? ` · ${queuedCount} queued` : ''}
        </Text>
      </Box>
    </Box>
  );
};

export default App;
