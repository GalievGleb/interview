import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mintLicenseKey } from '../gateway/license.util';
import { parseIssuedLicense, selectIssuedSubscription } from './issued-license';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('hex');
const publicKey = keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
test('issuer key preserves exact expiration and normalized recipient on repeated imports', () => {
  const key = mintLicenseKey({email:' Buyer@Example.COM ',plan:'max',expiresAt:2000000000},privateKey);
  const grant = parseIssuedLicense(key, publicKey);
  assert.equal(grant.email,'buyer@example.com');
  assert.equal(grant.plan,'PRO');
  assert.equal(grant.expiresAt?.toISOString(),'2033-05-18T03:33:20.000Z');
  assert.deepEqual(parseIssuedLicense(key,publicKey),grant);
});
test('rejects unsigned, expired, trial and rotating account keys', () => {
  for(const key of ['garbage',mintLicenseKey({email:'b@e.co',expiresAt:1},privateKey),mintLicenseKey({email:'b@e.co',plan:'trial'},privateKey),mintLicenseKey({email:'b@e.co',plan:'max',source:'account',accountId:'u'},privateKey)]) {
    assert.throws(()=>parseIssuedLicense(key,publicKey));
  }
});
test('active Max grant upgrades account view without erasing paid Basic period or usage', () => {
  const paid={plan:'BASIC',status:'ACTIVE',currentPeriodEnd:new Date('2030-02-01'),llmTokensUsed:123,sttMinutesUsed:4};
  const grant={plan:'PRO',expiresAt:new Date('2030-01-08')};
  const result=selectIssuedSubscription(paid,[grant],new Date('2030-01-01'));
  assert.equal(result?.plan,'PRO');
  assert.equal(result?.currentPeriodEnd?.toISOString(),'2030-01-08T00:00:00.000Z');
  assert.equal(result?.llmTokensUsed,123);
  assert.equal(selectIssuedSubscription(paid,[grant],new Date('2030-01-09'))?.plan,'BASIC');
  assert.equal(paid.plan,'BASIC');
});
test('repeated grants do not stack, expired grants do not activate and perpetual grants remain active', () => {
  const grant={plan:'PRO',expiresAt:new Date('2030-01-08')};
  assert.deepEqual(selectIssuedSubscription(null,[grant,grant],new Date('2030-01-01')),selectIssuedSubscription(null,[grant],new Date('2030-01-01')));
  assert.equal(selectIssuedSubscription(null,[grant],new Date('2030-01-08')),null);
  assert.equal(selectIssuedSubscription(null,[{plan:'BASIC',expiresAt:null}],new Date('2030-01-08'))?.status,'ACTIVE');
});
