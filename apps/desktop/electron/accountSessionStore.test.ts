import { describe, expect, it } from 'vitest';
import { AccountSessionStore } from './accountSessionStore';

function fixture(initial: string | null = null, encryptionAvailable = true) {
  let content = initial;
  let generated = 0;
  const files = {
    read: () => content,
    write: (value: string) => { content = value; },
  };
  const encryption = {
    isAvailable: () => encryptionAvailable,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decrypt: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/u, ''),
  };
  const store = new AccountSessionStore(files, encryption, () => `installation-${++generated}-long`);
  return { store, content: () => content };
}

describe('account session store', () => {
  it('persists a stable random installation ID and never writes the refresh token in plaintext', () => {
    const state = fixture();

    const installationId = state.store.getInstallationId();
    state.store.saveRefreshToken('private-refresh-token');

    expect(state.store.getInstallationId()).toBe(installationId);
    expect(state.store.loadRefreshToken()).toBe('private-refresh-token');
    expect(state.content() ?? '').not.toContain('private-refresh-token');
    expect(state.content()).toContain('installation-1-long');
  });

  it('recovers from a corrupt state without exposing or reusing bad token data', () => {
    const state = fixture('{broken-json');

    expect(state.store.loadRefreshToken()).toBeNull();
    expect(state.store.getInstallationId()).toBe('installation-1-long');
    expect(() => JSON.parse(state.content() ?? '')).not.toThrow();
  });

  it('fails closed instead of storing a refresh token without OS encryption', () => {
    const state = fixture(null, false);

    expect(() => state.store.saveRefreshToken('private-refresh-token')).toThrow(
      'SECURE_STORAGE_UNAVAILABLE',
    );
    expect(state.content() ?? '').not.toContain('private-refresh-token');
  });

  it('clears only the account credential and keeps the installation identity', () => {
    const state = fixture();
    const installationId = state.store.getInstallationId();
    state.store.saveRefreshToken('private-refresh-token');

    state.store.clearRefreshToken();

    expect(state.store.loadRefreshToken()).toBeNull();
    expect(state.store.getInstallationId()).toBe(installationId);
  });
});
