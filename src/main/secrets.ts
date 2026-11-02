import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStatus } from '../shared/api';

// Cofre de segredos. A chave só existe em claro na memória do processo main.
// Em disco fica apenas o blob cifrado por safeStorage (DPAPI / Keychain / libsecret).

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
  /** Linux: 'basic_text' significa SEM cofre real (chave fraca fixa) -> recusamos. */
  getSelectedStorageBackend?(): string;
}

export class SecretStoreError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'INSECURE_BACKEND' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

export class SecretStore {
  private cache: string | undefined;

  constructor(
    private readonly safe: SafeStorageLike,
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private backend(): string | null {
    return this.safe.getSelectedStorageBackend?.() ?? null;
  }

  private secure(): boolean {
    return this.safe.isEncryptionAvailable() && this.backend() !== 'basic_text';
  }

  status(): SecretStatus {
    const stored = this.readStored() !== undefined;
    const envKey = !!this.env.OLLAMA_API_KEY?.trim();
    return {
      configured: stored || envKey,
      source: stored ? 'vault' : envKey ? 'env' : 'none',
      backend: this.backend(),
      secure: this.secure(),
    };
  }

  /** Uso interno do main (adapter). Nunca exposto via IPC. */
  get(): string | undefined {
    return this.readStored() ?? (this.env.OLLAMA_API_KEY?.trim() || undefined);
  }

  set(key: string): void {
    const clean = key.trim();
    if (clean.length < 8 || /\s/.test(clean)) throw new SecretStoreError('INVALID', 'Chave inválida.');
    if (!this.safe.isEncryptionAvailable()) {
      throw new SecretStoreError('UNAVAILABLE', 'Cofre do sistema indisponível; a chave não será gravada em texto puro.');
    }
    if (this.backend() === 'basic_text') {
      throw new SecretStoreError(
        'INSECURE_BACKEND',
        'O Linux está sem chaveiro (libsecret/gnome-keyring). Instale/abra o chaveiro ou use a variável OLLAMA_API_KEY no terminal.',
      );
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.safe.encryptString(clean), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* alguns FS não suportam */
    }
    this.cache = clean;
  }

  clear(): void {
    this.cache = undefined;
    if (existsSync(this.file)) unlinkSync(this.file);
  }

  private readStored(): string | undefined {
    if (this.cache) return this.cache;
    if (!existsSync(this.file) || !this.secure()) return undefined;
    try {
      this.cache = this.safe.decryptString(readFileSync(this.file));
      return this.cache;
    } catch {
      return undefined;
    }
  }
}
