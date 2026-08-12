import { describe, expect, it } from 'vitest';
import { resolveSessionEvidenceLayout } from './sessionAnalysisPresentation';

describe('session analysis evidence layout', () => {
  it('removes the evidence row when the short call produced no reliable evidence', () => {
    expect(resolveSessionEvidenceLayout(0, 0)).toEqual({
      hasStrengths: false,
      hasWeaknesses: false,
      hasAny: false,
      isSplit: false,
    });
  });

  it.each([
    [2, 0, true, false],
    [0, 1, false, true],
  ])('uses the full width for one known evidence group', (strengths, weaknesses, hasStrengths, hasWeaknesses) => {
    expect(resolveSessionEvidenceLayout(strengths, weaknesses)).toEqual({
      hasStrengths,
      hasWeaknesses,
      hasAny: true,
      isSplit: false,
    });
  });

  it('keeps two columns when both evidence groups contain data', () => {
    expect(resolveSessionEvidenceLayout(2, 3)).toEqual({
      hasStrengths: true,
      hasWeaknesses: true,
      hasAny: true,
      isSplit: true,
    });
  });
});
