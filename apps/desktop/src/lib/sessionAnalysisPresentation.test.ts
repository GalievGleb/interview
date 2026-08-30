import { describe, expect, it } from 'vitest';
import * as presentation from './sessionAnalysisPresentation';

const { resolveSessionEvidenceLayout } = presentation;

type FormatSessionInterval = (
  startedAt: string,
  endedAt: string | null,
  options?: { locale?: string; timeZone?: string },
) => string;

const formatSessionInterval = (
  presentation as typeof presentation & { formatSessionInterval?: FormatSessionInterval }
).formatSessionInterval;

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

describe('session history time presentation', () => {
  it('treats timezone-less backend timestamps as UTC and shows a local start/end interval', () => {
    expect(formatSessionInterval?.(
      '2026-08-29T10:44:29.619756',
      '2026-08-29T10:46:20.169835',
      { locale: 'ru-RU', timeZone: 'Asia/Krasnoyarsk' },
    )).toBe('Сб, 29.08.26 · 17:44–17:46');
  });

  it('labels an unfinished interview with its local start time', () => {
    expect(formatSessionInterval?.(
      '2026-08-29T10:44:29.619756',
      null,
      { locale: 'ru-RU', timeZone: 'Asia/Krasnoyarsk' },
    )).toBe('Сб, 29.08.26 · с 17:44');
  });
});
