import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';

const license = {
  id: 'license-1',
  payload: { email: 'qa@example.test', plan: 'trial' },
  budget: 1,
};

test('atomically reserves answer seconds and releases them on provider failure', async () => {
  const calls: unknown[][] = [];
  const results = [120, 0];
  const service = new GatewaySttQuotaService({
    getClient: () => ({
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return results.shift();
      },
    }),
  } as never);

  await service.reserveUsage(license, 120);
  await service.releaseUsage(license.id, 120);

  assert.equal(calls.length, 2);
  assert.match(String(calls[0][0]), /INCRBY/);
  assert.match(String(calls[0][0]), /current \+ amount > budget/);
  assert.match(String(calls[1][0]), /DECRBY/);
});

test('rejects a reservation that would cross the monthly budget', async () => {
  const service = new GatewaySttQuotaService({
    getClient: () => ({ eval: async () => -1 }),
  } as never);

  await assert.rejects(
    service.reserveUsage(license, 120),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 402,
  );
});
