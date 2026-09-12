import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { mintLicenseKey, verifyLicenseKey } from './license.util';

function rawKeyPair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKeyHex: pkcs8.subarray(-32).toString('hex'),
    publicKeyHex: spki.subarray(-32).toString('hex'),
  };
}

test('account-managed licenses keep one quota identity across renewals', () => {
  const keys = rawKeyPair();
  const first = verifyLicenseKey(mintLicenseKey({
    email: 'buyer@example.com',
    plan: 'max',
    expiresAt: 1_900_000_000,
    accountId: 'user-123',
    source: 'account',
  }, keys.privateKeyHex), keys.publicKeyHex);
  const second = verifyLicenseKey(mintLicenseKey({
    email: 'buyer@example.com',
    plan: 'max',
    expiresAt: 1_900_086_400,
    accountId: 'user-123',
    source: 'account',
  }, keys.privateKeyHex), keys.publicKeyHex);

  assert.equal(first?.payload.source, 'account');
  assert.equal(first?.payload.account_id, 'user-123');
  assert.equal(first?.id, second?.id);
});
