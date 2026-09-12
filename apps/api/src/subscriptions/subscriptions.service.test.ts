import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { verifyLicenseKey } from '../gateway/license.util';
import { SubscriptionsService } from './subscriptions.service';

function rawKeyPair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKeyHex: pkcs8.subarray(-32).toString('hex'),
    publicKeyHex: spki.subarray(-32).toString('hex'),
  };
}

test('stores a paid entitlement by normalized email when the account does not exist yet', async () => {
  const created: unknown[] = [];
  const prisma = {
    user: { findUnique: async () => null },
    pendingEntitlement: {
      upsert: async (input: unknown) => { created.push(input); return input; },
    },
  };
  const service = new SubscriptionsService(prisma as never);

  const result = await service.activateForEmail(
    ' Buyer@Example.COM ', 'BASIC' as never, 'YOOKASSA', 'payment-1', 30,
  );

  assert.deepEqual(result, { pending: true });
  assert.deepEqual(created, [{
    where: { provider_externalId: { provider: 'YOOKASSA', externalId: 'payment-1' } },
    create: {
      email: 'buyer@example.com', plan: 'BASIC', provider: 'YOOKASSA',
      externalId: 'payment-1', durationDays: 30,
    },
    update: {},
  }]);
});

test('claiming pending purchases activates each payment once for the verified account', async () => {
  const activated: string[] = [];
  const claimed: string[] = [];
  const pending = [
    { id: 'pending-1', plan: 'BASIC', provider: 'YOOKASSA', externalId: 'payment-1', durationDays: 30 },
    { id: 'pending-2', plan: 'BASIC', provider: 'YOOKASSA', externalId: 'payment-2', durationDays: 30 },
  ];
  const prisma = {
    pendingEntitlement: {
      findMany: async () => pending,
      updateMany: async ({ where }: { where: { id: string } }) => { claimed.push(where.id); },
    },
  };
  const service = new SubscriptionsService(prisma as never);
  service.activateSubscription = async (_userId, _plan, _provider, externalId) => {
    activated.push(externalId);
    return {} as never;
  };

  await service.claimPending('user-1', 'BUYER@example.com');

  assert.deepEqual(activated, ['payment-1', 'payment-2']);
  assert.deepEqual(claimed, ['pending-1', 'pending-2']);
});

test('issues a 24-hour managed license for an active account subscription', async () => {
  const keys = rawKeyPair();
  const currentPeriodEnd = new Date(Date.now() + 30 * 86_400_000);
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'buyer@example.com',
        subscription: { plan: 'PRO', status: 'ACTIVE', currentPeriodEnd },
      }),
    },
  };
  const service = new SubscriptionsService(prisma as never, {
    privateKeyHex: keys.privateKeyHex,
    now: () => new Date('2026-09-13T12:00:00.000Z'),
  });

  const result = await service.getManagedLicense('user-1');
  const verified = result.active && result.key
    ? verifyLicenseKey(result.key, keys.publicKeyHex)
    : null;

  assert.equal(result.active, true);
  assert.equal(verified?.payload.email, 'buyer@example.com');
  assert.equal(verified?.payload.plan, 'max');
  assert.equal(verified?.payload.source, 'account');
  assert.equal(verified?.payload.account_id, 'user-1');
  assert.equal(verified?.payload.tokens_month, 2_000_000);
  assert.equal(result.expiresAt, '2026-09-14T12:00:00.000Z');
});

test('does not issue a managed license for an expired subscription', async () => {
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'buyer@example.com',
        subscription: {
          plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date('2026-09-12T12:00:00.000Z'),
        },
      }),
    },
  };
  const service = new SubscriptionsService(prisma as never, {
    privateKeyHex: '',
    now: () => new Date('2026-09-13T12:00:00.000Z'),
  });

  assert.deepEqual(await service.getManagedLicense('user-1'), {
    active: false, key: null, expiresAt: null,
  });
});

test('reports a stale active database row as expired after its paid period ends', async () => {
  const prisma = {
    subscription: {
      findUnique: async () => ({
        plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date('2026-09-12T12:00:00.000Z'),
        sttMinutesUsed: 12, llmTokensUsed: 34,
      }),
    },
  };
  const service = new SubscriptionsService(prisma as never, {
    privateKeyHex: '',
    now: () => new Date('2026-09-13T12:00:00.000Z'),
  });

  const result = await service.getSubscriptionInfo('user-1');

  assert.equal(result.status, 'EXPIRED');
});
