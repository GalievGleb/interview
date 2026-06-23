import { PLAN_LIMITS, Plan as SharedPlan, SubStatus, SubscriptionInfo } from '@interview/shared';

export function isDevSkipSubscription(): boolean {
  return process.env.DEV_SKIP_SUBSCRIPTION === 'true';
}

export function getDevSubscriptionInfo(): SubscriptionInfo {
  return {
    plan: SharedPlan.PRO,
    status: SubStatus.ACTIVE,
    currentPeriodEnd: null,
    sttMinutesUsed: 0,
    llmTokensUsed: 0,
    limits: PLAN_LIMITS[SharedPlan.PRO],
  };
}
