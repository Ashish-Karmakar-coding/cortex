import { randomUUID } from 'node:crypto';
import { LocalStore, getStorageDbPath } from '../storage/localStore.js';

export interface SessionRecord {
  id: string;
  title: string;
  provider: string;
  model: string;
  cwd?: string;
  messages: string; // JSON-serialized messages
  tokenEstimate?: number;
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  private store: LocalStore;

  constructor(dbPath?: string) {
    this.store = new LocalStore(dbPath ?? getStorageDbPath());
  }

  get rawStore(): LocalStore {
    return this.store;
  }

  save(session: SessionRecord): void {
    const stmt = this.store.db.prepare(`
      INSERT INTO sessions (id, title, provider, model, cwd, messages, token_estimate, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
        messages = excluded.messages,
        token_estimate = excluded.token_estimate,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      session.id,
      session.title,
      session.provider,
      session.model,
      session.cwd ?? process.cwd(),
      session.messages,
      session.tokenEstimate ?? 0,
      session.createdAt,
      session.updatedAt
    );
  }

  load(id: string): SessionRecord | null {
    const stmt = this.store.db.prepare(
      `SELECT id, title, provider, model, cwd, messages,
              token_estimate as tokenEstimate,
              created_at as createdAt, updated_at as updatedAt
       FROM sessions WHERE id = ?`
    );
    const row = stmt.get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  list(limit = 20): Array<{ id: string; title: string; updatedAt: string; model: string; cwd?: string }> {
    const stmt = this.store.db.prepare(
      `SELECT id, title, updated_at as updatedAt, model, cwd
       FROM sessions ORDER BY updated_at DESC LIMIT ?`
    );
    return stmt.all(limit) as Array<{
      id: string;
      title: string;
      updatedAt: string;
      model: string;
      cwd?: string;
    }>;
  }

  delete(id: string): void {
    const stmt = this.store.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(id);
  }

  generateId(): string {
    return randomUUID();
  }

  generateTitle(firstMessage: string): string {
    const cleaned = String(firstMessage ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Untitled session';
    if (cleaned.length <= 60) return cleaned;
    return cleaned.slice(0, 57) + '...';
  }

  close(): void {
    this.store.close();
  }
}
