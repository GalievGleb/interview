import { describe, expect, it } from 'vitest';
import {
  selectForceTargetSource,
  shouldFinalizeCurrentSpeech,
  SpeechActivityTracker,
} from './forceLiveAnswer';

describe('SpeechActivityTracker', () => {
  it('keeps a newer utterance active when an older final arrives afterwards', () => {
    const tracker = new SpeechActivityTracker();

    tracker.started('mic');
    tracker.started('mic');
    tracker.finished('mic');

    expect(tracker.snapshot()).toEqual({ mic: true, system: false });
    tracker.finished('mic');
    expect(tracker.snapshot()).toEqual({ mic: false, system: false });
  });

  it('treats a partial as active without double-counting its later speech-start event', () => {
    const tracker = new SpeechActivityTracker();

    tracker.partial('system');
    expect(tracker.snapshot().system).toBe(true);
    tracker.started('system');
    tracker.finished('system');

    expect(tracker.snapshot().system).toBe(false);
  });
});

describe('selectForceTargetSource', () => {
  it('targets the microphone when it is the only enabled channel', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: false },
        { mic: true, system: false },
        { mic: 0, system: 0 },
      ),
    ).toBe('mic');
  });

  it('keeps system audio authoritative when the candidate microphone is still speaking', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: true },
        { mic: true, system: false },
        { mic: 1, system: 1 },
      ),
    ).toBe('system');
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

  it('does not treat a candidate microphone final as a question in dual-source mode', () => {
    expect(
      selectForceTargetSource(
        { mic: true, system: true },
        { mic: false, system: false },
        { mic: 4, system: 0 },
      ),
    ).toBe('system');
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

describe('shouldFinalizeCurrentSpeech', () => {
  it('uses the visible unconsumed final when noisy VAD still reports microphone speech', () => {
    expect(
      shouldFinalizeCurrentSpeech(
        'mic',
        { mic: true, system: false },
        { mic: 1, system: 0 },
      ),
    ).toBe(false);
  });

  it('flushes the active source when no final transcript is available yet', () => {
    expect(
      shouldFinalizeCurrentSpeech(
        'mic',
        { mic: true, system: false },
        { mic: 0, system: 0 },
      ),
    ).toBe(true);
  });

  it('flushes a recently finalized prefix when speech-start may still be in flight', () => {
    expect(
      shouldFinalizeCurrentSpeech(
        'mic',
        { mic: false, system: false },
        { mic: 1, system: 0 },
        7_561,
        8_193,
      ),
    ).toBe(true);
  });

  it('uses an older finalized question immediately when no speech is active', () => {
    expect(
      shouldFinalizeCurrentSpeech(
        'mic',
        { mic: false, system: false },
        { mic: 1, system: 0 },
        7_000,
        8_193,
      ),
    ).toBe(false);
  });
});
