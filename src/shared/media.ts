// Utilitários puros de mídia (rodam no renderer e nos testes).

const round2 = (n: number) => Math.round(n * 100) / 100;

/** No máximo 1 quadro a cada 2 s, amostrando o centro de segmentos iguais. */
export function pickFrameTimestamps(durationSec: number, maxFrames: number): number[] {
  if (!(durationSec > 0) || !(maxFrames >= 1)) return [];
  const n = Math.min(Math.floor(maxFrames), Math.max(1, Math.ceil(durationSec / 2)));
  return Array.from({ length: n }, (_, i) => round2(((i + 0.5) / n) * durationSec));
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const len = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** PCM 16-bit mono em WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Picos normalizados para desenhar a forma de onda. */
export function waveformPeaks(samples: Float32Array, buckets: number): number[] {
  if (buckets < 1 || samples.length === 0) return [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    for (let i = start; i < Math.min(start + size, samples.length); i++) max = Math.max(max, Math.abs(samples[i] ?? 0));
    peaks.push(round2(max));
  }
  return peaks;
}
