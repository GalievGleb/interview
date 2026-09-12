import crypto from 'node:crypto';
import http from 'node:http';

export interface GoogleLoopbackListener {
  redirectUri: string;
  waitForRedirect: Promise<URL>;
  close(): void;
}

interface GoogleDesktopOAuthOptions {
  clientId: string;
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  createListener?: () => Promise<GoogleLoopbackListener>;
  state?: string;
  verifier?: string;
}

function randomUrlSafe(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function pkceChallengeForVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function stateMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function createGoogleLoopbackListener(
  timeoutMs = 120_000,
): Promise<GoogleLoopbackListener> {
  let resolveRedirect!: (url: URL) => void;
  let rejectRedirect!: (error: Error) => void;
  const waitForRedirect = new Promise<URL>((resolve, reject) => {
    resolveRedirect = resolve;
    rejectRedirect = reject;
  });
  let finished = false;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth2/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end('<!doctype html><meta charset="utf-8"><title>SkillCue</title><p>Вход завершён. Можно вернуться в SkillCue и закрыть эту вкладку.</p>');
    if (!finished) {
      finished = true;
      resolveRedirect(url);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('GOOGLE_OAUTH_LOOPBACK_UNAVAILABLE');
  }

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    rejectRedirect(new Error('GOOGLE_OAUTH_TIMEOUT'));
    server.close();
  }, timeoutMs);
  timer.unref?.();

  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth2/callback`,
    waitForRedirect,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

export async function runGoogleDesktopOAuth(
  options: GoogleDesktopOAuthOptions,
): Promise<{ idToken: string }> {
  if (!options.clientId.trim()) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not configured');

  const state = options.state ?? randomUrlSafe(32);
  const verifier = options.verifier ?? randomUrlSafe(64);
  if (verifier.length < 43 || verifier.length > 128) throw new Error('GOOGLE_OAUTH_PKCE_INVALID');
  const listener = await (options.createListener ?? createGoogleLoopbackListener)();

  try {
    const redirect = new URL(listener.redirectUri);
    if (
      redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' ||
      redirect.pathname !== '/oauth2/callback'
    ) {
      throw new Error('GOOGLE_OAUTH_LOOPBACK_INVALID');
    }

    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: listener.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: pkceChallengeForVerifier(verifier),
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account',
    }).toString();
    await options.openExternal(authorizationUrl.toString());

    const callback = await listener.waitForRedirect;
    if (
      callback.origin !== redirect.origin || callback.pathname !== redirect.pathname ||
      !stateMatches(state, callback.searchParams.get('state') ?? '')
    ) {
      throw new Error('GOOGLE_OAUTH_STATE_INVALID');
    }
    const providerError = callback.searchParams.get('error');
    if (providerError) throw new Error('GOOGLE_OAUTH_CANCELLED');
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('GOOGLE_OAUTH_CODE_MISSING');

    const response = await (options.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: listener.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED');
    const result = await response.json() as { id_token?: unknown };
    if (typeof result.id_token !== 'string' || !result.id_token) {
      throw new Error('GOOGLE_OAUTH_ID_TOKEN_MISSING');
    }
    return { idToken: result.id_token };
  } finally {
    listener.close();
  }
}
