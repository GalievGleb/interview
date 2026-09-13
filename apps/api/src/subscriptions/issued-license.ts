import { BadRequestException } from '@nestjs/common';
import { verifyLicenseKey } from '../gateway/license.util';

export function parseIssuedLicense(key: string, publicKey?: string) {
  const verified = verifyLicenseKey(key, publicKey);
  const p = verified?.payload;
  if (!verified || !p || p.source || p.account_id || !['basic','max'].includes(p.plan ?? '')
    || typeof p.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())
    || (p.expires_at != null && (!Number.isSafeInteger(p.expires_at) || p.expires_at <= Date.now()/1000))) {
    throw new BadRequestException('INVALID_ISSUED_LICENSE');
  }
  return {id:verified.id,email:p.email.trim().toLowerCase(),plan:p.plan==='basic'?'BASIC' as const:'PRO' as const,
    expiresAt:p.expires_at == null ? null : new Date(p.expires_at*1000)};
}

interface SubscriptionView {
  plan: string; status: string; currentPeriodEnd: Date | null;
  llmTokensUsed: number; sttMinutesUsed: number;
}
interface Grant {plan:string;expiresAt:Date|null}
// Choose the strongest currently valid entitlement; never add durations or mutate
// a paid subscription. When a promotional Max expires, paid Basic resumes.
export function selectIssuedSubscription<T extends SubscriptionView>(base:T|null, grants:Grant[], now:Date):T|SubscriptionView|null {
  let best:SubscriptionView|null=base && base.status==='ACTIVE' && (!base.currentPeriodEnd || base.currentPeriodEnd>now)?base:null;
  for(const grant of grants) {
    if(grant.expiresAt && grant.expiresAt<=now) continue;
    const stronger=grant.plan==='PRO' && best?.plan!=='PRO';
    const longer=best?.plan===grant.plan && best.currentPeriodEnd!==null && (!grant.expiresAt || grant.expiresAt>best.currentPeriodEnd);
    if(!best || stronger || longer) best={...base,plan:grant.plan,status:'ACTIVE',currentPeriodEnd:grant.expiresAt,
      llmTokensUsed:base?.llmTokensUsed??0,sttMinutesUsed:base?.sttMinutesUsed??0};
  }
  return best??base;
}
