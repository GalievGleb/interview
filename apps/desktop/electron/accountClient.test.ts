import { describe, expect, it, vi } from 'vitest';
import { AccountClient, resolveAccountApiUrl } from './accountClient';

const authPayload = {
  user: { id: 'user-1', email: 'person@example.com', displayName: null, avatarUrl: null },
  tokens: { accessToken: 'short-access', refreshToken: 'private-refresh' },
  subscription: {
    plan: null, status: 'EXPIRED', currentPeriodEnd: null,
    sttMinutesUsed: 0, llmTokensUsed: 0, limits: null,
  },
};

describe('account API configuration', () => {
  it('keeps Stable disabled and requires HTTPS for Alpha', () => {
    expect(resolveAccountApiUrl('stable', 'https://skill-cue.ru/account')).toBeNull();
    expect(resolveAccountApiUrl('alpha', 'http://skill-cue.ru/account')).toBeNull();
    expect(resolveAccountApiUrl('alpha', 'https://skill-cue.ru/account/')).toBe('https://skill-cue.ru/account');
  });

  it('allows loopback HTTP only for local Dev work', () => {
    expect(resolveAccountApiUrl('dev', 'http://127.0.0.1:8788/')).toBe('http://127.0.0.1:8788');
    expect(resolveAccountApiUrl('alpha', 'http://127.0.0.1:8788')).toBeNull();
  });
});

describe('account client', () => {
  it('stores refresh credentials outside the renderer-facing result', async () => {
    let stored: string | null = null;
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      loadRefreshToken: () => stored,
      saveRefreshToken: (token) => { stored = token; },
      clearRefreshToken: () => { stored = null; },
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => authPayload } as Response)),
    });

    const result = await client.loginWithGoogle('signed-google-id-token');

    expect(stored).toBe('private-refresh');
    expect(JSON.stringify(result)).not.toContain('private-refresh');
    expect(result.authenticated).toBe(true);
  });

  it('installs the account entitlement locally without exposing its signed key', async () => {
    let stored: string | null = null;
    const installed: string[] = [];
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(
      String(url).endsWith('/subscriptions/license')
        ? { active: true, key: 'SKILLCUE-private-managed-key', expiresAt: '2026-09-14T12:00:00.000Z' }
        : authPayload,
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      loadRefreshToken: () => stored,
      saveRefreshToken: (token) => { stored = token; },
      clearRefreshToken: () => { stored = null; },
      installManagedLicense: async (key) => { installed.push(key); },
      clearManagedLicense: async () => undefined,
      fetchImpl,
    });

    const state = await client.loginWithGoogle('signed-google-id-token');

    expect(installed).toEqual(['SKILLCUE-private-managed-key']);
    expect(JSON.stringify(state)).not.toContain('SKILLCUE-private-managed-key');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('removes only the managed entitlement on logout', async () => {
    let stored: string | null = null;
    let cleared = 0;
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(
      String(url).endsWith('/subscriptions/license')
        ? { active: false, key: null, expiresAt: null }
        : String(url).endsWith('/auth/logout')
          ? { ok: true }
          : authPayload,
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      loadRefreshToken: () => stored,
      saveRefreshToken: (token) => { stored = token; },
      clearRefreshToken: () => { stored = null; },
      installManagedLicense: async () => undefined,
      clearManagedLicense: async () => { cleared += 1; },
      fetchImpl,
    });
    await client.loginWithGoogle('signed-google-id-token');

    await client.logout();

    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(stored).toBeNull();
  });

  it('rotates the stored refresh token while restoring a session', async () => {
    let stored: string | null = 'old-refresh';
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        ...authPayload,
        tokens: { accessToken: 'new-access', refreshToken: 'rotated-refresh' },
      }),
    } as Response));
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      loadRefreshToken: () => stored,
      saveRefreshToken: (token) => { stored = token; },
      clearRefreshToken: () => { stored = null; },
      fetchImpl,
    });

    const result = await client.restore();

    expect(result.authenticated).toBe(true);
    expect(stored).toBe('rotated-refresh');
    expect(await (fetchImpl.mock.calls[0][1]?.body as string)).toContain('old-refresh');
  });

  it('clears an invalid refresh session instead of retrying forever', async () => {
    let stored: string | null = 'invalid-refresh';
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      loadRefreshToken: () => stored,
      saveRefreshToken: (token) => { stored = token; },
      clearRefreshToken: () => { stored = null; },
      fetchImpl: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as Response)),
    });

    const result = await client.restore();

    expect(result.authenticated).toBe(false);
    expect(stored).toBeNull();
  });

  it('extracts a stable code from a nested Nest error payload', async () => {
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      loadRefreshToken: () => null,
      saveRefreshToken: () => undefined,
      clearRefreshToken: () => undefined,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        statusCode: 409,
        message: { code: 'DEVICE_LIMIT_REACHED', message: 'Two devices are already active' },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } })),
    });

    await expect(client.login('person@example.com', 'strong-password'))
      .rejects.toThrow('DEVICE_LIMIT_REACHED');
  });

  it('uses an HTTPS return page for YooKassa and only then returns to Alpha', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = new AccountClient({
      baseUrl: 'https://skill-cue.ru/account',
      installationId: 'installation-111111',
      deviceName: 'Gleb PC',
      deepLinkProtocol: 'skillcue-alpha',
      loadRefreshToken: () => null,
      saveRefreshToken: () => undefined,
      clearRefreshToken: () => undefined,
      fetchImpl: vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body ?? '') });
        return new Response(JSON.stringify(
          requests.length === 1 ? authPayload : { checkoutUrl: 'https://yookassa.ru/pay' },
        ), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    });
    await client.loginWithGoogle('signed-google-id-token');

    await client.createCheckout('PRO', 'yookassa', 'monthly');

    const checkoutRequest = requests.find(({ url }) => url.endsWith('/billing/checkout'));
    const checkout = JSON.parse(checkoutRequest?.body ?? '') as { successUrl: string; cancelUrl: string };
    expect(checkout.successUrl).toBe('https://skill-cue.ru/account-payment-success.html?channel=alpha');
    expect(checkout.cancelUrl).toBe('https://skill-cue.ru/account-payment-cancel.html?channel=alpha');
  });
});
