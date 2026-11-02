import { OllamaError } from './errors';

/** Semáforo FIFO. A conta Free permite 1 modelo na nuvem por vez; o excedente entra em fila local. */
export class ConcurrencyLimiter {
  private active = 0;
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; signal: AbortSignal | undefined; onAbort?: () => void }> = [];

  constructor(
    private max: number,
    private readonly maxQueue = 20,
  ) {}

  setMax(n: number): void {
    this.max = Math.max(1, Math.floor(n));
    this.drain();
  }

  get stats() {
    return { active: this.active, queued: this.waiters.length, max: this.max };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new OllamaError('ABORTED', 'Cancelado antes de entrar na fila.');
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new OllamaError('QUEUE_FULL', 'Fila local cheia; aguarde as requisições atuais terminarem.');
    }
    await new Promise<void>((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new OllamaError('ABORTED', 'Cancelado enquanto aguardava na fila.'));
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.active++;
      w.resolve();
    }
  }
}
