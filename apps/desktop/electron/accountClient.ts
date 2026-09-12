import type {
  AuthResponse,
  DeviceInfo,
  ManagedLicenseResponse,
  RegistrationPendingResponse,
  SubscriptionInfo,
  UserProfile,
} from '@interview/shared';
import type { BuildChannel } from './buildChannel';

export interface PublicAccountState {
  available: boolean;
  authenticated: boolean;
  user: UserProfile | null;
  subscription: SubscriptionInfo | null;
  error: string | null;
}

interface AccountClientOptions {
  baseUrl: string;
  installationId: string;
  deviceName: string;
  deepLinkProtocol?: string;
  loadRefreshToken: () => string | null;
  saveRefreshToken: (token: string) => void;
  clearRefreshToken: () => void;
  installManagedLicense?: (key: string) => Promise<void>;
  clearManagedLicense?: () => Promise<void>;
  fetchImpl?: typeof fetch;
}

export function resolveAccountApiUrl(
  channel: BuildChannel,
  configured: string | undefined,
): string | null {
  if (channel === 'stable' || !configured?.trim()) return null;
  try {
    const url = new URL(configured.trim());
    const https = url.protocol === 'https:';
    const devLoopback = channel === 'dev' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (!https && !devLoopback) return null;
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

export class AccountClient {
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;
  private state: PublicAccountState = {
    available: true,
    authenticated: false,
    user: null,
    subscription: null,
    error: null,
  };

  constructor(private readonly options: AccountClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getState(): PublicAccountState {
    return { ...this.state };
  }

  register(email: string, password: string): Promise<RegistrationPendingResponse> {
    return this.post('/auth/register', {
      email, password,
      deviceId: this.options.installationId,
      deviceName: this.options.deviceName,
    });
  }

  async verifyEmail(email: string, code: string): Promise<PublicAccountState> {
    return this.consumeAuth(await this.post('/auth/verify-email', {
      email, code,
      deviceId: this.options.installationId,
      deviceName: this.options.deviceName,
    }));
  }

  async login(email: string, password: string): Promise<PublicAccountState> {
    return this.consumeAuth(await this.post('/auth/login', {
      email, password,
      deviceId: this.options.installationId,
      deviceName: this.options.deviceName,
    }));
  }

  async loginWithGoogle(idToken: string): Promise<PublicAccountState> {
    return this.consumeAuth(await this.post('/auth/google', {
      idToken,
      deviceId: this.options.installationId,
      deviceName: this.options.deviceName,
    }));
  }

  requestVerification(email: string): Promise<{ accepted: true }> {
    return this.post('/auth/verification/request', { email });
  }

  requestPasswordReset(email: string): Promise<{ accepted: true }> {
    return this.post('/auth/password-reset/request', { email });
  }

  confirmPasswordReset(email: string, code: string, password: string): Promise<{ changed: true }> {
    return this.post('/auth/password-reset/confirm', { email, code, password });
  }

  async restore(): Promise<PublicAccountState> {
    const refreshToken = this.options.loadRefreshToken();
    if (!refreshToken) return this.setSignedOut(null);
    try {
      return this.consumeAuth(await this.post('/auth/refresh', { refreshToken }));
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) {
        this.options.clearRefreshToken();
        return this.setSignedOut(null);
      }
      this.state = { ...this.state, error: safeErrorCode(error) };
      return this.getState();
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return this.authorized<DeviceInfo[]>('/auth/devices');
  }

  async refreshAccount(): Promise<PublicAccountState> {
    const [user, subscription] = await Promise.all([
      this.authorized<UserProfile>('/users/me'),
      this.authorized<SubscriptionInfo>('/subscriptions/me'),
    ]);
    this.state = {
      available: true,
      authenticated: true,
      user,
      subscription,
      error: null,
    };
    await this.trySyncManagedLicense();
    return this.getState();
  }

  async syncManagedLicense(): Promise<boolean> {
    if (!this.accessToken) return false;
    const entitlement = await this.authorized<ManagedLicenseResponse>(
      '/subscriptions/license', {}, false,
    );
    if (entitlement.active && entitlement.key) {
      await this.options.installManagedLicense?.(entitlement.key);
      return true;
    }
    await this.options.clearManagedLicense?.();
    return false;
  }

  async revokeDevice(sessionId: string): Promise<{ revoked: true }> {
    return this.authorized(`/auth/devices/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  async createCheckout(plan: 'BASIC' | 'PRO', provider: 'stripe' | 'yookassa', period: 'monthly' | 'yearly') {
    const channel = this.options.deepLinkProtocol === 'skillcue-alpha'
      ? 'alpha'
      : this.options.deepLinkProtocol === 'skillcue-dev'
        ? 'dev'
        : null;
    return this.authorized<{ checkoutUrl: string }>('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({
        plan,
        provider,
        period,
        ...(channel ? {
          successUrl: `https://skill-cue.ru/account-payment-success.html?channel=${channel}`,
          cancelUrl: `https://skill-cue.ru/account-payment-cancel.html?channel=${channel}`,
        } : {}),
      }),
    });
  }

  async logout(): Promise<PublicAccountState> {
    try {
      if (this.accessToken) await this.authorized('/auth/logout', { method: 'POST' }, false);
    } finally {
      this.options.clearRefreshToken();
      this.accessToken = null;
      await this.options.clearManagedLicense?.();
    }
    return this.setSignedOut(null);
  }

  private async consumeAuth(response: AuthResponse): Promise<PublicAccountState> {
    if (!response?.tokens?.accessToken || !response.tokens.refreshToken || !response.user) {
      throw new Error('ACCOUNT_RESPONSE_INVALID');
    }
    this.options.saveRefreshToken(response.tokens.refreshToken);
    this.accessToken = response.tokens.accessToken;
    this.state = {
      available: true,
      authenticated: true,
      user: response.user,
      subscription: response.subscription,
      error: null,
    };
    await this.trySyncManagedLicense();
    return this.getState();
  }

  private async trySyncManagedLicense(): Promise<void> {
    try {
      await this.syncManagedLicense();
    } catch {
      // Account login remains usable while the local backend is starting.
      // confirmBackendUp retries the entitlement sync once it is reachable.
    }
  }

  private setSignedOut(error: string | null): PublicAccountState {
    this.accessToken = null;
    this.state = {
      available: true, authenticated: false, user: null, subscription: null, error,
    };
    return this.getState();
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private async authorized<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    if (!this.accessToken) {
      const restored = await this.restore();
      if (!restored.authenticated) throw new AccountApiError(401, 'ACCOUNT_AUTH_REQUIRED');
    }
    try {
      return await this.request<T>(path, {
        ...init,
        headers: { ...headersObject(init.headers), Authorization: `Bearer ${this.accessToken}` },
      });
    } catch (error) {
      if (retry && error instanceof AccountApiError && error.status === 401) {
        this.accessToken = null;
        const restored = await this.restore();
        if (restored.authenticated) return this.authorized<T>(path, init, false);
      }
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...headersObject(init.headers) },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null) as T | unknown;
    if (!response.ok) {
      throw new AccountApiError(response.status, extractErrorCode(payload));
    }
    return payload as T;
  }
}

function extractErrorCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'ACCOUNT_REQUEST_FAILED';
  const value = payload as { code?: unknown; message?: unknown };
  if (typeof value.code === 'string') return value.code;
  if (typeof value.message === 'string') return value.message;
  if (value.message && typeof value.message === 'object') return extractErrorCode(value.message);
  return 'ACCOUNT_REQUEST_FAILED';
}

export class AccountApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function safeErrorCode(error: unknown): string {
  return error instanceof AccountApiError || error instanceof Error
    ? error.message
    : 'ACCOUNT_REQUEST_FAILED';
}
