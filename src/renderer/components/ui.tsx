import { useEffect, useMemo, type ReactNode } from 'react';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** URL de objeto criada a partir de bytes e revogada automaticamente. */
export function useObjectUrl(bytes: Uint8Array | null | undefined, mime: string): string | null {
  const url = useMemo(() => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) : null), [bytes, mime]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

export function Peaks({ peaks }: { peaks: number[] }) {
  return (
    <svg className="peaks" viewBox={`0 0 ${peaks.length * 3} 24`} preserveAspectRatio="none" aria-hidden="true">
      {peaks.map((p, i) => {
        const h = Math.max(1, p * 22);
        return <rect key={i} x={i * 3} y={12 - h / 2} width={2} height={h} rx={1} />;
      })}
    </svg>
  );
}
