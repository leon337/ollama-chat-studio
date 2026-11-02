import { useState } from 'react';
import type { ConversationSummary } from '../../shared/api';
import { fmtWhen } from '../lib/util';

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string, format: 'json' | 'md') => void;
}

export function Sidebar({ conversations, activeId, query, onQuery, onSelect, onNew, onRename, onDelete, onExport }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  return (
    <nav className="sidebar" aria-label="Conversas">
      <button className="primary wide-btn" onClick={onNew}>
        + Nova conversa
      </button>
      <input className="search" type="search" placeholder="Buscar no histórico…" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="Buscar conversas" />
      <ul>
        {conversations.length === 0 && <li className="muted small empty">{query ? 'Nada encontrado.' : 'Nenhuma conversa ainda.'}</li>}
        {conversations.map((c) => (
          <li key={c.id} className={c.id === activeId ? 'active' : ''}>
            {editing === c.id ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  if (title.trim()) onRename(c.id, title.trim());
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button className="conv" onClick={() => onSelect(c.id)} onDoubleClick={() => (setTitle(c.title), setEditing(c.id))} title="Duplo clique para renomear">
                <span className="ctitle">{c.title}</span>
                <span className="cmeta">
                  {c.model} · {fmtWhen(c.updatedAt)}
                </span>
              </button>
            )}
            {c.id === activeId && editing !== c.id && (
              <span className="conv-actions">
                <button title="Exportar Markdown" onClick={() => onExport(c.id, 'md')}>
                  MD
                </button>
                <button title="Exportar JSON" onClick={() => onExport(c.id, 'json')}>
                  JSON
                </button>
                <button
                  title="Excluir conversa"
                  onClick={() => window.confirm('Excluir esta conversa e seus anexos? Não dá para desfazer.') && onDelete(c.id)}
                >
                  🗑
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
