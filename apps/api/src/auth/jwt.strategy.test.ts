import assert from 'node:assert/strict';
import test from 'node:test';
import { JwtStrategy } from './jwt.strategy';

test('JWT verification fails closed when its signing secret is absent', () => {
  const previous = process.env.JWT_ACCESS_SECRET;
  delete process.env.JWT_ACCESS_SECRET;
  try {
    assert.throws(() => new JwtStrategy({} as never), /JWT_ACCESS_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  }
});

test('a revoked device session cannot keep using an otherwise valid access token', async () => {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-which-is-long-enough';
  const prisma = {
    user: { findUnique: async () => ({ id: 'user-1', email: 'person@example.com' }) },
    deviceSession: { findFirst: async () => null },
  };
  const strategy = new JwtStrategy(prisma as never);

  await assert.rejects(
    () => strategy.validate({ sub: 'user-1', email: 'person@example.com', sid: 'revoked-session' }),
  );
});
