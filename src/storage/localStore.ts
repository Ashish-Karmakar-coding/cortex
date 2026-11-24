import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir, getStorageDir, loadConfig, saveConfig } from '../config/store.js';

export interface StorageManifest {
  version: number;
  storageId: string;
  storageDir: string;
  dbFile: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointRecord {
  id: number;
  sessionId: string;
  turnIndex: number;
  cwd: string;
  filePath: string;
  existedBefore: boolean;
  previousContent: string | null;
  createdAt: string;
}

export interface MemoryEntry {
  id: number;
  scope: 'global' | 'project';
  projectRoot: string;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolAuditEntry {
  id: number;
  sessionId: string;
  toolName: string;
  argsSummary: string;
  status: string;
  durationMs: number;
  createdAt: string;
}

export interface CachedModelCapabilities {
  provider: string;
  modelId: string;
  supportsTools: boolean;
  contextWindow: number;
  capabilities: string[];
  updatedAt: string;
}

export interface StorageStats {
  configDir: string;
  storageDir: string;
  dbPath: string;
  manifestPath: string;
  dbBytes: number;
  sessionsCount: number;
  checkpointsCount: number;
  memoryCount: number;
  promptHistoryCount: number;
  auditLogsCount: number;
}

export function getStorageDbPath(storageDir?: string): string {
  return join(storageDir ?? getStorageDir(), 'cortex.db');
}

/**
 * Create and verify the dedicated local storage partition on disk:
 *   <storageDir>/
 *     storage-manifest.json
 *     cortex.db
 *     backups/
 *     logs/
 *     cache/
 * Plus <configDir>/agents and <configDir>/mcp.json if absent.
 */
export function ensureStoragePartition(customStorageDir?: string): {
  created: boolean;
  manifest: StorageManifest;
  configDir: string;
  storageDir: string;
  dbPath: string;
} {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(configDir, 'agents'), { recursive: true });

  const mcpPath = join(configDir, 'mcp.json');
  if (!existsSync(mcpPath)) {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf-8');
  }

  const config = loadConfig();
  const storageDir = customStorageDir ? resolve(customStorageDir) : getStorageDir(config);
  if (customStorageDir && config.storageDir !== storageDir) {
    config.storageDir = storageDir;
    saveConfig(config);
  }

  const existed = existsSync(join(storageDir, 'cortex.db'));
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(join(storageDir, 'backups'), { recursive: true });
  mkdirSync(join(storageDir, 'logs'), { recursive: true });
  mkdirSync(join(storageDir, 'cache'), { recursive: true });

  const manifestPath = join(storageDir, 'storage-manifest.json');
  const now = new Date().toISOString();
  let manifest: StorageManifest;
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf-8')) as StorageManifest;
      manifest = {
        ...existing,
        storageDir,
        dbFile: 'cortex.db',
        updatedAt: now,
      };
    } catch {
      manifest = {
        version: 1,
        storageId: randomUUID(),
        storageDir,
        dbFile: 'cortex.db',
        createdAt: now,
        updatedAt: now,
      };
    }
  } else {
    manifest = {
      version: 1,
      storageId: randomUUID(),
      storageDir,
      dbFile: 'cortex.db',
      createdAt: now,
      updatedAt: now,
    };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  const store = new LocalStore(join(storageDir, 'cortex.db'));
  const dbPath = store.dbPath;
  store.close();

  return {
    created: !existed,
    manifest,
    configDir,
    storageDir,
    dbPath,
  };
}

export class LocalStore {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly storageDir: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ? resolve(dbPath) : getStorageDbPath();
    this.storageDir = dirname(this.dbPath);
    mkdirSync(this.storageDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
    this.migrateLegacySessionsIfNeeded();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        messages TEXT NOT NULL DEFAULT '[]',
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        file_path TEXT NOT NULL,
        existed_before INTEGER NOT NULL,
        previous_content TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints(session_id, id DESC);

      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        project_root TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scope_key
        ON memory_entries(scope, project_root, key);

      CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session
        ON tool_audit_logs(session_id, id DESC);

      CREATE TABLE IF NOT EXISTS model_capabilities_cache (
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        supports_tools INTEGER NOT NULL,
        context_window INTEGER NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, model_id)
      );
    `);

    // Add missing columns if upgrading an older DB file
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('cwd')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
    }
    if (!colNames.has('token_estimate')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0');
    }
  }

  private migrateLegacySessionsIfNeeded(): void {
    const flag = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('migrated_legacy_sessions') as { value: string } | undefined;
    if (flag?.value === '1') return;

    const legacyPath = join(getConfigDir(), 'sessions.db');
    if (resolve(legacyPath) !== resolve(this.dbPath) && existsSync(legacyPath)) {
      try {
        const legacyDb = new DatabaseSync(legacyPath);
        const rows = legacyDb
          .prepare('SELECT id, title, provider, model, messages, created_at, updated_at FROM sessions')
          .all() as Array<{
          id: string;
          title: string;
          provider: string;
          model: string;
          messages: string;
          created_at: string;
          updated_at: string;
        }>;
        const insert = this.db.prepare(`
          INSERT OR IGNORE INTO sessions (id, title, provider, model, cwd, messages, token_estimate, created_at, updated_at)
          VALUES (?, ?, ?, ?, '', ?, 0, ?, ?)
        `);
        for (const r of rows) {
          insert.run(r.id, r.title, r.provider, r.model, r.messages, r.created_at, r.updated_at);
        }
        legacyDb.close();
      } catch {
        // Ignore corrupt/empty legacy DB
      }
    }

    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('migrated_legacy_sessions', '1');
  }

  saveCheckpoint(entry: {
    sessionId: string;
    turnIndex: number;
    cwd: string;
    filePath: string;
    existedBefore: boolean;
    previousContent: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (session_id, turn_index, cwd, file_path, existed_before, previous_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      entry.sessionId,
      entry.turnIndex,
      entry.cwd,
      resolve(entry.filePath),
      entry.existedBefore ? 1 : 0,
      entry.previousContent,
      new Date().toISOString()
    );
    return Number(res.lastInsertRowid);
  }

  listCheckpoints(sessionId: string, limit = 30): CheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id as sessionId, turn_index as turnIndex, cwd, file_path as filePath,
                existed_before as existedBefore, previous_content as previousContent, created_at as createdAt
         FROM checkpoints
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(sessionId, limit) as Array<{
      id: number;
      sessionId: string;
      turnIndex: number;
      cwd: string;
      filePath: string;
      existedBefore: number;
      previousContent: string | null;
      createdAt: string;
    }>;
    return rows.map((r) => ({ ...r, existedBefore: Boolean(r.existedBefore) }));
  }

  deleteCheckpoint(id: number): void {
    this.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
  }

  addPromptHistory(prompt: string, cwd = process.cwd()): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const latest = this.db
      .prepare('SELECT prompt FROM prompt_history ORDER BY id DESC LIMIT 1')
      .get() as { prompt: string } | undefined;
    if (latest?.prompt === trimmed) return;

    this.db
      .prepare('INSERT INTO prompt_history (prompt, cwd, created_at) VALUES (?, ?, ?)')
      .run(trimmed, cwd, new Date().toISOString());

    // Keep history bounded to latest 500 entries
    this.db.exec(`
      DELETE FROM prompt_history
      WHERE id NOT IN (SELECT id FROM prompt_history ORDER BY id DESC LIMIT 500)
    `);
  }

  getPromptHistory(limit = 100): string[] {
    const rows = this.db
      .prepare('SELECT prompt FROM prompt_history ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ prompt: string }>;
    return rows.map((r) => r.prompt).reverse();
  }

  setMemory(
    scope: 'global' | 'project',
    key: string,
    content: string,
    projectRoot = ''
  ): void {
    const now = new Date().toISOString();
    const root = scope === 'global' ? '' : resolve(projectRoot || process.cwd());
    this.db
      .prepare(
        `INSERT INTO memory_entries (scope, project_root, key, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, project_root, key) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`
      )
      .run(scope, root, key.trim(), content.trim(), now, now);
  }

  listMemory(projectRoot = process.cwd()): MemoryEntry[] {
    const resolvedRoot = resolve(projectRoot);
    return this.db
      .prepare(
        `SELECT id, scope, project_root as projectRoot, key, content,
                created_at as createdAt, updated_at as updatedAt
         FROM memory_entries
         WHERE scope = 'global' OR (scope = 'project' AND project_root = ?)
         ORDER BY scope ASC, updated_at DESC`
      )
      .all(resolvedRoot) as unknown as MemoryEntry[];
  }

  deleteMemory(id: number): void {
    this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
  }

  logToolCall(entry: {
    sessionId: string;
    toolName: string;
    argsSummary: string;
    status: string;
    durationMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_audit_logs (session_id, tool_name, args_summary, status, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.sessionId,
        entry.toolName,
        entry.argsSummary.slice(0, 500),
        entry.status,
        entry.durationMs ?? 0,
        new Date().toISOString()
      );
  }

  getRecentAuditLogs(limit = 30): ToolAuditEntry[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, tool_name as toolName, args_summary as argsSummary,
                status, duration_ms as durationMs, created_at as createdAt
         FROM tool_audit_logs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as unknown as ToolAuditEntry[];
  }

  getCachedModelCapabilities(
    provider: string,
    modelId: string,
    maxAgeMs = 1000 * 60 * 60 * 24
  ): CachedModelCapabilities | null {
    const row = this.db
      .prepare(
        `SELECT provider, model_id as modelId, supports_tools as supportsTools,
                context_window as contextWindow, capabilities_json as capabilitiesJson,
                updated_at as updatedAt
         FROM model_capabilities_cache
         WHERE provider = ? AND model_id = ?`
      )
      .get(provider, modelId) as
      | {
          provider: string;
          modelId: string;
          supportsTools: number;
          contextWindow: number;
          capabilitiesJson: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    const age = Date.now() - new Date(row.updatedAt).getTime();
    if (Number.isFinite(age) && age > maxAgeMs) return null;

    let capabilities: string[] = [];
    try {
      capabilities = JSON.parse(row.capabilitiesJson) as string[];
    } catch {
      capabilities = [];
    }

    return {
      provider: row.provider,
      modelId: row.modelId,
      supportsTools: Boolean(row.supportsTools),
      contextWindow: row.contextWindow,
      capabilities,
      updatedAt: row.updatedAt,
    };
  }

  setCachedModelCapabilities(entry: {
    provider: string;
    modelId: string;
    supportsTools: boolean;
    contextWindow: number;
    capabilities?: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO model_capabilities_cache (provider, model_id, supports_tools, context_window, capabilities_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model_id) DO UPDATE SET
           supports_tools = excluded.supports_tools,
           context_window = excluded.context_window,
           capabilities_json = excluded.capabilities_json,
           updated_at = excluded.updated_at`
      )
      .run(
        entry.provider,
        entry.modelId,
        entry.supportsTools ? 1 : 0,
        entry.contextWindow,
        JSON.stringify(entry.capabilities ?? []),
        new Date().toISOString()
      );
  }

  getStats(): StorageStats {
    const count = (table: string) =>
      Number(
        (this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number })?.c ?? 0
      );
    let dbBytes = 0;
    try {
      dbBytes = statSync(this.dbPath).size;
    } catch {
      dbBytes = 0;
    }

    return {
      configDir: getConfigDir(),
      storageDir: this.storageDir,
      dbPath: this.dbPath,
      manifestPath: join(this.storageDir, 'storage-manifest.json'),
      dbBytes,
      sessionsCount: count('sessions'),
      checkpointsCount: count('checkpoints'),
      memoryCount: count('memory_entries'),
      promptHistoryCount: count('prompt_history'),
      auditLogsCount: count('tool_audit_logs'),
    };
  }

  close(): void {
    this.db.close();
  }
}
