import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountApi } from './accountApi';

describe('renderer account API', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: {}, writable: true, configurable: true,
    });
  });

  it('reports account service unavailable outside the Alpha Electron bridge', async () => {
    await expect(accountApi.getState()).resolves.toMatchObject({
      available: false,
      authenticated: false,
    });
  });

  it('delegates Google sign-in without accepting or returning refresh credentials', async () => {
    const googleLogin = vi.fn(async () => ({
      available: true, authenticated: true,
      user: { id: 'user-1', email: 'person@example.com', displayName: null, avatarUrl: null },
      subscription: null, error: null,
    }));
    window.electronAPI = { account: { googleLogin } } as never;

    const result = await accountApi.googleLogin();

    expect(googleLogin).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('refresh');
  });
});
