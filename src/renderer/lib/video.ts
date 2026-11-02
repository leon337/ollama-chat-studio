import { pickFrameTimestamps } from '../../shared/media';

// Vídeo NÃO é enviado ao modelo: viramos quadros JPEG com timestamps (pipeline do app).

function once(el: HTMLMediaElement, event: string, message: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(message)), timeoutMs);
    const onErr = () => done(new Error(message));
    const onOk = () => done();
    function done(err?: Error) {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
      err ? reject(err) : resolve();
    }
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

export interface ExtractedVideo {
  durationSec: number;
  frames: Array<{ tSec: number; bytes: Uint8Array }>;
}

export async function extractFrames(file: File, maxFrames = 8, maxWidth = 768): Promise<ExtractedVideo> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    const ready = once(video, 'loadedmetadata', 'Não foi possível ler o vídeo (formato ou codec não suportado).');
    video.src = url;
    await ready;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Duração do vídeo desconhecida.');
    const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((video.videoWidth || maxWidth) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || maxWidth) * scale));
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas indisponível.');
    const frames: ExtractedVideo['frames'] = [];
    for (const t of pickFrameTimestamps(duration, maxFrames)) {
      const seeked = once(video, 'seeked', 'Falha ao posicionar o vídeo no quadro.');
      video.currentTime = t;
      await seeked;
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
      if (!blob) throw new Error('Falha ao codificar quadro.');
      frames.push({ tSec: t, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return { durationSec: duration, frames };
  } finally {
    URL.revokeObjectURL(url);
  }
}
