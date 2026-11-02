import { useEffect, useState } from 'react';
import type { AttachmentRef } from '../../shared/api';
import { formatTimestamp, waveformPeaks } from '../../shared/media';
import { decodeMono } from '../lib/audio';
import { fmtBytes, studio } from '../lib/util';
import { Peaks, useObjectUrl } from './ui';

function useAttachmentBytes(id: string, frameIndex?: number): Uint8Array | null {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let live = true;
    studio()
      .attachments.bytes(id, frameIndex)
      .then((b) => live && setBytes(b))
      .catch(() => live && setBytes(null));
    return () => {
      live = false;
    };
  }, [id, frameIndex]);
  return bytes;
}

export function AudioPlayer({ src, peaks }: { src: string; peaks: number[] }) {
  return (
    <div className="audio">
      <Peaks peaks={peaks} />
      <audio controls src={src} preload="metadata" />
    </div>
  );
}

function StoredAudio({ att }: { att: AttachmentRef }) {
  const bytes = useAttachmentBytes(att.id);
  const url = useObjectUrl(bytes, att.mime);
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    if (!bytes) return;
    let live = true;
    decodeMono(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 8000)
      .then((s) => live && setPeaks(waveformPeaks(s, 48)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bytes]);
  return url ? <AudioPlayer src={url} peaks={peaks} /> : <span className="muted small">carregando áudio…</span>;
}

function Frame({ id, index, tSec }: { id: string; index: number; tSec: number }) {
  const bytes = useAttachmentBytes(id, index);
  const url = useObjectUrl(bytes, 'image/jpeg');
  return (
    <figure className="frame">
      {url ? <img src={url} alt={`Quadro em ${formatTimestamp(tSec)}`} /> : <div className="ph" />}
      <figcaption>{formatTimestamp(tSec)}</figcaption>
    </figure>
  );
}

function StoredImage({ att }: { att: AttachmentRef }) {
  const bytes = useAttachmentBytes(att.id);
  const url = useObjectUrl(bytes, att.mime);
  return url ? <img className="thumb" src={url} alt={att.name} /> : <div className="thumb ph" />;
}

export function AttachmentView({ att }: { att: AttachmentRef }) {
  if (att.kind === 'image') return <StoredImage att={att} />;
  if (att.kind === 'video') {
    return (
      <div className="att-card">
        <strong>🎞 {att.name}</strong>
        <span className="muted small">
          pipeline: {att.meta.frames?.length ?? 0} quadros de {formatTimestamp(att.meta.durationSec ?? 0)} (não é vídeo nativo)
        </span>
        <div className="frames">
          {(att.meta.frames ?? []).map((f, i) => (
            <Frame key={i} id={att.id} index={i} tSec={f.tSec} />
          ))}
        </div>
        {att.meta.transcript && (
          <details>
            <summary>Transcrição do áudio (ASR externo)</summary>
            <p className="small">{att.meta.transcript}</p>
          </details>
        )}
      </div>
    );
  }
  if (att.kind === 'audio') {
    return (
      <div className="att-card">
        <strong>🎙 {att.name}</strong>
        <StoredAudio att={att} />
        {att.meta.transcript && (
          <details open>
            <summary>Transcrição (ASR externo, não é entendimento do modelo)</summary>
            <p className="small">{att.meta.transcript}</p>
          </details>
        )}
      </div>
    );
  }
  return (
    <div className="att-card">
      <strong>{att.kind === 'pdf' ? '📄' : '📝'} {att.name}</strong>
      <span className="muted small">
        {fmtBytes(att.size)}
        {att.kind === 'pdf' && att.meta.pages !== undefined ? ` · texto extraído de ${att.meta.pages}/${att.meta.totalPages} págs` : ''}
        {att.meta.chars !== undefined ? ` · ${att.meta.chars.toLocaleString('pt-BR')} caracteres` : ''}
        {att.meta.truncated ? ' · truncado' : ''}
      </span>
    </div>
  );
}
