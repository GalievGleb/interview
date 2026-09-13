import { describe, expect, it } from 'vitest';
import { runWithOverlayAccount } from './overlayAccountGate';

describe('native overlay account gate', () => {
  it.each([null, { authenticated: false, user: null }, { authenticated: true, user: null }])(
    'never reveals Alpha overlay before a complete account session (%j)', (account) => {
      const effects: string[] = [];
      const permitted = runWithOverlayAccount('alpha', account,
        () => effects.push('reveal'), () => effects.push('login'));
      expect(permitted).toBe(false);
      expect(effects).toEqual(['login']);
    },
  );
  it('opens after login and refuses again after logout', () => {
    const effects: string[] = [];
    const reveal = () => effects.push('reveal');
    const login = () => effects.push('login');
    expect(runWithOverlayAccount('alpha', { authenticated: true, user: { id: 'user-1' } }, reveal, login)).toBe(true);
    expect(runWithOverlayAccount('alpha', { authenticated: false, user: null }, reveal, login)).toBe(false);
    expect(effects).toEqual(['reveal', 'login']);
  });
  it.each(['dev', 'stable'] as const)('preserves %s behavior during Alpha rollout', (channel) => {
    const effects: string[] = [];
    expect(runWithOverlayAccount(channel, null, () => effects.push('reveal'), () => effects.push('login'))).toBe(true);
    expect(effects).toEqual(['reveal']);
  });
});
