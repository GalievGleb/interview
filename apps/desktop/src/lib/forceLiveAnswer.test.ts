import { describe, expect, it } from 'vitest';
import { selectForceTargetSource } from './forceLiveAnswer';

describe('selectForceTargetSource', () => {
  it('targets the only channel that is still speaking', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: true },
        { mic: true, system: false },
        { mic: 0, system: 0 },
      ),
    ).toBe('mic');
  });

  it('prefers system audio when both channels are speaking', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: true },
        { mic: true, system: true },
        { mic: 0, system: 0 },
      ),
    ).toBe('system');
  });

  it('uses an unconsumed microphone final when system has no new question', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: true },
        { mic: false, system: false },
        { mic: 4, system: 0 },
      ),
    ).toBe('mic');
  });

  it('prefers an unconsumed system final over a microphone final', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: true },
        { mic: false, system: false },
        { mic: 5, system: 3 },
      ),
    ).toBe('system');
  });

  it('uses the microphone when it is the trigger source', () => {
    expect(selectForceTargetSource({ mic: true, system: false })).toBe('mic');
  });

  it('reports no target when live audio is unavailable', () => {
    expect(selectForceTargetSource({ mic: false, system: false })).toBeNull();
  });
});
