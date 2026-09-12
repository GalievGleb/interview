import assert from 'node:assert/strict';
import test from 'node:test';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

type FakeUser = {
  id: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  hwid: string | null;
  hwidChangedAt: Date | null;
  refreshToken: string | null;
};

function fixture(user: FakeUser | null = null) {
  let stored = user ? { ...user } : null;
  const issued: Array<{ email: string; purpose: string }> = [];
  const verified: Array<{ email: string; code: string; purpose: string }> = [];
  const claimedSubscriptions: string[] = [];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) return stored?.email === where.email ? { ...stored } : null;
        return stored?.id === where.id ? { ...stored } : null;
      },
      findUniqueOrThrow: async () => {
        if (!stored) throw new Error('missing');
        return { ...stored };
      },
      create: async ({ data }: { data: Partial<FakeUser> }) => {
        stored = {
          id: 'user-1',
          email: String(data.email),
          passwordHash: String(data.passwordHash),
          emailVerifiedAt: null,
          hwid: data.hwid ?? null,
          hwidChangedAt: null,
          refreshToken: null,
        };
        return { ...stored };
      },
      update: async ({ data }: { data: Partial<FakeUser> }) => {
        if (!stored) throw new Error('missing');
        stored = { ...stored, ...data };
        return { ...stored };
      },
    },
  };
  const jwt = {
    sign: (_payload: unknown, options: { secret: string }) =>
      options.secret.includes('refresh') ? 'refresh-token' : 'access-token',
    verify: () => ({ sub: 'user-1', email: stored?.email }),
  };
  const subscriptions = {
    claimPending: async (_userId: string, email: string) => { claimedSubscriptions.push(email); },
    getSubscriptionInfo: async () => ({
      plan: null,
      status: 'EXPIRED',
      currentPeriodEnd: null,
      sttMinutesUsed: 0,
      llmTokensUsed: 0,
      limits: null,
    }),
  };
  const authCodes = {
    issue: async (email: string, purpose: string) => { issued.push({ email, purpose }); },
    verify: async (email: string, code: string, purpose: string) => {
      verified.push({ email, code, purpose });
    },
  };
  const deviceSessions = {
    open: async () => ({ sessionId: 'session-1', refreshToken: 'session-1.refresh' }),
    refresh: async () => ({ userId: 'user-1', sessionId: 'session-1', refreshToken: 'session-1.rotated' }),
    revoke: async () => {},
    revokeAll: async () => {},
    list: async () => [
      { id: 'session-1', name: 'This PC', createdAt: '2026-09-13T00:00:00.000Z', lastSeenAt: '2026-09-13T00:00:00.000Z' },
      { id: 'session-2', name: 'Laptop', createdAt: '2026-09-13T00:00:00.000Z', lastSeenAt: '2026-09-13T00:00:00.000Z' },
    ],
  };
  const googleIdentities = {
    resolve: async () => ({
      id: 'google-user-1', email: 'google.user@example.com', passwordHash: null,
      emailVerifiedAt: new Date(), hwid: null, displayName: 'Google User', avatarUrl: null,
    }),
  };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    subscriptions as never,
    authCodes as never,
    deviceSessions as never,
    googleIdentities as never,
  );
  return { authCodes, claimedSubscriptions, get user() { return stored; }, issued, verified, service };
}

test('registration normalizes email and waits for verification before issuing a session', async () => {
  const state = fixture();

  const result = await state.service.register({
    email: ' Person@Example.COM ',
    password: 'strong-password',
    deviceId: 'installation-111111',
  });

  assert.deepEqual(result, { verificationRequired: true, email: 'person@example.com' });
  assert.equal(state.user?.email, 'person@example.com');
  assert.equal(state.user?.emailVerifiedAt, null);
  assert.deepEqual(state.issued, [{ email: 'person@example.com', purpose: 'verify_email' }]);
  assert.equal(state.user?.refreshToken, null);
});

test('login refuses an account whose email is not verified', async () => {
  const passwordHash = await bcrypt.hash('strong-password', 4);
  const state = fixture({
    id: 'user-1', email: 'person@example.com', passwordHash, emailVerifiedAt: null,
    hwid: null, hwidChangedAt: null, refreshToken: null,
  });

  await assert.rejects(
    () => state.service.login({
      email: 'PERSON@example.com',
      password: 'strong-password',
      deviceId: 'installation-111111',
    }),
    /Email verification required/,
  );
});

test('password reset request is generic and sends only for a verified account', async () => {
  const missing = fixture();
  const missingResult = await missing.service.requestPasswordReset('missing@example.com');
  assert.deepEqual(missingResult, { accepted: true });
  assert.deepEqual(missing.issued, []);

  const existing = fixture({
    id: 'user-1', email: 'person@example.com', passwordHash: 'old',
    emailVerifiedAt: new Date('2026-09-13T00:00:00.000Z'), hwid: null,
    hwidChangedAt: null, refreshToken: 'old-refresh',
  });
  const existingResult = await existing.service.requestPasswordReset(' Person@Example.com ');
  assert.deepEqual(existingResult, { accepted: true });
  assert.deepEqual(existing.issued, [{ email: 'person@example.com', purpose: 'reset_password' }]);
});

test('password reset consumes the code, replaces the hash, and revokes the old refresh token', async () => {
  const state = fixture({
    id: 'user-1', email: 'person@example.com', passwordHash: 'old',
    emailVerifiedAt: new Date('2026-09-13T00:00:00.000Z'), hwid: null,
    hwidChangedAt: null, refreshToken: 'old-refresh',
  });

  const result = await state.service.resetPassword({
    email: 'PERSON@example.com',
    code: '431209',
    password: 'new-strong-password',
  });

  assert.deepEqual(result, { changed: true });
  assert.deepEqual(state.verified, [
    { email: 'person@example.com', code: '431209', purpose: 'reset_password' },
  ]);
  assert.equal(await bcrypt.compare('new-strong-password', state.user?.passwordHash ?? ''), true);
  assert.equal(state.user?.refreshToken, null);
});

test('Google sign-in opens the same bounded device session and claims paid access', async (context) => {
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-which-is-at-least-32-characters';
  context.after(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });
  const state = fixture();

  const result = await state.service.loginWithGoogle({
    idToken: 'signed-google-id-token',
    deviceId: 'installation-111111',
    deviceName: 'Gleb PC',
  });

  assert.equal(result.user.email, 'google.user@example.com');
  assert.equal(result.tokens.refreshToken, 'session-1.refresh');
  assert.deepEqual(state.claimedSubscriptions, ['google.user@example.com']);
});

test('device list identifies only the session making the request', async () => {
  const state = fixture();

  const devices = await state.service.listDevices('user-1', 'session-1');

  assert.deepEqual(devices.map((device) => ({ id: device.id, current: device.current })), [
    { id: 'session-1', current: true },
    { id: 'session-2', current: false },
  ]);
});
