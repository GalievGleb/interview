import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { decideAnswerAction } from '../lib/liveAnswerMachine';
import {
  startLiveSession,
  LiveSession,
  SttTimings,
  type SttTranscriptMetadata,
} from '../lib/liveSession';
import { prepareTranscriptForLlm, PreparedTranscript } from '../lib/prepareTranscriptForLlm';
import { SttSessionOptions } from '../lib/sttOptions';
import { requiresScreenContext } from '../lib/visualQuestion';
import {
  findLatestUnconsumedScreenCaptureCue,
  isSpokenScreenCaptureCue,
  screenCaptureRequestFromCue,
} from '../lib/screenTaskContinuity';
import {
  evaluateForcedFinalTranscript,
  evaluateForcedTranscript,
} from '../lib/forcedTranscriptQuality';
import { recordSkipped } from '../lib/skippedLog';
import { t } from '../lib/i18n';
import { audioSourceFailureMessage } from '../lib/audioSourceFailure';
import {
  selectForceTargetSource,
  shouldFinalizeCurrentSpeech,
  SpeechActivityTracker,
} from '../lib/forceLiveAnswer';
import {
  completeForcedAnswerStream,
  expireDelayedForcedTranscript,
  ForceFallbackScheduler,
  LatestForcedAnswerCoordinator,
  markForcedAnswerStreamStarted,
  notifyDelayedForcedTranscript,
  type ForceAcceptDecision,
  type ForcePhase,
  type ForcedTranscriptLine,
} from '../lib/latestForcedAnswer';
import {
  createEmptySessionContext,
  pushUtteranceBuffer,
  sanitizeLiveAnswer,
  trimSpokenAnswer,
  shouldWaitForMoreSpeech,
  shouldForceProceedIncomplete,
  updateSessionContextAfterAnswer,
  type InterviewSessionContext,
  type UtteranceBufferEntry,
  type UtteranceSpeaker,
} from '@interview/shared';
import {
  looksLikeQuestion,
  mergeRawParts,
  normalizeTranscript,
  stripExperienceFooter,
  isGarbageTranscript,
  isNonQuestionFragment,
} from '../lib/normalizeTranscript';
import type { SttDebugInfo } from '../components/SttDebugPanel';
import { SessionTranscriptWriteQueue } from '../lib/sessionTranscriptWriteQueue';
import { LiveDebugRecorder, type DebugBundle } from '../lib/liveDebugRecorder';
import {
  ActiveScreenAssistCancellation,
  ScreenAssistDiagnostics,
  SerializedDiagnosticsWriter,
  TimeoutScreenPartialState,
  mergeDebugBundles,
  type ScreenAssistTrigger,
} from '../lib/screenAssistDiagnostics';
import {
  LiveSourceHealth,
  SYSTEM_NO_SIGNAL_WARNING,
  type LiveSourceHealthResult,
  withAudioSource,
} from '../lib/liveSourceHealth';
import {
  buildLatencyBreakdown,
  computeExchangeSttLatencyMs,
} from '../lib/liveTiming';
import {
  buildExchangeLatency,
  buildPipelineFromPrepared,
  type CopilotAnswerEntry,
  type CopilotAnswerPipeline,
  type AnswerSttDiagnostics,
  type ExchangeLatency,
  type Speaker,
  type TranscriptLine,
} from '../lib/interviewSessionExport';
import { resolvePreferredResume } from '../lib/resumeContext';
import {
  ActiveScreenTaskContextMemory,
  CandidateFollowUpGenerationOwner,
  dispatchOwnedCandidateFollowUp,
} from '../lib/candidateFollowUp';

export type { Speaker, TranscriptLine, CopilotAnswerEntry, CopilotAnswerPipeline };
export type { SttDebugInfo };

export interface LiveSources {
  mic: boolean;
  system: boolean;
}

export interface LiveSessionLink {
  sessionId?: string;
  title?: string;
}

export type ForceAnswerStatus = 'started' | 'finalizing' | 'unavailable';

interface LiveEntry {
  source: 'mic' | 'system';
  session: LiveSession;
}

/** Fallback debounce, если speech_final / utterance_end не пришли. */
const FINAL_FALLBACK_MS = 450;
const SPEECH_FINAL_DELAY_MS = 280;
const INCOMPLETE_RETRY_MS = 700;
const FORCE_FINALIZE_TIMEOUT_MS = 3500;
const FORCE_FINALIZE_HARD_DEADLINE_MS = 12_000;
const FORCE_EMPTY_GRACE_MS = 1400;
const FORCE_PREFIX_STABILIZATION_MS = 120;
interface LiveTimingState {
  audioCaptureStartAt: number | null;
  speechDetectedAt: number | null;
  speechEndedAt: number | null;
  finalTranscriptionStartAt: number | null;
  finalTranscriptionEndAt: number | null;
  llmRequestStartAt: number | null;
  llmFirstTokenAt: number | null;
  llmEndAt: number | null;
}

interface AnswerRequest {
  prepared: PreparedTranscript;
  serverTimings: SttTimings | null;
  questionFinalAt: number | null;
  forceGeneration?: number;
  stt?: AnswerSttDiagnostics;
  displayQuestion?: string;
  preservePreviousTopic?: boolean;
  taskContextUpdate?: {
    rootQuestion: string;
    currentQuestion: string;
  };
}

interface QueuedAnswerRequest {
  rawMerged: string;
  serverTimings: SttTimings | null;
  questionFinalAt: number | null;
}

interface ForceScreenFallbackRequest {
  generation: number;
  screenRevision: number;
  question: string;
  untrustedPartialHint?: string;
}

const EMPTY_FORCE_SCREEN_FALLBACK: ForceScreenFallbackRequest = {
  generation: 0,
  screenRevision: 0,
  question: '',
};

interface ForcedSttSubmissionHandlers {
  prepare: () => void;
  reject: (question: string, generation: number, reason: string) => void;
  routeVisualToScreen: (question: string, generation: number) => boolean;
  askQuestion: (question: string, generation: number) => void;
}

export function dispatchForcedSttSubmission(
  decision: Extract<ForceAcceptDecision, { action: 'submit' }>,
  language: string | null | undefined,
  handlers: ForcedSttSubmissionHandlers,
): 'rejected' | 'screen' | 'text' {
  const quality = evaluateForcedTranscript(decision.question, language);
  if (!quality.eligible) {
    handlers.reject(decision.question, decision.generation, quality.reason);
    return 'rejected';
  }
  handlers.prepare();
  if (handlers.routeVisualToScreen(decision.question, decision.generation)) return 'screen';
  handlers.askQuestion(decision.question, decision.generation);
  return 'text';
}

export function dispatchForcedSttAcceptDecision(
  decision: ForceAcceptDecision,
  language: string | null | undefined,
  handlers: ForcedSttSubmissionHandlers,
): 'wait' | 'store-only' | 'rejected' | 'screen' | 'text' {
  if (decision.action !== 'submit') return decision.action;
  return dispatchForcedSttSubmission(decision, language, handlers);
}

/** Owns immutable, freshness-bearing finals received from the STT transport. */
export class ForcedFinalMetadataLedger {
  private sequence = 0;
  private lines: ForcedTranscriptLine[] = [];

  append(
    text: string,
    source: 'mic' | 'system',
    metadata?: SttTranscriptMetadata,
    receivedAt = Date.now(),
  ): ForcedTranscriptLine {
    const line: ForcedTranscriptLine = {
      sequence: ++this.sequence,
      text: text.trim(),
      source,
      receivedAt,
      utteranceId: metadata?.utteranceId,
      capturedAtMs: metadata?.capturedAtMs,
      queueWaitMs: metadata?.queueWaitMs,
      queueDepth: metadata?.queueDepth,
      speechEndToFinalMs: metadata?.speechEndToFinalMs,
      openaiInferenceMs: metadata?.openaiInferenceMs,
    };
    this.lines = [...this.lines.slice(-39), line];
    return line;
  }

  snapshot(): ForcedTranscriptLine[] {
    return [...this.lines];
  }

  reset(): void {
    this.sequence = 0;
    this.lines = [];
  }
}

/** Whitelisted authoritative STT fields suitable for persisted event diagnostics. */
export function toSttDiagnosticMeta(
  metadata?: SttTranscriptMetadata,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const result = {
    utteranceId: metadata.utteranceId,
    capturedAtMs: metadata.capturedAtMs,
    queueWaitMs: metadata.queueWaitMs,
    queueDepth: metadata.queueDepth,
    speechEndToFinalMs: metadata.speechEndToFinalMs,
    openaiInferenceMs: metadata.openaiInferenceMs,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function emptyTimingState(): LiveTimingState {
  return {
    audioCaptureStartAt: null,
    speechDetectedAt: null,
    speechEndedAt: null,
    finalTranscriptionStartAt: null,
    finalTranscriptionEndAt: null,
    llmRequestStartAt: null,
    llmFirstTokenAt: null,
    llmEndAt: null,
  };
}

function buildTimingDebug(t: LiveTimingState): Partial<SttDebugInfo> {
  const anchor = t.audioCaptureStartAt ?? t.speechDetectedAt;
  const llmStart = t.llmRequestStartAt;
  return {
    finalTranscriptionMs:
      t.finalTranscriptionStartAt != null && t.finalTranscriptionEndAt != null
        ? t.finalTranscriptionEndAt - t.finalTranscriptionStartAt
        : undefined,
    timeToFinalMs:
      t.speechEndedAt != null && anchor != null ? t.speechEndedAt - anchor : undefined,
    llmFirstTokenMs:
      t.llmFirstTokenAt != null && llmStart != null ? t.llmFirstTokenAt - llmStart : undefined,
    llmTotalMs: t.llmEndAt != null && llmStart != null ? t.llmEndAt - llmStart : undefined,
    totalEndToEndMs:
      t.llmEndAt != null && anchor != null ? t.llmEndAt - anchor : undefined,
  };
}

export function useLiveCopilot() {
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [answerHistory, setAnswerHistory] = useState<CopilotAnswerEntry[]>([]);
  const answerHistoryRef = useRef<CopilotAnswerEntry[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [forceGeneration, setForceGeneration] = useState(0);
  const [forcePhase, setForcePhase] = useState<ForcePhase>('idle');
  const [forceScreenFallback, setForceScreenFallback] = useState<ForceScreenFallbackRequest>(
    EMPTY_FORCE_SCREEN_FALLBACK,
  );
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [sourceHealthWarning, setSourceHealthWarning] = useState<
    typeof SYSTEM_NO_SIGNAL_WARNING | null
  >(null);
  const [sttDebug, setSttDebug] = useState<SttDebugInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const sttDebugRef = useRef<SttDebugInfo | null>(null);

  useEffect(() => {
    sttDebugRef.current = sttDebug;
  }, [sttDebug]);

  const sessionRef = useRef<string | null>(null);
  const candidateContextRef = useRef('');
  const candidateContextLoadRef = useRef<Promise<void> | null>(null);
  const reusedSessionRef = useRef(false);
  const liveRef = useRef<LiveEntry[]>([]);
  const cancelStreamRef = useRef<(() => void) | null>(null);
  const streamLockRef = useRef(false);
  const lastQuestionRef = useRef('');
  const lastCompletedRef = useRef('');
  const lastCompletedRawRef = useRef('');
  const streamGenRef = useRef(0);
  const finalPartsRef = useRef<string[]>([]);
  const finalDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttMetaRef = useRef<{
    engine: string;
    model: string;
    sampleRate: number;
  } | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const questionFinalAtRef = useRef<number | null>(null);
  // Authoritative STT timing measured server-side (speech-end -> final, etc.).
  const serverTimingsRef = useRef<SttTimings | null>(null);
  const sessionContextRef = useRef<InterviewSessionContext>(createEmptySessionContext());
  const utteranceBufferRef = useRef<UtteranceBufferEntry[]>([]);
  const triggerSpeakerRef = useRef<Speaker>('other');
  const liveSourcesRef = useRef<LiveSources>({ mic: true, system: false });
  const incompleteRetryRef = useRef(0);
  const lastFlushSpeakerRef = useRef<UtteranceSpeaker>('interviewer');
  const hasSessionContentRef = useRef(false);
  const timingRef = useRef<LiveTimingState>(emptyTimingState());
  const debugRef = useRef<LiveDebugRecorder>(new LiveDebugRecorder());
  const knowledgeMetaRef = useRef<CopilotAnswerPipeline['knowledge'] | null>(null);
  const queuedAnswerRef = useRef<QueuedAnswerRequest | null>(null);
  const lastPersistedTranscriptRef = useRef<Record<string, string>>({});
  const transcriptWriteQueueRef = useRef(new SessionTranscriptWriteQueue());
  const forcedFinalLedgerRef = useRef(new ForcedFinalMetadataLedger());
  const pendingTriggerSequenceRef = useRef<number | null>(null);
  const forceCoordinatorRef = useRef(new LatestForcedAnswerCoordinator());
  const candidateFollowUpOwnerRef = useRef(new CandidateFollowUpGenerationOwner());
  const activeScreenTaskContextRef = useRef(new ActiveScreenTaskContextMemory());
  const forceFallbackSchedulerRef = useRef<ForceFallbackScheduler | null>(null);
  const forceHardDeadlineSchedulerRef = useRef<ForceFallbackScheduler | null>(null);
  const forcePrefixStabilizationTimerRef = useRef<number | null>(null);
  const speechActivityRef = useRef(new SpeechActivityTracker());
  const sttLanguageRef = useRef('ru');
  const sourceHealthRef = useRef(new LiveSourceHealth({ mic: true, system: false }));
  const sourceHealthTimerRef = useRef<number | null>(null);
  const screenAssistDiagnosticsRef = useRef(new ScreenAssistDiagnostics());
  const diagnosticsWriterRef = useRef(
    new SerializedDiagnosticsWriter((sid, snapshot) => api.saveSessionDiagnostics(sid, snapshot)),
  );
  const diagnosticsEpochRef = useRef(0);
  const diagnosticsBaseRef = useRef<DebugBundle | null>(null);
  const activeScreenCancellationRef = useRef(new ActiveScreenAssistCancellation());
  const timeoutScreenPartialRef = useRef(new TimeoutScreenPartialState());
  const screenTaskAvailableRef = useRef(false);

  const preloadCandidateContext = useCallback(() => {
    if (!candidateContextLoadRef.current) {
      candidateContextLoadRef.current = resolvePreferredResume()
        .then(({ text }) => {
          candidateContextRef.current = text.trim().slice(0, 3200);
        })
        .catch(() => {
          // Live остаётся доступным без резюме; модель не должна выдумывать факты.
        })
        .finally(() => {
          candidateContextLoadRef.current = null;
        });
    }
    return candidateContextLoadRef.current;
  }, []);

  useEffect(() => {
    void preloadCandidateContext();
  }, [preloadCandidateContext]);
  const endingSessionRef = useRef<Promise<void> | null>(null);

  const buildDiagnosticsSnapshot = useCallback((): DebugBundle => {
    const screen = screenAssistDiagnosticsRef.current.snapshot();
    const current = debugRef.current.buildJson(null, {
      stt: sttMetaRef.current,
      sources: liveSourcesRef.current,
      sourceHealth: sourceHealthRef.current.snapshot(),
      exchanges: answerHistoryRef.current,
      screenAssists: screen.entries,
    });
    current.retention = {
      ...current.retention!,
      screenAssists: screen.retention,
    };
    return mergeDebugBundles(diagnosticsBaseRef.current, current);
  }, []);

  const enqueueDiagnosticsSnapshot = useCallback(() => {
    const sid = sessionRef.current;
    const epoch = diagnosticsEpochRef.current;
    if (!sid) return false;
    return diagnosticsWriterRef.current.enqueue(epoch, sid, buildDiagnosticsSnapshot);
  }, [buildDiagnosticsSnapshot]);

  const recordCandidateHotkeyDiagnostic = useCallback((
    type:
      | 'candidate_hotkey_received'
      | 'candidate_hotkey_queued'
      | 'candidate_hotkey_ignored'
      | 'candidate_hotkey_selected',
    data: {
      reason?: string;
      source?: 'mic' | 'system';
      meta?: Record<string, unknown>;
    } = {},
  ) => {
    hasSessionContentRef.current = true;
    debugRef.current.event(type, data);
    enqueueDiagnosticsSnapshot();
  }, [enqueueDiagnosticsSnapshot]);

  const applySourceHealthResult = useCallback((result: LiveSourceHealthResult) => {
    setSourceHealthWarning(result.warning);
    if (result.transition === 'warning') {
      hasSessionContentRef.current = true;
      debugRef.current.event(
        'source_warning',
        withAudioSource('system', {
          reason: SYSTEM_NO_SIGNAL_WARNING,
          meta: { nonFatal: true },
        }),
      );
      enqueueDiagnosticsSnapshot();
    } else if (result.transition === 'recovered') {
      debugRef.current.event(
        'source_recovered',
        withAudioSource('system', {
          meta: { recoveredFrom: SYSTEM_NO_SIGNAL_WARNING },
        }),
      );
      enqueueDiagnosticsSnapshot();
    }
  }, [enqueueDiagnosticsSnapshot]);

  const clearSourceHealthTimer = useCallback(() => {
    if (sourceHealthTimerRef.current == null) return;
    window.clearTimeout(sourceHealthTimerRef.current);
    sourceHealthTimerRef.current = null;
  }, []);

  const updateSourceHealth = useCallback(
    (result: LiveSourceHealthResult) => {
      applySourceHealthResult(result);
      clearSourceHealthTimer();
      const deadlineMs = sourceHealthRef.current.nextEvaluationAtMs();
      if (deadlineMs == null) return;
      sourceHealthTimerRef.current = window.setTimeout(() => {
        sourceHealthTimerRef.current = null;
        applySourceHealthResult(sourceHealthRef.current.evaluate());
      }, Math.max(0, deadlineMs - Date.now()));
    },
    [applySourceHealthResult, clearSourceHealthTimer],
  );

  const appendForcedFinal = useCallback(
    (
      text: string,
      source: 'mic' | 'system',
      metadata?: SttTranscriptMetadata,
    ): ForcedTranscriptLine => {
      return forcedFinalLedgerRef.current.append(text, source, metadata);
    },
    [],
  );

  const syncForceSnapshot = useCallback(() => {
    const snapshot = forceCoordinatorRef.current.snapshot();
    setForceGeneration(snapshot.generation);
    setForcePhase(snapshot.phase);
  }, []);

  const clearForceTimeout = useCallback((replacementGeneration?: number) => {
    forceFallbackSchedulerRef.current?.cancel(replacementGeneration);
    forceHardDeadlineSchedulerRef.current?.cancel(replacementGeneration);
  }, []);

  const clearForcePrefixStabilization = useCallback(() => {
    if (forcePrefixStabilizationTimerRef.current == null) return;
    window.clearTimeout(forcePrefixStabilizationTimerRef.current);
    forcePrefixStabilizationTimerRef.current = null;
  }, []);

  const scheduleForceTranscriptNotice = useCallback(
    (generation: number, delayMs = FORCE_FINALIZE_TIMEOUT_MS) => {
      if (!forceFallbackSchedulerRef.current) {
        forceFallbackSchedulerRef.current = new ForceFallbackScheduler((scheduledGeneration) => {
          notifyDelayedForcedTranscript(
            forceCoordinatorRef.current,
            scheduledGeneration,
            () => {
              setError(t('live.forceNoAudio'));
            },
          );
        });
      }
      forceFallbackSchedulerRef.current.schedule(generation, delayMs);
      if (!forceHardDeadlineSchedulerRef.current) {
        forceHardDeadlineSchedulerRef.current = new ForceFallbackScheduler((scheduledGeneration) => {
          const source = forceCoordinatorRef.current.snapshot().source;
          expireDelayedForcedTranscript(
            forceCoordinatorRef.current,
            scheduledGeneration,
            () => {
              candidateFollowUpOwnerRef.current.clear(scheduledGeneration);
              clearForcePrefixStabilization();
              pendingTriggerSequenceRef.current = null;
              timeoutScreenPartialRef.current.clearGeneration(scheduledGeneration);
              syncForceSnapshot();
              setError(t('live.forceNoAudio'));
              hasSessionContentRef.current = true;
              debugRef.current.event('error', {
                ...(source ? withAudioSource(source, {}) : {}),
                reason: 'finalization_hard_deadline',
                meta: { generation: scheduledGeneration },
              });
              enqueueDiagnosticsSnapshot();
            },
          );
        });
      }
      forceHardDeadlineSchedulerRef.current.schedule(
        generation,
        FORCE_FINALIZE_HARD_DEADLINE_MS,
      );
    },
    [clearForcePrefixStabilization, enqueueDiagnosticsSnapshot, syncForceSnapshot],
  );

  const routeVisualQuestionToScreen = useCallback(
    (question: string, generation: number, forceScreen = false): boolean => {
      if (
        !forceScreen &&
        !requiresScreenContext(question, screenTaskAvailableRef.current)
      ) return false;
      const screenQuestion = isSpokenScreenCaptureCue(question)
        ? screenCaptureRequestFromCue(question)
        : question.trim();
      timeoutScreenPartialRef.current.clearGeneration(generation);
      clearForceTimeout(generation);
      if (!forceCoordinatorRef.current.routeQuestionToScreen(generation)) return false;
      const { screenRevision } = forceCoordinatorRef.current.snapshot();
      syncForceSnapshot();
      setForceScreenFallback({ generation, screenRevision, question: screenQuestion });
      return true;
    },
    [clearForceTimeout, syncForceSnapshot],
  );

  const markScreenTaskAvailable = useCallback(() => {
    screenTaskAvailableRef.current = true;
  }, []);

  const publishScreenTaskContext = useCallback((input: {
    question: string;
    answer: string;
    continuesPrevious: boolean;
  }) => {
    activeScreenTaskContextRef.current.publishScreenResult(input);
    screenTaskAvailableRef.current = true;
  }, []);

  const clearScreenTaskContext = useCallback(() => {
    activeScreenTaskContextRef.current.clear();
    screenTaskAvailableRef.current = false;
  }, []);

  /** Consume the hook-level request and terminalize its active force epoch before UI reset. */
  const clearForceScreenFallback = useCallback(() => {
    const snapshot = forceCoordinatorRef.current.snapshot();
    clearForceTimeout(snapshot.generation);
    timeoutScreenPartialRef.current.clearGeneration(snapshot.generation);
    if (snapshot.phase === 'screen-fallback') {
      forceCoordinatorRef.current.setPhase(snapshot.generation, 'error');
      syncForceSnapshot();
    }
    setForceScreenFallback(EMPTY_FORCE_SCREEN_FALLBACK);
  }, [clearForceTimeout, syncForceSnapshot]);

  const resetForceCoordinator = useCallback(() => {
    clearForceTimeout();
    clearForcePrefixStabilization();
    forceCoordinatorRef.current.reset();
    candidateFollowUpOwnerRef.current.clear();
    forcedFinalLedgerRef.current.reset();
    pendingTriggerSequenceRef.current = null;
    timeoutScreenPartialRef.current.reset();
    setForceScreenFallback(EMPTY_FORCE_SCREEN_FALLBACK);
    syncForceSnapshot();
  }, [clearForcePrefixStabilization, clearForceTimeout, syncForceSnapshot]);

  const commitScreenFirstOutput = useCallback(
    (generation: number, screenRevision: number) =>
      forceCoordinatorRef.current.commitScreenFirstOutput(generation, screenRevision),
    [],
  );

  const finishScreenFallback = useCallback(
    (generation: number, screenRevision: number, phase: 'done' | 'error') => {
      const snapshot = forceCoordinatorRef.current.snapshot();
      if (
        snapshot.generation !== generation ||
        snapshot.screenRevision !== screenRevision ||
        snapshot.phase !== 'screen-fallback'
      ) return false;
      if (!forceCoordinatorRef.current.setPhase(generation, phase)) return false;
      syncForceSnapshot();
      return true;
    },
    [syncForceSnapshot],
  );

  const screenAssistDiagnostics = useMemo(() => ({
    request: (input: {
      id: string;
      generation: number;
      trigger: ScreenAssistTrigger;
      mode: string;
      effectiveQuestion: string;
    }) => {
      hasSessionContentRef.current = true;
      const id = screenAssistDiagnosticsRef.current.request(input);
      enqueueDiagnosticsSnapshot();
      return id;
    },
    captured: (id: string, image: string) => {
      const changed = screenAssistDiagnosticsRef.current.captured(id, image);
      if (changed) enqueueDiagnosticsSnapshot();
      return changed;
    },
    firstOutput: (id: string, chunk: string) => {
      const changed = screenAssistDiagnosticsRef.current.firstOutput(id, chunk);
      if (changed) enqueueDiagnosticsSnapshot();
      return changed;
    },
    done: (id: string, result: { answer: string; model?: string; modelSource?: string }) => {
      const changed = screenAssistDiagnosticsRef.current.done(id, result);
      if (changed) enqueueDiagnosticsSnapshot();
      return changed;
    },
    error: (id: string, reason: string) => {
      const changed = screenAssistDiagnosticsRef.current.error(id, reason);
      if (changed) enqueueDiagnosticsSnapshot();
      return changed;
    },
    cancel: (id: string) => {
      const changed = screenAssistDiagnosticsRef.current.cancel(id);
      if (changed) enqueueDiagnosticsSnapshot();
      return changed;
    },
    registerActiveCancel: (cancel: (() => void) | null) => {
      activeScreenCancellationRef.current.register(cancel);
    },
  }), [enqueueDiagnosticsSnapshot]);

  // Persist final transcript lines so History can show the full dialogue
  // (including the user's own answers) for post-interview review.
  const persistTranscriptLine = useCallback((text: string, speaker: Speaker) => {
    const sid = sessionRef.current;
    if (!sid) return;
    if (lastPersistedTranscriptRef.current[speaker] === text) return;
    lastPersistedTranscriptRef.current[speaker] = text;
    hasSessionContentRef.current = true;
    void transcriptWriteQueueRef.current.enqueue(sid, async () => {
      await api.addTranscript(sid, speaker, text);
    });
  }, []);

  const patchSttDebug = useCallback((patch: Partial<SttDebugInfo>) => {
    setSttDebug((prev) => ({
      rawTranscript: '',
      normalizedTranscript: '',
      ...prev,
      ...buildTimingDebug(timingRef.current),
      ...patch,
    }));
  }, []);

  const rejectForcedTranscript = useCallback(
    (question: string, generation: number, reason: string): boolean => {
      recordSkipped(reason, question);
      timeoutScreenPartialRef.current.clearGeneration(generation);
      const source =
        forceCoordinatorRef.current.snapshot().source ??
        (triggerSpeakerRef.current === 'other' ? 'system' : 'mic');
      debugRef.current.event(
        'low_quality',
        withAudioSource(source, { text: question, reason }),
      );
      patchSttDebug({
        finalTranscript: question,
        rawTranscript: question,
        normalizedTranscript: normalizeTranscript(question),
        answerTriggered: false,
        waitReason: `Skipped forced text: ${reason}`,
      });

      const snapshot = forceCoordinatorRef.current.snapshot();
      if (snapshot.generation !== generation) return false;
      clearForceTimeout(generation);
      if (!forceCoordinatorRef.current.setPhase(generation, 'error')) return false;
      syncForceSnapshot();
      setError(t('live.forceNoAudio'));
      return true;
    },
    [clearForceTimeout, patchSttDebug, syncForceSnapshot],
  );

  const syncDebugFromPrepared = useCallback(
    (prepared: PreparedTranscript, extra: Partial<SttDebugInfo>) => {
      patchSttDebug({
        rawTranscript: prepared.rawTranscript,
        normalizedTranscript: prepared.normalized,
        resolvedQuestion: prepared.resolvedQuestion,
        previousTopic: sessionContextRef.current.lastCanonicalTopic,
        currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
        isFollowUp: prepared.followUp.isFollowUp,
        usedPreviousContext: prepared.followUp.usedPreviousContext,
        followUpReason: prepared.followUp.reason,
        hallucinationRisk: prepared.followUp.hallucinationRisk,
        resumeFactSource: prepared.answerStrategy.resumeContextLevel,
        questionIntent: prepared.answerStrategy.questionIntent,
        answerStrategy: prepared.answerStrategy.answerStrategy,
        resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
        resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
        resumeContextReason: prepared.answerStrategy.resumeContextReason,
        sttEngine: sttMetaRef.current?.engine,
        sttModel: sttMetaRef.current?.model,
        sampleRate: sttMetaRef.current?.sampleRate,
        ...extra,
      });
    },
    [patchSttDebug],
  );

  const commitCorrectedToLine = useCallback(
    (raw: string, corrected: string, speaker: UtteranceSpeaker) => {
      const uiSpeaker: Speaker = speaker === 'interviewer' ? 'other' : 'me';
      setLines((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i -= 1) {
          if (updated[i].speaker === uiSpeaker && updated[i].isFinal) {
            updated[i] = {
              ...updated[i],
              corrected: corrected !== raw ? corrected : undefined,
            };
            break;
          }
        }
        return updated;
      });
    },
    [],
  );

  const endInterviewSession = useCallback((): Promise<void> => {
    if (endingSessionRef.current) return endingSessionRef.current;
    const sid = sessionRef.current;
    const epoch = diagnosticsEpochRef.current;
    const sessionHasContent = hasSessionContentRef.current;
    const reusedSession = reusedSessionRef.current;
    if (!sid) return Promise.resolve();
    const ending = (async () => {
      try {
        activeScreenCancellationRef.current.cancelAndClear();
        await transcriptWriteQueueRef.current.drain(sid);
        if (sessionHasContent) {
          if (!diagnosticsWriterRef.current.enqueue(epoch, sid, buildDiagnosticsSnapshot)) {
            throw new Error('Diagnostics epoch is no longer active');
          }
          await diagnosticsWriterRef.current.flush(epoch, sid);
          await api.endSession(sid);
        } else if (!reusedSession) {
          await api.deleteSession(sid);
        }
        if (sessionRef.current === sid && diagnosticsEpochRef.current === epoch) {
          sessionRef.current = null;
          reusedSessionRef.current = false;
          setSessionId(null);
        }
      } catch (reason) {
        setError('Не удалось сохранить диагностику сессии. Повторите завершение.');
        throw reason;
      }
    })();
    endingSessionRef.current = ending;
    void ending.finally(() => {
      if (endingSessionRef.current === ending) endingSessionRef.current = null;
    }).catch(() => undefined);
    return ending;
  }, [buildDiagnosticsSnapshot]);

  const removeStream = useCallback(
    (source: 'mic' | 'system', msg?: string) => {
      speechActivityRef.current.resetSource(source);
      updateSourceHealth(sourceHealthRef.current.markSourceRemoved(source));
      const forceSnapshot = forceCoordinatorRef.current.snapshot();
      if (
        source === forceSnapshot.source &&
        forceSnapshot.phase === 'finalizing-transcript'
      ) {
        scheduleForceTranscriptNotice(forceSnapshot.generation, 0);
      }
      liveRef.current = liveRef.current.filter((entry) => {
        if (entry.source === source) {
          entry.session.stop();
          return false;
        }
        return true;
      });
      if (msg) setError(msg);
      if (liveRef.current.length === 0) {
        setActive(false);
        setPaused(false);
        void endInterviewSession().catch(() => undefined);
      }
    },
    [endInterviewSession, scheduleForceTranscriptNotice, updateSourceHealth],
  );

  const runStream = useCallback((request: AnswerRequest) => {
    const { prepared, forceGeneration: requestForceGeneration } = request;
    // Hard manual-only invariant: only forceCoordinator.press()/submitQuestion()
    // (Ctrl+Enter) owns a generation. Legacy speech-final/queued paths have no
    // generation and therefore cannot start an LLM request or replace the
    // question/answer card. Keep this guard at the lowest possible level so a
    // future callback cannot accidentally reactivate automatic answering.
    if (requestForceGeneration == null) {
      debugRef.current.event('answer_blocked', {
        reason: 'manual_only_without_force_generation',
        text: prepared.rawTranscript,
      });
      return;
    }
    const requestTimings = request.serverTimings ?? (request.stt ? {
      speechEndToFinalMs: request.stt.speechEndToFinalMs,
      openaiInferenceMs: request.stt.openaiInferenceMs,
      queueWaitMs: request.stt.queueWaitMs,
      queueDepth: request.stt.queueDepth,
    } : null);
    const requestStt = request.stt ? { ...request.stt } : undefined;
    const requestQuestionFinalAt = request.questionFinalAt;
    const requestTaskContextUpdate = request.taskContextUpdate;
    // Ctrl+Enter fast-path sends the captured question as-is. Local intent and
    // follow-up analysis stays diagnostics-only and never expands the LLM prompt.
    const q = prepared.rawTranscript.trim();
    if (q.length < 3) return;
    const requestRequiresScreenContext = request.preservePreviousTopic
      ? true
      : requiresScreenContext(q, screenTaskAvailableRef.current);
    const requestActiveScreenTask = request.preservePreviousTopic
      ? activeScreenTaskContextRef.current.snapshot()
      : activeScreenTaskContextRef.current.contextForInterviewQuestion({
          resetPreviousTopic: prepared.followUp.resetPreviousTopic,
          requiresScreenContext: requestRequiresScreenContext,
        });
    if (prepared.followUp.resetPreviousTopic && !requestRequiresScreenContext) {
      screenTaskAvailableRef.current = false;
    }
    const displayQuestion = request.displayQuestion?.trim() || q;
    streamLockRef.current = true;
    lastQuestionRef.current = q;
    const gen = ++streamGenRef.current;
    const answerStartedAt = performance.now();
    timingRef.current.llmRequestStartAt = answerStartedAt;
    knowledgeMetaRef.current = null;
    const meta = sttMetaRef.current;

    // Snapshot the REAL per-utterance STT latency now, while the server timing is
    // fresh. The persisted exchange must use this — not the live sttDebug, which
    // later partials of the next utterance overwrite with a session-relative value
    // (the cause of the 24009/56622/113737ms bug). Only the server-authored
    // speech-end→final value is STT latency; client dispatch timing is separate.
    const exchangeSttLatencyMs = computeExchangeSttLatencyMs(
      requestStt?.speechEndToFinalMs ?? requestTimings?.speechEndToFinalMs,
      answerStartedAt,
      requestQuestionFinalAt,
    );

    setSttDebug({
      rawTranscript: prepared.rawTranscript,
      normalizedTranscript: prepared.normalized,
      finalTranscript: prepared.rawTranscript,
      resolvedQuestion: prepared.resolvedQuestion,
      previousTopic: sessionContextRef.current.lastCanonicalTopic,
      currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
      isFollowUp: prepared.followUp.isFollowUp,
      usedPreviousContext: prepared.followUp.usedPreviousContext,
      wasPreviousTopicUsed: prepared.followUp.wasPreviousTopicUsed,
      followUpReason: prepared.followUp.reason,
      resetPreviousTopic: prepared.followUp.resetPreviousTopic,
      resetPreviousTopicReason: prepared.followUp.resetPreviousTopicReason,
      hallucinationRisk: prepared.followUp.hallucinationRisk,
      resumeFactSource: prepared.answerStrategy.resumeContextLevel,
      answerTriggered: true,
      questionIntent: prepared.answerStrategy.questionIntent,
      answerStrategy: prepared.answerStrategy.answerStrategy,
      resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
      resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
      resumeContextReason: prepared.answerStrategy.resumeContextReason,
      sttEngine: meta?.engine,
      sttModel: meta?.model,
      sampleRate: meta?.sampleRate,
      ...buildTimingDebug(timingRef.current),
      // Only the server-measured speech-end -> final latency belongs here. The
      // desktop sees final arrival/dispatch, not the authoritative speech end.
      timeToFinalMs:
        requestStt?.speechEndToFinalMs ?? requestTimings?.speechEndToFinalMs,
      finalTranscriptionMs:
        requestStt?.openaiInferenceMs ??
        requestTimings?.openaiInferenceMs ??
        requestTimings?.finalInferenceMs ??
        buildTimingDebug(timingRef.current).finalTranscriptionMs,
    });

    setStreaming(true);
    setSuggestLoading(true);
    setStreamText('');
    setCurrentQuestion(displayQuestion);
    setError('');
    if (
      requestForceGeneration != null &&
      forceCoordinatorRef.current.setPhase(requestForceGeneration, 'waiting-first-token')
    ) {
      syncForceSnapshot();
    }
    debugRef.current.event('answer_started', {
      text: q,
      meta: { sttLatencyMs: requestStt?.speechEndToFinalMs ?? requestTimings?.speechEndToFinalMs },
    });

    const runQueuedAnswer = () => {
      const queued = queuedAnswerRef.current;
      if (!queued) return;
      queuedAnswerRef.current = null;
      const nextPrepared = prepareTranscriptForLlm(queued.rawMerged, sessionContextRef.current);
      const nextQuestion = nextPrepared.resolvedQuestion.trim();
      if (!nextQuestion || nextQuestion === lastCompletedRef.current) return;
      setTimeout(() => {
        runStream({
          prepared: nextPrepared,
          serverTimings: queued.serverTimings,
          questionFinalAt: queued.questionFinalAt,
        });
      }, 0);
    };

    const pushHistory = (
      text: string,
      answerId?: string,
      pipeline?: CopilotAnswerPipeline,
      latency?: ExchangeLatency,
    ) => {
      hasSessionContentRef.current = true;
      const entry: CopilotAnswerEntry = {
        id: answerId || crypto.randomUUID(),
        question: displayQuestion,
        spoken: text,
        ts: Date.now(),
        source: 'live',
        pipeline,
        latency,
        stt: requestStt,
      };
      answerHistoryRef.current = [...answerHistoryRef.current, entry];
      setAnswerHistory(answerHistoryRef.current);
      const sid = sessionRef.current;
      if (sid) {
        enqueueDiagnosticsSnapshot();
      }
      setStreamText('');
      setCurrentQuestion('');
    };
    let accumulated = '';
    let firstChunk = true;
    cancelStreamRef.current = api.streamInterview(
      q,
      {
        onChunk: (chunk) => {
          if (gen !== streamGenRef.current) return;
          if (firstChunk) {
            firstChunk = false;
            if (
              requestForceGeneration != null &&
              markForcedAnswerStreamStarted(forceCoordinatorRef.current, requestForceGeneration)
            ) {
              syncForceSnapshot();
            }
            timingRef.current.llmFirstTokenAt = performance.now();
            debugRef.current.event('answer_first_token');
            setSttDebug((prev) =>
              prev
                ? {
                    ...prev,
                    ...buildTimingDebug(timingRef.current),
                    // Keep the authoritative per-utterance STT timings runStream set
                    // from the server. buildTimingDebug derives these from a
                    // session-start anchor, so re-spreading it here would inflate
                    // sttLatencyMs on every later utterance (15s, 28s, 53s...).
                    timeToFinalMs: prev.timeToFinalMs,
                    finalTranscriptionMs: prev.finalTranscriptionMs,
                    timeToAnswerMs: performance.now() - answerStartedAt,
                  }
                : prev,
            );
          }
          accumulated += chunk;
          const preserveCode =
            ['technical_task', 'api_test_task'].includes(prepared.answerStrategy.questionIntent) || accumulated.includes('```');
          setStreamText(preserveCode ? accumulated : sanitizeLiveAnswer(accumulated));
          setSuggestLoading(false);
        },
        onDone: (spoken: string, answerId?: string, responseMeta?: { model?: string; modelSource?: string }) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          if (
            requestForceGeneration != null &&
            completeForcedAnswerStream(forceCoordinatorRef.current, requestForceGeneration)
          ) {
            syncForceSnapshot();
          }
          timingRef.current.llmEndAt = performance.now();
          lastCompletedRef.current = q;
          lastCompletedRawRef.current = prepared.rawTranscript;
          const rawAnswer = stripExperienceFooter(spoken || accumulated).trim();
          const preserveCode =
            ['technical_task', 'api_test_task'].includes(prepared.answerStrategy.questionIntent) || rawAnswer.includes('```');
          const text = preserveCode ? rawAnswer : trimSpokenAnswer(sanitizeLiveAnswer(rawAnswer));
          if (requestTaskContextUpdate && text) {
            activeScreenTaskContextRef.current.settleCandidateStream({
              completed: true,
              ...requestTaskContextUpdate,
              answer: text,
            });
          }
          const debugSnapshot = sttDebugRef.current;
          const llmLatencyMs = performance.now() - answerStartedAt;
          const pipeline = buildPipelineFromPrepared(prepared, {
            previousTopic: sessionContextRef.current.lastCanonicalTopic,
            timeToAnswerMs: debugSnapshot?.timeToAnswerMs,
            timeToFinalMs: exchangeSttLatencyMs ?? undefined,
            model: responseMeta?.model,
            modelSource: responseMeta?.modelSource,
          });
          if (knowledgeMetaRef.current) pipeline.knowledge = knowledgeMetaRef.current;
          const latency = buildExchangeLatency(
            exchangeSttLatencyMs,
            llmLatencyMs,
            buildLatencyBreakdown({
              serverTimings: requestTimings,
              answerStartedAt,
              questionFinalAt: requestQuestionFinalAt,
              llmFirstTokenMs: debugSnapshot?.timeToAnswerMs,
              llmLatencyMs,
              speechEndedAt: timingRef.current.speechEndedAt,
              audioCaptureStartAt: timingRef.current.audioCaptureStartAt,
            }),
          );
          debugRef.current.event('answer_done', {
            text,
            meta: { sttLatencyMs: latency.sttLatencyMs, llmLatencyMs: latency.llmLatencyMs },
          });
          const contextQuestion = request.preservePreviousTopic
            ? displayQuestion
            : prepared.resolvedQuestion;
          sessionContextRef.current = updateSessionContextAfterAnswer(sessionContextRef.current, {
            rawQuestion: request.preservePreviousTopic ? displayQuestion : prepared.rawTranscript,
            correctedQuestion: request.preservePreviousTopic ? displayQuestion : prepared.normalized,
            intentCorrectedQuestion: request.preservePreviousTopic ? displayQuestion : prepared.normalized,
            resolvedQuestion: contextQuestion,
            questionIntent: prepared.answerStrategy.questionIntent,
            canonicalTopic: request.preservePreviousTopic
              ? (sessionContextRef.current.lastCanonicalTopic ?? prepared.canonicalTopic)
              : prepared.canonicalTopic,
            answerSummary: text,
            resetPreviousTopic: prepared.followUp.resetPreviousTopic,
          });
          pushHistory(text, answerId, pipeline, latency);
          runQueuedAnswer();
        },
        onError: (msg) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          if (
            requestForceGeneration != null &&
            forceCoordinatorRef.current.setPhase(
              requestForceGeneration,
              requestTaskContextUpdate ? 'error' : accumulated ? 'done' : 'error',
            )
          ) {
            syncForceSnapshot();
          }
          debugRef.current.event('error', { reason: msg, text: q });
          if (requestTaskContextUpdate) {
            activeScreenTaskContextRef.current.settleCandidateStream({
              completed: false,
              ...requestTaskContextUpdate,
              answer: accumulated,
            });
            setStreamText('');
            setCurrentQuestion('');
            setError(msg);
            runQueuedAnswer();
            return;
          }
          if (accumulated) {
            lastCompletedRef.current = q;
            lastCompletedRawRef.current = prepared.rawTranscript;
            const rawAnswer = stripExperienceFooter(accumulated).trim();
            const preserveCode =
              ['technical_task', 'api_test_task'].includes(prepared.answerStrategy.questionIntent) || rawAnswer.includes('```');
            const text = preserveCode ? rawAnswer : trimSpokenAnswer(sanitizeLiveAnswer(rawAnswer));
            const llmLatencyMs = performance.now() - answerStartedAt;
            const pipeline = buildPipelineFromPrepared(prepared, {
              previousTopic: sessionContextRef.current.lastCanonicalTopic,
              timeToFinalMs: exchangeSttLatencyMs ?? undefined,
            });
            if (knowledgeMetaRef.current) pipeline.knowledge = knowledgeMetaRef.current;
            const latency = buildExchangeLatency(exchangeSttLatencyMs, llmLatencyMs);
            pushHistory(text, undefined, pipeline, latency);
            runQueuedAnswer();
          } else {
            setStreamText('');
            setCurrentQuestion('');
            setError(msg);
            runQueuedAnswer();
          }
        },
      },
      {
        sessionId: sessionRef.current ?? undefined,
        rawQuestion: q,
        candidateContext: candidateContextRef.current,
        activeScreenTask: requestActiveScreenTask ?? undefined,
        fastAnswer: true,
        onMeta: (correctionMeta) => {
          if (gen !== streamGenRef.current) return;
          setSttDebug((prev) => {
            if (!prev) return prev;
            const next = { ...prev };
            if (correctionMeta.question_intent) next.questionIntent = correctionMeta.question_intent;
            if (correctionMeta.answer_strategy) next.answerStrategy = correctionMeta.answer_strategy;
            if (correctionMeta.resume_context_used != null) {
              next.resumeContextUsed = correctionMeta.resume_context_used;
            }
            if (correctionMeta.resume_context_level) {
              next.resumeContextLevel = correctionMeta.resume_context_level;
            }
            if (correctionMeta.resume_context_reason) {
              next.resumeContextReason = correctionMeta.resume_context_reason;
            }
            return next;
          });
          // Capture server-reported Python Knowledge Pack metrics for this
          // exchange so the export/persisted entry matches the debug bundle.
          if (correctionMeta.knowledgePackUsed != null) {
            knowledgeMetaRef.current = {
              knowledgePackUsed: correctionMeta.knowledgePackUsed,
              knowledgePackName: correctionMeta.knowledgePackName,
              knowledgeSource: correctionMeta.knowledgeSource,
              retrievedItemsCount: correctionMeta.retrievedItemsCount,
              injectedContextTokens: correctionMeta.injectedContextTokens,
              knowledgeRetrievalMs: correctionMeta.knowledgeRetrievalMs,
              answerLatencyWithKnowledgeMs: correctionMeta.answerLatencyWithKnowledgeMs,
            };
          }
        },
      },
    );
  }, [enqueueDiagnosticsSnapshot, syncForceSnapshot]);

  const requestSuggestion = useCallback(
    (rawMerged: string, force = false) => {
      const prepared = prepareTranscriptForLlm(rawMerged, sessionContextRef.current);
      const q = prepared.resolvedQuestion.trim();
      const raw = rawMerged.trim();

      if (!force && isGarbageTranscript(q) && isGarbageTranscript(raw)) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Waiting for complete question…',
          finalTranscript: raw,
        });
        return false;
      }

      if (!force && q.length < 6 && raw.length < 6) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Waiting for complete question…',
        });
        return false;
      }
      if (!force && !looksLikeQuestion(q) && !looksLikeQuestion(raw)) {
        // Not a question and no interview intent — never call the LLM, never
        // touch previousTopic. Surface it as an explicit skip.
        recordSkipped('unclear_non_question', raw);
        debugRef.current.event(
          'low_quality',
          withAudioSource(triggerSpeakerRef.current === 'other' ? 'system' : 'mic', {
            reason: 'unclear_non_question',
            text: raw,
          }),
        );
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Skipped: unclear phrase (not a question)',
        });
        return false;
      }
      // A «?»-fragment with no real intent («Вместе или не?») — also skip.
      if (!force && isNonQuestionFragment(q) && isNonQuestionFragment(raw)) {
        recordSkipped('too_low_intent', raw);
        debugRef.current.event(
          'low_quality',
          withAudioSource(triggerSpeakerRef.current === 'other' ? 'system' : 'mic', {
            reason: 'too_low_intent',
            text: raw,
          }),
        );
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Skipped: unclear phrase (low intent)',
        });
        return false;
      }
      const requestTimings = serverTimingsRef.current ? { ...serverTimingsRef.current } : null;
      const requestQuestionFinalAt = questionFinalAtRef.current;

      if (force) {
        cancelStreamRef.current?.();
        streamLockRef.current = false;
        queuedAnswerRef.current = null;
        runStream({
          prepared,
          serverTimings: requestTimings,
          questionFinalAt: requestQuestionFinalAt,
        });
        return true;
      }

      const decision = decideAnswerAction({
        question: q,
        locked: streamLockRef.current,
        lastQuestion: lastQuestionRef.current,
        lastCompleted: lastCompletedRef.current,
      });

      if (decision.action === 'skip') return true;

      if (decision.action === 'queue') {
        queuedAnswerRef.current = {
          rawMerged,
          serverTimings: requestTimings,
          questionFinalAt: requestQuestionFinalAt,
        };
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Queued: finishing previous answer',
        });
        return true;
      }

      incompleteRetryRef.current = 0;
      runStream({
        prepared,
        serverTimings: requestTimings,
        questionFinalAt: requestQuestionFinalAt,
      });
      return true;
    },
    [runStream, syncDebugFromPrepared],
  );

  /**
   * Ручной ввод вопроса в live-сессии: если STT распознал криво, пользователь
   * набирает вопрос сам — он идёт через тот же конвейер, что и финал STT,
   * минуя качественные гейты (ввод явный, доверяем ему).
   */
  const askQuestion = useCallback(
    (
      text: string,
      forceGeneration?: number,
      stt?: AnswerSttDiagnostics,
      presentation?: {
        displayQuestion: string;
        preservePreviousTopic: boolean;
        taskContextUpdate?: { rootQuestion: string; currentQuestion: string };
      },
    ) => {
      const t = text.trim();
      if (t.length < 3) return;
      if (finalDebounceRef.current) {
        clearTimeout(finalDebounceRef.current);
        finalDebounceRef.current = null;
      }
      finalPartsRef.current = [];
      cancelStreamRef.current?.();
      streamLockRef.current = false;
      queuedAnswerRef.current = null;
      serverTimingsRef.current = null;
      questionFinalAtRef.current = performance.now();
      const prepared = prepareTranscriptForLlm(t, sessionContextRef.current);
      runStream({
        prepared,
        serverTimings: null,
        questionFinalAt: questionFinalAtRef.current,
        forceGeneration,
        stt: stt ? { ...stt } : undefined,
        displayQuestion: presentation?.displayQuestion,
        preservePreviousTopic: presentation?.preservePreviousTopic,
        taskContextUpdate: presentation?.taskContextUpdate,
      });
    },
    [runStream],
  );

  const cancelPendingQuestion = useCallback(() => {
    if (finalDebounceRef.current) {
      clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = null;
    }
    finalPartsRef.current = [];
    pendingTriggerSequenceRef.current = null;
  }, []);

  const dispatchAcceptedForceDecision = useCallback((decision: ForceAcceptDecision) => {
    const decisionGeneration = decision.action === 'store-only'
      ? forceCoordinatorRef.current.snapshot().generation
      : decision.generation;
    const candidateOwned = candidateFollowUpOwnerRef.current.isOwned(decisionGeneration);
    const candidateSequence = decision.action === 'submit' ? decision.sequence : undefined;
    const answeredLine = decision.action === 'submit'
      ? forcedFinalLedgerRef.current
          .snapshot()
          .find((line) => line.sequence === decision.sequence)
      : undefined;
    if (decision.action === 'store-only' && candidateOwned) {
      candidateFollowUpOwnerRef.current.clear(decisionGeneration);
      forceCoordinatorRef.current.setPhase(decisionGeneration, 'error');
      syncForceSnapshot();
      recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
        source: 'mic',
        reason: 'stale_owned_final',
        meta: { generation: decisionGeneration },
      });
    }
    return dispatchForcedSttAcceptDecision(decision, sttLanguageRef.current, {
      askQuestion: (question, generation) => {
        const stt = answeredLine ? {
          utteranceId: answeredLine.utteranceId,
          source: answeredLine.source,
          capturedAtMs: answeredLine.capturedAtMs,
          queueWaitMs: answeredLine.queueWaitMs,
          queueDepth: answeredLine.queueDepth,
          speechEndToFinalMs: answeredLine.speechEndToFinalMs,
          openaiInferenceMs: answeredLine.openaiInferenceMs,
        } : undefined;
        if (!candidateOwned) {
          askQuestion(question, generation, stt);
          return;
        }
        const followUp = dispatchOwnedCandidateFollowUp({
          owner: candidateFollowUpOwnerRef.current,
          generation,
          candidatePhrase: question,
          cancelActiveScreen: () => activeScreenCancellationRef.current.cancelAndClear(),
          requestProvider: (request) => {
            recordCandidateHotkeyDiagnostic('candidate_hotkey_selected', {
              source: answeredLine?.source ?? 'mic',
              meta: {
                generation,
                sequence: answeredLine?.sequence ?? candidateSequence,
                contextSource: request.contextSource,
              },
            });
            askQuestion(request.prompt, generation, stt, {
              displayQuestion: request.displayQuestion,
              preservePreviousTopic: true,
              taskContextUpdate: {
                rootQuestion: request.taskRootQuestion,
                currentQuestion: request.taskCurrentQuestion,
              },
            });
          },
        });
        if (!followUp) {
          recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
            source: 'mic',
            reason: 'owned_final_missing_context',
            meta: { generation, sequence: answeredLine?.sequence },
          });
          return;
        }
      },
      prepare: () => {
        if (decision.action !== 'submit') return;
        clearForcePrefixStabilization();
        clearForceTimeout(decision.generation);
        syncForceSnapshot();
        cancelPendingQuestion();
        utteranceBufferRef.current = [];
      },
      reject: (question, generation, reason) => {
        candidateFollowUpOwnerRef.current.clear(generation);
        if (candidateOwned) {
          recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
            source: 'mic',
            reason,
            meta: { generation, sequence: candidateSequence },
          });
        }
        rejectForcedTranscript(question, generation, reason);
      },
      routeVisualToScreen: (question, generation) =>
        candidateOwned ? false : routeVisualQuestionToScreen(question, generation),
    });
  }, [
    askQuestion,
    cancelPendingQuestion,
    clearForcePrefixStabilization,
    clearForceTimeout,
    rejectForcedTranscript,
      routeVisualQuestionToScreen,
      recordCandidateHotkeyDiagnostic,
      syncForceSnapshot,
  ]);

  const scheduleFinalizedPrefixCommit = useCallback((
    requestId: string,
    generation: number,
    source: 'mic' | 'system',
  ) => {
    clearForcePrefixStabilization();
    forcePrefixStabilizationTimerRef.current = window.setTimeout(() => {
      forcePrefixStabilizationTimerRef.current = null;
      const snapshot = forceCoordinatorRef.current.snapshot();
      if (
        snapshot.generation !== generation ||
        snapshot.requestId !== requestId ||
        snapshot.phase !== 'finalizing-transcript'
      ) {
        return;
      }
      // A speech_started frame can trail Ctrl+Enter by a few milliseconds.
      // Keep the finalized prefix pending until that continuation gets its final.
      if (speechActivityRef.current.snapshot()[source]) return;
      dispatchAcceptedForceDecision(
        forceCoordinatorRef.current.commitFinalizedPrefix(requestId),
      );
    }, FORCE_PREFIX_STABILIZATION_MS);
  }, [clearForcePrefixStabilization, dispatchAcceptedForceDecision]);

  const recordUtterance = useCallback((text: string, isFinal: boolean, speaker: Speaker) => {
    const utteranceSpeaker: UtteranceSpeaker = speaker === 'other' ? 'interviewer' : 'me';
    utteranceBufferRef.current = pushUtteranceBuffer(utteranceBufferRef.current, {
      text,
      timestamp: Date.now(),
      speaker: utteranceSpeaker,
      isFinal,
    });
  }, []);

  const markPendingTriggerHandled = useCallback(() => {
    const sequence = pendingTriggerSequenceRef.current;
    pendingTriggerSequenceRef.current = null;
    if (sequence == null) return;
    if (forceCoordinatorRef.current.markHandled(sequence)) syncForceSnapshot();
  }, [syncForceSnapshot]);

  const flushQuestion = useCallback(() => {
    if (finalDebounceRef.current) {
      clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = null;
    }
    const mergedParts = mergeRawParts(finalPartsRef.current);
    finalPartsRef.current = [];
    if (!mergedParts) return;

    const utteranceSpeaker = lastFlushSpeakerRef.current;
    const waitCheck = shouldWaitForMoreSpeech(
      mergedParts,
      utteranceBufferRef.current,
      utteranceSpeaker,
    );
    const toEvaluate = waitCheck.merged ?? mergedParts;
    const preparedPreview = prepareTranscriptForLlm(toEvaluate, sessionContextRef.current);

    if (waitCheck.wait) {
      const mergedForRetry = toEvaluate;
      syncDebugFromPrepared(preparedPreview, {
        answerTriggered: false,
        waitReason: waitCheck.reason ?? waitCheck.action,
      });
      if (shouldForceProceedIncomplete(incompleteRetryRef.current, mergedForRetry)) {
        incompleteRetryRef.current = 0;
        utteranceBufferRef.current = [];
        questionFinalAtRef.current = performance.now();
        const accepted = requestSuggestion(mergedForRetry);
        if (accepted) markPendingTriggerHandled();
        return;
      }
      incompleteRetryRef.current += 1;
      finalPartsRef.current = [mergedParts];
      finalDebounceRef.current = setTimeout(flushQuestion, INCOMPLETE_RETRY_MS);
      return;
    }

    incompleteRetryRef.current = 0;
    utteranceBufferRef.current = [];
    questionFinalAtRef.current = performance.now();
    commitCorrectedToLine(toEvaluate, preparedPreview.normalized, utteranceSpeaker);
    syncDebugFromPrepared(preparedPreview, {
      answerTriggered: undefined,
      waitReason: undefined,
      finalTranscript: toEvaluate,
    });
    const accepted = requestSuggestion(toEvaluate);
    if (accepted) markPendingTriggerHandled();
  }, [
    commitCorrectedToLine,
    markPendingTriggerHandled,
    requestSuggestion,
    syncDebugFromPrepared,
  ]);

  const pushFinalPart = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = finalPartsRef.current[finalPartsRef.current.length - 1];
    if (last === trimmed) return;
    finalPartsRef.current.push(trimmed);
    if (finalPartsRef.current.length > 3) {
      finalPartsRef.current = finalPartsRef.current.slice(-3);
    }
  }, []);

  const scheduleSpeechFinal = useCallback(
    (text: string, speaker: Speaker, sequence: number) => {
      if (!speechStartedAtRef.current) speechStartedAtRef.current = performance.now();
      lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
      pendingTriggerSequenceRef.current = Math.max(
        pendingTriggerSequenceRef.current ?? 0,
        sequence,
      );
      recordUtterance(text, true, speaker);
      pushFinalPart(text);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = setTimeout(flushQuestion, SPEECH_FINAL_DELAY_MS);
    },
    [flushQuestion, pushFinalPart, recordUtterance],
  );

  const scheduleFinalFallback = useCallback(
    (text: string, speaker: Speaker, sequence: number) => {
      lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
      pendingTriggerSequenceRef.current = Math.max(
        pendingTriggerSequenceRef.current ?? 0,
        sequence,
      );
      recordUtterance(text, true, speaker);
      pushFinalPart(text);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = setTimeout(flushQuestion, FINAL_FALLBACK_MS);
    },
    [flushQuestion, pushFinalPart, recordUtterance],
  );

  const forceAnswer = useCallback((questionOverride?: string): ForceAnswerStatus => {
    if (!active || paused) return 'unavailable';

    const typedQuestion = questionOverride?.trim();
    if (questionOverride != null && (!typedQuestion || typedQuestion.length < 3)) {
      return 'unavailable';
    }

    clearForcePrefixStabilization();
    streamGenRef.current += 1;
    cancelStreamRef.current?.();
    cancelStreamRef.current = null;
    streamLockRef.current = false;
    queuedAnswerRef.current = null;
    setStreaming(false);
    setSuggestLoading(false);
    setStreamText('');
    setCurrentQuestion('');
    cancelPendingQuestion();
    setError('');
    const pressedAtMs = Date.now();
    const forceSnapshot = forceCoordinatorRef.current.snapshot();
    const forcedFinals = forcedFinalLedgerRef.current.snapshot();
    const unconsumedForcedFinals = {
      mic: forcedFinals.some(
        (line) => line.source === 'mic' && line.sequence > forceSnapshot.consumedSequence,
      )
        ? 1
        : 0,
      system: forcedFinals.some(
        (line) => line.source === 'system' && line.sequence > forceSnapshot.consumedSequence,
      )
        ? 1
        : 0,
    };
    const spokenScreenCue = typedQuestion
      ? null
      : findLatestUnconsumedScreenCaptureCue(
          forcedFinals,
          forceSnapshot.consumedSequence,
        );
    if (spokenScreenCue) {
      forceCoordinatorRef.current.markHandled(spokenScreenCue.sequence);
    }
    const explicitQuestion = typedQuestion
      ? isSpokenScreenCaptureCue(typedQuestion)
        ? screenCaptureRequestFromCue(typedQuestion)
        : typedQuestion
      : spokenScreenCue
        ? screenCaptureRequestFromCue(spokenScreenCue.text)
        : '';
    const speechActivity = speechActivityRef.current.snapshot();
    const targetSource = selectForceTargetSource(
      liveSourcesRef.current,
      speechActivity,
      unconsumedForcedFinals,
      {
        systemSilent:
          sourceHealthRef.current.snapshot().warning === SYSTEM_NO_SIGNAL_WARNING,
      },
    );
    const latestUnconsumedFinal = forcedFinals
      .filter(
        (line) =>
          line.sequence > forceSnapshot.consumedSequence &&
          (!targetSource || !line.source || line.source === targetSource),
      )
      .at(-1);
    const decision = explicitQuestion
      ? forceCoordinatorRef.current.submitQuestion(explicitQuestion)
      : forceCoordinatorRef.current.press(
          forcedFinals.filter(
            (line) => !targetSource || !line.source || line.source === targetSource,
          ),
          targetSource,
          shouldFinalizeCurrentSpeech(
            targetSource,
            speechActivity,
            unconsumedForcedFinals,
            latestUnconsumedFinal?.receivedAt,
            pressedAtMs,
            targetSource
              ? speechActivityRef.current.latestStartedAt(targetSource)
              : null,
          ),
        );
    if (explicitQuestion) timeoutScreenPartialRef.current.clearGeneration(decision.generation);
    else {
      timeoutScreenPartialRef.current.freezeGeneration(
        decision.generation,
        targetSource,
        pressedAtMs,
      );
    }
    clearForceTimeout(decision.generation);
    syncForceSnapshot();

    if (decision.action === 'submit') {
      utteranceBufferRef.current = [];
      if (!explicitQuestion) {
        const quality = evaluateForcedTranscript(decision.question, sttLanguageRef.current);
        if (!quality.eligible) {
          rejectForcedTranscript(
            decision.question,
            decision.generation,
            quality.reason,
          );
          return 'finalizing';
        }
      }
      if (routeVisualQuestionToScreen(decision.question, decision.generation)) {
        return 'finalizing';
      }
      const answeredLine = forcedFinals.find(
        (line) => line.sequence === decision.sequence,
      );
      askQuestion(decision.question, decision.generation, answeredLine ? {
        utteranceId: answeredLine.utteranceId,
        source: answeredLine.source,
        capturedAtMs: answeredLine.capturedAtMs,
        queueWaitMs: answeredLine.queueWaitMs,
        queueDepth: answeredLine.queueDepth,
        speechEndToFinalMs: answeredLine.speechEndToFinalMs,
        openaiInferenceMs: answeredLine.openaiInferenceMs,
      } : undefined);
      return 'started';
    }

    if (decision.action === 'flush') {
      const targetSession = liveRef.current.find((entry) => entry.source === decision.source);
      if (!targetSession?.session.flush(decision.requestId)) {
        forceCoordinatorRef.current.setPhase(decision.generation, 'error');
        syncForceSnapshot();
        return 'unavailable';
      }
      serverTimingsRef.current = null;
      questionFinalAtRef.current = performance.now();
      scheduleForceTranscriptNotice(decision.generation);
      return 'finalizing';
    }

    return 'unavailable';
  }, [
    active,
    paused,
    askQuestion,
    cancelPendingQuestion,
    clearForcePrefixStabilization,
    clearForceTimeout,
    routeVisualQuestionToScreen,
    rejectForcedTranscript,
    scheduleForceTranscriptNotice,
    syncForceSnapshot,
  ]);

  const forceCandidateFollowUp = useCallback((hotkeySource = 'button'): ForceAnswerStatus => {
    recordCandidateHotkeyDiagnostic('candidate_hotkey_received', {
      source: 'mic',
      meta: { hotkeySource },
    });
    if (!active || paused || !liveSourcesRef.current.mic) {
      recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
        source: 'mic',
        reason: !active ? 'session_inactive' : paused ? 'session_paused' : 'mic_disabled',
        meta: { hotkeySource },
      });
      return 'unavailable';
    }
    const pressedAtMs = Date.now();
    const forceSnapshot = forceCoordinatorRef.current.snapshot();
    const forcedFinals = forcedFinalLedgerRef.current.snapshot();
    const micFinals = forcedFinals.filter((line) => line.source === 'mic');
    const hasUnconsumedMic = micFinals.some(
      (line) => line.sequence > forceSnapshot.consumedSequence,
    );
    const speechActivity = speechActivityRef.current.snapshot();
    if (!hasUnconsumedMic && !speechActivity.mic) {
      recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
        source: 'mic',
        reason: 'no_candidate_utterance',
        meta: { hotkeySource, generation: forceSnapshot.generation },
      });
      return 'unavailable';
    }
    const previous = answerHistoryRef.current.at(-1);
    const candidateBase = activeScreenTaskContextRef.current.selectCandidateBase(previous);

    clearForcePrefixStabilization();
    streamGenRef.current += 1;
    cancelStreamRef.current?.();
    cancelStreamRef.current = null;
    streamLockRef.current = false;
    queuedAnswerRef.current = null;
    setStreaming(false);
    setSuggestLoading(false);
    setStreamText('');
    setCurrentQuestion('');
    cancelPendingQuestion();
    setError('');

    const latestUnconsumedFinal = micFinals
      .filter((line) => line.sequence > forceSnapshot.consumedSequence)
      .at(-1);
    const decision = forceCoordinatorRef.current.press(
      micFinals,
      'mic',
      shouldFinalizeCurrentSpeech(
        'mic',
        speechActivity,
        { mic: hasUnconsumedMic ? 1 : 0, system: 0 },
        latestUnconsumedFinal?.receivedAt,
        pressedAtMs,
        speechActivityRef.current.latestStartedAt('mic'),
      ),
    );
    candidateFollowUpOwnerRef.current.begin(decision.generation, candidateBase);
    timeoutScreenPartialRef.current.freezeGeneration(
      decision.generation,
      'mic',
      pressedAtMs,
    );
    clearForceTimeout(decision.generation);
    syncForceSnapshot();

    if (decision.action === 'submit') {
      utteranceBufferRef.current = [];
      const result = dispatchAcceptedForceDecision(decision);
      return result === 'text' ? 'started' : 'unavailable';
    }

    if (decision.action === 'flush') {
      recordCandidateHotkeyDiagnostic('candidate_hotkey_queued', {
        source: 'mic',
        reason: speechActivity.mic
          ? 'finalizing_active_speech'
          : 'finalizing_owned_utterance',
        meta: { generation: decision.generation, phase: 'finalizing-transcript' },
      });
      const micSession = liveRef.current.find((entry) => entry.source === 'mic');
      if (!micSession?.session.flush(decision.requestId)) {
        candidateFollowUpOwnerRef.current.clear(decision.generation);
        forceCoordinatorRef.current.setPhase(decision.generation, 'error');
        syncForceSnapshot();
        recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
          source: 'mic',
          reason: 'finalize_unavailable',
          meta: { generation: decision.generation },
        });
        return 'unavailable';
      }
      serverTimingsRef.current = null;
      questionFinalAtRef.current = performance.now();
      scheduleForceTranscriptNotice(decision.generation);
      return 'finalizing';
    }

    candidateFollowUpOwnerRef.current.clear(decision.generation);
    recordCandidateHotkeyDiagnostic('candidate_hotkey_ignored', {
      source: 'mic',
      reason: 'no_owned_final',
      meta: { generation: decision.generation },
    });
    return 'unavailable';
  }, [
    active,
    paused,
    cancelPendingQuestion,
    clearForcePrefixStabilization,
    clearForceTimeout,
    dispatchAcceptedForceDecision,
    recordCandidateHotkeyDiagnostic,
    scheduleForceTranscriptNotice,
    syncForceSnapshot,
  ]);

  const forceScreenAnswer = useCallback((questionOverride?: string): ForceAnswerStatus => {
    if (!active || paused) return 'unavailable';
    const request = questionOverride?.trim() || screenCaptureRequestFromCue('Покажу решение');
    clearForcePrefixStabilization();
    streamGenRef.current += 1;
    cancelStreamRef.current?.();
    cancelStreamRef.current = null;
    streamLockRef.current = false;
    queuedAnswerRef.current = null;
    setStreaming(false);
    setSuggestLoading(false);
    setStreamText('');
    setCurrentQuestion('');
    cancelPendingQuestion();
    setError('');

    const decision = forceCoordinatorRef.current.submitQuestion(request);
    timeoutScreenPartialRef.current.clearGeneration(decision.generation);
    clearForceTimeout(decision.generation);
    syncForceSnapshot();
    return routeVisualQuestionToScreen(request, decision.generation, true)
      ? 'finalizing'
      : 'unavailable';
  }, [
    active,
    cancelPendingQuestion,
    clearForcePrefixStabilization,
    clearForceTimeout,
    paused,
    routeVisualQuestionToScreen,
    syncForceSnapshot,
  ]);

  const appendLine = useCallback((rawText: string, isFinal: boolean, speaker: Speaker) => {
    const text = rawText.trim();
    const normalized = normalizeTranscript(text);
    const showNorm = normalized !== text.trim();
    setLines((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (
        last &&
        last.speaker === speaker &&
        last.isFinal &&
        isFinal &&
        normalizeTranscript(last.text) === normalized
      ) {
        return prev;
      }
      if (last && !last.isFinal && last.speaker === speaker) {
        updated[updated.length - 1] = {
          text,
          normalized: showNorm ? normalized : undefined,
          isFinal,
          speaker,
        };
      } else {
        updated.push({
          text,
          normalized: showNorm ? normalized : undefined,
          isFinal,
          speaker,
        });
      }
      return updated.slice(-40);
    });
  }, []);

  const start = useCallback(
    async (
      sources: LiveSources,
      stt: SttSessionOptions = {},
      link: LiveSessionLink = {},
    ): Promise<string | null> => {
      // Обновляем выбранное резюме в фоне заранее; захват звука из-за этого не ждёт сеть.
      void preloadCandidateContext();
      try {
        if (endingSessionRef.current) await endingSessionRef.current;
        if (sessionRef.current) await endInterviewSession();
      } catch {
        return null;
      }
      // A standalone screen request has no sessionRef, so endInterviewSession
      // cannot own it. Invalidate its generation/transport synchronously before
      // the diagnostic recorder is reset for the new live epoch.
      activeScreenCancellationRef.current.cancelAndClear();
      const diagnosticsEpoch = diagnosticsEpochRef.current + 1;
      diagnosticsEpochRef.current = diagnosticsEpoch;
      diagnosticsBaseRef.current = null;
      screenAssistDiagnosticsRef.current.reset(performance.now());
      timeoutScreenPartialRef.current.reset();
      const language = stt.language ?? 'ru';
      sttLanguageRef.current = language;
      setError('');
      setReconnecting(null);
      setSourceHealthWarning(null);
      clearSourceHealthTimer();
      setPaused(false);
      setLines([]);
      setAnswerHistory([]);
      answerHistoryRef.current = [];
      setCurrentQuestion('');
      setStreamText('');
      setSttDebug(null);
      lastQuestionRef.current = '';
      lastCompletedRef.current = '';
      lastCompletedRawRef.current = '';
      finalPartsRef.current = [];
      speechStartedAtRef.current = null;
      questionFinalAtRef.current = null;
      timingRef.current = emptyTimingState();
      sttMetaRef.current = null;
      sessionContextRef.current = createEmptySessionContext();
      utteranceBufferRef.current = [];
      incompleteRetryRef.current = 0;
      streamLockRef.current = false;
      queuedAnswerRef.current = null;
      hasSessionContentRef.current = false;
      lastPersistedTranscriptRef.current = {};
      resetForceCoordinator();
      speechActivityRef.current.reset();
      sourceHealthRef.current = new LiveSourceHealth(sources);
      debugRef.current.start(16000);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      liveRef.current.forEach((e) => e.session.stop());
      liveRef.current = [];

      try {
        let nextSessionId = '';
        if (link.sessionId) {
          const existing = await api.getSession(link.sessionId);
          if (diagnosticsEpochRef.current !== diagnosticsEpoch) return null;
          nextSessionId = existing.id;
          diagnosticsBaseRef.current = existing.diagnostics ?? null;
          reusedSessionRef.current = true;
        } else {
          const created = await api.createSession('interview', link.title);
          if (diagnosticsEpochRef.current !== diagnosticsEpoch) return null;
          nextSessionId = created.id;
          reusedSessionRef.current = false;
        }
        sessionRef.current = nextSessionId;
        diagnosticsWriterRef.current.activate(diagnosticsEpoch, nextSessionId);
        setSessionId(nextSessionId);
        setSessionStartedAt(Date.now());
      } catch {
        try {
          const created = await api.createSession('interview', link.title);
          if (diagnosticsEpochRef.current !== diagnosticsEpoch) return null;
          sessionRef.current = created.id;
          diagnosticsWriterRef.current.activate(diagnosticsEpoch, created.id);
          setSessionId(created.id);
          setSessionStartedAt(Date.now());
          reusedSessionRef.current = false;
        } catch {
          sessionRef.current = null;
          reusedSessionRef.current = false;
        }
      }

      const triggerSpeaker: Speaker = sources.system ? 'other' : 'me';
      triggerSpeakerRef.current = triggerSpeaker;
      liveSourcesRef.current = { ...sources };
      timingRef.current.audioCaptureStartAt = performance.now();

      const startOne = async (source: 'mic' | 'system', speaker: Speaker) => {
        const label = source === 'mic' ? t('live.microphone') : t('live.systemAudio');
        const live = await startLiveSession(
          {
            onTranscript: (text, isFinal, _speechFinal, metadata) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              const forceRequestId = metadata?.forceRequestId;

              if (!isFinal) {
                speechActivityRef.current.partial(source);
                const partialQuality = evaluateForcedTranscript(trimmed, language);
                timeoutScreenPartialRef.current.observe({
                  text: trimmed,
                  source,
                  receivedAtMs: Date.now(),
                  capturedAtMs: metadata?.capturedAtMs,
                  active: true,
                  rejected: !partialQuality.eligible,
                });
                if (!timingRef.current.speechDetectedAt) {
                  timingRef.current.speechDetectedAt = performance.now();
                }
                return;
              }

              // A later successful fragment clears a recoverable upstream STT
              // notice without requiring the user to restart the microphone.
              setError('');

              timingRef.current.finalTranscriptionStartAt =
                timingRef.current.finalTranscriptionStartAt ?? performance.now();
              timingRef.current.finalTranscriptionEndAt = performance.now();
              timingRef.current.speechEndedAt = performance.now();
              speechActivityRef.current.finished(source);
              timeoutScreenPartialRef.current.clearCandidate(source);
              appendLine(trimmed, true, speaker);
              persistTranscriptLine(trimmed, speaker);
              debugRef.current.event(
                'final',
                withAudioSource(source, {
                  text: trimmed,
                  speaker,
                  meta: toSttDiagnosticMeta(metadata),
                }),
              );
              patchSttDebug({
                finalTranscript: trimmed,
                rawTranscript: trimmed,
                normalizedTranscript: normalizeTranscript(trimmed),
                waitReason: undefined,
              });

              const ledgerLine = appendForcedFinal(trimmed, source, metadata);
              const forceSnapshot = forceCoordinatorRef.current.snapshot();
              if (
                forceRequestId ||
                forceSnapshot.phase === 'finalizing-transcript' ||
                forceSnapshot.phase === 'screen-fallback'
              ) {
                const forcedTextPolicy = evaluateForcedFinalTranscript(
                  trimmed,
                  language,
                  forceRequestId,
                  forceSnapshot.requestId,
                  source,
                  forceSnapshot.source,
                  metadata?.capturedAtMs,
                  Date.now(),
                );
                if (forcedTextPolicy.action === 'reject') {
                  rejectForcedTranscript(
                    trimmed,
                    forceSnapshot.generation,
                    forcedTextPolicy.reason,
                  );
                  return;
                }
                const decision = forceCoordinatorRef.current.acceptFinal(
                  ledgerLine,
                  forceRequestId,
                );
                if (decision.action !== 'submit') {
                  if (decision.action === 'wait') {
                    syncForceSnapshot();
                    scheduleForceTranscriptNotice(decision.generation);
                  }
                  if (speaker !== triggerSpeakerRef.current) {
                    recordUtterance(trimmed, true, speaker);
                  }
                  return;
                }

                dispatchAcceptedForceDecision(decision);
                return;
              }

              // Собственная речь кандидата (не-триггерный канал) идёт в контекст
              // обычного auto-flow, но остаётся доступной явному Ctrl+Enter выше.
              if (speaker !== triggerSpeakerRef.current) {
                recordUtterance(trimmed, true, speaker);
                return;
              }

              // Manual-only policy: final transcripts are persisted and kept in
              // the Ctrl+Enter ledger, but recognition alone never starts the LLM.
              // This also keeps the candidate's own speech available for the
              // post-session assessment without turning it into a new request.
              recordUtterance(trimmed, true, speaker);
            },
            onSpeechStarted: (captureEpoch) => {
              speechActivityRef.current.started(source);
              timeoutScreenPartialRef.current.clearCandidate(source);
              updateSourceHealth(
                sourceHealthRef.current.markSpeechStarted(source, captureEpoch),
              );
              if (speaker === triggerSpeakerRef.current) {
                serverTimingsRef.current = null;
                cancelPendingQuestion();
              }
              if (!timingRef.current.speechDetectedAt) {
                timingRef.current.speechDetectedAt = performance.now();
              }
              timingRef.current.finalTranscriptionStartAt = null;
              timingRef.current.finalTranscriptionEndAt = null;
              debugRef.current.event(
                'speech_started',
                withAudioSource(source, { speaker }),
              );
            },
            onReady: (info) => {
              sttMetaRef.current = {
                engine: info.engine,
                model: info.model,
                sampleRate: info.sampleRate,
              };
              debugRef.current.setSampleRate(info.sampleRate);
              debugRef.current.event('ready', withAudioSource(source, {
                meta: {
                  readyKind: 'stt_connection',
                  model: info.model,
                  sampleRate: info.sampleRate,
                },
              }));
            },
            onCaptureReady: ({ capturedAtMs, captureEpoch }) => {
              timeoutScreenPartialRef.current.clearCandidate(source);
              updateSourceHealth(
                sourceHealthRef.current.markCaptureReady(
                  source,
                  captureEpoch,
                  capturedAtMs,
                ),
              );
              debugRef.current.event(
                'ready',
                withAudioSource(source, {
                  meta: { readyKind: 'capture', captureEpoch },
                }),
              );
            },
            onAudioFrame: (buffer, signal, captureEpoch) => {
              // Record the trigger speaker's mic so the debug WAV is the user's voice.
              if (speaker === triggerSpeakerRef.current) debugRef.current.audioFrame(buffer);
              if (signal) {
                updateSourceHealth(
                  sourceHealthRef.current.observeAudioFrame(source, captureEpoch, signal),
                );
              }
            },
            onUtteranceEnd: (timings, forceRequestId) => {
              // Только триггерный канал (интервьюер при mic+system) завершает
              // вопрос — конец собственной реплики кандидата не должен
              // форсировать flush чужого буфера.
              if (speaker !== triggerSpeakerRef.current) return;
              // Forced transcript submission is decided by acceptFinal. Its
              // trailing utterance_end may belong to an older generation and
              // must never flush or clear the current one.
              if (forceRequestId) return;
              lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
              if (timings) serverTimingsRef.current = timings;
            },
            onLowQuality: (text, _reason, forceRequestId, metadata) => {
              // Server quality gate rejected this utterance — keep listening,
              // never call the LLM with garbage. (Server logs the reason.)
              serverTimingsRef.current = null;
              speechActivityRef.current.finished(source);
              timeoutScreenPartialRef.current.clearCandidate(source);
              if (forceRequestId) {
                const decision = forceCoordinatorRef.current.acceptEmpty(forceRequestId);
                dispatchAcceptedForceDecision(decision);
                if (decision.action === 'wait') {
                  timeoutScreenPartialRef.current.clearGeneration(decision.generation);
                  syncForceSnapshot();
                  scheduleFinalizedPrefixCommit(
                    forceRequestId,
                    decision.generation,
                    source,
                  );
                  scheduleForceTranscriptNotice(decision.generation, FORCE_EMPTY_GRACE_MS);
                }
              }
              recordSkipped(_reason, text);
              hasSessionContentRef.current = true;
              debugRef.current.event(
                'low_quality',
                withAudioSource(source, {
                  text,
                  reason: _reason,
                  speaker,
                  meta: toSttDiagnosticMeta(metadata),
                }),
              );
              patchSttDebug({
                finalTranscript: text,
                rawTranscript: text,
                normalizedTranscript: normalizeTranscript(text),
                waitReason: 'Waiting for complete question…',
              });
            },
            onForceEmpty: (forceRequestId) => {
              if (!forceRequestId) return;
              const decision = forceCoordinatorRef.current.acceptEmpty(forceRequestId);
              dispatchAcceptedForceDecision(decision);
              if (decision.action === 'wait') {
                timeoutScreenPartialRef.current.clearGeneration(decision.generation);
                syncForceSnapshot();
                scheduleFinalizedPrefixCommit(
                  forceRequestId,
                  decision.generation,
                  source,
                );
                scheduleForceTranscriptNotice(decision.generation, FORCE_EMPTY_GRACE_MS);
              }
            },
            onTurnResumed: () => {
              lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
              cancelPendingQuestion();
            },
            onReconnecting: (attempt, maxAttempts) => {
              updateSourceHealth(sourceHealthRef.current.markCapturePending(source));
              setReconnecting(
                `${label}: ${t('live.reconnectLost')} (${attempt}/${maxAttempts})`,
              );
              debugRef.current.event('error', withAudioSource(source, {
                reason: `reconnecting ${attempt}/${maxAttempts}`,
              }));
            },
            onReconnected: () => {
              setReconnecting(null);
              debugRef.current.event(
                'ready',
                withAudioSource(source, { meta: { reconnected: true } }),
              );
            },
            onError: (msg) => {
              setReconnecting(null);
              debugRef.current.event('error', withAudioSource(source, { reason: msg }));
              const remainingSources = liveRef.current
                .filter((entry) => entry.source !== source)
                .map((entry) => entry.source);
              removeStream(
                source,
                audioSourceFailureMessage(source, remainingSources, label, msg) || undefined,
              );
            },
            onRecoverableError: (msg) => {
              setReconnecting(null);
              speechActivityRef.current.finished(source);
              // A single upstream STT hiccup is not a failed answer. Keep the
              // stream alive and record it only in diagnostics; putting it in
              // the global error state duplicated the same warning in both
              // the answer card and the footer until the next successful turn.
              debugRef.current.event(
                'error',
                withAudioSource(source, { reason: msg, meta: { recoverable: true } }),
              );
            },
            onClose: () => {
              if (liveRef.current.some((e) => e.source === source)) {
                debugRef.current.event(
                  'error',
                  withAudioSource(source, { reason: t('live.reconnectFailed') }),
                );
                removeStream(source, `${label}: ${t('live.reconnectFailed')}`);
              }
            },
          },
          {
            sessionId: sessionRef.current ?? undefined,
            speaker,
            source,
            language,
            audioSampleRate: stt.audioSampleRate,
          },
        );
        if (diagnosticsEpochRef.current !== diagnosticsEpoch) {
          live.stop();
          return;
        }
        liveRef.current.push({ source, session: live });
      };

      try {
        const tasks: Promise<void>[] = [];
        if (sources.mic) tasks.push(startOne('mic', 'me'));
        if (sources.system) tasks.push(startOne('system', 'other'));
        await Promise.all(tasks);
        if (diagnosticsEpochRef.current !== diagnosticsEpoch) return null;
        if (liveRef.current.length > 0) {
          setActive(true);
        } else {
          setError(t('live.startNoSource'));
          await endInterviewSession();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('live.startFailed'));
        liveRef.current.forEach((e) => e.session.stop());
        liveRef.current = [];
        await endInterviewSession();
      }
      return sessionRef.current;
    },
    // The two speech-final helpers deliberately remain disconnected from STT callbacks:
    // keeping them in this closure makes accidental reactivation visible to the behavior test.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appendForcedFinal, appendLine, askQuestion, cancelPendingQuestion, clearForceTimeout, clearSourceHealthTimer, dispatchAcceptedForceDecision, endInterviewSession, patchSttDebug, persistTranscriptLine, preloadCandidateContext, recordUtterance, removeStream, resetForceCoordinator, routeVisualQuestionToScreen, scheduleFinalFallback, scheduleFinalizedPrefixCommit, scheduleForceTranscriptNotice, scheduleSpeechFinal, syncForceSnapshot, updateSourceHealth],
  );

  const pause = useCallback(() => {
    if (!active || paused) return;
    clearSourceHealthTimer();
    sourceHealthRef.current = new LiveSourceHealth(liveSourcesRef.current);
    setSourceHealthWarning(null);
    timeoutScreenPartialRef.current.clearCandidates();
    liveRef.current.forEach((entry) => entry.session.pause());
    speechActivityRef.current.reset();
    setReconnecting(null);
    setPaused(true);
  }, [active, clearSourceHealthTimer, paused]);

  const resume = useCallback(async () => {
    if (!active || !paused) return;
    setError('');
    timeoutScreenPartialRef.current.clearCandidates();
    try {
      await Promise.all(liveRef.current.map((entry) => entry.session.resume()));
      timingRef.current.audioCaptureStartAt = performance.now();
      setPaused(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('live.startFailed'));
    }
  }, [active, paused]);

  const stop = useCallback(async () => {
    if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
    clearSourceHealthTimer();
    resetForceCoordinator();
    streamGenRef.current += 1;
    cancelStreamRef.current?.();
    streamLockRef.current = false;
    queuedAnswerRef.current = null;
    setStreaming(false);
    const hadStreams = liveRef.current.length > 0;
    liveRef.current.forEach((e) => e.session.stop());
    liveRef.current = [];
    setActive(false);
    setPaused(false);
    setReconnecting(null);
    setSourceHealthWarning(null);
    screenTaskAvailableRef.current = false;
    sessionContextRef.current = createEmptySessionContext();
    if (hadStreams || sessionRef.current) {
      try {
        await endInterviewSession();
      } catch {
        // Keep the durable session ID and diagnostics in memory for an explicit retry.
      }
    }
  }, [clearSourceHealthTimer, endInterviewSession, resetForceCoordinator]);

  // Уход со страницы во время записи обязан выключить микрофон и закрыть сокеты —
  // иначе mic «горит» в фоне (приватность) и trial-минуты не фиксируются на закрытии
  // сокета. Держим stop в ref, чтобы cleanup сработал РОВНО раз на анмаунте, а не
  // пересоздавался при каждой смене identity колбэка stop.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(
    () => () => {
      void stopRef.current();
    },
    [],
  );

  // Сигнал о live-состоянии: сайдбар-хронометр и веха активации (App.tsx,
  // Layout.tsx) слушают skillcue:live-start/stop. Хук теперь живёт в оверлее
  // (отдельное окно), поэтому, помимо локального события, дублируем состояние в
  // главное окно через main-процесс — там App.tsx ре-диспатчит те же события.
  useEffect(() => {
    window.dispatchEvent(new Event(active ? 'skillcue:live-start' : 'skillcue:live-stop'));
    void window.electronAPI?.overlay?.setLiveState?.(active);
  }, [active]);

  // Телеметрия задержек завершённого обмена: локальный снимок для Diagnostics
  // (у той страницы нет своей live-сессии) + серверный p50/p95-тренд с бюджетами.
  // Раньше жила в InterviewPage; перенесена в хук, чтобы пережить удаление страницы.
  useEffect(() => {
    const dbg = sttDebug;
    if (dbg?.totalEndToEndMs == null) return;
    try {
      localStorage.setItem(
        'skillcue:lastTimings',
        JSON.stringify({
          firstPartialMs: null,
          transcribeMs: dbg.finalTranscriptionMs ?? dbg.timeToFinalMs ?? null,
          sttFinalMs: dbg.timeToFinalMs ?? null,
          llmFirstMs: dbg.llmFirstTokenMs ?? dbg.timeToAnswerMs ?? null,
          llmTotalMs: dbg.llmTotalMs ?? null,
          totalMs: dbg.totalEndToEndMs,
          at: Date.now(),
        }),
      );
    } catch {
      /* storage unavailable */
    }
    void api
      .recordLatency({
        stt_ms: dbg.timeToFinalMs != null ? Math.round(dbg.timeToFinalMs) : null,
        llm_first_ms: dbg.llmFirstTokenMs != null ? Math.round(dbg.llmFirstTokenMs) : null,
        llm_total_ms: dbg.llmTotalMs != null ? Math.round(dbg.llmTotalMs) : null,
        total_ms: Math.round(dbg.totalEndToEndMs),
      })
      .catch(() => {
        /* telemetry is best-effort */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sttDebug?.totalEndToEndMs]);

  const updateAnswerEntry = useCallback((id: string, spoken: string) => {
    setAnswerHistory((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, spoken, ts: Date.now() } : entry)),
    );
  }, []);

  const setLiveAnswerText = useCallback((text: string) => {
    setStreamText(text);
  }, []);

  /**
   * Download a debug bundle for the current/last session: a WAV of the user's
   * mic plus a JSON timeline of every STT/LLM event with ms-accurate timestamps
   * (and the per-exchange pipeline data). Lets you see exactly when each word was
   * heard and where a slow/dropped question came from.
   */
  const downloadDebug = useCallback(() => {
    const rec = debugRef.current;
    if (!rec.hasData()) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const wav = rec.buildWav();
    const audioName = wav ? `live-debug-${stamp}.wav` : null;

    const triggerDownload = (blob: Blob, filename: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    if (wav && audioName) triggerDownload(wav, audioName);

    const screen = screenAssistDiagnosticsRef.current.snapshot();
    const current = rec.buildJson(audioName, {
      stt: sttMetaRef.current,
      sources: liveSourcesRef.current,
      sourceHealth: sourceHealthRef.current.snapshot(),
      exchanges: answerHistoryRef.current,
      screenAssists: screen.entries,
    });
    current.retention = { ...current.retention!, screenAssists: screen.retention };
    const bundle = mergeDebugBundles(diagnosticsBaseRef.current, current);
    triggerDownload(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      `live-debug-${stamp}.json`,
    );
    return true;
  }, []);

  return {
    active,
    paused,
    lines,
    answerHistory,
    currentQuestion,
    streamText,
    streaming,
    forceGeneration,
    forcePhase,
    forceScreenFallback,
    commitScreenFirstOutput,
    finishScreenFallback,
    markScreenTaskAvailable,
    publishScreenTaskContext,
    clearScreenTaskContext,
    clearForceScreenFallback,
    screenAssistDiagnostics,
    suggestLoading,
    error,
    reconnecting,
    sourceHealthWarning,
    sttDebug,
    sessionId,
    sessionStartedAt,
    updateAnswerEntry,
    setLiveAnswerText,
    downloadDebug,
    askQuestion,
    forceAnswer,
    forceCandidateFollowUp,
    forceScreenAnswer,
    start,
    pause,
    resume,
    stop,
  };
}
