import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from '../config/store.js';

export interface SessionRecord {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: string; // JSON-serialized messages
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(getConfigDir(), 'sessions.db');
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  save(session: SessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, title, provider, model, messages, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.title,
      session.provider,
      session.model,
      session.messages,
      session.createdAt,
      session.updatedAt
    );
  }

  load(id: string): SessionRecord | null {
    const stmt = this.db.prepare(
      'SELECT id, title, provider, model, messages, created_at as createdAt, updated_at as updatedAt FROM sessions WHERE id = ?'
    );
    const row = stmt.get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  list(): Array<{ id: string; title: string; updatedAt: string; model: string }> {
    const stmt = this.db.prepare(
      'SELECT id, title, updated_at as updatedAt, model FROM sessions ORDER BY updated_at DESC LIMIT 20'
    );
    return stmt.all() as Array<{
      id: string;
      title: string;
      updatedAt: string;
      model: string;
    }>;
  }

  delete(id: string): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(id);
  }

  generateId(): string {
    return randomUUID();
  }

  generateTitle(firstMessage: string): string {
    const cleaned = firstMessage.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= 60) return cleaned;
    return cleaned.slice(0, 57) + '...';
  }

  close(): void {
    this.db.close();
  }
}
