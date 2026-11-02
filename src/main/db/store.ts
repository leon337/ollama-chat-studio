import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AttachmentRef, ConversationSummary, StoredMessage, ToolCallRecord, UsageInfo } from '../../shared/api';
import type { AttachmentKind } from '../../shared/router';
import { migrate } from './migrations';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

type Row = Record<string, unknown>;

export interface NewMessage {
  conversationId: string;
  role: StoredMessage['role'];
  content: string;
  model?: string;
  status?: StoredMessage['status'];
  error?: string;
  usage?: UsageInfo;
  toolCalls?: ToolCallRecord[];
}

export interface StoredAttachment extends AttachmentRef {
  path: string;
  sha256: string;
  messageId: string | null;
}

export interface AuditEntry {
  conversationId: string | null;
  callId: string;
  tool: string;
  risk: string;
  argsJson: string;
  decision: 'auto' | 'approved' | 'denied' | 'blocked';
  outcome: 'ok' | 'error' | 'skipped';
  resultPreview?: string;
}

/** Converte texto livre em consulta FTS5 segura (cada termo entre aspas, o último como prefixo). */
export function toFtsQuery(input: string): string | null {
  const terms = input.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
}

export class Store {
  constructor(readonly db: DatabaseSync) {}

  // ---- conversas ----
  createConversation(model: string, title = 'Nova conversa'): ConversationSummary {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO conversations(id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, title, model, now, now);
    return { id, title, model, updatedAt: now };
  }

  listConversations(query?: string): ConversationSummary[] {
    const map = (r: Row): ConversationSummary => ({
      id: r.id as string,
      title: r.title as string,
      model: r.model as string,
      updatedAt: r.updated_at as number,
    });
    const fts = query ? toFtsQuery(query) : null;
    if (!fts) {
      return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Row[]).map(map);
    }
    const like = `%${query!.replace(/[%_]/g, '')}%`;
    return (
      this.db
        .prepare(
          `SELECT DISTINCT c.* FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id AND m.superseded = 0
           WHERE c.title LIKE ? OR m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)
           ORDER BY c.updated_at DESC`,
        )
        .all(like, fts) as Row[]
    ).map(map);
  }

  getConversation(id: string): ConversationSummary | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id as string, title: r.title as string, model: r.model as string, updatedAt: r.updated_at as number } : undefined;
  }

  renameConversation(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title.slice(0, 120), Date.now(), id);
  }

  setConversationModel(id: string, model: string): void {
    this.db.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(model, id);
  }

  /** Remove a conversa e devolve os caminhos de arquivos de anexo para limpeza. */
  deleteConversation(id: string): string[] {
    const paths = (
      this.db
        .prepare('SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?')
        .all(id) as Row[]
    ).map((r) => r.path as string);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return paths;
  }

  // ---- mensagens ----
  addMessage(m: NewMessage): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO messages(id,conversation_id,role,content,model,status,error,usage_json,tool_calls_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        m.conversationId,
        m.role,
        m.content,
        m.model ?? null,
        m.status ?? 'complete',
        m.error ?? null,
        m.usage ? JSON.stringify(m.usage) : null,
        m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
        now,
      );
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, m.conversationId);
    return id;
  }

  getMessage(id: string): StoredMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? this.mapMessage(r) : undefined;
  }

  listMessages(conversationId: string, includeSuperseded = false): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ${includeSuperseded ? '' : 'AND superseded = 0'} ORDER BY rowid`)
      .all(conversationId) as Row[];
    return rows.map((r) => this.mapMessage(r));
  }

  /** Edição/reenvio: preserva o histórico anterior, apenas o marca como substituído (soft-delete). */
  supersedeFrom(messageId: string): void {
    const r = this.db.prepare('SELECT rowid AS rid, conversation_id FROM messages WHERE id = ?').get(messageId) as Row | undefined;
    if (!r) return;
    this.db.prepare('UPDATE messages SET superseded = 1 WHERE conversation_id = ? AND rowid >= ?').run(r.conversation_id as string, r.rid as number);
  }

  /** Regenerar: substitui tudo depois da última mensagem do usuário. */
  supersedeAfterLastUser(conversationId: string): void {
    const r = this.db
      .prepare("SELECT MAX(rowid) AS rid FROM messages WHERE conversation_id = ? AND role = 'user' AND superseded = 0")
      .get(conversationId) as Row;
    if (r.rid == null) return;
    this.db.prepare('UPDATE messages SET superseded = 1 WHERE conversation_id = ? AND rowid > ?').run(conversationId, r.rid as number);
  }

  private mapMessage(r: Row): StoredMessage {
    const msg: StoredMessage = {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      role: r.role as StoredMessage['role'],
      content: r.content as string,
      createdAt: r.created_at as number,
      status: r.status as StoredMessage['status'],
      attachments: this.attachmentsOf(r.id as string),
      toolCalls: r.tool_calls_json ? (JSON.parse(r.tool_calls_json as string) as ToolCallRecord[]) : [],
    };
    if (r.model) msg.model = r.model as string;
    if (r.error) msg.error = r.error as string;
    if (r.usage_json) msg.usage = JSON.parse(r.usage_json as string) as UsageInfo;
    return msg;
  }

  // ---- anexos ----
  insertAttachment(a: { kind: AttachmentKind; name: string; mime: string; size: number; sha256: string; path: string; meta: AttachmentRef['meta'] }): AttachmentRef {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO attachments(id,message_id,kind,name,mime,size,sha256,path,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, null, a.kind, a.name, a.mime, a.size, a.sha256, a.path, JSON.stringify(a.meta), Date.now());
    return { id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, meta: a.meta };
  }

  getAttachment(id: string): StoredAttachment | undefined {
    const r = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Row | undefined;
    return r ? this.mapAttachment(r) : undefined;
  }

  /** Reenvio de mensagem editada: duplica a linha do anexo (mesmo arquivo) para a nova mensagem. */
  cloneAttachment(id: string, newMessageId: string): string | undefined {
    const a = this.getAttachment(id);
    if (!a) return undefined;
    const newId = randomUUID();
    this.db
      .prepare('INSERT INTO attachments(id,message_id,kind,name,mime,size,sha256,path,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(newId, newMessageId, a.kind, a.name, a.mime, a.size, a.sha256, a.path, JSON.stringify(a.meta), Date.now());
    return newId;
  }

  bindAttachments(messageId: string, ids: string[]): void {
    const stmt = this.db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL');
    for (const id of ids) stmt.run(messageId, id);
  }

  private attachmentsOf(messageId: string): AttachmentRef[] {
    return (this.db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at').all(messageId) as Row[]).map((r) => {
      const { path: _p, sha256: _s, messageId: _m, ...ref } = this.mapAttachment(r);
      return ref;
    });
  }

  private mapAttachment(r: Row): StoredAttachment {
    return {
      id: r.id as string,
      kind: r.kind as AttachmentKind,
      name: r.name as string,
      mime: r.mime as string,
      size: r.size as number,
      meta: JSON.parse(r.meta_json as string) as AttachmentRef['meta'],
      path: r.path as string,
      sha256: r.sha256 as string,
      messageId: (r.message_id as string | null) ?? null,
    };
  }

  // ---- auditoria de tools / notas / configurações ----
  addAudit(a: AuditEntry): void {
    this.db
      .prepare('INSERT INTO tool_audit(id,conversation_id,call_id,tool,risk,args_json,decision,outcome,result_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), a.conversationId, a.callId, a.tool, a.risk, a.argsJson, a.decision, a.outcome, a.resultPreview ?? null, Date.now());
  }

  listAudit(limit = 100): Row[] {
    return this.db.prepare('SELECT * FROM tool_audit ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
  }

  addNote(title: string, content: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO notes(id,title,content,created_at) VALUES (?,?,?,?)').run(id, title, content, Date.now());
    return id;
  }

  searchMessages(query: string, limit = 5): Array<{ conversationId: string; role: string; snippet: string }> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    return (
      this.db
        .prepare(
          `SELECT m.conversation_id AS cid, m.role AS role, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip
           FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE messages_fts MATCH ? AND m.superseded = 0 ORDER BY rank LIMIT ?`,
        )
        .all(fts, limit) as Row[]
    ).map((r) => ({ conversationId: r.cid as string, role: r.role as string, snippet: r.snip as string }));
  }

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? (JSON.parse(r.value_json as string) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(value));
  }

  // ---- exportação ----
  exportConversation(id: string, format: 'json' | 'md'): string {
    const conv = this.getConversation(id);
    if (!conv) throw new Error('Conversa não encontrada.');
    const msgs = this.listMessages(id);
    if (format === 'json') {
      return JSON.stringify({ conversation: conv, messages: msgs, exportedAt: new Date().toISOString() }, null, 2);
    }
    const lines = [`# ${conv.title}`, '', `Modelo: ${conv.model}`, ''];
    for (const m of msgs) {
      lines.push(`## ${m.role === 'user' ? 'Você' : m.role === 'assistant' ? `Assistente (${m.model ?? conv.model})` : m.role}`, '');
      for (const a of m.attachments) lines.push(`_Anexo: ${a.name} (${a.kind})_`, '');
      lines.push(m.content, '');
      if (m.usage) lines.push(`_tokens: ${m.usage.promptTokens ?? '?'} entrada / ${m.usage.completionTokens ?? '?'} saída · ${m.usage.totalMs ?? '?'} ms_`, '');
    }
    return lines.join('\n');
  }
}
