import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

export type TtsState = { playing: boolean; error?: string };
type SpawnTts = typeof spawn;

/** Fixed Linux speech synthesis command, no shell, stdin-only utterances. */
export class NativeLinuxTts {
  private current: ChildProcess | null = null;
  private sequence = 0;

  constructor(
    private readonly emit: (state: TtsState) => void,
    private readonly runner: SpawnTts = spawn,
    private readonly platform: string = process.platform,
    private readonly binary = '/usr/bin/spd-say',
  ) {}

  available(): boolean {
    if (this.platform !== 'linux') return false;
    try { accessSync(this.binary, constants.X_OK); return true; } catch { return false; }
  }

  status(): { available: boolean; backend: 'speech-dispatcher' | 'none' } {
    return { available: this.available(), backend: this.available() ? 'speech-dispatcher' : 'none' };
  }

  speak(text: string): { started: boolean } {
    if (!this.available()) throw new Error('Speech Dispatcher indisponível no Linux.');
    if (typeof text !== 'string' || text.length < 1 || text.length > 4000) throw new Error('Texto TTS fora dos limites.');
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!clean) throw new Error('Texto TTS vazio.');
    this.stop();
    const seq = ++this.sequence;
    const child = this.runner(this.binary, ['--wait', '--pipe-mode', '--language', 'pt-BR', '--application-name', 'ollama-chat-studio'], {
      shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    });
    this.current = child;
    child.once('error', () => {
      if (this.current === child && seq === this.sequence) {
        this.current = null;
        this.emit({ playing: false, error: 'Falha ao iniciar o sintetizador.' });
      }
    });
    child.once('close', (code) => {
      if (this.current === child && seq === this.sequence) {
        this.current = null;
        this.emit(code === 0 ? { playing: false } : { playing: false, error: 'Falha ao reproduzir voz.' });
      }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(clean + '\n');
    this.emit({ playing: true });
    return { started: true };
  }

  stop(): void {
    const active = this.current;
    this.current = null;
    this.sequence++;
    if (active) {
      active.kill('SIGTERM');
      const stopper = this.runner(this.binary, ['--stop', '--application-name', 'ollama-chat-studio'], {
        shell: false, stdio: 'ignore', windowsHide: true,
      });
      stopper.on('error', () => {});
      this.emit({ playing: false });
    }
  }
}
