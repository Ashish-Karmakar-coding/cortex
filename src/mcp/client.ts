import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jsonSchema, tool, type Tool } from 'ai';
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
  rawName: string;
  description: string;
  parameters: Record<string, unknown>;
  serverName: string;
}

interface RawMCPFile {
  servers?: MCPServerConfig[];
  mcpServers?: Record<
    string,
    {
      transport?: 'stdio' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    }
  >;
}

function parseMCPFile(configPath: string): MCPServerConfig[] {
  if (!existsSync(configPath)) return [];
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as RawMCPFile;
    const out: MCPServerConfig[] = [];

    if (Array.isArray(parsed.servers)) {
      out.push(...parsed.servers);
    }

    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      for (const [name, entry] of Object.entries(parsed.mcpServers)) {
        if (!entry || typeof entry !== 'object') continue;
        const transport: 'stdio' | 'http' =
          entry.transport ?? (entry.url ? 'http' : 'stdio');
        out.push({
          name,
          transport,
          command: entry.command,
          args: entry.args,
          url: entry.url,
          env: entry.env,
        });
      }
    }

    return out;
  } catch (err) {
    console.error(`[MCP] Failed to read ${configPath}:`, err);
    return [];
  }
}

export async function loadMCPConfig(cwd = process.cwd()): Promise<MCPServerConfig[]> {
  const byName = new Map<string, MCPServerConfig>();
  for (const srv of parseMCPFile(join(getConfigDir(), 'mcp.json'))) {
    byName.set(srv.name, srv);
  }
  for (const srv of parseMCPFile(join(cwd, '.cortex', 'mcp.json'))) {
    byName.set(srv.name, srv);
  }
  return [...byName.values()];
}

export class MCPManager {
  private clients = new Map<string, Client>();
  private cachedTools: MCPToolDefinition[] = [];

  async connect(configs: MCPServerConfig[]): Promise<void> {
    this.cachedTools = [];
    for (const config of configs) {
      try {
        const client = new Client({
          name: 'cortex',
          version: '0.2.0',
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
            stderr: 'ignore',
          });

          await client.connect(transport);
        } else if (config.transport === 'http') {
          if (!config.url) {
            console.error(`[MCP] Server "${config.name}": http transport requires a url`);
            continue;
          }

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
      } catch (err) {
        console.error(`[MCP] Failed to connect to server "${config.name}":`, err);
      }
    }
    this.cachedTools = await this.listTools();
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const allTools: MCPToolDefinition[] = [];

    for (const [serverName, client] of this.clients) {
      try {
        const response = await client.listTools();
        for (const t of response.tools) {
          allTools.push({
            name: `${serverName}__${t.name}`,
            rawName: t.name,
            description: t.description ?? `MCP tool ${t.name} from ${serverName}`,
            parameters: (t.inputSchema as Record<string, unknown>) ?? {
              type: 'object',
              properties: {},
            },
            serverName,
          });
        }
      } catch (err) {
        console.error(`[MCP] Failed to list tools from "${serverName}":`, err);
      }
    }

    this.cachedTools = allTools;
    return allTools;
  }

  getTools(): MCPToolDefinition[] {
    return this.cachedTools;
  }

  buildToolSet(): Record<string, Tool> {
    const out: Record<string, Tool> = {};
    for (const def of this.cachedTools) {
      const schemaObj =
        def.parameters && typeof def.parameters === 'object'
          ? { type: 'object', properties: {}, ...def.parameters }
          : { type: 'object', properties: {} };

      out[def.name] = tool({
        description: `[MCP:${def.serverName}] ${def.description}`,
        parameters: jsonSchema(schemaObj as Record<string, unknown>),
        execute: async (args) => {
          return this.callTool(
            def.serverName,
            def.rawName,
            (args ?? {}) as Record<string, unknown>
          );
        },
      }) as Tool;
    }
    return out;
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

      if (Array.isArray(result.content)) {
        return result.content
          .map((c: unknown) => {
            if (
              c &&
              typeof c === 'object' &&
              (c as Record<string, unknown>)['type'] === 'text' &&
              typeof (c as Record<string, unknown>)['text'] === 'string'
            ) {
              return (c as Record<string, string>)['text']!;
            }
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
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.clients.clear();
    this.cachedTools = [];
  }

  get connectedServers(): string[] {
    return [...this.clients.keys()];
  }
}
