export type SubscriptionPlan = 'BASIC' | 'PRO';
export type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING';

export interface CurrentSubscriptionPeriod {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
}

export function computeSubscriptionActivation(
  current: CurrentSubscriptionPeriod | null,
  purchasedPlan: SubscriptionPlan,
  purchasedPeriodEnd: Date,
  now: Date,
): { plan: SubscriptionPlan; currentPeriodEnd: Date } {
  if (!current || current.status !== 'ACTIVE' || !current.currentPeriodEnd || current.currentPeriodEnd <= now) {
    return { plan: purchasedPlan, currentPeriodEnd: purchasedPeriodEnd };
  }

  const planRank: Record<SubscriptionPlan, number> = { BASIC: 1, PRO: 2 };
  if (planRank[purchasedPlan] > planRank[current.plan]) {
    return {
      plan: purchasedPlan,
      currentPeriodEnd: current.currentPeriodEnd > purchasedPeriodEnd
        ? current.currentPeriodEnd
        : purchasedPeriodEnd,
    };
  }

  if (purchasedPlan === current.plan) {
    const purchasedDurationMs = Math.max(0, purchasedPeriodEnd.getTime() - now.getTime());
    return {
      plan: current.plan,
      currentPeriodEnd: new Date(current.currentPeriodEnd.getTime() + purchasedDurationMs),
    };
  }

  // A paid PRO period is never silently downgraded in the middle of the term.
  return { plan: current.plan, currentPeriodEnd: current.currentPeriodEnd };
}
