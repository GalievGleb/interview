import { describe, expect, it, vi } from 'vitest';
import {
  LiveSourceHealth,
  SYSTEM_AUDIO_NO_SIGNAL_MS,
  SYSTEM_ONLY_AUDIO_NO_SIGNAL_MS,
  SYSTEM_NO_SIGNAL_WARNING,
  withAudioSource,
} from './liveSourceHealth';

function fakeClock(startAtMs = 1_000) {
  let nowMs = startAtMs;
  return {
    now: () => nowMs,
    set: (value: number) => {
      nowMs = value;
    },
  };
}

describe('LiveSourceHealth', () => {
  it('does not warn for a pending permission dialog or initial silence', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    clock.set(61_000);
    expect(health.evaluate()).toEqual({ warning: null, transition: null });

    health.markCaptureReady('system', 1);
    clock.set(91_000);
    expect(health.evaluate()).toEqual({ warning: null, transition: null });
    expect(health.snapshot().sources.system.readyAtMs).toBe(61_000);
  });

  it('warns at the exact ready-duration and mic-speech evidence threshold only once', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    clock.set(10_000);
    health.markCaptureReady('mic', 1);
    health.markSpeechStarted('mic', 1);
    clock.set(20_000);
    health.markSpeechStarted('mic', 1);
    clock.set(30_999);
    health.markSpeechStarted('mic', 1);

    expect(health.evaluate()).toEqual({ warning: null, transition: null });
    expect(health.nextEvaluationAtMs()).toBe(31_000);
    clock.set(1_000 + SYSTEM_AUDIO_NO_SIGNAL_MS);
    expect(health.evaluate()).toEqual({
      warning: SYSTEM_NO_SIGNAL_WARNING,
      transition: 'warning',
    });
    expect(health.snapshot().sources.system.warning).toBe(SYSTEM_NO_SIGNAL_WARNING);
    expect(health.evaluate()).toEqual({
      warning: SYSTEM_NO_SIGNAL_WARNING,
      transition: null,
    });
  });

  it('warns quickly when system audio is the only requested source and has no signal', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: false, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    expect(health.nextEvaluationAtMs()).toBe(1_000 + SYSTEM_ONLY_AUDIO_NO_SIGNAL_MS);

    clock.set(1_000 + SYSTEM_ONLY_AUDIO_NO_SIGNAL_MS - 1);
    expect(health.evaluate()).toEqual({ warning: null, transition: null });

    clock.set(1_000 + SYSTEM_ONLY_AUDIO_NO_SIGNAL_MS);
    expect(health.evaluate()).toEqual({
      warning: SYSTEM_NO_SIGNAL_WARNING,
      transition: 'warning',
    });
  });

  it('does not warn in system-only mode once system signal is observed', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: false, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    health.observeAudioFrame('system', 1, {
      capturedAtMs: 1_500,
      rms: 0.2,
      peak: 0.4,
      hasSignal: true,
    });
    clock.set(1_000 + SYSTEM_ONLY_AUDIO_NO_SIGNAL_MS);

    expect(health.evaluate()).toEqual({ warning: null, transition: null });
    expect(health.nextEvaluationAtMs()).toBeNull();
  });

  it('recovers immediately and only once when system signal appears', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    health.markCaptureReady('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    clock.set(31_000);
    expect(health.evaluate().transition).toBe('warning');

    expect(
      health.observeAudioFrame('system', 1, {
        capturedAtMs: 31_001,
        rms: 0.25,
        peak: 0.5,
        hasSignal: true,
      }),
    ).toEqual({ warning: null, transition: 'recovered' });
    expect(
      health.observeAudioFrame('system', 1, {
        capturedAtMs: 31_002,
        rms: 0.2,
        peak: 0.4,
        hasSignal: true,
      }),
    ).toEqual({ warning: null, transition: null });
  });

  it('treats system STT speech as immediate recovery even without a level sample', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    health.markCaptureReady('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    clock.set(31_000);
    health.evaluate();

    expect(health.markSpeechStarted('system', 1)).toEqual({
      warning: null,
      transition: 'recovered',
    });
    expect(health.snapshot().sources.system.firstSpeechAtMs).toBe(31_000);
  });

  it('never warns when system audio was not requested', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: false }, clock.now);

    health.markCaptureReady('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    clock.set(120_000);

    expect(health.evaluate()).toEqual({ warning: null, transition: null });
  });

  it('keeps only bounded metadata, first observations, and counts in its snapshot', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('mic', 1);
    health.observeAudioFrame('mic', 1, {
      capturedAtMs: 1_005,
      rms: 0,
      peak: 0,
      hasSignal: false,
    });
    health.observeAudioFrame('mic', 1, {
      capturedAtMs: 1_250,
      rms: 0.1,
      peak: 0.2,
      hasSignal: true,
    });
    health.markSpeechStarted('mic', 1);

    const snapshot = health.snapshot();
    expect(snapshot.sources.mic).toEqual({
      requested: true,
      ready: true,
      readyAtMs: 1_000,
      captureEpoch: 1,
      firstFrameAtMs: 1_005,
      firstSignalAtMs: 1_250,
      firstSpeechAtMs: 1_000,
      signalFrameCount: 1,
      speechStartCount: 1,
      warning: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/pcm|buffer|audioData/i);
  });

  it('starts fresh after pause/resume capture epochs', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    health.markCaptureReady('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.observeAudioFrame('system', 1, {
      capturedAtMs: 1_100,
      rms: 0.2,
      peak: 0.4,
      hasSignal: true,
    });

    clock.set(50_000);
    health.markCaptureReady('system', 2);
    health.markCaptureReady('mic', 2);
    expect(health.snapshot().sources.system.firstSignalAtMs).toBeNull();
    expect(health.snapshot().sources.mic.speechStartCount).toBe(0);

    health.markSpeechStarted('mic', 2);
    health.markSpeechStarted('mic', 2);
    health.markSpeechStarted('mic', 2);
    clock.set(79_999);
    expect(health.evaluate().warning).toBeNull();
    clock.set(80_000);
    expect(health.evaluate().warning).toBe(SYSTEM_NO_SIGNAL_WARNING);
  });

  it('rejects signal and speech from an older reconnect epoch', () => {
    const clock = fakeClock();
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    health.markCaptureReady('system', 2);
    health.observeAudioFrame('system', 1, {
      capturedAtMs: 1_500,
      rms: 0.2,
      peak: 0.4,
      hasSignal: true,
    });
    health.markCaptureReady('mic', 2);
    health.markSpeechStarted('mic', 1);

    expect(health.snapshot().sources.system.firstSignalAtMs).toBeNull();
    expect(health.snapshot().sources.mic.speechStartCount).toBe(0);
  });

  it('invalidates a removed system source before its deadline can warn', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const health = new LiveSourceHealth({ mic: true, system: true });

      health.markCaptureReady('system', 1);
      health.markCaptureReady('mic', 1);
      health.markSpeechStarted('mic', 1);
      health.markSpeechStarted('mic', 1);
      health.markSpeechStarted('mic', 1);
      vi.advanceTimersByTime(29_999);

      expect(health.markSourceRemoved('system')).toEqual({
        warning: null,
        transition: null,
      });
      vi.advanceTimersByTime(1);
      expect(health.evaluate()).toEqual({ warning: null, transition: null });
      expect(health.nextEvaluationAtMs()).toBeNull();
      expect(health.snapshot().sources.system).toEqual({
        requested: true,
        ready: false,
        readyAtMs: null,
        captureEpoch: 1,
        firstFrameAtMs: null,
        firstSignalAtMs: null,
        firstSpeechAtMs: null,
        signalFrameCount: 0,
        speechStartCount: 0,
        warning: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['pending', 'removed'] as const)(
    'clears an active warning silently when the mic epoch becomes %s',
    (change) => {
      const clock = fakeClock(0);
      const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

      health.markCaptureReady('system', 1);
      health.markCaptureReady('mic', 1);
      health.markSpeechStarted('mic', 1);
      health.markSpeechStarted('mic', 1);
      health.markSpeechStarted('mic', 1);
      clock.set(30_000);
      expect(health.evaluate().transition).toBe('warning');

      const result =
        change === 'pending'
          ? health.markCapturePending('mic')
          : health.markSourceRemoved('mic');
      expect(result).toEqual({ warning: null, transition: null });
      expect(health.snapshot().warning).toBeNull();
      expect(health.snapshot().sources.system.warning).toBeNull();
      expect(health.snapshot().sources.mic.ready).toBe(false);
    },
  );

  it('requires three fresh mic starts after an active warning is reset by a new epoch', () => {
    const clock = fakeClock(0);
    const health = new LiveSourceHealth({ mic: true, system: true }, clock.now);

    health.markCaptureReady('system', 1);
    health.markCaptureReady('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    health.markSpeechStarted('mic', 1);
    clock.set(30_000);
    expect(health.evaluate().transition).toBe('warning');

    expect(health.markCaptureReady('mic', 2)).toEqual({
      warning: null,
      transition: null,
    });
    expect(health.snapshot().sources.mic.speechStartCount).toBe(0);
    expect(health.markSpeechStarted('mic', 2).warning).toBeNull();
    expect(health.markSpeechStarted('mic', 2).warning).toBeNull();
    expect(health.markSpeechStarted('mic', 2)).toEqual({
      warning: SYSTEM_NO_SIGNAL_WARNING,
      transition: 'warning',
    });
  });
});

describe('source-aware diagnostic metadata', () => {
  it('keeps physical source explicit and separate from speaker', () => {
    expect(
      withAudioSource('system', {
        speaker: 'other' as const,
        reason: 'low_quality',
        meta: { recoverable: true },
      }),
    ).toEqual({
      speaker: 'other',
      reason: 'low_quality',
      source: 'system',
      meta: { recoverable: true },
    });
  });
});
