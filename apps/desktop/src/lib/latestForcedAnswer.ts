export type ForcePhase =
  | 'idle'
  | 'finalizing-transcript'
  | 'screen-fallback'
  | 'waiting-first-token'
  | 'streaming'
  | 'done'
  | 'error';

export interface ForcedTranscriptLine {
  sequence: number;
  text: string;
  source?: 'mic' | 'system';
}

export interface ForceSnapshot {
  generation: number;
  consumedSequence: number;
  requestId: string | null;
  source: 'mic' | 'system' | null;
  phase: ForcePhase;
  pendingRequestCount: number;
}

export type ForceDecision =
  | { action: 'submit'; generation: number; sequence: number; question: string }
  | {
      action: 'flush';
      generation: number;
      requestId: string;
      source: 'mic' | 'system';
    }
  | { action: 'unavailable'; generation: number };

export type ForceAcceptDecision =
  | { action: 'submit'; generation: number; sequence: number; question: string }
  | { action: 'wait'; generation: number }
  | { action: 'store-only' };

interface PendingFinalization {
  generation: number;
  source: 'mic' | 'system';
}

export class LatestForcedAnswerCoordinator {
  private state: ForceSnapshot = {
    generation: 0,
    consumedSequence: 0,
    requestId: null,
    source: null,
    phase: 'idle',
    pendingRequestCount: 0,
  };

  private readonly pendingFinalizations = new Map<string, PendingFinalization>();

  constructor(private readonly createRequestId: () => string = () => crypto.randomUUID()) {}

  snapshot(): ForceSnapshot {
    return { ...this.state, pendingRequestCount: this.pendingFinalizations.size };
  }

  press(
    lines: ForcedTranscriptLine[],
    source: 'mic' | 'system' | null,
    forceCurrentSpeechFinalization = false,
  ): ForceDecision {
    const generation = this.state.generation + 1;
    // Every press supersedes the previous forced finalization. Keeping older
    // request ids made late STT callbacks eligible forever and leaked the map.
    this.pendingFinalizations.clear();
    const line = forceCurrentSpeechFinalization
      ? undefined
      : [...lines]
        .reverse()
        .find(
          (item) =>
            item.sequence > this.state.consumedSequence &&
            (!source || !item.source || item.source === source),
        );

    if (line) {
      this.state = {
        generation,
        consumedSequence: line.sequence,
        requestId: null,
        source: null,
        phase: 'waiting-first-token',
        pendingRequestCount: 0,
      };
      return {
        action: 'submit',
        generation,
        sequence: line.sequence,
        question: line.text,
      };
    }

    if (!source) {
      this.state = {
        ...this.state,
        generation,
        requestId: null,
        source: null,
        phase: 'error',
        pendingRequestCount: 0,
      };
      return { action: 'unavailable', generation };
    }

    const requestId = this.createRequestId();
    this.pendingFinalizations.set(requestId, { generation, source });
    this.state = {
      ...this.state,
      generation,
      requestId,
      source,
      phase: 'finalizing-transcript',
      pendingRequestCount: 1,
    };
    return { action: 'flush', generation, requestId, source };
  }

  acceptFinal(line: ForcedTranscriptLine, requestId?: string): ForceAcceptDecision {
    const activeRequestId = this.state.requestId;

    // A forced finalize is tagged end-to-end by the STT server. While that
    // tagged request is pending, an id-less final from the same socket may be
    // an older transcription job that happened to finish first. Submitting it
    // immediately races the actual latest utterance and produces exactly the
    // wrong Ctrl+Enter answer. Keep waiting for the tagged result; the caller
    // refreshes the fallback timer so a busy transcription queue still gets a
    // chance to deliver it.
    if (!requestId && activeRequestId) {
      const activePending = this.pendingFinalizations.get(activeRequestId);
      if (
        activePending &&
        activePending.generation === this.state.generation &&
        line.sequence > this.state.consumedSequence &&
        (!line.source || line.source === activePending.source)
      ) {
        return { action: 'wait', generation: activePending.generation };
      }
      return { action: 'store-only' };
    }

    const pending = requestId
      ? this.pendingFinalizations.get(requestId)
      : (this.state.phase === 'finalizing-transcript' ||
            this.state.phase === 'screen-fallback') &&
          this.state.source
        ? { generation: this.state.generation, source: this.state.source }
        : undefined;

    if (
      !pending ||
      pending.generation !== this.state.generation ||
      line.sequence <= this.state.consumedSequence ||
      (line.source && line.source !== pending.source)
    ) {
      return { action: 'store-only' };
    }
    if (requestId) this.pendingFinalizations.delete(requestId);
    if (activeRequestId) this.pendingFinalizations.delete(activeRequestId);

    this.state = {
      generation: pending.generation,
      consumedSequence: line.sequence,
      requestId: null,
      source: null,
      phase: 'waiting-first-token',
      pendingRequestCount: 0,
    };
    return {
      action: 'submit',
      generation: pending.generation,
      sequence: line.sequence,
      question: line.text,
    };
  }

  acceptEmpty(requestId: string): ForceAcceptDecision {
    const pending = this.pendingFinalizations.get(requestId);
    if (!pending || pending.generation !== this.state.generation) {
      this.pendingFinalizations.delete(requestId);
      return { action: 'store-only' };
    }

    // An explicit finalize can complete before the streaming transcript final
    // arrives. Keep the generation open so that late final can still satisfy it;
    // the caller owns the short grace timer and screen fallback.
    return { action: 'wait', generation: pending.generation };
  }

  /** Mark a normal/stale transcript final as no longer eligible for Ctrl+Enter. */
  markHandled(sequence: number): boolean {
    if (sequence <= this.state.consumedSequence) return false;
    this.state = { ...this.state, consumedSequence: sequence };
    return true;
  }

  /** Start an explicitly typed question while preserving latest-wins semantics. */
  submitQuestion(question: string): Extract<ForceDecision, { action: 'submit' }> {
    const generation = this.state.generation + 1;
    this.pendingFinalizations.clear();
    this.state = {
      ...this.state,
      generation,
      requestId: null,
      source: null,
      phase: 'waiting-first-token',
      pendingRequestCount: 0,
    };
    return {
      action: 'submit',
      generation,
      sequence: this.state.consumedSequence,
      question: question.trim(),
    };
  }

  /**
   * Starts the screen fallback without closing the STT request. A final
   * transcript can arrive after screen capture has begun; that real question
   * must still replace the fallback for the same Ctrl+Enter generation.
   */
  beginScreenFallback(generation: number): boolean {
    if (
      generation !== this.state.generation ||
      (this.state.phase !== 'finalizing-transcript' &&
        this.state.phase !== 'screen-fallback')
    ) {
      return false;
    }
    this.state = { ...this.state, phase: 'screen-fallback' };
    return true;
  }

  /** Route an already finalized deictic question («что выведет этот код?»)
   * directly to vision. Unlike an empty-transcript fallback there is no pending
   * STT request to preserve. */
  routeQuestionToScreen(generation: number): boolean {
    if (generation !== this.state.generation || this.state.phase !== 'waiting-first-token') {
      return false;
    }
    this.pendingFinalizations.clear();
    this.state = {
      ...this.state,
      requestId: null,
      source: null,
      phase: 'screen-fallback',
      pendingRequestCount: 0,
    };
    return true;
  }

  setPhase(generation: number, phase: ForcePhase): boolean {
    if (generation !== this.state.generation) return false;
    if (phase === 'done' || phase === 'error') {
      this.pendingFinalizations.clear();
      this.state = {
        ...this.state,
        requestId: null,
        source: null,
        phase,
        pendingRequestCount: 0,
      };
      return true;
    }
    this.state = { ...this.state, phase };
    return true;
  }

  reset(): void {
    this.pendingFinalizations.clear();
    this.state = {
      generation: 0,
      consumedSequence: 0,
      requestId: null,
      source: null,
      phase: 'idle',
      pendingRequestCount: 0,
    };
  }
}
