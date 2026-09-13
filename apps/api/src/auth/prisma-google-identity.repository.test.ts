import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaGoogleIdentityRepository } from './prisma-google-identity.repository';

test('serializes Google identity linking before reading or creating account rows', async () => {
  const calls: string[] = [];
  const lockQueries: string[] = [];
  const linkedUser = {
    id: 'user-1', email: 'person@example.com', passwordHash: null,
    emailVerifiedAt: new Date(), hwid: null, displayName: null, avatarUrl: null,
  };
  const transaction = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      calls.push('lock');
      lockQueries.push(strings.join('?'));
      return [{ lock: '' }];
    },
    authIdentity: {
      findUnique: async () => { calls.push('find-identity'); return { user: linkedUser }; },
    },
  };
  const repository = new PrismaGoogleIdentityRepository({
    $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
  } as never);

  const user = await repository.resolve({
    subject: 'google-subject', email: 'person@example.com', displayName: null, avatarUrl: null,
  });

  assert.equal(user.id, 'user-1');
  assert.deepEqual(calls, ['lock', 'lock', 'find-identity']);
  assert.ok(lockQueries.every((query) => query.includes('::text AS lock')));
});
