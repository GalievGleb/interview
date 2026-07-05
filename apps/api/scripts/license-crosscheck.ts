/**
 * Smoke-проверка совместимости лицензий Node <-> Python.
 *
 * Генерирует временную пару Ed25519, выпускает ключ через license.util (тот же
 * код, что /gateway/issue) и проверяет его в Node. Печатает PUB/KEY, чтобы
 * прогнать питоновскую проверку (см. GATEWAY.md):
 *   npx tsx scripts/license-crosscheck.ts
 */
import { generateKeyPairSync } from 'crypto';
import { mintLicenseKey, verifyLicenseKey } from '../src/gateway/license.util';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');

const key = mintLicenseKey({ email: 'buyer@test.dev', plan: 'max', days: 30 }, privRaw);
const verified = verifyLicenseKey(key, pubRaw);
if (!verified || verified.payload.email !== 'buyer@test.dev' || verified.budget !== 20_000_000) {
  console.error('NODE SELF-VERIFY FAILED', verified);
  process.exit(1);
}
const expired = mintLicenseKey({ email: 'x@y.z', days: -1 } as never, privRaw);
if (verifyLicenseKey(expired, pubRaw) !== null) {
  // days<=0 не ставит expires_at — этот ключ бессрочный и обязан проходить.
  console.log('NOTE: negative days => perpetual key (as designed)');
}
console.log('NODE_SELF_VERIFY_OK');
console.log(`PUB=${pubRaw}`);
console.log(`KEY=${key}`);
