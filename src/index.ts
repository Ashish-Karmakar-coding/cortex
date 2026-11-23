import { Command } from 'commander';
import { loadConfig, saveConfig, setApiKey } from './config/store.js';
import { type Provider, getModelInfo, listAvailableModels } from './config/models.js';
import { createModel, createModelFromConfig } from './providers/factory.js';
import { runAgentLoop, type AgentState, type ApprovalCallback } from './agent/loop.js';
import { SessionStore } from './persistence/sessions.js';
import type { CoreMessage } from 'ai';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { VERSION, REPO } from './version.js';
import { palette, applyTerminalTheme } from './tui/palette.js';

const fg = chalk.hex(palette.fg);
const muted = chalk.hex(palette.muted);
const success = chalk.hex(palette.success);
const warning = chalk.hex(palette.warning);
const danger = chalk.hex(palette.danger);

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

function upgrade(): void {
  console.log(`Updating Cortex (${REPO}) to the latest release...`);
  const installerUrl = `https://raw.githubusercontent.com/${REPO}/main`;

  const result =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `irm ${installerUrl}/install.ps1 | iex`,
          ],
          { stdio: 'inherit' }
        )
      : spawnSync(
          'bash',
          ['-c', `curl -fsSL ${installerUrl}/install.sh | bash`],
          { stdio: 'inherit' }
        );

  if (result.error) {
    console.error(`\nUpdate failed: ${result.error.message}`);
    console.error(`Re-run the installer manually:\n  ${installerUrl}/install.sh`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('\nUpdate failed. Re-run the installer manually.');
    process.exit(result.status ?? 1);
  }
  console.log('\nCortex is up to date. Restart the CLI to use the new version.');
}


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
    console.log(muted('  /model /provider /key /compact /sessions /clear /help\n'));

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
      const cmd = parts[0]!.toLowerCase();

      switch (cmd) {
        case '/help':
          console.log(`\n${fg.bold('Slash Commands:')}`);
          console.log(muted('  /provider          — Switch LLM provider'));
          console.log(muted('  /model             — Select model'));
          console.log(muted('  /key <prov> <key>  — Save API key'));
          console.log(muted('  /compact           — Compact conversation context'));
          console.log(muted('  /sessions          — List/load previous sessions'));
          console.log(muted('  /clear             — Reset conversation'));
          console.log(muted('  /help              — Show this help\n'));
          return true;

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
              console.log(muted(`     ID: ${s.id}`));
            });
            console.log(muted('\n  Use --resume <session-id> to load a session.\n'));
          }
          return true;
        }

        case '/clear':
          state.messages = [];
          console.log(`${success('Conversation cleared.')}\n`);
          return true;

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
  upgrade();
  process.exit(0);
}

await main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
