import { Command } from 'commander';
import { loadConfig, saveConfig, setApiKey, getConfigDir } from './config/store.js';
import {
  type Provider,
  getModelInfo,
  listAvailableModels,
  resolveModelInfo,
} from './config/models.js';
import { createModelFromConfig } from './providers/factory.js';
import { runAgentLoop, type AgentState, type ApprovalCallback } from './agent/loop.js';
import { expandFileMentions } from './agent/mentions.js';
import { SessionStore } from './persistence/sessions.js';
import { ensureStoragePartition, LocalStore } from './storage/localStore.js';
import { MCPManager, loadMCPConfig } from './mcp/client.js';
import type { CoreMessage } from 'ai';
import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { VERSION } from './version.js';
import { upgrade } from './upgrade.js';
import { palette, applyTerminalTheme } from './tui/palette.js';
import { createSolidStdout } from './tui/solidOutput.js';
import { findSlashCommand, formatCommandHelp } from './tui/commands.js';
import { initProjectFile } from './agent/init.js';
import { loadSubagents } from './agent/subagents.js';
import type { AgentPermissionMode } from './tools/registry.js';

const fg = chalk.hex(palette.fg);
const muted = chalk.hex(palette.muted);
const success = chalk.hex(palette.success);
const warning = chalk.hex(palette.warning);
const danger = chalk.hex(palette.danger);

const CONFIRM_TOOL_NAMES = ['write_file', 'edit_file', 'bash_exec', 'web_fetch', 'task'];

const program = new Command();

type SubcommandAction = 'none' | 'upgrade' | 'init-storage' | 'storage';
const subcommandState: { action: SubcommandAction; customStorageDir?: string } = {
  action: 'none',
};

program
  .name('cortex')
  .description('Cortex — An open-source, local-first agentic coding CLI')
  .version(VERSION)
  .option('-p, --prompt <text>', 'Non-interactive prompt (pipe mode)')
  .option('--provider <name>', 'Override LLM provider')
  .option('--model <name>', 'Override model')
  .option('--yes', 'Auto-approve all tool calls')
  .option('--plan', 'Start in read-only plan mode')
  .option('--resume <session-id>', 'Resume a previous session')
  .option('--plain', 'Use plain line-by-line terminal mode instead of Ink TUI')
  .option('--num-ctx <number>', 'Set Ollama context window size', '16384');

program
  .command('upgrade')
  .description('Update Cortex to the latest release from GitHub')
  .action(() => {
    subcommandState.action = 'upgrade';
  });

program
  .command('init-storage')
  .alias('setup')
  .description('Create and initialize the local storage partition')
  .option('--storage-dir <path>', 'Custom directory for the local storage partition')
  .action((cmdOpts: { storageDir?: string }) => {
    subcommandState.action = 'init-storage';
    subcommandState.customStorageDir = cmdOpts.storageDir;
  });

program
  .command('storage')
  .description('Show local storage partition location and usage statistics')
  .action(() => {
    subcommandState.action = 'storage';
  });

program.action(() => {});

await program.parseAsync(process.argv);

const opts = program.opts<{
  prompt?: string;
  provider?: string;
  model?: string;
  yes?: boolean;
  plan?: boolean;
  resume?: string;
  plain?: boolean;
  numCtx: string;
}>();

if (subcommandState.action === 'upgrade') {
  const ok = await upgrade();
  process.exit(ok ? 0 : 1);
}

if (subcommandState.action === 'init-storage') {
  const result = ensureStoragePartition(subcommandState.customStorageDir);
  console.log(
    result.created
      ? `Initialized Cortex local storage partition:`
      : `Verified Cortex local storage partition:`
  );
  console.log(`  Config dir : ${result.configDir}`);
  console.log(`  Storage dir: ${result.storageDir}`);
  console.log(`  SQLite DB  : ${result.dbPath}`);
  console.log(`  Storage ID : ${result.manifest.storageId}`);
  process.exit(0);
}

if (subcommandState.action === 'storage') {
  ensureStoragePartition();
  const store = new LocalStore();
  const stats = store.getStats();
  store.close();
  console.log(`Cortex Local Storage Partition`);
  console.log(`  Config dir     : ${stats.configDir}`);
  console.log(`  Storage dir    : ${stats.storageDir}`);
  console.log(`  Database       : ${stats.dbPath} (${(stats.dbBytes / 1024).toFixed(1)} KB)`);
  console.log(`  Manifest       : ${stats.manifestPath}`);
  console.log(`  Sessions       : ${stats.sessionsCount}`);
  console.log(`  Checkpoints    : ${stats.checkpointsCount}`);
  console.log(`  Memory entries : ${stats.memoryCount}`);
  console.log(`  Prompt history : ${stats.promptHistoryCount}`);
  console.log(`  Tool audit log : ${stats.auditLogsCount}`);
  process.exit(0);
}

async function main() {
  // Always ensure the local storage partition exists before loading config/sessions.
  ensureStoragePartition();
  const config = loadConfig();

  if (opts.provider) config.activeProvider = opts.provider;
  if (opts.model) config.activeModel = opts.model;
  if (opts.numCtx) config.numCtx = parseInt(opts.numCtx, 10);

  const provider = config.activeProvider as Provider;
  let modelInfo = getModelInfo(config.activeModel, provider, config.numCtx);

  let model;
  try {
    model = createModelFromConfig(config);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const sessionStore = new SessionStore();
  const localStore = sessionStore.rawStore;
  let messages: CoreMessage[] = [];
  let sessionId = sessionStore.generateId();
  let sessionTitle: string | undefined;
  let sessionCreatedAt = new Date().toISOString();

  if (opts.resume) {
    const session = sessionStore.load(opts.resume);
    if (session) {
      messages = JSON.parse(session.messages) as CoreMessage[];
      sessionId = session.id;
      sessionTitle = session.title;
      sessionCreatedAt = session.createdAt;
      console.error(`Resumed session: ${session.title}`);
    } else {
      console.error(`Session not found: ${opts.resume}`);
      process.exit(1);
    }
  }

  const isTTY = process.stdin.isTTY && !opts.prompt;

  if (!isTTY) {
    // === Pipe / Non-Interactive Mode ===
    let input = '';

    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      input = Buffer.concat(chunks).toString('utf-8');
    }

    const rawPrompt = opts.prompt
      ? input
        ? `${opts.prompt}\n\n---\n\n${input}`
        : opts.prompt
      : input;

    if (!rawPrompt.trim()) {
      console.error('Error: No input provided. Use -p "prompt" or pipe input.');
      process.exit(1);
    }

    const { expandedPrompt } = expandFileMentions(rawPrompt);
    modelInfo = await resolveModelInfo(config.activeModel, provider, config, localStore);

    const mcpManager = new MCPManager();
    const mcpConfigs = await loadMCPConfig();
    if (mcpConfigs.length > 0) {
      await mcpManager.connect(mcpConfigs);
    }

    const permissionMode: AgentPermissionMode = opts.plan
      ? 'plan'
      : opts.yes
        ? 'auto'
        : 'manual';

    const state: AgentState = {
      messages,
      abortController: new AbortController(),
      isRunning: false,
      sessionApprovals: new Set(opts.yes ? CONFIRM_TOOL_NAMES : []),
      permissionMode,
      model,
      config,
      modelInfo,
      sessionId,
      localStore,
      mcpManager,
    };

    const approvalCallback: ApprovalCallback = async () => 'allow';

    try {
      await runAgentLoop(state, expandedPrompt, {
        onStream: (chunk) => process.stdout.write(chunk),
        onApproval: opts.yes
          ? approvalCallback
          : async (toolName, args) => {
              console.error(`\n[Tool: ${toolName}] ${JSON.stringify(args).slice(0, 200)}`);
              console.error('[Auto-rejecting in pipe mode without --yes]');
              return 'reject';
            },
        onToolStart: (name) => console.error(`\n[Running: ${name}]`),
        onToolEnd: (name, result) =>
          console.error(`[Done: ${name}] ${result.slice(0, 100)}`),
        onSubagentEvent: (event) => {
          if (event.type === 'start') {
            console.error(`[Subagent ${event.name}: ${event.description}]`);
          } else if (event.type === 'tool') {
            console.error(`  [${event.name}] ${event.tool} ${event.detail}`);
          } else if (event.type === 'error') {
            console.error(`[Subagent ${event.name} error: ${event.error}]`);
          }
        },
      });

      sessionStore.save({
        id: sessionId,
        title: sessionTitle ?? sessionStore.generateTitle(rawPrompt),
        provider: config.activeProvider,
        model: config.activeModel,
        cwd: process.cwd(),
        messages: JSON.stringify(state.messages),
        createdAt: sessionCreatedAt,
        updatedAt: new Date().toISOString(),
      });

      await mcpManager.disconnect();
      sessionStore.close();
      process.stdout.write('\n');
      process.exit(0);
    } catch (err) {
      await mcpManager.disconnect();
      sessionStore.close();
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else if (!opts.plain) {
    // === Interactive Ink TUI Mode (Solid non-transparent surface) ===
    sessionStore.close();
    applyTerminalTheme(true);

    const { render } = await import('ink');
    const { default: React } = await import('react');
    const { App } = await import('./tui/App.js');

    const solidStdout = createSolidStdout(process.stdout);

    render(
      React.createElement(App, {
        initialConfig: config,
        sessionId,
        initialMessages: messages,
        autoApprove: opts.yes,
      }),
      { stdout: solidStdout }
    );
  } else {
    // === Plain Terminal Readline Fallback Mode ===
    applyTerminalTheme(true);
    modelInfo = await resolveModelInfo(config.activeModel, provider, config, localStore);

    const mcpManager = new MCPManager();
    const mcpConfigs = await loadMCPConfig();
    if (mcpConfigs.length > 0) {
      await mcpManager.connect(mcpConfigs);
    }

    const permissionMode: AgentPermissionMode = opts.plan
      ? 'plan'
      : opts.yes
        ? 'auto'
        : 'manual';

    const state: AgentState = {
      messages,
      abortController: new AbortController(),
      isRunning: false,
      sessionApprovals: new Set(opts.yes ? CONFIRM_TOOL_NAMES : []),
      permissionMode,
      model,
      config,
      modelInfo,
      sessionId,
      localStore,
      mcpManager,
    };

    console.log(fg('╔══════════════════════════════════════════════╗'));
    console.log(`${fg('║')}  🤖 ${fg.bold('Cortex')} — Agentic AI Coding Assistant   ${fg('║')}`);
    console.log(fg('╚══════════════════════════════════════════════╝'));
    console.log(
      `  ${muted('Provider:')} ${fg(config.activeProvider)} ${muted('|')} ${muted('Model:')} ${fg(config.activeModel)} ${muted('|')} ${muted('Storage:')} ${fg(localStore.storageDir)}`
    );
    console.log(muted('  Type your request, @file to attach, or /help for commands\n'));

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${fg('cortex>')} `,
    });

    let ctrlCCount = 0;

    rl.on('SIGINT', () => {
      if (state.isRunning) {
        state.abortController.abort();
        state.abortController = new AbortController();
        console.log(`\n${warning('[Interrupted]')}`);
        ctrlCCount = 0;
      } else {
        ctrlCCount++;
        if (ctrlCCount >= 2) {
          console.log('\nGoodbye!');
          void mcpManager.disconnect();
          sessionStore.close();
          process.exit(0);
        }
        console.log(`\n${muted('(Press Ctrl+C again to exit)')}`);
        rl.prompt();
      }
    });

    const handleSlashCommand = async (input: string): Promise<boolean> => {
      const parts = input.trim().split(/\s+/);
      const found = findSlashCommand(input);
      const cmd = found ? `/${found.name}` : parts[0]!.toLowerCase();

      switch (cmd) {
        case '/help':
          console.log(`\n${fg.bold('Slash Commands:')}`);
          console.log(muted(formatCommandHelp().split('\n').map((line) => `  ${line}`).join('\n')));
          console.log('');
          return true;

        case '/agents': {
          const agents = loadSubagents();
          console.log(`\n${fg.bold('Subagents:')}`);
          for (const agent of agents) {
            const source = agent.source === 'builtin' ? '' : ` ${muted(`(${agent.source})`)}`;
            console.log(`  ${fg(agent.name)}${source} — ${agent.description}`);
            console.log(muted(`    tools: ${agent.tools.join(', ')}`));
          }
          console.log('');
          return true;
        }

        case '/storage': {
          const stats = localStore.getStats();
          console.log(`\n${fg.bold('Local Storage Partition:')}`);
          console.log(`  ${muted('Storage dir:')} ${fg(stats.storageDir)}`);
          console.log(`  ${muted('DB:')} ${fg(stats.dbPath)} (${(stats.dbBytes / 1024).toFixed(1)} KB)`);
          console.log(`  ${muted('Sessions:')} ${fg(String(stats.sessionsCount))} | ${muted('Checkpoints:')} ${fg(String(stats.checkpointsCount))}\n`);
          return true;
        }

        case '/rewind': {
          const checkpoints = localStore.listCheckpoints(sessionId, 10);
          if (checkpoints.length === 0) {
            console.log(`${warning('No checkpoints to rewind.')}\n`);
            return true;
          }
          const latestTurn = checkpoints[0]!.turnIndex;
          for (const cp of checkpoints.filter((c) => c.turnIndex === latestTurn)) {
            if (!cp.existedBefore) {
              if (existsSync(cp.filePath)) unlinkSync(cp.filePath);
            } else if (cp.previousContent !== null) {
              mkdirSync(dirname(cp.filePath), { recursive: true });
              writeFileSync(cp.filePath, cp.previousContent, 'utf-8');
            }
            localStore.deleteCheckpoint(cp.id);
          }
          console.log(`${success(`Rewound turn ${latestTurn}.`)}\n`);
          return true;
        }

        case '/diff': {
          try {
            const out = execFileSync('git', ['diff'], { encoding: 'utf-8' }).trim();
            console.log(`\n${out || muted('(no unstaged changes)')}\n`);
          } catch (err) {
            console.log(`${danger(String(err))}\n`);
          }
          return true;
        }

        case '/provider': {
          const providers = ['ollama', 'lmstudio', 'openai', 'anthropic', 'google', 'groq', 'openrouter'];
          console.log(`\n${fg.bold('Available providers:')}`);
          providers.forEach((p, i) => {
            const marker = p === config.activeProvider ? ` ${success('(active)')}` : '';
            console.log(`  ${i + 1}. ${fg(p)}${marker}`);
          });
          const answer = parts[1];
          if (answer && providers.includes(answer)) {
            config.activeProvider = answer;
            state.modelInfo = await resolveModelInfo(config.activeModel, answer as Provider, config, localStore);
            try {
              state.model = createModelFromConfig(config);
              saveConfig(config);
              console.log(`${success(`Switched to ${answer}`)}\n`);
            } catch (err) {
              console.log(`${danger(`Error: ${err instanceof Error ? err.message : String(err)}`)}\n`);
            }
          }
          return true;
        }

        case '/model': {
          const prov = config.activeProvider as Provider;
          console.log(`\n${fg.bold(`Fetching models for ${prov}...`)}`);
          const models = await listAvailableModels(prov, config);
          if (models.length === 0) {
            console.log(`${warning('No models found. Is the provider running?')}\n`);
          } else {
            models.forEach((m, i) => {
              const marker = m.id === config.activeModel ? ` ${success('(active)')}` : '';
              console.log(`  ${i + 1}. ${fg(m.name)} ${muted(`(${m.id})`)}${marker}`);
            });
          }
          const modelId = parts[1];
          if (modelId) {
            config.activeModel = modelId;
            state.modelInfo = await resolveModelInfo(modelId, prov, config, localStore);
            try {
              state.model = createModelFromConfig(config);
              saveConfig(config);
              console.log(`${success(`Switched to model: ${modelId}`)}\n`);
            } catch (err) {
              console.log(`${danger(`Error: ${err instanceof Error ? err.message : String(err)}`)}\n`);
            }
          }
          return true;
        }

        case '/key': {
          const prov = parts[1];
          const key = parts[2];
          if (!prov || !key) {
            console.log(`${warning('Usage: /key <provider> <api_key>')}\n`);
          } else {
            setApiKey(prov, key);
            console.log(`${success(`API key saved for ${prov}`)}\n`);
          }
          return true;
        }

        case '/compact':
          console.log(warning('Compacting conversation...'));
          state.messages = await (await import('./agent/compaction.js')).compactMessages(state.messages, state.model);
          console.log(`${success(`Done. ${state.messages.length} messages remaining.`)}\n`);
          return true;

        case '/sessions': {
          const sessions = sessionStore.list();
          if (sessions.length === 0) {
            console.log(`${warning('No saved sessions.')}\n`);
          } else {
            console.log(`\n${fg.bold('Recent sessions:')}`);
            sessions.forEach((s, i) => {
              console.log(`  ${i + 1}. ${muted(`[${s.model}]`)} ${fg(s.title)} ${muted(`(${s.updatedAt})`)}`);
              console.log(muted(`     /resume ${s.id}`));
            });
            console.log('');
          }
          return true;
        }

        case '/resume': {
          const target = parts[1];
          if (!target) {
            console.log(`${warning('Usage: /resume <session-id>')}\n`);
            return true;
          }
          const session = sessionStore.load(target);
          if (!session) {
            console.log(`${danger(`Session not found: ${target}`)}\n`);
            return true;
          }
          try {
            state.messages = JSON.parse(session.messages) as CoreMessage[];
            sessionId = session.id;
            sessionTitle = session.title;
            sessionCreatedAt = session.createdAt;
            console.log(`${success(`Resumed "${session.title}" (${state.messages.length} messages)`)}\n`);
          } catch {
            console.log(`${danger('That session could not be parsed.')}\n`);
          }
          return true;
        }

        case '/new':
        case '/clear':
          state.messages = [];
          sessionId = sessionStore.generateId();
          sessionTitle = undefined;
          sessionCreatedAt = new Date().toISOString();
          console.log(`${success('Started a new conversation.')}\n`);
          return true;

        case '/init': {
          const result = initProjectFile();
          console.log(
            result.created
              ? `${success(`Created ${result.path}`)}\n`
              : `${warning(`${result.path} already exists.`)}\n`
          );
          return true;
        }

        case '/status':
          console.log(`\n${fg.bold(`Cortex ${VERSION}`)}`);
          console.log(`  ${muted('Provider:')} ${fg(config.activeProvider)}`);
          console.log(`  ${muted('Model:')} ${fg(config.activeModel)}`);
          console.log(`  ${muted('Mode:')} ${fg(state.permissionMode)}`);
          console.log(`  ${muted('Storage:')} ${fg(localStore.storageDir)}\n`);
          return true;

        case '/auto':
          state.permissionMode = state.permissionMode === 'auto' ? 'manual' : 'auto';
          for (const tool of CONFIRM_TOOL_NAMES) {
            if (state.permissionMode === 'auto') state.sessionApprovals.add(tool);
            else state.sessionApprovals.delete(tool);
          }
          console.log(`${success(`Mode: ${state.permissionMode}`)}\n`);
          return true;

        case '/plan':
          state.permissionMode = state.permissionMode === 'plan' ? 'manual' : 'plan';
          console.log(`${success(`Mode: ${state.permissionMode}`)}\n`);
          return true;

        case '/quit':
        case '/exit':
          await mcpManager.disconnect();
          sessionStore.close();
          console.log('\nGoodbye!');
          process.exit(0);

        default:
          return false;
      }
    };

    const approvalCallback: ApprovalCallback = async (toolName, args, diff) => {
      return new Promise((resolve) => {
        console.log(`\n${warning(`┌─ Tool: ${toolName}`)}`);
        if (toolName === 'bash_exec') {
          console.log(`${warning('│')} ${muted('Command:')} ${fg(String(args['command'] ?? ''))}`);
        } else if (toolName === 'edit_file' || toolName === 'write_file') {
          console.log(`${warning('│')} ${muted('File:')} ${fg(String(args['path'] ?? ''))}`);
          if (diff) {
            for (const line of diff.split('\n').slice(0, 30)) {
              if (line.startsWith('+')) console.log(`${warning('│')} ${success(line)}`);
              else if (line.startsWith('-')) console.log(`${warning('│')} ${danger(line)}`);
              else console.log(`${warning('│')} ${muted(line)}`);
            }
          }
        } else {
          console.log(`${warning('│')} ${muted('Args:')} ${fg(JSON.stringify(args).slice(0, 200))}`);
        }
        console.log(
          `${warning('└─')} ${fg.bold('[y]')} Allow once  ${fg.bold('[a]')} Allow session  ${fg.bold('[n]')} Reject`
        );

        const approvalRl = createInterface({ input: process.stdin, output: process.stdout });
        approvalRl.question(`${fg('  >')} `, (answer) => {
          approvalRl.close();
          const a = answer.trim().toLowerCase();
          if (a === 'a' || a === 'allow') resolve('allow_session');
          else if (a === 'n' || a === 'no' || a === 'reject') resolve('reject');
          else resolve('allow');
        });
      });
    };

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      ctrlCCount = 0;

      if (!input) {
        rl.prompt();
        return;
      }

      if (input.startsWith('/')) {
        const handled = await handleSlashCommand(input);
        if (handled) {
          rl.prompt();
          return;
        }
      }

      localStore.addPromptHistory(input, process.cwd());
      if (!sessionTitle) sessionTitle = sessionStore.generateTitle(input);
      const { expandedPrompt } = expandFileMentions(input);

      console.log('');
      try {
        await runAgentLoop(state, expandedPrompt, {
          onStream: (chunk) => process.stdout.write(chunk),
          onApproval: approvalCallback,
          onToolStart: (name) => console.log(`\n${muted(`[Running: ${name}]`)}`),
          onToolEnd: (name) => console.log(muted(`[Done: ${name}]`)),
          onSubagentEvent: (event) => {
            if (event.type === 'start') {
              console.log(muted(`\n[Subagent ${event.name}: ${event.description}]`));
            } else if (event.type === 'tool') {
              console.log(muted(`  [${event.name}] ${event.tool} ${event.detail}`));
            } else if (event.type === 'error') {
              console.log(danger(`[Subagent ${event.name} error: ${event.error}]`));
            }
          },
        });

        sessionStore.save({
          id: sessionId,
          title: sessionTitle,
          provider: config.activeProvider,
          model: config.activeModel,
          cwd: process.cwd(),
          messages: JSON.stringify(state.messages),
          createdAt: sessionCreatedAt,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`\n${danger(`Error: ${err instanceof Error ? err.message : String(err)}`)}`);
      }

      console.log('\n');
      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\nGoodbye!');
      void mcpManager.disconnect();
      sessionStore.close();
      process.exit(0);
    });
  }
}

await main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
