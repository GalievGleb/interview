import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GoogleIdentityPayload,
  GoogleIdentityService,
} from './google-identity.service';

const nowSeconds = Math.floor(Date.now() / 1000);

function fixture(payload: GoogleIdentityPayload) {
  const resolved: Array<Record<string, unknown>> = [];
  const verifier = { verify: async () => payload };
  const repository = {
    resolve: async (identity: Record<string, unknown>) => {
      resolved.push(identity);
      return {
        id: 'user-1', email: identity.email as string, passwordHash: null,
        emailVerifiedAt: new Date(), hwid: null,
        displayName: (identity.displayName as string | null | undefined) ?? null,
        avatarUrl: (identity.avatarUrl as string | null | undefined) ?? null,
      };
    },
  };
  return {
    service: new GoogleIdentityService(verifier, repository as never, {
      clientId: 'skillcue-client.apps.googleusercontent.com',
    }),
    resolved,
  };
}

test('accepts a valid Google identity and keys it by immutable subject', async () => {
  const state = fixture({
    iss: 'https://accounts.google.com', aud: 'skillcue-client.apps.googleusercontent.com',
    exp: nowSeconds + 300, sub: 'google-subject-123', email: ' Person@Example.COM ',
    email_verified: true, name: 'Person', picture: 'https://example.com/avatar.png',
  });

  const user = await state.service.resolve('signed-google-token');

  assert.equal(user.id, 'user-1');
  assert.deepEqual(state.resolved, [{
    subject: 'google-subject-123', email: 'person@example.com',
    displayName: 'Person', avatarUrl: 'https://example.com/avatar.png',
  }]);
});

test('rejects an unverified Google email', async () => {
  const state = fixture({
    iss: 'https://accounts.google.com', aud: 'skillcue-client.apps.googleusercontent.com',
    exp: nowSeconds + 300, sub: 'subject', email: 'person@example.com', email_verified: false,
  });

  await assert.rejects(() => state.service.resolve('token'), /GOOGLE_IDENTITY_INVALID/);
  assert.deepEqual(state.resolved, []);
});

test('rejects wrong audience, issuer, or expired assertions even after signature verification', async () => {
  for (const changed of [
    { aud: 'another-client' },
    { iss: 'https://attacker.example' },
    { exp: nowSeconds - 1 },
  ]) {
    const state = fixture({
      iss: 'https://accounts.google.com', aud: 'skillcue-client.apps.googleusercontent.com',
      exp: nowSeconds + 300, sub: 'subject', email: 'person@example.com',
      email_verified: true, ...changed,
    });
    await assert.rejects(() => state.service.resolve('token'), /GOOGLE_IDENTITY_INVALID/);
  }
});

test('fails closed when Google OAuth is not configured', async () => {
  const verifier = { verify: async () => ({}) };
  const repository = { resolve: async () => ({}) };
  const service = new GoogleIdentityService(verifier as never, repository as never, { clientId: '' });

  await assert.rejects(() => service.resolve('token'), /GOOGLE_OAUTH_CLIENT_ID/);
});
