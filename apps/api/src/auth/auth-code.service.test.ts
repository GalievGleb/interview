import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthCodeError,
  AuthCodeService,
  type AuthCodeRecord,
  type AuthCodeRepository,
} from './auth-code.service';

class MemoryCodes implements AuthCodeRepository {
  current: AuthCodeRecord | null = null;

  async replace(record: AuthCodeRecord): Promise<void> {
    this.current = { ...record };
  }

  async countRecent(email: string, purpose: AuthCodeRecord['purpose'], since: Date): Promise<number> {
    return this.current?.email === email && this.current.purpose === purpose && this.current.createdAt >= since ? 1 : 0;
  }

  async findActive(email: string, purpose: AuthCodeRecord['purpose']): Promise<AuthCodeRecord | null> {
    return this.current?.email === email && this.current.purpose === purpose && !this.current.consumedAt
      ? { ...this.current }
      : null;
  }

  async incrementAttempts(id: string, consume: boolean): Promise<void> {
    if (!this.current || this.current.id !== id) return;
    this.current.attempts += 1;
    if (consume) this.current.consumedAt = new Date('2026-09-13T00:01:00.000Z');
  }

  async consume(id: string): Promise<void> {
    if (this.current?.id === id) this.current.consumedAt = new Date('2026-09-13T00:01:00.000Z');
  }

  async consumeIfActive(id: string): Promise<boolean> {
    if (!this.current || this.current.id !== id || this.current.consumedAt) return false;
    this.current.consumedAt = new Date('2026-09-13T00:01:00.000Z');
    return true;
  }

  async remove(id: string): Promise<void> {
    if (this.current?.id === id) this.current = null;
  }
}

function fixture(now = new Date('2026-09-13T00:00:00.000Z')) {
  const repository = new MemoryCodes();
  const sent: Array<{ email: string; code: string; purpose: 'verify_email' | 'reset_password' }> = [];
  const service = new AuthCodeService(
    repository,
    { sendVerificationCode: async (email, code, purpose) => { sent.push({ email, code, purpose }); } },
    {
      secret: 'test-auth-code-secret-which-is-long-enough',
      now: () => now,
      randomCode: () => '431209',
      randomId: () => 'challenge-1',
    },
  );
  return { repository, sent, service };
}

test('normalizes the email and stores only a digest of the ten-minute code', async () => {
  const { repository, sent, service } = fixture();

  await service.issue('  Person@Example.COM ', 'verify_email');

  assert.deepEqual(sent, [{ email: 'person@example.com', code: '431209', purpose: 'verify_email' }]);
  assert.equal(repository.current?.email, 'person@example.com');
  assert.equal(repository.current?.codeHash.includes('431209'), false);
  assert.equal(repository.current?.expiresAt.toISOString(), '2026-09-13T00:10:00.000Z');
});

test('accepts a correct code once and rejects reuse', async () => {
  const { service } = fixture();
  await service.issue('person@example.com', 'verify_email');

  await service.verify('PERSON@example.com', '431209', 'verify_email');

  await assert.rejects(
    () => service.verify('person@example.com', '431209', 'verify_email'),
    (error: unknown) => error instanceof AuthCodeError && error.code === 'CODE_INVALID',
  );
});

test('two concurrent confirmations can consume one code only once', async () => {
  const { service } = fixture();
  await service.issue('person@example.com', 'verify_email');

  const results = await Promise.allSettled([
    service.verify('person@example.com', '431209', 'verify_email'),
    service.verify('person@example.com', '431209', 'verify_email'),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('rejects an expired code', async () => {
  let now = new Date('2026-09-13T00:00:00.000Z');
  const { service } = fixture(now);
  await service.issue('person@example.com', 'reset_password');
  now = new Date('2026-09-13T00:10:01.000Z');
  (service as unknown as { options: { now: () => Date } }).options.now = () => now;

  await assert.rejects(
    () => service.verify('person@example.com', '431209', 'reset_password'),
    (error: unknown) => error instanceof AuthCodeError && error.code === 'CODE_EXPIRED',
  );
});

test('locks a code after five wrong attempts', async () => {
  const { repository, service } = fixture();
  await service.issue('person@example.com', 'verify_email');

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(
      () => service.verify('person@example.com', '000000', 'verify_email'),
      (error: unknown) => error instanceof AuthCodeError && error.code === 'CODE_INVALID',
    );
  }

  assert.equal(repository.current?.attempts, 5);
  assert.ok(repository.current?.consumedAt);
  await assert.rejects(
    () => service.verify('person@example.com', '431209', 'verify_email'),
    (error: unknown) => error instanceof AuthCodeError && error.code === 'CODE_INVALID',
  );
});

test('removes an unsent challenge if the mail provider fails', async () => {
  const repository = new MemoryCodes();
  const service = new AuthCodeService(
    repository,
    { sendVerificationCode: async () => { throw new Error('provider failure'); } },
    {
      secret: 'test-auth-code-secret-which-is-long-enough',
      now: () => new Date('2026-09-13T00:00:00.000Z'),
      randomCode: () => '431209',
      randomId: () => 'challenge-1',
    },
  );

  await assert.rejects(() => service.issue('person@example.com', 'verify_email'), /provider failure/);
  assert.equal(repository.current, null);
});

test('rate-limits repeated code delivery for the same email and purpose', async () => {
  const { service } = fixture();
  await service.issue('person@example.com', 'verify_email');

  await assert.rejects(
    () => service.issue('person@example.com', 'verify_email'),
    (error: unknown) => error instanceof AuthCodeError && error.code === 'CODE_RATE_LIMITED',
  );
});
