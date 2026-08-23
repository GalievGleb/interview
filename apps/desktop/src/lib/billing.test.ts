import { describe, expect, it } from 'vitest';
import { PLANS, hhAutomationAllowed } from './billing';

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

describe('hhAutomationAllowed', () => {
  it('allows only an active Max licence', () => {
    expect(hhAutomationAllowed(null)).toBe(false);
    expect(hhAutomationAllowed({ status: 'trial', plan: 'trial' })).toBe(false);
    expect(hhAutomationAllowed({ status: 'active', plan: 'basic' })).toBe(false);
    expect(hhAutomationAllowed({ status: 'expired', plan: 'max' })).toBe(false);
    expect(hhAutomationAllowed({ status: 'active', plan: 'max' })).toBe(true);
  });
});
