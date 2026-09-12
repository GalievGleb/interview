import fs from 'node:fs';
import path from 'node:path';

interface AccountSessionState {
  version: 1;
  installationId: string | null;
  encryptedRefreshToken?: string;
}

export interface AccountSessionFiles {
  read(): string | null;
  write(value: string): void;
}

export interface AccountSessionEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const EMPTY_STATE: AccountSessionState = { version: 1, installationId: null };

export class AccountSessionStore {
  constructor(
    private readonly files: AccountSessionFiles,
    private readonly encryption: AccountSessionEncryption,
    private readonly createInstallationId: () => string,
  ) {}

  getInstallationId(): string {
    const state = this.readState();
    if (state.installationId) return state.installationId;
    state.installationId = this.createInstallationId();
    this.writeState(state);
    return state.installationId;
  }

  saveRefreshToken(refreshToken: string): void {
    if (!this.encryption.isAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
    const state = this.readState();
    state.installationId ??= this.createInstallationId();
    state.encryptedRefreshToken = this.encryption.encrypt(refreshToken).toString('base64');
    this.writeState(state);
  }

  loadRefreshToken(): string | null {
    const state = this.readState();
    if (!state.encryptedRefreshToken) return null;
    if (!this.encryption.isAvailable()) return null;
    try {
      return this.encryption.decrypt(Buffer.from(state.encryptedRefreshToken, 'base64'));
    } catch {
      delete state.encryptedRefreshToken;
      this.writeState(state);
      return null;
    }
  }

  clearRefreshToken(): void {
    const state = this.readState();
    delete state.encryptedRefreshToken;
    this.writeState(state);
  }

  private readState(): AccountSessionState {
    const raw = this.files.read();
    if (!raw) return { ...EMPTY_STATE };
    try {
      const parsed = JSON.parse(raw) as Partial<AccountSessionState>;
      if (
        parsed.version !== 1 ||
        (parsed.installationId !== null && typeof parsed.installationId !== 'string') ||
        (parsed.encryptedRefreshToken !== undefined && typeof parsed.encryptedRefreshToken !== 'string')
      ) return { ...EMPTY_STATE };
      return {
        version: 1,
        installationId: parsed.installationId ?? null,
        ...(parsed.encryptedRefreshToken ? { encryptedRefreshToken: parsed.encryptedRefreshToken } : {}),
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  private writeState(state: AccountSessionState): void {
    this.files.write(JSON.stringify(state));
  }
}

export function createAccountSessionFiles(filePath: string): AccountSessionFiles {
  return {
    read: () => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: (value) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
    },
  };
}
