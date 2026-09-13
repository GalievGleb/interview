import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { GatewayService } from './gateway.service';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';
import { mintLicenseKey, verifyLicenseKey } from './license.util';

test('rollout rejects anonymous issuance and cached trial keys but keeps account and paid access', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateHex = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const beforeFlag = process.env.GATEWAY_REQUIRE_ACCOUNT_TRIAL;
  const beforeKey = process.env.LICENSE_PUBLIC_KEY_HEX;
  process.env.GATEWAY_REQUIRE_ACCOUNT_TRIAL = '1';
  process.env.LICENSE_PUBLIC_KEY_HEX = publicHex;
  try {
    const service = new GatewayService({} as never);
    const anonymous = mintLicenseKey({ email: 'trial@example.test', plan: 'trial', days: 1 }, privateHex);
    assert.throws(() => service.authorize(`Bearer ${anonymous}`), /Unauthorized/);
    await assert.rejects(service.issueTrial('reinstalled-client'), /Unauthorized/);
    const account = mintLicenseKey({ email: 'user@example.test', plan: 'trial', days: 1,
      accountId: 'same-user', source: 'account' }, privateHex);
    const renewed = mintLicenseKey({ email: 'user@example.test', plan: 'trial', days: 2,
      accountId: 'same-user', source: 'account' }, privateHex);
    const identity = service.authorize(`Bearer ${account}`).id;
    assert.match(identity, /^trial-/);
    assert.equal(identity, service.authorize(`Bearer ${renewed}`).id);
    const paid = mintLicenseKey({ email: 'buyer@example.test', plan: 'max', days: 1 }, privateHex);
    assert.equal(service.authorize(`Bearer ${paid}`).payload.plan, 'max');
    const paidAccount = mintLicenseKey({ email: 'user@example.test', plan: 'max', days: 1,
      accountId: 'same-user', source: 'account' }, privateHex);
    assert.notEqual(identity, verifyLicenseKey(paidAccount)?.id);
    const readKeys: string[] = [];
    const redis = { getClient: () => ({ get: async (key: string) => { readKeys.push(key); return '42'; } }) };
    const gateway = new GatewayService(redis as never);
    const stt = new GatewaySttQuotaService(redis as never);
    await gateway.usedTokens(identity);
    await stt.secondsUsed(identity);
    assert.equal(readKeys.length, 2);
    assert.ok(readKeys.every((key) => key.endsWith(':lifetime')));
    process.env.GATEWAY_REQUIRE_ACCOUNT_TRIAL = '0';
    assert.equal(service.authorize(`Bearer ${anonymous}`).payload.plan, 'trial');
  } finally {
    if (beforeFlag === undefined) delete process.env.GATEWAY_REQUIRE_ACCOUNT_TRIAL;
    else process.env.GATEWAY_REQUIRE_ACCOUNT_TRIAL = beforeFlag;
    if (beforeKey === undefined) delete process.env.LICENSE_PUBLIC_KEY_HEX;
    else process.env.LICENSE_PUBLIC_KEY_HEX = beforeKey;
  }
});
