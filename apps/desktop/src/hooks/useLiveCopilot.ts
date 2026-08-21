import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { decideAnswerAction } from '../lib/liveAnswerMachine';
import { startLiveSession, LiveSession, SttTimings } from '../lib/liveSession';
import { prepareTranscriptForLlm, PreparedTranscript } from '../lib/prepareTranscriptForLlm';
import { SttSessionOptions } from '../lib/sttOptions';
import { getWeakTopicTitles } from '../lib/vacancyReview/weakTopics';
import { recordSkipped } from '../lib/skippedLog';
import { t } from '../lib/i18n';
import { selectForceTargetSource, SpeechActivityTracker } from '../lib/forceLiveAnswer';
import {
  LatestForcedAnswerCoordinator,
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
import { LiveDebugRecorder } from '../lib/liveDebugRecorder';
import {
  buildLatencyBreakdown,
  computeExchangeSttLatencyMs,
  sanitizeSttLatencyMs,
} from '../lib/liveTiming';
import {
  buildExchangeLatency,
  buildPipelineFromPrepared,
  type CopilotAnswerEntry,
  type CopilotAnswerPipeline,
  type ExchangeLatency,
  type Speaker,
  type TranscriptLine,
} from '../lib/interviewSessionExport';

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
const FORCE_EMPTY_GRACE_MS = 1400;
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
}

interface QueuedAnswerRequest {
  rawMerged: string;
  serverTimings: SttTimings | null;
  questionFinalAt: number | null;
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
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [answerHistory, setAnswerHistory] = useState<CopilotAnswerEntry[]>([]);
  const answerHistoryRef = useRef<CopilotAnswerEntry[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [forceGeneration, setForceGeneration] = useState(0);
  const [forcePhase, setForcePhase] = useState<ForcePhase>('idle');
  const [forceScreenFallbackGeneration, setForceScreenFallbackGeneration] = useState(0);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [sttDebug, setSttDebug] = useState<SttDebugInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const sttDebugRef = useRef<SttDebugInfo | null>(null);

  useEffect(() => {
    sttDebugRef.current = sttDebug;
  }, [sttDebug]);

  const sessionRef = useRef<string | null>(null);
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
  const transcriptSequenceRef = useRef(0);
  const forcedFinalLedgerRef = useRef<ForcedTranscriptLine[]>([]);
  const pendingTriggerSequenceRef = useRef<number | null>(null);
  const forceCoordinatorRef = useRef(new LatestForcedAnswerCoordinator());
  const forceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechActivityRef = useRef(new SpeechActivityTracker());

  const appendForcedFinal = useCallback(
    (text: string, source: 'mic' | 'system'): ForcedTranscriptLine => {
      const line = {
        sequence: ++transcriptSequenceRef.current,
        text: text.trim(),
        source,
      };
      forcedFinalLedgerRef.current = [...forcedFinalLedgerRef.current.slice(-39), line];
      return line;
    },
    [],
  );

  const syncForceSnapshot = useCallback(() => {
    const snapshot = forceCoordinatorRef.current.snapshot();
    setForceGeneration(snapshot.generation);
    setForcePhase(snapshot.phase);
  }, []);

  const clearForceTimeout = useCallback(() => {
    if (!forceTimeoutRef.current) return;
    clearTimeout(forceTimeoutRef.current);
    forceTimeoutRef.current = null;
  }, []);

  const scheduleForceScreenFallback = useCallback(
    (generation: number, delayMs = FORCE_FINALIZE_TIMEOUT_MS) => {
      clearForceTimeout();
      forceTimeoutRef.current = setTimeout(() => {
        forceTimeoutRef.current = null;
        if (!forceCoordinatorRef.current.beginScreenFallback(generation)) return;
        syncForceSnapshot();
        setForceScreenFallbackGeneration(generation);
      }, delayMs);
    },
    [clearForceTimeout, syncForceSnapshot],
  );

  const resetForceCoordinator = useCallback(() => {
    clearForceTimeout();
    forceCoordinatorRef.current.reset();
    transcriptSequenceRef.current = 0;
    forcedFinalLedgerRef.current = [];
    pendingTriggerSequenceRef.current = null;
    setForceScreenFallbackGeneration(0);
    syncForceSnapshot();
  }, [clearForceTimeout, syncForceSnapshot]);

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

  const endInterviewSession = useCallback(async () => {
    const sid = sessionRef.current;
    const sessionHasContent = hasSessionContentRef.current;
    const reusedSession = reusedSessionRef.current;
    sessionRef.current = null;
    reusedSessionRef.current = false;
    setSessionId(null);
    if (!sid) return;
    try {
      await transcriptWriteQueueRef.current.drain(sid);
      if (sessionHasContent) {
        const diagnostics = debugRef.current.buildJson(null, {
          stt: sttMetaRef.current,
          sources: liveSourcesRef.current,
          exchanges: answerHistoryRef.current,
        });
        await api.saveSessionDiagnostics(sid, diagnostics).catch(() => undefined);
        await api.endSession(sid);
      } else if (!reusedSession) {
        await api.deleteSession(sid);
      }
    } catch {
      // ignore
    }
  }, []);

  const removeStream = useCallback(
    (source: 'mic' | 'system', msg?: string) => {
      speechActivityRef.current.resetSource(source);
      const forceSnapshot = forceCoordinatorRef.current.snapshot();
      if (
        source === forceSnapshot.source &&
        forceSnapshot.phase === 'finalizing-transcript'
      ) {
        scheduleForceScreenFallback(forceSnapshot.generation, 0);
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
        void endInterviewSession();
      }
    },
    [endInterviewSession, scheduleForceScreenFallback],
  );

  const runStream = useCallback((request: AnswerRequest) => {
    const { prepared, forceGeneration: requestForceGeneration } = request;
    const requestTimings = request.serverTimings;
    const requestQuestionFinalAt = request.questionFinalAt;
    const q = prepared.resolvedQuestion.trim();
    if (q.length < 3) return;
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
    // (the cause of the 24009/56622/113737ms bug). Prefer the server's
    // speech-end→final; fall back to a sane client measure, never session-elapsed.
    const exchangeSttLatencyMs = computeExchangeSttLatencyMs(
      requestTimings?.speechEndToFinalMs,
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
      // Prefer the server-measured speech-end -> final latency (the desktop can
      // only see when the final *arrived*, not when speech ended on the server).
      // The client fallback can be anchored to a stale/earlier moment after
      // silence or filtered hallucinations, producing absurd values (30s, 70s).
      // Real STT is a second or two, so discard an implausible fallback rather
      // than record a misleading number.
      timeToFinalMs:
        requestTimings?.speechEndToFinalMs ??
        (requestQuestionFinalAt != null
          ? sanitizeSttLatencyMs(answerStartedAt - requestQuestionFinalAt)
          : undefined),
      finalTranscriptionMs:
        requestTimings?.finalInferenceMs ?? buildTimingDebug(timingRef.current).finalTranscriptionMs,
    });

    setStreaming(true);
    setSuggestLoading(true);
    setStreamText('');
    setCurrentQuestion(q);
    setError('');
    if (
      requestForceGeneration != null &&
      forceCoordinatorRef.current.setPhase(requestForceGeneration, 'waiting-first-token')
    ) {
      syncForceSnapshot();
    }
    debugRef.current.event('answer_started', {
      text: q,
      meta: { sttLatencyMs: requestTimings?.speechEndToFinalMs },
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
        question: q,
        spoken: text,
        ts: Date.now(),
        source: 'live',
        pipeline,
        latency,
      };
      answerHistoryRef.current = [...answerHistoryRef.current, entry];
      setAnswerHistory(answerHistoryRef.current);
      const sid = sessionRef.current;
      if (sid) {
        void api.saveSessionDiagnostics(sid, debugRef.current.buildJson(null, {
          stt: sttMetaRef.current,
          sources: liveSourcesRef.current,
          exchanges: answerHistoryRef.current,
        })).catch(() => undefined);
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
              forceCoordinatorRef.current.setPhase(requestForceGeneration, 'streaming')
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
          setStreamText(sanitizeLiveAnswer(accumulated));
          setSuggestLoading(false);
        },
        onDone: (spoken: string, answerId?: string, responseMeta?: { model?: string; modelSource?: string }) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          if (
            requestForceGeneration != null &&
            forceCoordinatorRef.current.setPhase(requestForceGeneration, 'done')
          ) {
            syncForceSnapshot();
          }
          timingRef.current.llmEndAt = performance.now();
          lastCompletedRef.current = q;
          lastCompletedRawRef.current = prepared.rawTranscript;
          const text = trimSpokenAnswer(sanitizeLiveAnswer(stripExperienceFooter(spoken || accumulated)));
          const debugSnapshot = sttDebugRef.current;
          const llmLatencyMs = performance.now() - answerStartedAt;
          const pipeline = buildPipelineFromPrepared(prepared, {
            previousTopic: sessionContextRef.current.lastCanonicalTopic,
            timeToAnswerMs: debugSnapshot?.timeToAnswerMs,
            timeToFinalMs: exchangeSttLatencyMs,
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
          sessionContextRef.current = updateSessionContextAfterAnswer(sessionContextRef.current, {
            rawQuestion: prepared.rawTranscript,
            correctedQuestion: prepared.normalized,
            intentCorrectedQuestion: prepared.normalized,
            resolvedQuestion: prepared.resolvedQuestion,
            questionIntent: prepared.answerStrategy.questionIntent,
            canonicalTopic: prepared.canonicalTopic,
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
              accumulated ? 'done' : 'error',
            )
          ) {
            syncForceSnapshot();
          }
          debugRef.current.event('error', { reason: msg, text: q });
          if (accumulated) {
            lastCompletedRef.current = q;
            lastCompletedRawRef.current = prepared.rawTranscript;
            const text = trimSpokenAnswer(sanitizeLiveAnswer(stripExperienceFooter(accumulated)));
            const llmLatencyMs = performance.now() - answerStartedAt;
            const pipeline = buildPipelineFromPrepared(prepared, {
              previousTopic: sessionContextRef.current.lastCanonicalTopic,
              timeToFinalMs: exchangeSttLatencyMs,
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
        rawQuestion: prepared.rawTranscript,
        resolvedQuestion: prepared.resolvedQuestion,
        previousTopic: sessionContextRef.current.lastCanonicalTopic,
        isFollowUp: prepared.followUp.isFollowUp,
        usedPreviousContext: prepared.followUp.usedPreviousContext,
        followUpReason: prepared.followUp.reason,
        currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
        questionIntent: prepared.answerStrategy.questionIntent,
        answerStrategy: prepared.answerStrategy.answerStrategy,
        resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
        resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
        resumeContextReason: prepared.answerStrategy.resumeContextReason,
        suggestUnclearPrefix: prepared.answerStrategy.suggestUnclearPrefix,
        // Подготовка ↔ live: слабые темы из последнего mock-отчёта.
        weakTopics: getWeakTopicTitles(),
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
  }, [syncForceSnapshot]);

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
        debugRef.current.event('low_quality', { reason: 'unclear_non_question', text: raw });
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Skipped: unclear phrase (not a question)',
        });
        return false;
      }
      // A «?»-fragment with no real intent («Вместе или не?») — also skip.
      if (!force && isNonQuestionFragment(q) && isNonQuestionFragment(raw)) {
        recordSkipped('too_low_intent', raw);
        debugRef.current.event('low_quality', { reason: 'too_low_intent', text: raw });
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
    (text: string, forceGeneration?: number) => {
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
    if (!active) return 'unavailable';

    const typedQuestion = questionOverride?.trim();
    if (questionOverride != null && (!typedQuestion || typedQuestion.length < 3)) {
      return 'unavailable';
    }

    clearForceTimeout();
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
    const forceSnapshot = forceCoordinatorRef.current.snapshot();
    const unconsumedForcedFinals = {
      mic: forcedFinalLedgerRef.current.some(
        (line) => line.source === 'mic' && line.sequence > forceSnapshot.consumedSequence,
      )
        ? 1
        : 0,
      system: forcedFinalLedgerRef.current.some(
        (line) => line.source === 'system' && line.sequence > forceSnapshot.consumedSequence,
      )
        ? 1
        : 0,
    };
    const speechActivity = speechActivityRef.current.snapshot();
    const targetSource = selectForceTargetSource(
      liveSourcesRef.current,
      speechActivity,
      unconsumedForcedFinals,
    );
    const decision = typedQuestion
      ? forceCoordinatorRef.current.submitQuestion(typedQuestion)
      : forceCoordinatorRef.current.press(
          forcedFinalLedgerRef.current.filter(
            (line) => !targetSource || !line.source || line.source === targetSource,
          ),
          targetSource,
          Boolean(targetSource && speechActivity[targetSource]),
        );
    syncForceSnapshot();

    if (decision.action === 'submit') {
      utteranceBufferRef.current = [];
      askQuestion(decision.question, decision.generation);
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
      scheduleForceScreenFallback(decision.generation);
      return 'finalizing';
    }

    return 'unavailable';
  }, [
    active,
    askQuestion,
    cancelPendingQuestion,
    clearForceTimeout,
    scheduleForceScreenFallback,
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
      const language = stt.language ?? 'ru';
      setError('');
      setReconnecting(null);
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
      debugRef.current.start(16000);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      liveRef.current.forEach((e) => e.session.stop());
      liveRef.current = [];

      try {
        let nextSessionId = '';
        if (link.sessionId) {
          const existing = await api.getSession(link.sessionId);
          nextSessionId = existing.id;
          reusedSessionRef.current = true;
        } else {
          const created = await api.createSession('interview', link.title);
          nextSessionId = created.id;
          reusedSessionRef.current = false;
        }
        sessionRef.current = nextSessionId;
        setSessionId(nextSessionId);
        setSessionStartedAt(Date.now());
      } catch {
        try {
          const created = await api.createSession('interview', link.title);
          sessionRef.current = created.id;
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
            onTranscript: (text, isFinal, _speechFinal, forceRequestId) => {
              const trimmed = text.trim();
              if (!trimmed) return;

              if (!isFinal) {
                speechActivityRef.current.partial(source);
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
              appendLine(trimmed, true, speaker);
              persistTranscriptLine(trimmed, speaker);
              debugRef.current.event('final', { text: trimmed, speaker });
              patchSttDebug({
                finalTranscript: trimmed,
                rawTranscript: trimmed,
                normalizedTranscript: normalizeTranscript(trimmed),
                waitReason: undefined,
              });

              const ledgerLine = appendForcedFinal(trimmed, source);
              const forceSnapshot = forceCoordinatorRef.current.snapshot();
              if (
                forceRequestId ||
                forceSnapshot.phase === 'finalizing-transcript' ||
                forceSnapshot.phase === 'screen-fallback'
              ) {
                const decision = forceCoordinatorRef.current.acceptFinal(
                  ledgerLine,
                  forceRequestId,
                );
                if (decision.action !== 'submit') {
                  if (decision.action === 'wait') {
                    syncForceSnapshot();
                    scheduleForceScreenFallback(decision.generation);
                  }
                  if (speaker !== triggerSpeakerRef.current) {
                    recordUtterance(trimmed, true, speaker);
                  }
                  return;
                }

                clearForceTimeout();
                syncForceSnapshot();
                cancelPendingQuestion();
                utteranceBufferRef.current = [];
                askQuestion(decision.question, decision.generation);
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
            onSpeechStarted: () => {
              speechActivityRef.current.started(source);
              if (speaker === triggerSpeakerRef.current) {
                serverTimingsRef.current = null;
                cancelPendingQuestion();
              }
              if (!timingRef.current.speechDetectedAt) {
                timingRef.current.speechDetectedAt = performance.now();
              }
              timingRef.current.finalTranscriptionStartAt = null;
              timingRef.current.finalTranscriptionEndAt = null;
              debugRef.current.event('speech_started', { speaker });
            },
            onReady: (info) => {
              sttMetaRef.current = {
                engine: info.engine,
                model: info.model,
                sampleRate: info.sampleRate,
              };
              debugRef.current.setSampleRate(info.sampleRate);
              debugRef.current.event('ready', {
                meta: {
                  model: info.model,
                  sampleRate: info.sampleRate,
                },
              });
            },
            onAudioFrame: (buffer) => {
              // Record the trigger speaker's mic so the debug WAV is the user's voice.
              if (speaker === triggerSpeakerRef.current) debugRef.current.audioFrame(buffer);
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
            onLowQuality: (text, _reason, forceRequestId) => {
              // Server quality gate rejected this utterance — keep listening,
              // never call the LLM with garbage. (Server logs the reason.)
              serverTimingsRef.current = null;
              speechActivityRef.current.finished(source);
              if (forceRequestId) {
                const decision = forceCoordinatorRef.current.acceptEmpty(forceRequestId);
                if (decision.action === 'wait') {
                  syncForceSnapshot();
                  scheduleForceScreenFallback(decision.generation, FORCE_EMPTY_GRACE_MS);
                }
              }
              recordSkipped(_reason, text);
              debugRef.current.event('low_quality', { text, reason: _reason, speaker });
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
              if (decision.action !== 'wait') return;
              syncForceSnapshot();
              scheduleForceScreenFallback(decision.generation, FORCE_EMPTY_GRACE_MS);
            },
            onTurnResumed: () => {
              lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
              cancelPendingQuestion();
            },
            onReconnecting: (attempt, maxAttempts) => {
              setReconnecting(
                `${label}: ${t('live.reconnectLost')} (${attempt}/${maxAttempts})`,
              );
              debugRef.current.event('error', {
                reason: `reconnecting ${attempt}/${maxAttempts}`,
              });
            },
            onReconnected: () => {
              setReconnecting(null);
              debugRef.current.event('ready', { meta: { reconnected: true } });
            },
            onError: (msg) => {
              setReconnecting(null);
              removeStream(source, `${label}: ${msg}`);
            },
            onRecoverableError: (msg) => {
              setReconnecting(null);
              speechActivityRef.current.finished(source);
              // A single upstream STT hiccup is not a failed answer. Keep the
              // stream alive and record it only in diagnostics; putting it in
              // the global error state duplicated the same warning in both
              // the answer card and the footer until the next successful turn.
              debugRef.current.event('error', { reason: msg, meta: { recoverable: true } });
            },
            onClose: () => {
              if (liveRef.current.some((e) => e.source === source)) {
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
        liveRef.current.push({ source, session: live });
      };

      try {
        const tasks: Promise<void>[] = [];
        if (sources.mic) tasks.push(startOne('mic', 'me'));
        if (sources.system) tasks.push(startOne('system', 'other'));
        await Promise.all(tasks);
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
    [appendForcedFinal, appendLine, askQuestion, cancelPendingQuestion, clearForceTimeout, endInterviewSession, patchSttDebug, persistTranscriptLine, recordUtterance, removeStream, resetForceCoordinator, scheduleFinalFallback, scheduleForceScreenFallback, scheduleSpeechFinal, syncForceSnapshot],
  );

  const stop = useCallback(async () => {
    if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
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
    setReconnecting(null);
    sessionContextRef.current = createEmptySessionContext();
    if (hadStreams) await endInterviewSession();
  }, [endInterviewSession, resetForceCoordinator]);

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

    const bundle = rec.buildJson(audioName, {
      stt: sttMetaRef.current,
      sources: liveSourcesRef.current,
      exchanges: answerHistory,
    });
    triggerDownload(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      `live-debug-${stamp}.json`,
    );
    return true;
  }, [answerHistory]);

  return {
    active,
    lines,
    answerHistory,
    currentQuestion,
    streamText,
    streaming,
    forceGeneration,
    forcePhase,
    forceScreenFallbackGeneration,
    suggestLoading,
    error,
    reconnecting,
    sttDebug,
    sessionId,
    sessionStartedAt,
    updateAnswerEntry,
    setLiveAnswerText,
    downloadDebug,
    askQuestion,
    forceAnswer,
    start,
    stop,
  };
}
