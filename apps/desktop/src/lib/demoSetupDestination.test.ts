import { describe, expect, it } from 'vitest';
import { demoSetupDestination } from './demoSetupDestination';

describe('demoSetupDestination', () => {
  it('routes missing AI entitlement to billing', () => {
    expect(demoSetupDestination(false, true)).toBe('/settings?tab=billing');
  });

  it('routes missing speech setup to speech settings', () => {
    expect(demoSetupDestination(true, false)).toBe('/settings?tab=speech');
  });

  it('returns no setup route when live is ready', () => {
    expect(demoSetupDestination(true, true)).toBeNull();
  });
});
