import { describe, expect, it } from 'vitest';
import { overlayScrollOffset } from './overlayScroll';

describe('overlayScrollOffset', () => {
  it('moves down by one compact code line instead of skipping several lines', () => {
    expect(overlayScrollOffset(1)).toBe(24);
  });

  it('moves up by the same one-line distance', () => {
    expect(overlayScrollOffset(-1)).toBe(-24);
  });
});
