import { encodeWav, resampleLinear } from '../../shared/media';

// Áudio no renderer: decodificação, gravação de microfone e TTS do sistema.
// ASR e TTS aqui são ADAPTADORES externos ao modelo (o LLM só lê/gera texto).

let ctx: AudioContext | null = null;
const audioCtx = () => (ctx ??= new AudioContext());

/** Decodifica qualquer áudio suportado pelo Chromium para PCM mono. */
export async function decodeMono(buf: ArrayBuffer, targetRate = 16000): Promise<Float32Array> {
  const audio = await audioCtx().decodeAudioData(buf.slice(0));
  const mix = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < mix.length; i++) mix[i]! += data[i]! / audio.numberOfChannels;
  }
  return resampleLinear(mix, audio.sampleRate, targetRate);
}

export async function toWav16k(buf: ArrayBuffer): Promise<{ wav: Uint8Array; samples: Float32Array; durationSec: number }> {
  const samples = await decodeMono(buf, 16000);
  return { wav: encodeWav(samples, 16000), samples, durationSec: samples.length / 16000 };
}

export class MicRecorder {
  private stream: MediaStream | undefined;
  private rec: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private raf = 0;
  private actx: AudioContext | undefined;

  async start(onLevel: (level: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.actx = new AudioContext();
    const analyser = this.actx.createAnalyser();
    analyser.fftSize = 512;
    this.actx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let max = 0;
      for (const v of buf) max = Math.max(max, Math.abs(v - 128) / 128);
      onLevel(max);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) return reject(new Error('Gravação não iniciada.'));
      rec.onstop = () => {
        this.cleanup();
        resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      rec.stop();
    });
  }

  cancel(): void {
    try {
      this.rec?.stop();
    } catch {
      /* já parado */
    }
    this.cleanup();
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.actx?.close();
  }
}

// ---- TTS (voz do sistema, local; adaptador, não capacidade do LLM) ----

export const ttsSupported = (): boolean => typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices().length > 0;

export async function ttsAvailable(): Promise<boolean> {
  try {
    const backend = await window.studio.tts.status();
    if (backend.available) return true;
  } catch { /* Fall back to browser speech if native IPC is unavailable. */ }
  return ttsSupported();
}


function plainSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (trecho de código) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]{1,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function speak(text: string, lang = 'pt-BR'): Promise<void> {
  const words = plainSpeech(text).slice(0, 4000);
  if (!words) return;
  const backend = await window.studio.tts.status();
  if (backend.available) {
    await window.studio.tts.speak(words);
    return;
  }
  if (!ttsSupported()) throw new Error('Nenhuma voz TTS disponível no dispositivo.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(words);
  u.lang = lang;
  speechSynthesis.speak(u);
}

export async function stopSpeaking(): Promise<void> {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  try { await window.studio.tts.stop(); } catch { /* app is closing */ }
}
