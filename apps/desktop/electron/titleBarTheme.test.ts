import { describe, expect, it } from 'vitest';
import { getTitleBarOverlayTheme } from './titleBarTheme';

describe('native title-bar theme', () => {
  it('matches the light application surface', () => {
    expect(getTitleBarOverlayTheme('light')).toEqual({
      color: '#f7fafd',
      symbolColor: '#16283c',
      height: 44,
    });
  });

  it('keeps the existing dark title bar', () => {
    expect(getTitleBarOverlayTheme('dark')).toEqual({
      color: '#0c1726',
      symbolColor: '#c7d3e2',
      height: 44,
    });
  });
});
