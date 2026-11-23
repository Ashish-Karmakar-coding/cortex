export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
  /** Argument hint shown in the palette, e.g. `<provider> <key>`. */
  args?: string;
  aliases?: string[];
}

/**
 * Single source of truth for the `/` palette and /help output.
 * Keep names short: the palette filters by prefix as the user types.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show commands, shortcuts, and tips',
    aliases: ['?'],
  },
  {
    name: 'model',
    description: 'Choose a model (local or cloud)',
    aliases: ['models'],
  },
  {
    name: 'provider',
    description: 'Switch LLM provider',
    aliases: ['providers'],
  },
  {
    name: 'key',
    description: 'Save an API key for a provider',
    args: '<provider> <key>',
  },
  {
    name: 'compact',
    description: 'Compress the conversation context',
  },
  {
    name: 'sessions',
    description: 'List saved sessions',
  },
  {
    name: 'resume',
    description: 'Resume a saved session',
    args: '[session-id]',
  },
  {
    name: 'new',
    description: 'Start a fresh conversation',
  },
  {
    name: 'clear',
    description: 'Clear messages and context',
  },
  {
    name: 'init',
    description: 'Analyze the repo and create CORTEX.md',
  },
  {
    name: 'agents',
    description: 'List available subagents and their tools',
  },
  {
    name: 'status',
    description: 'Show model, context, and session info',
  },
  {
    name: 'doctor',
    description: 'Check Node, providers, and configuration',
  },
  {
    name: 'export',
    description: 'Export this conversation to Markdown',
  },
  {
    name: 'auto',
    description: 'Toggle auto-approve for tool calls',
  },
  {
    name: 'quit',
    description: 'Exit Cortex',
    aliases: ['exit', 'q'],
  },
];

const MAX_VISIBLE = 8;

export function filterSlashCommands(query: string): SlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return SLASH_COMMANDS.slice(0, MAX_VISIBLE);
  }

  return SLASH_COMMANDS.filter((command) => {
    if (command.name.startsWith(normalized)) return true;
    if (command.aliases?.some((alias) => alias.startsWith(normalized))) return true;
    return command.description.toLowerCase().includes(normalized);
  });
}

export function findSlashCommand(value: string): SlashCommand | undefined {
  const name = value.replace(/^\//, '').split(/\s+/)[0]?.toLowerCase();
  if (!name) return undefined;
  return SLASH_COMMANDS.find(
    (command) =>
      command.name === name || command.aliases?.some((alias) => alias === name)
  );
}

/** Human-readable command list for /help and plain mode. */
export function formatCommandHelp(): string {
  const width = Math.max(
    ...SLASH_COMMANDS.map(
      (command) =>
        command.name.length + (command.args ? command.args.length + 1 : 0)
    )
  );
  return SLASH_COMMANDS.map((command) => {
    const usage = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
    return `${usage.padEnd(width + 4)}${command.description}`;
  }).join('\n');
}
