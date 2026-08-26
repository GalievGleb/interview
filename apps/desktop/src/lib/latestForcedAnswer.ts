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
  receivedAt?: number;
  utteranceId?: string;
  capturedAtMs?: number;
  queueWaitMs?: number;
  queueDepth?: number;
  speechEndToFinalMs?: number;
  openaiInferenceMs?: number;
}

export interface ForceSnapshot {
  generation: number;
  consumedSequence: number;
  requestId: string | null;
  source: 'mic' | 'system' | null;
  phase: ForcePhase;
  pendingRequestCount: number;
  fallbackStartedAtMs: number | null;
  fallbackDeadlineMs: number | null;
  screenOutputCommitted: boolean;
  screenRevision: number;
}

export type ForceDecision =
  | { action: 'submit'; generation: number; sequence: number; question: string }
  | { action: 'flush'; generation: number; requestId: string; source: 'mic' | 'system' }
  | { action: 'unavailable'; generation: number };

export type ForceAcceptDecision =
  | { action: 'submit'; generation: number; sequence: number; question: string }
  | { action: 'wait'; generation: number }
  | { action: 'store-only' };

interface PendingFinalization {
  generation: number;
  source: 'mic' | 'system';
  finalizedPrefix: ForcedTranscriptLine[];
  earlyIdlessFinals: ForcedTranscriptLine[];
  acceptNextIdlessFinal: boolean;
}

const MAX_SAME_QUESTION_FINAL_GAP_MS = 20_000;
const MAX_TEXT_CAPTURE_AGE_MS = 20_000;
const MAX_SCREEN_REPLACEMENT_MS = 1_500;

export function shouldCancelScreenFallbackOwner(
  ownedGeneration: number,
  currentGeneration: number,
  phase: ForcePhase,
): boolean {
  return (
    ownedGeneration > 0 &&
    (ownedGeneration !== currentGeneration || phase !== 'screen-fallback')
  );
}

export interface ForceFallbackScheduleSnapshot {
  generation: number;
  deadlineMs: number;
}

export class ForceFallbackScheduler {
  private scheduled:
    | (ForceFallbackScheduleSnapshot & { timer: ReturnType<typeof setTimeout> })
    | null = null;

  constructor(
    private readonly onElapsed: (generation: number) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: (
      callback: () => void,
      delayMs: number,
    ) => ReturnType<typeof setTimeout> = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly cancelTimer: (timer: ReturnType<typeof setTimeout>) => void = (timer) =>
      clearTimeout(timer),
  ) {}

  schedule(generation: number, delayMs: number): boolean {
    const normalizedDelayMs = Math.max(0, delayMs);
    const deadlineMs = this.now() + normalizedDelayMs;
    if (this.scheduled) {
      if (generation < this.scheduled.generation) return false;
      if (
        generation === this.scheduled.generation &&
        deadlineMs >= this.scheduled.deadlineMs
      ) {
        return false;
      }
      this.cancelTimer(this.scheduled.timer);
    }
    const timer = this.setTimer(() => {
      if (!this.scheduled || this.scheduled.timer !== timer) return;
      this.scheduled = null;
      this.onElapsed(generation);
    }, normalizedDelayMs);
    this.scheduled = { generation, deadlineMs, timer };
    return true;
  }

  cancel(replacementGeneration?: number): boolean {
    if (!this.scheduled) return false;
    if (
      replacementGeneration != null &&
      replacementGeneration < this.scheduled.generation
    ) {
      return false;
    }
    this.cancelTimer(this.scheduled.timer);
    this.scheduled = null;
    return true;
  }

  snapshot(): ForceFallbackScheduleSnapshot | null {
    if (!this.scheduled) return null;
    return {
      generation: this.scheduled.generation,
      deadlineMs: this.scheduled.deadlineMs,
    };
  }
}

function normalizedFragment(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function hasCaptureTime(line: ForcedTranscriptLine): boolean {
  return typeof line.capturedAtMs === 'number' && Number.isFinite(line.capturedAtMs);
}

function isFreshCapture(line: ForcedTranscriptLine, now: number): boolean {
  return !hasCaptureTime(line) || now - line.capturedAtMs! <= MAX_TEXT_CAPTURE_AGE_MS;
}

function lineOrder(left: ForcedTranscriptLine, right: ForcedTranscriptLine): number {
  if (hasCaptureTime(left) && hasCaptureTime(right)) {
    return left.capturedAtMs! - right.capturedAtMs! || left.sequence - right.sequence;
  }
  if (!hasCaptureTime(left) && !hasCaptureTime(right)) {
    if (left.receivedAt != null && right.receivedAt != null) {
      return left.receivedAt - right.receivedAt || left.sequence - right.sequence;
    }
  }
  return left.sequence - right.sequence;
}

function lineGap(older: ForcedTranscriptLine, newer: ForcedTranscriptLine): number | null {
  if (hasCaptureTime(older) && hasCaptureTime(newer)) {
    return newer.capturedAtMs! - older.capturedAtMs!;
  }
  if (!hasCaptureTime(older) && !hasCaptureTime(newer)) {
    if (older.receivedAt != null && newer.receivedAt != null) {
      return newer.receivedAt - older.receivedAt;
    }
  }
  return null;
}

function collectQuestionFragments(
  lines: ForcedTranscriptLine[],
  consumedSequence: number,
  source: 'mic' | 'system' | null,
  consumedUtteranceIds: ReadonlySet<string>,
): ForcedTranscriptLine[] {
  const candidates = lines.filter(
    (line) =>
      line.sequence > consumedSequence &&
      line.text.trim().length > 0 &&
      (!source || !line.source || line.source === source) &&
      (!line.utteranceId || !consumedUtteranceIds.has(line.utteranceId)),
  );
  if (candidates.length === 0) return [];

  const deduplicated = new Map<string, ForcedTranscriptLine>();
  const withoutId: ForcedTranscriptLine[] = [];
  for (const line of candidates) {
    if (!line.utteranceId) {
      withoutId.push(line);
      continue;
    }
    const prior = deduplicated.get(line.utteranceId);
    if (!prior || line.sequence > prior.sequence) deduplicated.set(line.utteranceId, line);
  }
  const unique = [...withoutId, ...deduplicated.values()];
  const terminal = unique.reduce((latest, line) =>
    line.sequence > latest.sequence ? line : latest,
  );
  const terminalHasCapture = hasCaptureTime(terminal);
  const ordered = unique
    .filter((line) => hasCaptureTime(line) === terminalHasCapture)
    .sort(lineOrder);

  const selected: ForcedTranscriptLine[] = [];
  for (let cursor = ordered.length - 1; cursor >= 0; cursor -= 1) {
    const line = ordered[cursor];
    const newer = selected[0];
    if (newer) {
      const gap = lineGap(line, newer);
      if (gap != null && gap > MAX_SAME_QUESTION_FINAL_GAP_MS) break;
    }
    selected.unshift(line);
  }
  return selected;
}

function mergeQuestionFragments(lines: ForcedTranscriptLine[]): string {
  let merged = '';
  for (const line of lines) {
    const fragment = line.text.trim();
    if (!fragment) continue;
    if (!merged) {
      merged = fragment;
      continue;
    }
    const mergedNormalized = normalizedFragment(merged);
    const fragmentNormalized = normalizedFragment(fragment);
    if (fragmentNormalized === mergedNormalized || mergedNormalized.endsWith(fragmentNormalized)) {
      continue;
    }
    if (fragmentNormalized.startsWith(mergedNormalized)) {
      merged = fragment;
      continue;
    }
    merged = `${merged} ${fragment}`;
  }
  return merged.trim();
}

export class LatestForcedAnswerCoordinator {
  private state: ForceSnapshot = {
    generation: 0,
    consumedSequence: 0,
    requestId: null,
    source: null,
    phase: 'idle',
    pendingRequestCount: 0,
    fallbackStartedAtMs: null,
    fallbackDeadlineMs: null,
    screenOutputCommitted: false,
    screenRevision: 0,
  };
  private readonly pendingFinalizations = new Map<string, PendingFinalization>();
  private readonly consumedUtteranceIds = new Set<string>();

  constructor(
    private readonly createRequestId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  snapshot(): ForceSnapshot {
    return { ...this.state, pendingRequestCount: this.pendingFinalizations.size };
  }

  private consume(line: ForcedTranscriptLine): void {
    if (line.utteranceId) this.consumedUtteranceIds.add(line.utteranceId);
    if (line.sequence > this.state.consumedSequence) {
      this.state = { ...this.state, consumedSequence: line.sequence };
    }
  }

  private consumeAll(lines: ForcedTranscriptLine[]): void {
    for (const line of lines) this.consume(line);
  }

  press(
    lines: ForcedTranscriptLine[],
    source: 'mic' | 'system' | null,
    forceCurrentSpeechFinalization = false,
  ): ForceDecision {
    const generation = this.state.generation + 1;
    const consumedAtPress = this.state.consumedSequence;
    this.pendingFinalizations.clear();
    const relevant = lines.filter(
      (line) =>
        line.sequence > consumedAtPress &&
        (!source || !line.source || line.source === source) &&
        (!line.utteranceId || !this.consumedUtteranceIds.has(line.utteranceId)),
    );
    const now = this.now();
    const stale = relevant.filter((line) => hasCaptureTime(line) && !isFreshCapture(line, now));
    const eligible = relevant.filter((line) => !hasCaptureTime(line) || isFreshCapture(line, now));
    const finalizedPrefix = collectQuestionFragments(
      eligible,
      consumedAtPress,
      source,
      this.consumedUtteranceIds,
    );
    this.consumeAll(stale);
    const line = forceCurrentSpeechFinalization ? undefined : finalizedPrefix.at(-1);

    if (line) {
      this.consumeAll(finalizedPrefix);
      const sequence = Math.max(...finalizedPrefix.map((fragment) => fragment.sequence));
      this.state = {
        ...this.state,
        generation,
        consumedSequence: Math.max(this.state.consumedSequence, sequence),
        requestId: null,
        source: null,
        phase: 'waiting-first-token',
        pendingRequestCount: 0,
        fallbackStartedAtMs: null,
        fallbackDeadlineMs: null,
        screenOutputCommitted: false,
      };
      return { action: 'submit', generation, sequence, question: mergeQuestionFragments(finalizedPrefix) };
    }

    if (!source) {
      this.state = {
        ...this.state,
        generation,
        requestId: null,
        source: null,
        phase: 'error',
        pendingRequestCount: 0,
        fallbackStartedAtMs: null,
        fallbackDeadlineMs: null,
        screenOutputCommitted: false,
      };
      return { action: 'unavailable', generation };
    }

    const requestId = this.createRequestId();
    this.pendingFinalizations.set(requestId, {
      generation,
      source,
      finalizedPrefix,
      earlyIdlessFinals: [],
      acceptNextIdlessFinal: false,
    });
    this.state = {
      ...this.state,
      generation,
      requestId,
      source,
      phase: 'finalizing-transcript',
      pendingRequestCount: 1,
      fallbackStartedAtMs: null,
      fallbackDeadlineMs: null,
      screenOutputCommitted: false,
    };
    return { action: 'flush', generation, requestId, source };
  }

  acceptFinal(line: ForcedTranscriptLine, requestId?: string): ForceAcceptDecision {
    if (line.utteranceId && this.consumedUtteranceIds.has(line.utteranceId)) {
      this.consume(line);
      return { action: 'store-only' };
    }
    const now = this.now();
    if (hasCaptureTime(line) && !isFreshCapture(line, now)) {
      this.consume(line);
      return { action: 'store-only' };
    }

    const activeRequestId = this.state.requestId;
    let resolvedRequestId = requestId;
    if (!resolvedRequestId && activeRequestId) {
      const activePending = this.pendingFinalizations.get(activeRequestId);
      if (
        activePending &&
        activePending.generation === this.state.generation &&
        line.sequence > this.state.consumedSequence &&
        (!line.source || line.source === activePending.source)
      ) {
        if (!activePending.acceptNextIdlessFinal) {
          const withoutDuplicate = activePending.earlyIdlessFinals.filter((candidate) =>
            line.utteranceId
              ? candidate.utteranceId !== line.utteranceId
              : candidate.sequence !== line.sequence,
          );
          this.pendingFinalizations.set(activeRequestId, {
            ...activePending,
            earlyIdlessFinals: [...withoutDuplicate, line].slice(-10),
          });
          return { action: 'wait', generation: activePending.generation };
        }
        resolvedRequestId = activeRequestId;
      } else {
        return { action: 'store-only' };
      }
    }

    const pending = resolvedRequestId
      ? this.pendingFinalizations.get(resolvedRequestId)
      : undefined;
    if (!pending || pending.generation !== this.state.generation) {
      this.consume(line);
      if (resolvedRequestId) this.pendingFinalizations.delete(resolvedRequestId);
      return { action: 'store-only' };
    }
    if (line.sequence <= this.state.consumedSequence || (line.source && line.source !== pending.source)) {
      return { action: 'store-only' };
    }

    if (this.state.phase === 'screen-fallback') {
      const withinDeadline =
        this.state.fallbackDeadlineMs != null && now <= this.state.fallbackDeadlineMs;
      if (
        resolvedRequestId !== activeRequestId ||
        !hasCaptureTime(line) ||
        !withinDeadline ||
        this.state.screenOutputCommitted
      ) {
        this.consume(line);
        this.pendingFinalizations.delete(resolvedRequestId!);
        return { action: 'store-only' };
      }
    }

    this.pendingFinalizations.delete(resolvedRequestId!);
    if (activeRequestId) this.pendingFinalizations.delete(activeRequestId);
    const allLines = [...pending.finalizedPrefix, line];
    const stalePrefix = allLines.filter(
      (fragment) => hasCaptureTime(fragment) && !isFreshCapture(fragment, now),
    );
    this.consumeAll(stalePrefix);
    const questionLines = collectQuestionFragments(
      allLines.filter((fragment) => !hasCaptureTime(fragment) || isFreshCapture(fragment, now)),
      this.state.consumedSequence,
      pending.source,
      this.consumedUtteranceIds,
    );
    if (questionLines.length === 0) {
      this.consume(line);
      return { action: 'store-only' };
    }
    this.consumeAll(questionLines);
    const latestSequence = Math.max(...questionLines.map((fragment) => fragment.sequence));
    this.state = {
      ...this.state,
      generation: pending.generation,
      consumedSequence: Math.max(this.state.consumedSequence, latestSequence),
      requestId: null,
      source: null,
      phase: 'waiting-first-token',
      pendingRequestCount: 0,
      screenOutputCommitted: false,
    };
    return {
      action: 'submit',
      generation: pending.generation,
      sequence: latestSequence,
      question: mergeQuestionFragments(questionLines),
    };
  }

  acceptEmpty(requestId: string): ForceAcceptDecision {
    const pending = this.pendingFinalizations.get(requestId);
    if (!pending || pending.generation !== this.state.generation) {
      this.pendingFinalizations.delete(requestId);
      return { action: 'store-only' };
    }
    const earlyIdlessFinals = pending.earlyIdlessFinals;
    this.pendingFinalizations.set(requestId, {
      ...pending,
      finalizedPrefix: [
        ...pending.finalizedPrefix,
        ...earlyIdlessFinals.slice(0, -1),
      ],
      earlyIdlessFinals: [],
      acceptNextIdlessFinal: true,
    });
    const earlyFinal = earlyIdlessFinals.at(-1);
    if (earlyFinal) return this.acceptFinal(earlyFinal, requestId);
    return { action: 'wait', generation: pending.generation };
  }

  /**
   * Commits the transcript that was already final when Ctrl+Enter was pressed.
   * The caller invokes this only after a short empty-flush grace period, giving
   * an in-flight speech_started/final pair time to extend the same question.
   */
  commitFinalizedPrefix(requestId: string): ForceAcceptDecision {
    const pending = this.pendingFinalizations.get(requestId);
    if (
      !pending ||
      pending.generation !== this.state.generation ||
      this.state.phase !== 'finalizing-transcript'
    ) {
      this.pendingFinalizations.delete(requestId);
      return { action: 'store-only' };
    }

    const now = this.now();
    const stale = pending.finalizedPrefix.filter(
      (fragment) => hasCaptureTime(fragment) && !isFreshCapture(fragment, now),
    );
    this.consumeAll(stale);
    const questionLines = collectQuestionFragments(
      pending.finalizedPrefix.filter(
        (fragment) => !hasCaptureTime(fragment) || isFreshCapture(fragment, now),
      ),
      this.state.consumedSequence,
      pending.source,
      this.consumedUtteranceIds,
    );
    if (questionLines.length === 0) {
      return { action: 'wait', generation: pending.generation };
    }

    this.pendingFinalizations.delete(requestId);
    if (this.state.requestId) this.pendingFinalizations.delete(this.state.requestId);
    this.consumeAll(questionLines);
    const latestSequence = Math.max(...questionLines.map((fragment) => fragment.sequence));
    this.state = {
      ...this.state,
      generation: pending.generation,
      consumedSequence: Math.max(this.state.consumedSequence, latestSequence),
      requestId: null,
      source: null,
      phase: 'waiting-first-token',
      pendingRequestCount: 0,
      screenOutputCommitted: false,
    };
    return {
      action: 'submit',
      generation: pending.generation,
      sequence: latestSequence,
      question: mergeQuestionFragments(questionLines),
    };
  }

  markHandled(sequence: number): boolean {
    if (sequence <= this.state.consumedSequence) return false;
    this.state = { ...this.state, consumedSequence: sequence };
    return true;
  }

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
      fallbackStartedAtMs: null,
      fallbackDeadlineMs: null,
      screenOutputCommitted: false,
    };
    return {
      action: 'submit',
      generation,
      sequence: this.state.consumedSequence,
      question: question.trim(),
    };
  }

  beginScreenFallback(generation: number): boolean {
    if (
      generation !== this.state.generation ||
      (this.state.phase !== 'finalizing-transcript' && this.state.phase !== 'screen-fallback')
    ) {
      return false;
    }
    if (this.state.phase === 'screen-fallback') return true;
    const fallbackStartedAtMs = this.now();
    this.state = {
      ...this.state,
      phase: 'screen-fallback',
      fallbackStartedAtMs,
      fallbackDeadlineMs: fallbackStartedAtMs + MAX_SCREEN_REPLACEMENT_MS,
      screenOutputCommitted: false,
      screenRevision: this.state.screenRevision + 1,
    };
    return true;
  }

  routeQuestionToScreen(generation: number): boolean {
    if (generation !== this.state.generation || this.state.phase !== 'waiting-first-token') {
      return false;
    }
    this.pendingFinalizations.clear();
    const fallbackStartedAtMs = this.now();
    this.state = {
      ...this.state,
      requestId: null,
      source: null,
      phase: 'screen-fallback',
      pendingRequestCount: 0,
      fallbackStartedAtMs,
      fallbackDeadlineMs: fallbackStartedAtMs + MAX_SCREEN_REPLACEMENT_MS,
      screenOutputCommitted: false,
      screenRevision: this.state.screenRevision + 1,
    };
    return true;
  }

  commitScreenFirstOutput(generation: number, screenRevision: number): boolean {
    if (
      generation !== this.state.generation ||
      screenRevision !== this.state.screenRevision ||
      this.state.phase !== 'screen-fallback'
    ) {
      return false;
    }
    if (!this.state.screenOutputCommitted) {
      this.state = { ...this.state, screenOutputCommitted: true };
    }
    return true;
  }

  setPhase(generation: number, phase: ForcePhase): boolean {
    if (generation !== this.state.generation) return false;
    if (phase === 'done' || phase === 'error') {
      this.pendingFinalizations.clear();
      this.state = { ...this.state, requestId: null, source: null, phase, pendingRequestCount: 0 };
      return true;
    }
    this.state = { ...this.state, phase };
    return true;
  }

  reset(): void {
    this.pendingFinalizations.clear();
    this.consumedUtteranceIds.clear();
    this.state = {
      generation: 0,
      consumedSequence: 0,
      requestId: null,
      source: null,
      phase: 'idle',
      pendingRequestCount: 0,
      fallbackStartedAtMs: null,
      fallbackDeadlineMs: null,
      screenOutputCommitted: false,
      screenRevision: 0,
    };
  }
}

/**
 * Reports a delayed forced transcript without changing coordinator ownership.
 * A late request-tagged final can therefore still complete the same Ctrl+Enter
 * generation instead of losing to an unrelated automatic screen capture.
 */
export function notifyDelayedForcedTranscript(
  coordinator: Pick<LatestForcedAnswerCoordinator, 'snapshot'>,
  generation: number,
  onWaiting: (generation: number) => void,
): boolean {
  const snapshot = coordinator.snapshot();
  if (
    snapshot.generation !== generation ||
    snapshot.phase !== 'finalizing-transcript'
  ) {
    return false;
  }
  onWaiting(generation);
  return true;
}
