import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthMailPurpose } from '../mail/resend-mail.client';

export type AuthCodePurpose = AuthMailPurpose;

export interface AuthCodeRecord {
  id: string;
  email: string;
  purpose: AuthCodePurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface AuthCodeRepository {
  countRecent(email: string, purpose: AuthCodePurpose, since: Date): Promise<number>;
  replace(record: AuthCodeRecord): Promise<void>;
  findActive(email: string, purpose: AuthCodePurpose): Promise<AuthCodeRecord | null>;
  incrementAttempts(id: string, consume: boolean): Promise<void>;
  consume(id: string): Promise<void>;
  consumeIfActive(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
}

export interface AuthCodeMailer {
  sendVerificationCode(email: string, code: string, purpose: AuthCodePurpose): Promise<void>;
}

interface AuthCodeOptions {
  secret: string;
  now?: () => Date;
  randomCode?: () => string;
  randomId?: () => string;
}

export class AuthCodeError extends Error {
  constructor(public readonly code: 'CODE_INVALID' | 'CODE_EXPIRED' | 'CODE_RATE_LIMITED') {
    super(code);
    this.name = 'AuthCodeError';
  }
}

export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthCodeService {
  private readonly options: Required<AuthCodeOptions>;

  constructor(
    private readonly repository: AuthCodeRepository,
    private readonly mailer: AuthCodeMailer,
    options: AuthCodeOptions,
  ) {
    if (options.secret.length < 32) {
      throw new Error('AUTH_CODE_SECRET must contain at least 32 characters');
    }
    this.options = {
      secret: options.secret,
      now: options.now ?? (() => new Date()),
      randomCode: options.randomCode ?? (() => randomInt(0, 1_000_000).toString().padStart(6, '0')),
      randomId: options.randomId ?? randomUUID,
    };
  }

  async issue(email: string, purpose: AuthCodePurpose): Promise<void> {
    const normalized = normalizeAccountEmail(email);
    const now = this.options.now();
    const recentlyIssued = await this.repository.countRecent(
      normalized,
      purpose,
      new Date(now.getTime() - 60_000),
    );
    if (recentlyIssued > 0) throw new AuthCodeError('CODE_RATE_LIMITED');
    const code = this.options.randomCode();
    const record: AuthCodeRecord = {
      id: this.options.randomId(),
      email: normalized,
      purpose,
      codeHash: this.digest(normalized, purpose, code),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      attempts: 0,
      consumedAt: null,
      createdAt: now,
    };
    await this.repository.replace(record);
    try {
      await this.mailer.sendVerificationCode(normalized, code, purpose);
    } catch (error) {
      await this.repository.remove(record.id);
      throw error;
    }
  }

  async verify(email: string, code: string, purpose: AuthCodePurpose): Promise<void> {
    const normalized = normalizeAccountEmail(email);
    const record = await this.repository.findActive(normalized, purpose);
    if (!record || record.attempts >= 5) {
      throw new AuthCodeError('CODE_INVALID');
    }
    if (record.expiresAt.getTime() <= this.options.now().getTime()) {
      await this.repository.consume(record.id);
      throw new AuthCodeError('CODE_EXPIRED');
    }

    const actual = Buffer.from(this.digest(normalized, purpose, code), 'hex');
    const expected = Buffer.from(record.codeHash, 'hex');
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!matches) {
      await this.repository.incrementAttempts(record.id, record.attempts + 1 >= 5);
      throw new AuthCodeError('CODE_INVALID');
    }
    if (!await this.repository.consumeIfActive(record.id)) {
      throw new AuthCodeError('CODE_INVALID');
    }
  }

  private digest(email: string, purpose: AuthCodePurpose, code: string): string {
    return createHmac('sha256', this.options.secret)
      .update(`${purpose}:${email}:${code}`)
      .digest('hex');
  }
}
