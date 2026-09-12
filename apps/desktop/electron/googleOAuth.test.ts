import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  pkceChallengeForVerifier,
  runGoogleDesktopOAuth,
  type GoogleLoopbackListener,
} from './googleOAuth';

const clientId = 'skillcue-client.apps.googleusercontent.com';
const verifier = 'A'.repeat(64);

function listener(callbackUrl: string): GoogleLoopbackListener {
  return {
    redirectUri: 'http://127.0.0.1:43123/oauth2/callback',
    waitForRedirect: Promise.resolve(new URL(callbackUrl)),
    close: vi.fn(),
  };
}

describe('Google desktop OAuth', () => {
  it('creates the required PKCE S256 challenge', () => {
    const expected = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(pkceChallengeForVerifier(verifier)).toBe(expected);
  });

  it('uses the system browser, minimal scopes, state, and loopback callback', async () => {
    const opened: string[] = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id_token: 'signed-google-id-token' }),
    } as Response));
    const result = await runGoogleDesktopOAuth({
      clientId,
      state: 'expected-state',
      verifier,
      openExternal: async (url) => { opened.push(url); },
      createListener: async () => listener(
        'http://127.0.0.1:43123/oauth2/callback?code=auth-code&state=expected-state',
      ),
      fetchImpl,
    });

    expect(result).toEqual({ idToken: 'signed-google-id-token' });
    const authorizationUrl = new URL(opened[0]);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid email profile');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('state')).toBe('expected-state');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43123/oauth2/callback');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a callback with the wrong state before token exchange', async () => {
    const fetchImpl = vi.fn();
    await expect(runGoogleDesktopOAuth({
      clientId,
      state: 'expected-state',
      verifier,
      openExternal: async () => {},
      createListener: async () => listener(
        'http://127.0.0.1:43123/oauth2/callback?code=stolen&state=wrong-state',
      ),
      fetchImpl: fetchImpl as never,
    })).rejects.toThrow('GOOGLE_OAUTH_STATE_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the public desktop client ID is missing', async () => {
    await expect(runGoogleDesktopOAuth({
      clientId: '', openExternal: async () => {},
    })).rejects.toThrow('GOOGLE_OAUTH_CLIENT_ID');
  });
});
