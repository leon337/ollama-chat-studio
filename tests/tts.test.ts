import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ttsTextSchema } from '../src/main/ipc-schemas';
import { NativeLinuxTts } from '../src/main/tts';

type ChildTest = EventEmitter & {
  stdin: { end: (text: string) => void; on: (event: string, cb: () => void) => void };
  kill: (sig: string) => void;
};

function fixture() {
  const launches: Array<{ binary: string; args: string[]; options: any; input: string; signals: string[]; child: ChildTest }> = [];
  const states: Array<{ playing: boolean; error?: string }> = [];
  const runner = (binary: string, args: string[], options: any) => {
    const child = new EventEmitter() as ChildTest;
    const launched = { binary, args, options, input: '', signals: [] as string[], child };
    child.stdin = {
      end: (input: string) => { launched.input += input; },
      on: () => {},
    };
    child.kill = (sig: string) => { launched.signals.push(sig); };
    launches.push(launched);
    return child;
  };
  const service = new NativeLinuxTts((state) => states.push(state), runner as any, 'linux', '/usr/bin/spd-say', () => true);
  return { service, launches, states };
}

describe('TTS nativo isolado e seguro', () => {
  it('stdin, caminho absoluto e flags fixas, sem shell ou prompt em argv', () => {
    const { service, launches, states } = fixture();
    expect(service.status()).toEqual({ available: true, backend: 'speech-dispatcher' });
    const untrusted = 'Olá; rm -rf / && echo qualquer coisa';
    expect(service.speak(untrusted)).toEqual({ started: true });
    expect(launches).toHaveLength(1);
    const [item] = launches;
    expect(item!.binary).toBe('/usr/bin/spd-say');
    expect(item!.options.shell).toBe(false);
    expect(item!.args).toEqual(['--wait', '--pipe-mode', '--language', 'pt-BR', '--application-name', 'ollama-chat-studio']);
    expect(item!.args.join(' ')).not.toContain(untrusted);
    expect(item!.input).toBe(untrusted + '\n');
    expect(states.at(-1)).toEqual({ playing: true });
    item!.child.emit('close', 0);
    expect(states.at(-1)).toEqual({ playing: false });
  });
  it('recusa outros tipos, valores vazios, comandos via CLI e textos longos', () => {
    const { service, launches } = fixture();
    expect(ttsTextSchema.safeParse({ text: 'foo' }).success).toBe(false);
    expect(ttsTextSchema.safeParse('x'.repeat(4001)).success).toBe(false);
    expect(() => service.speak('')).toThrow();
    expect(() => service.speak('x'.repeat(4001))).toThrow();
    expect(() => service.speak('\n')).toThrow();
    expect(launches).toHaveLength(0);
  });
  it('stop interrompe a fala e envia somente comando --stop limitado', () => {
    const { service, launches, states } = fixture();
    service.speak('Teste de voz');
    service.stop();
    expect(launches).toHaveLength(2);
    expect(launches[0]!.signals).toEqual(['SIGTERM']);
    expect(launches[1]!.args).toEqual(['--stop', '--application-name', 'ollama-chat-studio']);
    expect(launches[1]!.options.shell).toBe(false);
    expect(states.at(-1)).toEqual({ playing: false });
    launches[0]!.child.emit('close', -1);
    expect(states.at(-1)).toEqual({ playing: false });
  });
  it('sem Linux, sem backend externo', () => {
    const { service } = fixture();
    const nonLinux = new NativeLinuxTts(() => {}, undefined, 'win32');
    expect(nonLinux.status()).toEqual({ available: false, backend: 'none' });
    expect(() => nonLinux.speak('ola')).toThrow();
    const missingBinary = new NativeLinuxTts(() => {}, undefined, 'linux', '/usr/bin/spd-say', () => false);
    expect(missingBinary.status()).toEqual({ available: false, backend: 'none' });
    expect(() => missingBinary.speak('ola')).toThrow();
    service.stop();
  });
});
