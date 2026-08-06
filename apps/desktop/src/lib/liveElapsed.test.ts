import { describe, expect, it } from 'vitest';
import { formatLiveElapsed } from './liveElapsed';

describe('live elapsed time', () => {
  it('formats an elapsed duration as hours, minutes and seconds', () => {
    expect(formatLiveElapsed(3_723_999)).toBe('01:02:03');
  });

  it('never renders a negative timer while the start event is being committed', () => {
    expect(formatLiveElapsed(-33_000)).toBe('00:00:00');
  });

  it('falls back to zero for an invalid timestamp', () => {
    expect(formatLiveElapsed(Number.NaN)).toBe('00:00:00');
  });
});
