import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/store.js';

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  serverName: string;
}

export async function loadMCPConfig(): Promise<MCPServerConfig[]> {
  const configPath = join(getConfigDir(), 'mcp.json');
  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { servers?: MCPServerConfig[] };
    return config.servers ?? [];
  } catch (err) {
    console.error('[MCP] Failed to read mcp.json:', err);
    return [];
  }
}

export class MCPManager {
  private clients = new Map<string, Client>();

  async connect(configs: MCPServerConfig[]): Promise<void> {
    for (const config of configs) {
      try {
        const client = new Client({
          name: 'cortex',
          version: '0.1.0',
        });

        if (config.transport === 'stdio') {
          if (!config.command) {
            console.error(`[MCP] Server "${config.name}": stdio transport requires a command`);
            continue;
          }

          const transport = new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
          });

          await client.connect(transport);
        } else if (config.transport === 'http') {
          if (!config.url) {
            console.error(`[MCP] Server "${config.name}": http transport requires a url`);
            continue;
          }

          // Streamable HTTP transport
          // Note: Import dynamically since it may not be available in all versions
          try {
            const { StreamableHTTPClientTransport } = await import(
              '@modelcontextprotocol/sdk/client/streamableHttp.js'
            );
            const transport = new StreamableHTTPClientTransport(new URL(config.url));
            await client.connect(transport);
          } catch (httpErr) {
            console.error(
              `[MCP] Server "${config.name}": Failed to connect via HTTP:`,
              httpErr
            );
            continue;
          }
        }

        this.clients.set(config.name, client);
        console.error(`[MCP] Connected to server: ${config.name}`);
      } catch (err) {
        console.error(`[MCP] Failed to connect to server "${config.name}":`, err);
      }
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const allTools: MCPToolDefinition[] = [];

    for (const [serverName, client] of this.clients) {
      try {
        const response = await client.listTools();
        for (const tool of response.tools) {
          allTools.push({
            name: `${serverName}__${tool.name}`,
            description: tool.description ?? '',
            parameters: (tool.inputSchema as Record<string, unknown>) ?? {},
            serverName,
          });
        }
      } catch (err) {
        console.error(`[MCP] Failed to list tools from "${serverName}":`, err);
      }
    }

    return allTools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      // Extract text content from result
      if (Array.isArray(result.content)) {
        return result.content
          .map((c: any) => {
            if (c.type === 'text') return c.text;
            return JSON.stringify(c);
          })
          .join('\n');
      }
      return JSON.stringify(result.content);
    } catch (err) {
      throw new Error(
        `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async disconnect(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch (err) {
        console.error(`[MCP] Error disconnecting from "${name}":`, err);
      }
    }
    this.clients.clear();
  }

  get connectedServers(): string[] {
    return [...this.clients.keys()];
  }
}
