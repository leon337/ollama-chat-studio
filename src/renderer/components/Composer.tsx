import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { AttachmentRef, ChatParams } from '../../shared/api';
import type { ModelCapabilities } from '../../shared/capabilities';
import { formatTimestamp, waveformPeaks } from '../../shared/media';
import { attachAccept, planRoute, type AdapterAvailability } from '../../shared/router';
import { MicRecorder, toWav16k } from '../lib/audio';
import { cleanError, fmtBytes, studio } from '../lib/util';
import { extractFrames } from '../lib/video';
import { AudioPlayer } from './AttachmentView';
import { Peaks } from './ui';
import { ModelReasoningPicker } from './ModelReasoningPicker';

interface Pending {
  ref: AttachmentRef;
  previewUrl?: string;
  audioUrl?: string;
  peaks?: number[];
}

interface Props {
  model: ModelCapabilities;
  models: ModelCapabilities[];
  params: ChatParams;
  onModelChange: (id: string) => void;
  onThinkingChange: (value: string) => void;
  onOpenCapabilities: () => void;
  toolsOn: boolean;
  adapters: AdapterAvailability;
  asrReason: string | null;
  streaming: boolean;
  onSend: (text: string, attachmentIds: string[]) => Promise<void>;
  onStop: () => void;
  onNotice: (text: string) => void;
}

const MAX_ATTACH = 10;
const MAX_REC_SEC = 300;
const MAX_VIDEO_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_AUDIO_SEC = 600;
const MAX_IPC_BYTES = 30 * 1024 * 1024;

export function Composer({ model, models, params, onModelChange, onThinkingChange, onOpenCapabilities, toolsOn, adapters, asrReason, streaming, onSend, onStop, onNotice }: Props) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const recorder = useRef<MicRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const accept = attachAccept(model, adapters);
  const plan = useMemo(
    () =>
      planRoute({
        model,
        attachments: pending.map((p) => p.ref.kind),
        tools: toolsOn,
        json: !!params.json,
        think: params.think ?? null,
        numCtx: params.num_ctx ?? null,
        adapters,
      }),
    [model, pending, toolsOn, params, adapters],
  );

  useEffect(
    () => () => {
      recorder.current?.cancel();
      for (const p of pendingRef.current) revoke(p);
    },
    [],
  );

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => {
    if (recording && recSec >= MAX_REC_SEC) void stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recSec, recording]);

  const revoke = (p: Pending) => {
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    if (p.audioUrl) URL.revokeObjectURL(p.audioUrl);
  };

  async function transcribe(wav: Uint8Array): Promise<string> {
    setBusy('Transcrevendo áudio no ASR externo…');
    return (await studio().audio.transcribe({ bytes: wav, mime: 'audio/wav' })).text;
  }

  async function addAudio(buf: ArrayBuffer, name: string) {
    if (!accept.audio.enabled) throw new Error(accept.audio.reason ?? 'Áudio indisponível.');
    setBusy('Preparando áudio…');
    const { wav, samples } = await toWav16k(buf);
    const transcript = await transcribe(wav);
    setBusy('Salvando anexo…');
    const ref = await studio().attachments.ingest({ name, mime: 'audio/wav', bytes: wav, transcript });
    const audioUrl = URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' }));
    setPending((p) => [...p, { ref, audioUrl, peaks: waveformPeaks(samples, 48) }]);
  }

  async function addVideo(f: File) {
    if (!accept.video.enabled) throw new Error(accept.video.reason ?? 'Vídeo indisponível.');
    setBusy('Extraindo quadros do vídeo…');
    const v = await extractFrames(f);
    let transcript: string | undefined;
    if (adapters.asr && f.size <= MAX_VIDEO_AUDIO_BYTES && v.durationSec <= MAX_VIDEO_AUDIO_SEC) {
      try {
        setBusy('Transcrevendo áudio do vídeo…');
        const { wav } = await toWav16k(await f.arrayBuffer());
        transcript = await transcribe(wav);
      } catch (e) {
        onNotice(`Áudio do vídeo não transcrito (${cleanError(e)}). Seguindo só com os quadros.`);
      }
    }
    setBusy('Salvando anexo…');
    const ref = await studio().attachments.ingestVideo({ name: f.name, mime: f.type || 'video/mp4', durationSec: v.durationSec, frames: v.frames, ...(transcript ? { transcript } : {}) });
    const previewUrl = URL.createObjectURL(new Blob([v.frames[0]!.bytes as BlobPart], { type: 'image/jpeg' }));
    setPending((p) => [...p, { ref, previewUrl }]);
  }

  async function addFile(f: File) {
    if (pendingRef.current.length >= MAX_ATTACH) throw new Error(`Máximo de ${MAX_ATTACH} anexos por mensagem.`);
    if (f.type.startsWith('video/')) return addVideo(f);
    if (f.type.startsWith('audio/')) return addAudio(await f.arrayBuffer(), f.name);
    if (f.type.startsWith('image/') && !accept.image.enabled) throw new Error(accept.image.reason ?? 'Imagens indisponíveis.');
    if (f.size > MAX_IPC_BYTES) throw new Error(`"${f.name}" é grande demais (limite ${fmtBytes(MAX_IPC_BYTES)}).`);
    setBusy(`Processando ${f.name}…`);
    const ref = await studio().attachments.ingest({ name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
    const previewUrl = ref.kind === 'image' ? URL.createObjectURL(f) : undefined;
    setPending((p) => [...p, { ref, ...(previewUrl ? { previewUrl } : {}) }]);
  }

  async function addFiles(files: File[]) {
    setError(null);
    for (const f of files) {
      try {
        await addFile(f);
      } catch (e) {
        setError(cleanError(e));
      }
    }
    setBusy(null);
  }

  async function startRecording() {
    setError(null);
    if (!accept.audio.enabled) return setError(accept.audio.reason ?? 'Áudio indisponível.');
    try {
      const r = new MicRecorder();
      await r.start(setLevel);
      recorder.current = r;
      setRecSec(0);
      setRecording(true);
    } catch (e) {
      setError(`Não foi possível acessar o microfone: ${cleanError(e)}`);
    }
  }

  async function stopRecording() {
    const r = recorder.current;
    recorder.current = null;
    setRecording(false);
    setLevel(0);
    if (!r) return;
    try {
      const blob = await r.stop();
      const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
      await addAudio(await blob.arrayBuffer(), `gravacao-${stamp}.wav`);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(null);
    }
  }

  function remove(i: number) {
    setPending((list) => {
      revoke(list[i]!);
      return list.filter((_, idx) => idx !== i);
    });
  }

  async function submit() {
    if (streaming || busy || !plan.ok || (!text.trim() && pending.length === 0)) return;
    setError(null);
    try {
      await onSend(text.trim(), pending.map((p) => p.ref.id));
      pending.forEach(revoke);
      setPending([]);
      setText('');
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles([...e.dataTransfer.files]);
  };

  const micDisabled = !accept.audio.enabled;
  const canSend = plan.ok && !busy && !recording && (text.trim().length > 0 || pending.length > 0);

  return (
    <div className={`composer${dragOver ? ' drag' : ''}`} onDragOver={(e) => (e.preventDefault(), setDragOver(true))} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      {pending.length > 0 && (
        <div className="pending">
          {pending.map((p, i) => (
            <div key={p.ref.id} className="pend">
              {p.ref.kind === 'image' && p.previewUrl && <img src={p.previewUrl} alt={p.ref.name} />}
              {p.ref.kind === 'video' && (
                <>
                  {p.previewUrl && <img src={p.previewUrl} alt="primeiro quadro" />}
                  <span className="small">
                    {p.ref.meta.frames?.length} quadros · {formatTimestamp(p.ref.meta.durationSec ?? 0)}
                    {p.ref.meta.transcript ? ' · com transcrição' : ''}
                  </span>
                </>
              )}
              {p.ref.kind === 'audio' && p.audioUrl && (
                <div className="pend-audio">
                  <AudioPlayer src={p.audioUrl} peaks={p.peaks ?? []} />
                  <span className="small muted" title={p.ref.meta.transcript}>
                    “{(p.ref.meta.transcript ?? '').slice(0, 90)}
                    {(p.ref.meta.transcript ?? '').length > 90 ? '…' : ''}”
                  </span>
                </div>
              )}
              {(p.ref.kind === 'pdf' || p.ref.kind === 'text') && (
                <span className="small">
                  {p.ref.kind === 'pdf' ? '📄' : '📝'} {p.ref.name}
                  <br />
                  <span className="muted">
                    {p.ref.kind === 'pdf' ? `${p.ref.meta.pages}/${p.ref.meta.totalPages} págs · ` : ''}
                    {fmtBytes(p.ref.size)}
                    {p.ref.meta.truncated ? ' · truncado' : ''}
                  </span>
                </span>
              )}
              <button className="icon x" onClick={() => remove(i)} aria-label={`Remover ${p.ref.name}`}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {plan.pipeline.length > 0 && (
        <div className="pipeline small">
          {plan.pipeline.map((s) => (
            <span key={s.id} className={`chip ${s.native ? 'native' : 'adapter'}`}>
              {s.label}
            </span>
          ))}
        </div>
      )}
      {plan.blocks.map((b, i) => (
        <div key={i} className="badge bad">
          {b.message}
        </div>
      ))}
      {plan.warnings.map((b, i) => (
        <div key={i} className="badge warn">
          {b.message}
        </div>
      ))}
      {error && <div className="badge bad">{error}</div>}
      {busy && <div className="badge info">{busy}</div>}

      {recording && (
        <div className="recording" role="status">
          <span className="dot" /> Gravando {formatTimestamp(recSec)}
          <Peaks peaks={Array.from({ length: 24 }, (_, i) => Math.max(0.05, level * (0.4 + 0.6 * Math.abs(Math.sin(i + recSec)))))} />
          <button onClick={() => void stopRecording()}>Parar e transcrever</button>
          <button
            onClick={() => {
              recorder.current?.cancel();
              recorder.current = null;
              setRecording(false);
              setLevel(0);
            }}
          >
            Descartar
          </button>
        </div>
      )}

      <div className="row compose-row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <button className="icon" title="Anexar arquivos (imagem, PDF, texto, áudio, vídeo)" aria-label="Anexar" disabled={!!busy || streaming} onClick={() => fileInput.current?.click()}>
          📎
        </button>
        <ModelReasoningPicker model={model} models={models} think={params.think} disabled={streaming || !!busy || recording}
          onModelChange={onModelChange} onThinkChange={onThinkingChange} onOpenCapabilities={onOpenCapabilities} />
        <button
          className={`icon${recording ? ' rec' : ''}`}
          disabled={micDisabled || !!busy || streaming}
          title={micDisabled ? (accept.audio.reason ?? asrReason ?? '') : recording ? 'Parar gravação' : 'Gravar voz (transcrita por ASR externo)'}
          aria-label="Microfone"
          onClick={() => (recording ? void stopRecording() : void startRecording())}
        >
          🎙
        </button>
        <textarea
          value={text}
          rows={2}
          placeholder={`Mensagem para ${model.displayName}… (Enter envia · Shift+Enter quebra linha)`}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {streaming ? (
          <button className="danger" onClick={onStop}>
            ■ Parar
          </button>
        ) : (
          <button className="primary" disabled={!canSend} onClick={() => void submit()}>
            Enviar
          </button>
        )}
      </div>
      <div className="hints small muted">
        {!accept.image.enabled && <span>🖼 imagem: {accept.image.reason}</span>}
        {!accept.audio.enabled && <span>🎙 áudio: {accept.audio.reason}</span>}
        {!accept.video.enabled && <span>🎞 vídeo: {accept.video.reason}</span>}
      </div>
    </div>
  );
}
