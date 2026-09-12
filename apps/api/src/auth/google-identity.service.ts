import { OAuth2Client, TokenPayload } from 'google-auth-library';

export type GoogleIdentityPayload = Pick<
  TokenPayload,
  'iss' | 'aud' | 'exp' | 'sub' | 'email' | 'email_verified' | 'name' | 'picture'
>;

export interface GoogleIdTokenVerifier {
  verify(idToken: string, audience: string): Promise<GoogleIdentityPayload>;
}

export interface GoogleIdentityRepository {
  resolve(identity: {
    subject: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  }): Promise<{
    id: string;
    email: string;
    passwordHash: string | null;
    emailVerifiedAt: Date | null;
    hwid: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  }>;
}

export class GoogleIdentityService {
  constructor(
    private readonly verifier: GoogleIdTokenVerifier,
    private readonly repository: GoogleIdentityRepository,
    private readonly config: { clientId: string; now?: () => number },
  ) {}

  async resolve(idToken: string) {
    if (!this.config.clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not configured');

    let payload: GoogleIdentityPayload;
    try {
      payload = await this.verifier.verify(idToken, this.config.clientId);
    } catch {
      throw new Error('GOOGLE_IDENTITY_INVALID');
    }

    const validIssuer = payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com';
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const nowSeconds = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    if (
      !validIssuer ||
      !audiences.includes(this.config.clientId) ||
      typeof payload.exp !== 'number' || payload.exp <= nowSeconds ||
      !payload.sub || !payload.email || payload.email_verified !== true
    ) {
      throw new Error('GOOGLE_IDENTITY_INVALID');
    }

    return this.repository.resolve({
      subject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      displayName: payload.name?.trim() || null,
      avatarUrl: payload.picture?.startsWith('https://') ? payload.picture : null,
    });
  }
}

export class GoogleOAuthVerifier implements GoogleIdTokenVerifier {
  async verify(idToken: string, audience: string): Promise<GoogleIdentityPayload> {
    const ticket = await new OAuth2Client(audience).verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new Error('GOOGLE_IDENTITY_INVALID');
    return payload;
  }
}
