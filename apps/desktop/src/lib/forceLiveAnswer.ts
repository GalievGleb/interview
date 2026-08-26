export type ForceAudioSource = 'mic' | 'system';

const RECENT_FINAL_STABILIZATION_MS = 900;

interface SpeechActivityState {
  pending: number;
  provisionalPartial: boolean;
}

/**
 * Tracks overlapping STT utterances per audio source.
 *
 * A boolean is not enough here: the provider may report `speech_started` for
 * utterance B before the final transcript for utterance A arrives. Finishing A
 * must not make Ctrl+Enter believe that B has also finished.
 */
export class SpeechActivityTracker {
  private readonly state: Record<ForceAudioSource, SpeechActivityState> = {
    mic: { pending: 0, provisionalPartial: false },
    system: { pending: 0, provisionalPartial: false },
  };

  started(source: ForceAudioSource): void {
    const current = this.state[source];
    if (current.provisionalPartial && current.pending === 0) {
      current.provisionalPartial = false;
      current.pending = 1;
      return;
    }
    current.pending += 1;
  }

  partial(source: ForceAudioSource): void {
    const current = this.state[source];
    if (current.pending === 0) current.provisionalPartial = true;
  }

  finished(source: ForceAudioSource): void {
    const current = this.state[source];
    if (current.pending > 0) current.pending -= 1;
    else current.provisionalPartial = false;
  }

  resetSource(source: ForceAudioSource): void {
    this.state[source] = { pending: 0, provisionalPartial: false };
  }

  reset(): void {
    this.resetSource('mic');
    this.resetSource('system');
  }

  snapshot(): Record<ForceAudioSource, boolean> {
    return {
      mic: this.state.mic.pending > 0 || this.state.mic.provisionalPartial,
      system: this.state.system.pending > 0 || this.state.system.provisionalPartial,
    };
  }
}

export function selectForceTargetSource(
  sources: {
    mic: boolean;
    system: boolean;
  },
  speaking: {
    mic: boolean;
    system: boolean;
  } = { mic: false, system: false },
  unconsumed: {
    mic: number;
    system: number;
  } = { mic: 0, system: 0 },
): 'mic' | 'system' | null {
  // With desktop/system capture enabled, that channel owns the interviewer's
  // questions. Candidate speech on mic must never steal Ctrl+Enter merely
  // because it is newer or still active; doing so also advances the shared
  // transcript cursor past the real interviewer question.
  if (sources.system) return 'system';
  if (sources.mic && (speaking.mic || unconsumed.mic > 0)) return 'mic';
  if (sources.mic) return 'mic';
  return null;
}

export function shouldFinalizeCurrentSpeech(
  source: ForceAudioSource | null,
  speaking: Record<ForceAudioSource, boolean>,
  unconsumed: Record<ForceAudioSource, number>,
  latestUnconsumedFinalReceivedAt?: number,
  pressedAtMs = Date.now(),
): boolean {
  if (source == null) return false;
  if (speaking[source] && unconsumed[source] === 0) return true;
  if (
    unconsumed[source] === 0 ||
    latestUnconsumedFinalReceivedAt == null ||
    !Number.isFinite(latestUnconsumedFinalReceivedAt)
  ) {
    return false;
  }

  const finalAgeMs = pressedAtMs - latestUnconsumedFinalReceivedAt;
  return finalAgeMs >= 0 && finalAgeMs <= RECENT_FINAL_STABILIZATION_MS;
}
