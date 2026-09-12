import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaDeviceSessionRepository } from './prisma-device-session.repository';

test('device limit transaction casts PostgreSQL advisory lock result to text', async () => {
  let lockQuery = '';
  const transaction = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      lockQuery = strings.join('?');
      return [{ lock: '' }];
    },
    deviceSession: {
      count: async () => 0,
      create: async () => undefined,
    },
  };
  const repository = new PrismaDeviceSessionRepository({
    $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
  } as never);

  const created = await repository.createIfBelowLimit({
    id: 'session-1',
    userId: 'user-1',
    installationHash: 'installation-hash',
    deviceName: 'Test PC',
    refreshTokenHash: 'refresh-hash',
    createdAt: new Date(),
    lastSeenAt: new Date(),
    revokedAt: null,
  }, 2);

  assert.equal(created, true);
  assert.ok(lockQuery.includes('::text AS lock'));
});
