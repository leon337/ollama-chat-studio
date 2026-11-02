import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Migrations são append-only: nunca edite uma já publicada, crie a próxima versão.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-schema',
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','cancelled','error')),
        error TEXT,
        usage_json TEXT,
        tool_calls_json TEXT,
        superseded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_conv ON messages(conversation_id, superseded);
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image','audio','video','pdf','text')),
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_attachments_msg ON attachments(message_id);
      CREATE TABLE tool_audit (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        risk TEXT NOT NULL,
        args_json TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('auto','approved','denied','blocked')),
        outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','skipped')),
        result_preview TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'messages-fts',
    sql: `
      CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages;
    `,
  },
];

export function currentVersion(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/** Aplica migrations pendentes, cada uma em sua transação. Recusa bancos de versão futura. */
export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number {
  const latest = Math.max(0, ...migrations.map((m) => m.version));
  const current = currentVersion(db);
  if (current > latest) {
    throw new Error(`Banco na versão ${current}, mas este app conhece até a ${latest}. Atualize o app.`);
  }
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Falha na migration ${m.version} (${m.name}): ${(e as Error).message}`);
    }
  }
  return currentVersion(db);
}
