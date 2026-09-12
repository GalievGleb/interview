import { describe, expect, it } from 'vitest';
import { PLANS, hhAutomationAllowed, planPurchaseAction, shouldDisableHhDailySchedule } from './billing';

describe('billing plans (skill-cue.ru terms)', () => {
  it('keeps site prices: 1490/2990 monthly, year = 10 months', () => {
    const basic = PLANS.find((p) => p.id === 'basic');
    const max = PLANS.find((p) => p.id === 'max');
    expect(basic?.monthlyRub).toBe(1490);
    expect(basic?.yearlyRub).toBe(14900);
    expect(max?.monthlyRub).toBe(2990);
    expect(max?.yearlyRub).toBe(29900);
  });

  it('promises HH auto-applications only in the Max plan', () => {
    const basic = PLANS.find((p) => p.id === 'basic');
    const max = PLANS.find((p) => p.id === 'max');
    expect(basic?.features.find((f) => f.textKey === 'billing.feat.hhAuto')?.included).toBe(false);
    expect(max?.features.find((f) => f.textKey === 'billing.feat.hhAuto')?.included).toBe(true);
  });
});

describe('planPurchaseAction', () => {
  it('allows renewal and upgrades but never offers a paid downgrade', () => {
    expect(planPurchaseAction(null, 'basic')).toBe('subscribe');
    expect(planPurchaseAction('basic', 'basic')).toBe('renew');
    expect(planPurchaseAction('basic', 'max')).toBe('upgrade');
    expect(planPurchaseAction('max', 'max')).toBe('renew');
    expect(planPurchaseAction('max', 'basic')).toBe('blocked');
  });
});

describe('hhAutomationAllowed', () => {
  it('allows only an active Max licence', () => {
    expect(hhAutomationAllowed(null)).toBe(false);
    expect(hhAutomationAllowed({ status: 'trial', plan: 'trial' })).toBe(false);
    expect(hhAutomationAllowed({ status: 'active', plan: 'basic' })).toBe(false);
    expect(hhAutomationAllowed({ status: 'expired', plan: 'max' })).toBe(false);
    expect(hhAutomationAllowed({ status: 'active', plan: 'max' })).toBe(true);
  });

  it('does not disable a saved daily schedule while the licence is still loading', () => {
    expect(shouldDisableHhDailySchedule(true, null)).toBe(false);
    expect(shouldDisableHhDailySchedule(false, null)).toBe(false);
    expect(shouldDisableHhDailySchedule(false, { status: 'active', plan: 'basic' })).toBe(true);
    expect(shouldDisableHhDailySchedule(false, { status: 'active', plan: 'max' })).toBe(false);
  });
});
