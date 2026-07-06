/**
 * Лицензионные ключи SkillCue на стороне сервера.
 *
 * Формат и криптография зеркалят apps/api-py/app/services/license.py и
 * tools/generate_license_key.py: `SKILLCUE-<b64url(json)>.<b64url(sig)>`,
 * подпись Ed25519, payload {email, issued_at, plan, expires_at?, tokens_month?}.
 * Проверка полностью офлайн — гейтвею не нужна база пользователей.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'crypto';

export const KEY_PREFIX = 'SKILLCUE-';

/** Публичный ключ издателя — тот же, что в apps/api-py/app/services/license.py. */
export const DEFAULT_PUBLIC_KEY_HEX =
  '6c8c28be738e231af5429b12837d3406d9934c802b9fd32300d7ad6cb8fd4876';

/** Месячные токен-бюджеты тарифов (вход+выход), зеркало license.py. */
export const PLAN_TOKEN_BUDGETS: Record<string, number> = {
  trial: 300_000,
  basic: 5_000_000,
  max: 20_000_000,
};

// DER-обёртки для raw-ключей Ed25519 (Node crypto не ест raw напрямую).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface LicensePayload {
  email: string;
  issued_at?: number;
  plan?: string;
  expires_at?: number;
  tokens_month?: number;
}

function b64urlDecode(data: string): Buffer {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + pad, 'base64');
}

function b64urlEncode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function normalizePlan(plan: string | null | undefined): 'trial' | 'basic' | 'max' {
  const p = (plan ?? '').trim().toLowerCase();
  if (p === 'trial') return 'trial';
  if (p === 'basic') return 'basic';
  // pro/full/неизвестное в ПОДПИСАННОМ ключе трактуем в пользу покупателя.
  return 'max';
}

export function tokenBudgetFor(payload: LicensePayload): number {
  const override = payload.tokens_month;
  if (typeof override === 'number' && override > 0) return Math.floor(override);
  return PLAN_TOKEN_BUDGETS[normalizePlan(payload.plan)];
}

/** Стабильный анонимный id ключа для учёта расхода (не раскрывает email в Redis). */
export function licenseId(payloadB64: string): string {
  return createHash('sha256').update(payloadB64).digest('hex').slice(0, 24);
}

export interface VerifiedLicense {
  payload: LicensePayload;
  id: string;
  budget: number;
}

/** Вернуть данные валидного ключа или null. Не бросает исключений. */
export function verifyLicenseKey(
  key: string,
  publicKeyHex: string = process.env.LICENSE_PUBLIC_KEY_HEX || DEFAULT_PUBLIC_KEY_HEX,
): VerifiedLicense | null {
  const trimmed = (key ?? '').trim();
  if (!trimmed.startsWith(KEY_PREFIX)) return null;
  const body = trimmed.slice(KEY_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);
  try {
    const payloadBytes = b64urlDecode(payloadB64);
    const signature = b64urlDecode(sigB64);
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, payloadBytes, publicKey, signature)) return null;
    const payload = JSON.parse(payloadBytes.toString('utf-8')) as LicensePayload;
    if (!payload || typeof payload !== 'object' || !payload.email) return null;
    if (payload.expires_at != null && Date.now() / 1000 > Number(payload.expires_at)) {
      return null;
    }
    return { payload, id: licenseId(payloadB64), budget: tokenBudgetFor(payload) };
  } catch {
    return null;
  }
}

export interface MintOptions {
  email: string;
  plan?: 'trial' | 'basic' | 'max';
  days?: number;
  tokensMonth?: number;
}

/**
 * Выпуск ключа (издатель). Приватный ключ — 32-байтовый seed hex в
 * LICENSE_PRIVATE_KEY_HEX (тот же, что в apps/api-py/.license_signing_key).
 * Использует его вебхук оплаты и админ-эндпоинт /gateway/issue.
 */
export function mintLicenseKey(opts: MintOptions, privateKeyHex: string): string {
  const payload: LicensePayload = {
    email: opts.email,
    issued_at: Math.floor(Date.now() / 1000),
    plan: opts.plan ?? 'max',
  };
  if (opts.days && opts.days > 0) {
    payload.expires_at = Math.floor(Date.now() / 1000) + opts.days * 86_400;
  }
  if (opts.tokensMonth && opts.tokensMonth > 0) {
    payload.tokens_month = Math.floor(opts.tokensMonth);
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = sign(null, body, privateKey);
  return `${KEY_PREFIX}${b64urlEncode(body)}.${b64urlEncode(signature)}`;
}
