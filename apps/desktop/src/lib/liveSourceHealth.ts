import type { AudioFrameSignal, AudioSource } from './audioCapture';

export const SYSTEM_AUDIO_NO_SIGNAL_MS = 30_000;
export const MIN_MIC_SPEECH_STARTS_FOR_SYSTEM_WARNING = 3;
export const SYSTEM_NO_SIGNAL_WARNING = 'system_no_signal_after_mic_speech' as const;

export type LiveSourceHealthWarning = typeof SYSTEM_NO_SIGNAL_WARNING;
export type LiveSourceHealthTransition = 'warning' | 'recovered';

export interface LiveSourceHealthResult {
  warning: LiveSourceHealthWarning | null;
  transition: LiveSourceHealthTransition | null;
}

export interface LiveSourceState {
  requested: boolean;
  ready: boolean;
  readyAtMs: number | null;
  captureEpoch: number | null;
  firstFrameAtMs: number | null;
  firstSignalAtMs: number | null;
  firstSpeechAtMs: number | null;
  signalFrameCount: number;
  speechStartCount: number;
  warning: LiveSourceHealthWarning | null;
}

export interface LiveSourceHealthSnapshot {
  sources: Record<AudioSource, LiveSourceState>;
  warning: LiveSourceHealthWarning | null;
}

function emptySourceState(requested: boolean): LiveSourceState {
  return {
    requested,
    ready: false,
    readyAtMs: null,
    captureEpoch: null,
    firstFrameAtMs: null,
    firstSignalAtMs: null,
    firstSpeechAtMs: null,
    signalFrameCount: 0,
    speechStartCount: 0,
    warning: null,
  };
}

export class LiveSourceHealth {
  private sources: Record<AudioSource, LiveSourceState>;
  private warning: LiveSourceHealthWarning | null = null;

  private clearWarningWithoutRecovery(): void {
    this.warning = null;
    this.sources.system.warning = null;
  }

  constructor(
    requested: Record<AudioSource, boolean>,
    private readonly now: () => number = Date.now,
  ) {
    this.sources = {
      mic: emptySourceState(requested.mic),
      system: emptySourceState(requested.system),
    };
  }

  markCaptureReady(
    source: AudioSource,
    captureEpoch: number,
    atMs = this.now(),
  ): LiveSourceHealthResult {
    const current = this.sources[source];
    if (current.captureEpoch != null && captureEpoch <= current.captureEpoch) {
      return { warning: this.warning, transition: null };
    }
    this.sources[source] = {
      ...emptySourceState(current.requested),
      ready: true,
      readyAtMs: atMs,
      captureEpoch,
    };
    this.clearWarningWithoutRecovery();
    return this.evaluate(atMs);
  }

  markCapturePending(source: AudioSource): LiveSourceHealthResult {
    const current = this.sources[source];
    this.sources[source] = {
      ...emptySourceState(current.requested),
      captureEpoch: current.captureEpoch,
    };
    this.clearWarningWithoutRecovery();
    return { warning: this.warning, transition: null };
  }

  markSourceRemoved(source: AudioSource): LiveSourceHealthResult {
    return this.markCapturePending(source);
  }

  observeAudioFrame(
    source: AudioSource,
    captureEpoch: number,
    signal: AudioFrameSignal,
  ): LiveSourceHealthResult {
    const state = this.sources[source];
    if (!state.ready || state.captureEpoch !== captureEpoch) {
      return { warning: this.warning, transition: null };
    }
    state.firstFrameAtMs ??= signal.capturedAtMs;
    if (signal.hasSignal) {
      state.firstSignalAtMs ??= signal.capturedAtMs;
      state.signalFrameCount += 1;
    }
    return this.evaluate(signal.capturedAtMs);
  }

  markSpeechStarted(
    source: AudioSource,
    captureEpoch: number,
    atMs = this.now(),
  ): LiveSourceHealthResult {
    const state = this.sources[source];
    if (!state.ready || state.captureEpoch !== captureEpoch) {
      return { warning: this.warning, transition: null };
    }
    state.firstSpeechAtMs ??= atMs;
    state.speechStartCount += 1;
    return this.evaluate(atMs);
  }

  evaluate(atMs = this.now()): LiveSourceHealthResult {
    const system = this.sources.system;
    const mic = this.sources.mic;
    const systemEvidenceObserved =
      system.firstSignalAtMs != null || system.firstSpeechAtMs != null;

    if (this.warning && systemEvidenceObserved) {
      this.warning = null;
      system.warning = null;
      return { warning: null, transition: 'recovered' };
    }

    const shouldWarn =
      !this.warning &&
      system.requested &&
      system.ready &&
      system.readyAtMs != null &&
      atMs - system.readyAtMs >= SYSTEM_AUDIO_NO_SIGNAL_MS &&
      mic.speechStartCount >= MIN_MIC_SPEECH_STARTS_FOR_SYSTEM_WARNING &&
      !systemEvidenceObserved;

    if (shouldWarn) {
      this.warning = SYSTEM_NO_SIGNAL_WARNING;
      system.warning = this.warning;
      return { warning: this.warning, transition: 'warning' };
    }
    return { warning: this.warning, transition: null };
  }

  nextEvaluationAtMs(): number | null {
    const system = this.sources.system;
    const mic = this.sources.mic;
    if (
      this.warning ||
      !system.requested ||
      !system.ready ||
      system.readyAtMs == null ||
      system.firstSignalAtMs != null ||
      system.firstSpeechAtMs != null ||
      mic.speechStartCount < MIN_MIC_SPEECH_STARTS_FOR_SYSTEM_WARNING
    ) {
      return null;
    }
    return system.readyAtMs + SYSTEM_AUDIO_NO_SIGNAL_MS;
  }

  snapshot(): LiveSourceHealthSnapshot {
    return {
      sources: {
        mic: { ...this.sources.mic },
        system: { ...this.sources.system },
      },
      warning: this.warning,
    };
  }
}

export function withAudioSource<T extends object>(
  source: AudioSource,
  data: T,
): T & { source: AudioSource } {
  return {
    ...data,
    source,
  };
}
