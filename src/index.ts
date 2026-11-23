import { Command } from 'commander';
import { loadConfig, saveConfig, setApiKey, getConfigDir } from './config/store.js';
import { type Provider, getModelInfo, listAvailableModels } from './config/models.js';
import { createModel, createModelFromConfig } from './providers/factory.js';
import { runAgentLoop, type AgentState, type ApprovalCallback } from './agent/loop.js';
import { SessionStore } from './persistence/sessions.js';
import type { CoreMessage } from 'ai';
import { createInterface } from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { VERSION } from './version.js';
import { upgrade } from './upgrade.js';
import { palette, applyTerminalTheme } from './tui/palette.js';
import { findSlashCommand, formatCommandHelp } from './tui/commands.js';
import { initProjectFile } from './agent/init.js';
import { loadSubagents } from './agent/subagents.js';

const fg = chalk.hex(palette.fg);
const muted = chalk.hex(palette.muted);
const success = chalk.hex(palette.success);
const warning = chalk.hex(palette.warning);
const danger = chalk.hex(palette.danger);

/** Tools that require approval unless auto-approve is enabled. */
const CONFIRM_TOOL_NAMES = ['write_file', 'edit_file', 'bash_exec', 'task'];

const program = new Command();

program
  .name('cortex')
  .description('Cortex — An agentic AI coding assistant for your terminal')
  .version(VERSION)
  .option('-p, --prompt <text>', 'Non-interactive prompt (pipe mode)')
  .option('--provider <name>', 'Override LLM provider')
  .option('--model <name>', 'Override model')
  .option('--yes', 'Auto-approve all tool calls')
  .option('--resume <session-id>', 'Resume a previous session')
  .option('--plain', 'Use plain line-by-line terminal mode instead of Ink TUI')
  .option('--num-ctx <number>', 'Set Ollama context window size', '16384');

program
  .command('upgrade')
  .description('Update Cortex to the latest release from GitHub')
  .action(() => {
    upgradeRequested = true;
  });

// Defining a subcommand makes Commander print help when the root command has no
// action. This no-op keeps `cortex` / `cortex --plain` working as before.
program.action(() => {});

let upgradeRequested = false;

await program.parseAsync(process.argv);

const opts = program.opts<{
  prompt?: string;
  provider?: string;
  model?: string;
  yes?: boolean;
  resume?: string;
  plain?: boolean;
  numCtx: string;
}>();


async function main() {
  const config = loadConfig();

  // Apply CLI overrides
  if (opts.provider) {
    config.activeProvider = opts.provider;
  }
  if (opts.model) {
    config.activeModel = opts.model;
  }
  if (opts.numCtx) {
    config.numCtx = parseInt(opts.numCtx, 10);
  }

  const provider = config.activeProvider as Provider;
  const modelInfo = getModelInfo(config.activeModel, provider);

  let model;
  try {
    model = createModelFromConfig(config);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Session management
  const sessionStore = new SessionStore();
  let messages: CoreMessage[] = [];
  let sessionId = sessionStore.generateId();

  if (opts.resume) {
    const session = sessionStore.load(opts.resume);
    if (session) {
      messages = JSON.parse(session.messages) as CoreMessage[];
      sessionId = session.id;
      console.error(`Resumed session: ${session.title}`);
    } else {
      console.error(`Session not found: ${opts.resume}`);
      process.exit(1);
    }
  }

  const state: AgentState = {
    messages,
    abortController: new AbortController(),
    isRunning: false,
    sessionApprovals: new Set(opts.yes ? ['write_file', 'edit_file', 'bash_exec'] : []),
    model,
    config,
    modelInfo,
  };

  const isTTY = process.stdin.isTTY && !opts.prompt;

  if (!isTTY) {
    // === Pipe / Non-Interactive Mode ===
    let input = '';

    if (!process.stdin.isTTY) {
      // Read stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      input = Buffer.concat(chunks).toString('utf-8');
    }

    const prompt = opts.prompt
      ? input
        ? `${opts.prompt}\n\n---\n\n${input}`
        : opts.prompt
      : input;

    if (!prompt.trim()) {
      console.error('Error: No input provided. Use -p "prompt" or pipe input.');
      process.exit(1);
    }

    // Auto-approve all tools in pipe mode
    const approvalCallback: ApprovalCallback = async () => 'allow';

    try {
      const result = await runAgentLoop(state, prompt, {
        onStream: (chunk) => process.stdout.write(chunk),
        onApproval: opts.yes ? approvalCallback : async (toolName, args) => {
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

      // Save session
      sessionStore.save({
        id: sessionId,
        title: sessionStore.generateTitle(prompt),
        provider: config.activeProvider,
        model: config.activeModel,
        messages: JSON.stringify(state.messages),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      process.stdout.write('\n');
      process.exit(0);
    } catch (err) {
      console.error(
        `\nError: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  } else if (!opts.plain) {
    // === Interactive Ink TUI Mode ===
    applyTerminalTheme();

    const { render } = await import('ink');
    const { default: React } = await import('react');
    const { App } = await import('./tui/App.js');

    render(
      React.createElement(App, {
        initialConfig: config,
        sessionId,
        initialMessages: messages,
        autoApprove: opts.yes,
      })
    );
  } else {
    // === Plain Terminal Readline Fallback Mode ===
    applyTerminalTheme();

    console.log(fg('╔══════════════════════════════════════════════╗'));
    console.log(`${fg('║')}  🤖 ${fg.bold('Cortex')} — Agentic AI Coding Assistant   ${fg('║')}`);
    console.log(fg('╚══════════════════════════════════════════════╝'));
    console.log(
      `  ${muted('Provider:')} ${fg(config.activeProvider)} ${muted('|')} ${muted('Model:')} ${fg(config.activeModel)}`
    );
    console.log(muted('  Type your request, or use slash commands:'));
    console.log(muted('  / commands — type /help for the full list\n'));

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${fg('cortex>')} `,
    });

    let ctrlCCount = 0;

    rl.on('SIGINT', () => {
      if (state.isRunning) {
        // Abort current operation
        state.abortController.abort();
        state.abortController = new AbortController();
        console.log(`\n${warning('[Interrupted]')}`);
        ctrlCCount = 0;
      } else {
        ctrlCCount++;
        if (ctrlCCount >= 2) {
          console.log('\nGoodbye!');
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
          console.log(
            `\n${fg.bold('Shortcuts:')}\n${muted(
              '  Ctrl+C  interrupt, or press twice to exit\n  /quit   exit Cortex'
            )}\n`
          );
          return true;

        case '/agents': {
          const agents = loadSubagents();
          console.log(`\n${fg.bold('Subagents:')}`);
          for (const agent of agents) {
            const source = agent.source === 'builtin' ? '' : ` ${muted(`(${agent.source})`)}`;
            console.log(`  ${fg(agent.name)}${source} — ${agent.description}`);
            console.log(muted(`    tools: ${agent.tools.join(', ')}`));
          }
          console.log(
            muted(
              `\n  Add custom agents in .cortex/agents/<name>.md or ${join(getConfigDir(), 'agents')}.\n`
            )
          );
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
            const newModelInfo = getModelInfo(config.activeModel, answer as Provider);
            state.modelInfo = newModelInfo;
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
            state.modelInfo = getModelInfo(modelId, prov);
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
            console.log(muted('\n  Use /resume <session-id> to load a session.\n'));
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
            console.log(
              `${success(`Resumed "${session.title}" (${state.messages.length} messages)`)}\n`
            );
          } catch {
            console.log(`${danger('That session could not be parsed.')}\n`);
          }
          return true;
        }

        case '/new':
        case '/clear':
          state.messages = [];
          sessionId = sessionStore.generateId();
          console.log(`${success('Started a new conversation.')}\n`);
          return true;

        case '/init': {
          try {
            const result = initProjectFile();
            console.log(
              result.created
                ? `${success(`Created ${result.path}`)}\n`
                : `${warning(`${result.path} already exists — edit it to describe this project.`)}\n`
            );
          } catch (err) {
            console.log(`${danger(`Could not create CORTEX.md: ${String(err)}`)}\n`);
          }
          return true;
        }

        case '/status':
          console.log(`\n${fg.bold(`Cortex ${VERSION}`)}`);
          console.log(`  ${muted('Provider:')} ${fg(config.activeProvider)}`);
          console.log(`  ${muted('Model:')} ${fg(config.activeModel)}`);
          console.log(`  ${muted('Context:')} ${fg(state.modelInfo.contextWindow.toLocaleString())} tokens`);
          console.log(`  ${muted('Messages:')} ${fg(String(state.messages.length))}`);
          console.log(`  ${muted('Session:')} ${fg(sessionId)}`);
          console.log(
            `  ${muted('Auto-approve:')} ${fg(
              CONFIRM_TOOL_NAMES.every((tool) => state.sessionApprovals.has(tool)) ? 'on' : 'off'
            )}`
          );
          console.log(`  ${muted('Config:')} ${fg(getConfigDir())}`);
          console.log(`  ${muted('cwd:')} ${fg(process.cwd())}\n`);
          return true;

        case '/doctor': {
          const checks: string[] = [];
          const [major, minor] = process.versions.node.split('.').map(Number);
          const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
          checks.push(`${nodeOk ? '✓' : '✗'} Node.js ${process.versions.node} (need >= 22.13)`);
          checks.push(`${existsSync(getConfigDir()) ? '✓' : '✗'} Config directory ${getConfigDir()}`);
          try {
            sessionStore.list();
            checks.push('✓ Session database readable');
          } catch (err) {
            checks.push(`✗ Session database: ${String(err)}`);
          }
          const prov = config.activeProvider as Provider;
          if (prov === 'ollama' || prov === 'lmstudio') {
            const baseUrl =
              config.providers[prov]?.baseUrl ??
              (prov === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1');
            const url = prov === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/models`;
            try {
              const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
              checks.push(`${response.ok ? '✓' : '✗'} ${prov} at ${baseUrl}`);
            } catch {
              checks.push(`✗ ${prov} not reachable at ${baseUrl}`);
            }
          } else {
            const key =
              config.providers[prov]?.apiKey ?? process.env[`${prov.toUpperCase()}_API_KEY`];
            checks.push(`${key ? '✓' : '✗'} ${prov} API key ${key ? 'configured' : 'missing'}`);
          }
          console.log(`\n${fg.bold('Diagnostics:')}`);
          console.log(muted(checks.map((line) => `  ${line}`).join('\n')));
          console.log('');
          return true;
        }

        case '/export': {
          const lines: string[] = [
            '# Cortex conversation',
            '',
            `- Exported: ${new Date().toISOString()}`,
            `- Provider: ${config.activeProvider}`,
            `- Model: ${config.activeModel}`,
            `- Session: ${sessionId}`,
            '',
          ];
          for (const message of state.messages) {
            if (message.role !== 'user' && message.role !== 'assistant') continue;
            const text =
              typeof message.content === 'string'
                ? message.content
                : Array.isArray(message.content)
                  ? message.content
                      .filter((part) => part.type === 'text')
                      .map((part) => (part as { text: string }).text)
                      .join('\n')
                  : '';
            if (!text.trim()) continue;
            lines.push(message.role === 'user' ? '## You' : '## Cortex', '', text, '');
          }
          const filePath = join(
            process.cwd(),
            `cortex-export-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}.md`
          );
          try {
            writeFileSync(filePath, lines.join('\n'), 'utf-8');
            console.log(`${success(`Exported to ${filePath}`)}\n`);
          } catch (err) {
            console.log(`${danger(`Export failed: ${String(err)}`)}\n`);
          }
          return true;
        }

        case '/auto': {
          const enabled = CONFIRM_TOOL_NAMES.every((tool) => state.sessionApprovals.has(tool));
          for (const tool of CONFIRM_TOOL_NAMES) {
            if (enabled) state.sessionApprovals.delete(tool);
            else state.sessionApprovals.add(tool);
          }
          console.log(
            `${success(`Auto-approve ${enabled ? 'disabled' : 'enabled'}.`)}\n`
          );
          return true;
        }

        case '/quit':
        case '/exit':
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
          console.log(`${warning('│')} ${muted('Command:')} ${fg(String((args as any).command))}`);
        } else if (toolName === 'edit_file' || toolName === 'write_file') {
          console.log(`${warning('│')} ${muted('File:')} ${fg(String((args as any).path))}`);
          if (diff) {
            console.log(`${warning('│')} ${muted('Diff:')}`);
            for (const line of diff.split('\n').slice(0, 30)) {
              if (line.startsWith('+')) {
                console.log(`${warning('│')} ${success(line)}`);
              } else if (line.startsWith('-')) {
                console.log(`${warning('│')} ${danger(line)}`);
              } else {
                console.log(`${warning('│')} ${muted(line)}`);
              }
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
          if (a === 'a' || a === 'allow') {
            resolve('allow_session');
          } else if (a === 'n' || a === 'no' || a === 'reject') {
            resolve('reject');
          } else {
            resolve('allow');
          }
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

      // Handle slash commands
      if (input.startsWith('/')) {
        const handled = await handleSlashCommand(input);
        if (handled) {
          rl.prompt();
          return;
        }
      }

      // Run agent loop
      console.log('');
      try {
        await runAgentLoop(state, input, {
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

        // Auto-save session
        sessionStore.save({
          id: sessionId,
          title: sessionStore.generateTitle(state.messages[0]?.content as string ?? 'untitled'),
          provider: config.activeProvider,
          model: config.activeModel,
          messages: JSON.stringify(state.messages),
          createdAt: new Date().toISOString(),
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
      sessionStore.close();
      process.exit(0);
    });
  }
}

if (upgradeRequested) {
  const ok = await upgrade();
  process.exit(ok ? 0 : 1);
}

await main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
