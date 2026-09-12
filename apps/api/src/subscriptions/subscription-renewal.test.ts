import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSubscriptionActivation } from './subscription-renewal';

const now = new Date('2026-09-13T00:00:00.000Z');
const paidEnd = new Date('2026-10-13T00:00:00.000Z');

test('a repeated purchase of the same plan extends from the current future end', () => {
  const result = computeSubscriptionActivation(
    { plan: 'BASIC', status: 'ACTIVE', currentPeriodEnd: paidEnd },
    'BASIC',
    paidEnd,
    now,
  );

  assert.equal(result.plan, 'BASIC');
  assert.equal(result.currentPeriodEnd.toISOString(), '2026-11-12T00:00:00.000Z');
});

test('an upgrade becomes active immediately without shortening the paid period', () => {
  const currentEnd = new Date('2026-11-01T00:00:00.000Z');
  const result = computeSubscriptionActivation(
    { plan: 'BASIC', status: 'ACTIVE', currentPeriodEnd: currentEnd },
    'PRO',
    paidEnd,
    now,
  );

  assert.equal(result.plan, 'PRO');
  assert.equal(result.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('an expired subscription starts from the newly purchased period', () => {
  const result = computeSubscriptionActivation(
    { plan: 'PRO', status: 'EXPIRED', currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z') },
    'BASIC',
    paidEnd,
    now,
  );

  assert.equal(result.plan, 'BASIC');
  assert.equal(result.currentPeriodEnd.toISOString(), paidEnd.toISOString());
});

test('a duplicate or malformed zero-length paid period never extends access', () => {
  const currentEnd = new Date('2026-10-01T00:00:00.000Z');
  const result = computeSubscriptionActivation(
    { plan: 'BASIC', status: 'ACTIVE', currentPeriodEnd: currentEnd },
    'BASIC',
    now,
    now,
  );

  assert.equal(result.currentPeriodEnd.toISOString(), currentEnd.toISOString());
});
