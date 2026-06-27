import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { startLiveSession, LiveSession, SttMode, SttTimings } from '../lib/liveSession';
import { prepareTranscriptForLlm, PreparedTranscript } from '../lib/prepareTranscriptForLlm';
import { SttSessionOptions } from '../lib/sttOptions';
import { isSpeculativeEnabled } from '../lib/speculativePref';
import { recordSkipped } from '../lib/skippedLog';
import {
  createEmptySessionContext,
  isOrphanComparativeTail,
  pushUtteranceBuffer,
  sanitizeLiveAnswer,
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
  questionChanged,
  stripExperienceFooter,
  isGarbageTranscript,
} from '../lib/normalizeTranscript';
import type { SttDebugInfo } from '../components/SttDebugPanel';
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

interface LiveEntry {
  source: 'mic' | 'system';
  session: LiveSession;
}

/** Fallback debounce, если speech_final / utterance_end не пришли. */
const FINAL_FALLBACK_MS = 450;
const SPEECH_FINAL_DELAY_MS = 280;
const INCOMPLETE_RETRY_MS = 700;
// Speculative answering: fire once the interim partial has been stable this long.
const SPECULATIVE_STABLE_MS = 350;

interface LiveTimingState {
  audioCaptureStartAt: number | null;
  speechDetectedAt: number | null;
  firstPartialTranscriptAt: number | null;
  speechEndedAt: number | null;
  finalTranscriptionStartAt: number | null;
  finalTranscriptionEndAt: number | null;
  glossaryCorrectionEndAt: number | null;
  llmRequestStartAt: number | null;
  llmFirstTokenAt: number | null;
  llmEndAt: number | null;
}

// On-device STT (even large-v3 on CPU) finalises within a few seconds. A client
// fallback latency far above this is an anchoring artifact (silence gaps,
// filtered hallucinations), not a real measurement — drop it instead of logging
// a misleading 30–70s value.
const MAX_PLAUSIBLE_STT_LATENCY_MS = 20000;

function sanitizeSttLatencyMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value > MAX_PLAUSIBLE_STT_LATENCY_MS) return undefined;
  return value;
}

function emptyTimingState(): LiveTimingState {
  return {
    audioCaptureStartAt: null,
    speechDetectedAt: null,
    firstPartialTranscriptAt: null,
    speechEndedAt: null,
    finalTranscriptionStartAt: null,
    finalTranscriptionEndAt: null,
    glossaryCorrectionEndAt: null,
    llmRequestStartAt: null,
    llmFirstTokenAt: null,
    llmEndAt: null,
  };
}

function buildTimingDebug(t: LiveTimingState): Partial<SttDebugInfo> {
  const anchor = t.audioCaptureStartAt ?? t.speechDetectedAt;
  const llmStart = t.llmRequestStartAt;
  return {
    timeToFirstPartialMs:
      t.firstPartialTranscriptAt != null && anchor != null
        ? t.firstPartialTranscriptAt - anchor
        : undefined,
    finalTranscriptionMs:
      t.finalTranscriptionStartAt != null && t.finalTranscriptionEndAt != null
        ? t.finalTranscriptionEndAt - t.finalTranscriptionStartAt
        : undefined,
    correctionMs:
      t.finalTranscriptionEndAt != null && t.glossaryCorrectionEndAt != null
        ? t.glossaryCorrectionEndAt - t.finalTranscriptionEndAt
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
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [error, setError] = useState('');
  const [sttDebug, setSttDebug] = useState<SttDebugInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const sttDebugRef = useRef<SttDebugInfo | null>(null);

  useEffect(() => {
    sttDebugRef.current = sttDebug;
  }, [sttDebug]);

  const sessionRef = useRef<string | null>(null);
  const liveRef = useRef<LiveEntry[]>([]);
  const cancelStreamRef = useRef<(() => void) | null>(null);
  const streamLockRef = useRef(false);
  const lastQuestionRef = useRef('');
  const lastCompletedRef = useRef('');
  const streamGenRef = useRef(0);
  const finalPartsRef = useRef<string[]>([]);
  const finalDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speculativeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttMetaRef = useRef<{
    engine: string;
    model: string;
    partialModel?: string;
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

  const patchSttDebug = useCallback((patch: Partial<SttDebugInfo>) => {
    setSttDebug((prev) => ({
      rawTranscript: '',
      glossaryCorrected: '',
      intentCorrected: '',
      correctedTranscript: '',
      corrections: [],
      intentCorrections: [],
      ...prev,
      ...buildTimingDebug(timingRef.current),
      ...patch,
    }));
  }, []);

  const syncDebugFromPrepared = useCallback(
    (prepared: PreparedTranscript, extra: Partial<SttDebugInfo>) => {
      patchSttDebug({
        rawTranscript: prepared.rawTranscript,
        glossaryCorrected: prepared.corrected,
        intentCorrected: prepared.intentCorrected,
        correctedTranscript: prepared.intentCorrected,
        correctedFinalTranscript: prepared.corrected,
        resolvedQuestion: prepared.resolvedQuestion,
        previousTopic: sessionContextRef.current.lastCanonicalTopic,
        currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
        isFollowUp: prepared.followUp.isFollowUp,
        usedPreviousContext: prepared.followUp.usedPreviousContext,
        followUpReason: prepared.followUp.reason,
        hallucinationRisk: prepared.followUp.hallucinationRisk,
        resumeFactSource: prepared.answerStrategy.resumeContextLevel,
        corrections: prepared.correction.corrections,
        intentCorrections: prepared.intent.intentCorrections,
        intentConfidence:
          prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
        intentReason: prepared.intent.reason,
        ambiguity: prepared.intent.ambiguity,
        questionIntent: prepared.answerStrategy.questionIntent,
        answerStrategy: prepared.answerStrategy.answerStrategy,
        resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
        resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
        resumeContextReason: prepared.answerStrategy.resumeContextReason,
        sttEngine: sttMetaRef.current?.engine,
        sttModel: sttMetaRef.current?.model,
        partialSttModel: sttMetaRef.current?.partialModel,
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
    sessionRef.current = null;
    setSessionId(null);
    if (!sid) return;
    try {
      if (hasSessionContentRef.current) {
        await api.endSession(sid);
      } else {
        await api.deleteSession(sid);
      }
    } catch {
      // ignore
    }
  }, []);

  const removeStream = useCallback(
    (source: 'mic' | 'system', msg?: string) => {
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
    [endInterviewSession],
  );

  const runStream = useCallback((prepared: PreparedTranscript) => {
    const q = prepared.resolvedQuestion.trim();
    if (q.length < 3) return;
    streamLockRef.current = true;
    lastQuestionRef.current = q;
    const gen = ++streamGenRef.current;
    const answerStartedAt = performance.now();
    timingRef.current.llmRequestStartAt = answerStartedAt;
    const meta = sttMetaRef.current;

    setSttDebug({
      rawTranscript: prepared.rawTranscript,
      glossaryCorrected: prepared.corrected,
      intentCorrected: prepared.intentCorrected,
      correctedTranscript: prepared.intentCorrected,
      finalTranscript: prepared.rawTranscript,
      correctedFinalTranscript: prepared.corrected,
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
      corrections: prepared.correction.corrections,
      intentCorrections: prepared.intent.intentCorrections,
      intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
      intentReason: prepared.intent.reason,
      ambiguity: prepared.intent.ambiguity,
      questionIntent: prepared.answerStrategy.questionIntent,
      answerStrategy: prepared.answerStrategy.answerStrategy,
      resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
      resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
      resumeContextReason: prepared.answerStrategy.resumeContextReason,
      sttEngine: meta?.engine,
      sttModel: meta?.model,
      partialSttModel: meta?.partialModel,
      sampleRate: meta?.sampleRate,
      ...buildTimingDebug(timingRef.current),
      // Prefer the server-measured speech-end -> final latency (the desktop can
      // only see when the final *arrived*, not when speech ended on the server).
      // The client fallback can be anchored to a stale/earlier moment after
      // silence or filtered hallucinations, producing absurd values (30s, 70s).
      // Real STT is a second or two, so discard an implausible fallback rather
      // than record a misleading number.
      timeToFinalMs:
        serverTimingsRef.current?.speechEndToFinalMs ??
        (questionFinalAtRef.current != null
          ? sanitizeSttLatencyMs(answerStartedAt - questionFinalAtRef.current)
          : undefined),
      finalTranscriptionMs:
        serverTimingsRef.current?.finalInferenceMs ?? buildTimingDebug(timingRef.current).finalTranscriptionMs,
      timeToFirstPartialMs:
        serverTimingsRef.current?.firstPartialMs ??
        buildTimingDebug(timingRef.current).timeToFirstPartialMs,
    });

    setStreaming(true);
    setSuggestLoading(true);
    setStreamText('');
    setCurrentQuestion(q);
    setError('');

    const pushHistory = (
      text: string,
      answerId?: string,
      pipeline?: CopilotAnswerPipeline,
      latency?: ExchangeLatency,
    ) => {
      hasSessionContentRef.current = true;
      setAnswerHistory((prev) => [
        ...prev,
        {
          id: answerId || crypto.randomUUID(),
          question: q,
          spoken: text,
          ts: Date.now(),
          source: 'live',
          pipeline,
          latency,
        },
      ]);
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
            timingRef.current.llmFirstTokenAt = performance.now();
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
                    timeToFirstPartialMs: prev.timeToFirstPartialMs,
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
        onDone: (spoken: string, answerId?: string) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          timingRef.current.llmEndAt = performance.now();
          lastCompletedRef.current = q;
          const text = sanitizeLiveAnswer(stripExperienceFooter(spoken || accumulated));
          const debugSnapshot = sttDebugRef.current;
          const llmLatencyMs = performance.now() - answerStartedAt;
          const pipeline = buildPipelineFromPrepared(prepared, {
            previousTopic: sessionContextRef.current.lastCanonicalTopic,
            llmCorrectedTranscript: debugSnapshot?.llmCorrectedTranscript,
            timeToAnswerMs: debugSnapshot?.timeToAnswerMs,
            timeToFinalMs: debugSnapshot?.timeToFinalMs,
          });
          const latency = buildExchangeLatency(debugSnapshot?.timeToFinalMs, llmLatencyMs);
          sessionContextRef.current = updateSessionContextAfterAnswer(sessionContextRef.current, {
            rawQuestion: prepared.rawTranscript,
            correctedQuestion: prepared.corrected,
            intentCorrectedQuestion: prepared.intentCorrected,
            resolvedQuestion: prepared.resolvedQuestion,
            questionIntent: prepared.answerStrategy.questionIntent,
            canonicalTopic: prepared.canonicalTopic,
            answerSummary: text,
            resetPreviousTopic: prepared.followUp.resetPreviousTopic,
          });
          pushHistory(text, answerId, pipeline, latency);
        },
        onError: (msg) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          if (accumulated) {
            lastCompletedRef.current = q;
            const text = sanitizeLiveAnswer(stripExperienceFooter(accumulated));
            const debugSnapshot = sttDebugRef.current;
            const llmLatencyMs = performance.now() - answerStartedAt;
            const pipeline = buildPipelineFromPrepared(prepared, {
              previousTopic: sessionContextRef.current.lastCanonicalTopic,
              llmCorrectedTranscript: debugSnapshot?.llmCorrectedTranscript,
              timeToFinalMs: debugSnapshot?.timeToFinalMs,
            });
            const latency = buildExchangeLatency(debugSnapshot?.timeToFinalMs, llmLatencyMs);
            pushHistory(text, undefined, pipeline, latency);
          } else {
            setStreamText('');
            setCurrentQuestion('');
            setError(msg);
          }
        },
      },
      {
        sessionId: sessionRef.current ?? undefined,
        rawQuestion: prepared.rawTranscript,
        glossaryCorrected: prepared.corrected,
        intentCorrected: prepared.intentCorrected,
        resolvedQuestion: prepared.resolvedQuestion,
        previousTopic: sessionContextRef.current.lastCanonicalTopic,
        isFollowUp: prepared.followUp.isFollowUp,
        usedPreviousContext: prepared.followUp.usedPreviousContext,
        followUpReason: prepared.followUp.reason,
        currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
        ambiguity: prepared.intent.ambiguity,
        corrections: prepared.correction.corrections,
        intentCorrections: prepared.intent.intentCorrections,
        intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
        intentReason: prepared.intent.reason,
        needsLlmCorrection: prepared.correction.needsLlmCorrection,
        questionIntent: prepared.answerStrategy.questionIntent,
        answerStrategy: prepared.answerStrategy.answerStrategy,
        resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
        resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
        resumeContextReason: prepared.answerStrategy.resumeContextReason,
        suggestUnclearPrefix: prepared.answerStrategy.suggestUnclearPrefix,
        onMeta: (correctionMeta) => {
          setSttDebug((prev) => {
            if (!prev) return prev;
            const next = { ...prev };
            const llmText = correctionMeta.llm_corrected?.trim();
            if (llmText) {
              next.llmCorrectedTranscript = llmText;
              next.intentCorrected = llmText;
            }
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
        },
      },
    );
  }, []);

  const requestSuggestion = useCallback(
    (rawMerged: string) => {
      const correctionStartedAt = performance.now();
      const prepared = prepareTranscriptForLlm(rawMerged, sessionContextRef.current);
      timingRef.current.glossaryCorrectionEndAt = performance.now();
      const q = prepared.resolvedQuestion.trim();
      const raw = rawMerged.trim();

      if (isGarbageTranscript(q) && isGarbageTranscript(raw)) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Waiting for complete question…',
          interimTranscript: undefined,
          finalTranscript: raw,
          correctedFinalTranscript: prepared.corrected,
          correctionMs: timingRef.current.glossaryCorrectionEndAt - correctionStartedAt,
        });
        return;
      }

      if (q.length < 6 && raw.length < 6) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Waiting for complete question…',
        });
        return;
      }
      if (!looksLikeQuestion(q) && !looksLikeQuestion(raw)) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'Waiting for complete question…',
        });
        return;
      }
      if (isOrphanComparativeTail(raw)) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'orphan comparative tail',
        });
        return;
      }

      if (q === lastCompletedRef.current) return;
      if (streamLockRef.current && q === lastQuestionRef.current) return;

      if (streamLockRef.current) {
        if (!questionChanged(lastQuestionRef.current, q)) return;
        cancelStreamRef.current?.();
        streamGenRef.current += 1;
        streamLockRef.current = false;
      }

      incompleteRetryRef.current = 0;
      runStream(prepared);
    },
    [runStream, syncDebugFromPrepared],
  );

  const clearSpeculative = useCallback(() => {
    if (speculativeTimerRef.current) {
      clearTimeout(speculativeTimerRef.current);
      speculativeTimerRef.current = null;
    }
  }, []);

  // Speculative answering: start the LLM on a stable, question-like partial. The
  // existing requestSuggestion handles all gating + cancel/restart when the final
  // arrives, so a matching final keeps the running stream and a different final
  // restarts it. Bounded to one in-flight speculation (skips while a stream runs).
  const trySpeculative = useCallback(
    (text: string) => {
      if (!isSpeculativeEnabled()) return;
      if (streamLockRef.current) return;
      const t = text.trim();
      if (t.length < 8) return;
      if (isGarbageTranscript(t) || !looksLikeQuestion(t)) return;
      questionFinalAtRef.current = performance.now();
      requestSuggestion(t);
    },
    [requestSuggestion],
  );

  const cancelPendingQuestion = useCallback(() => {
    if (finalDebounceRef.current) {
      clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = null;
    }
    if (speculativeTimerRef.current) {
      clearTimeout(speculativeTimerRef.current);
      speculativeTimerRef.current = null;
    }
    finalPartsRef.current = [];
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
        requestSuggestion(mergedForRetry);
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
    commitCorrectedToLine(toEvaluate, preparedPreview.corrected, utteranceSpeaker);
    syncDebugFromPrepared(preparedPreview, {
      answerTriggered: undefined,
      waitReason: undefined,
      finalTranscript: toEvaluate,
      correctedFinalTranscript: preparedPreview.corrected,
    });
    requestSuggestion(toEvaluate);
  }, [commitCorrectedToLine, requestSuggestion, syncDebugFromPrepared]);

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
    (text: string, speaker: Speaker) => {
      if (!speechStartedAtRef.current) speechStartedAtRef.current = performance.now();
      lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
      recordUtterance(text, true, speaker);
      pushFinalPart(text);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = setTimeout(flushQuestion, SPEECH_FINAL_DELAY_MS);
    },
    [flushQuestion, pushFinalPart, recordUtterance],
  );

  const scheduleFinalFallback = useCallback(
    (text: string, speaker: Speaker) => {
      lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
      recordUtterance(text, true, speaker);
      pushFinalPart(text);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = setTimeout(flushQuestion, FINAL_FALLBACK_MS);
    },
    [flushQuestion, pushFinalPart, recordUtterance],
  );

  const appendLine = useCallback((text: string, isFinal: boolean, speaker: Speaker) => {
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
    async (sources: LiveSources, stt: SttSessionOptions = {}) => {
      const mode: SttMode = stt.mode ?? 'stable';
      const language = stt.language ?? 'ru';
      setError('');
      setLines([]);
      setAnswerHistory([]);
      setCurrentQuestion('');
      setStreamText('');
      setSttDebug(null);
      lastQuestionRef.current = '';
      lastCompletedRef.current = '';
      finalPartsRef.current = [];
      speechStartedAtRef.current = null;
      questionFinalAtRef.current = null;
      timingRef.current = emptyTimingState();
      sttMetaRef.current = null;
      sessionContextRef.current = createEmptySessionContext();
      utteranceBufferRef.current = [];
      incompleteRetryRef.current = 0;
      streamLockRef.current = false;
      hasSessionContentRef.current = false;
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      clearSpeculative();
      liveRef.current.forEach((e) => e.session.stop());
      liveRef.current = [];

      try {
        const s = await api.createSession('interview');
        sessionRef.current = s.id;
        setSessionId(s.id);
        setSessionStartedAt(Date.now());
      } catch {
        sessionRef.current = null;
      }

      const triggerSpeaker: Speaker = sources.system ? 'other' : 'me';
      triggerSpeakerRef.current = triggerSpeaker;
      liveSourcesRef.current = { ...sources };
      timingRef.current.audioCaptureStartAt = performance.now();

      const startOne = async (source: 'mic' | 'system', speaker: Speaker) => {
        const label = source === 'mic' ? 'Микрофон' : 'Системный звук';
        const live = await startLiveSession(
          {
            onTranscript: (text, isFinal, speechFinal) => {
              const trimmed = text.trim();
              if (!trimmed) return;

              if (!isFinal) {
                if (!timingRef.current.speechDetectedAt) {
                  timingRef.current.speechDetectedAt = performance.now();
                }
                if (!timingRef.current.firstPartialTranscriptAt) {
                  timingRef.current.firstPartialTranscriptAt = performance.now();
                }
                appendLine(trimmed, false, speaker);
                patchSttDebug({
                  interimTranscript: trimmed,
                  waitReason: undefined,
                });
                // Speculatively answer once the partial has been stable a moment
                // (only for the speaker we answer). No-op unless the user opted in.
                if (speaker === triggerSpeakerRef.current) {
                  if (speculativeTimerRef.current) clearTimeout(speculativeTimerRef.current);
                  const snapshot = trimmed;
                  speculativeTimerRef.current = setTimeout(
                    () => trySpeculative(snapshot),
                    SPECULATIVE_STABLE_MS,
                  );
                }
                return;
              }

              clearSpeculative();
              timingRef.current.finalTranscriptionStartAt =
                timingRef.current.finalTranscriptionStartAt ?? performance.now();
              timingRef.current.finalTranscriptionEndAt = performance.now();
              timingRef.current.speechEndedAt = performance.now();
              appendLine(trimmed, true, speaker);
              patchSttDebug({
                interimTranscript: undefined,
                finalTranscript: trimmed,
                rawTranscript: trimmed,
                waitReason: undefined,
              });

              if (speechFinal) {
                scheduleSpeechFinal(trimmed, speaker);
              } else if (trimmed.length > 2) {
                scheduleFinalFallback(trimmed, speaker);
              }
            },
            onSpeechStarted: () => {
              if (!timingRef.current.speechDetectedAt) {
                timingRef.current.speechDetectedAt = performance.now();
              }
              timingRef.current.finalTranscriptionStartAt = null;
              timingRef.current.finalTranscriptionEndAt = null;
            },
            onReady: (info) => {
              sttMetaRef.current = {
                engine: info.engine,
                model: info.model,
                partialModel: info.partialModel,
                sampleRate: info.sampleRate,
              };
            },
            onUtteranceEnd: (timings) => {
              lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
              if (timings) serverTimingsRef.current = timings;
              flushQuestion();
            },
            onLowQuality: (text, _reason) => {
              // Server quality gate rejected this utterance — keep listening,
              // never call the LLM with garbage. (Server logs the reason.)
              serverTimingsRef.current = null;
              recordSkipped(_reason, text);
              patchSttDebug({
                interimTranscript: undefined,
                finalTranscript: text,
                waitReason: 'Waiting for complete question…',
              });
            },
            onTurnResumed: () => {
              lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
              cancelPendingQuestion();
              cancelStreamRef.current?.();
              streamGenRef.current += 1;
              streamLockRef.current = false;
            },
            onError: (msg) => removeStream(source, `${label}: ${msg}`),
            onClose: () => {
              if (liveRef.current.some((e) => e.source === source)) {
                removeStream(
                  source,
                  `${label}: соединение прервано. Проверьте, что backend запущен и модель Whisper загружена.`,
                );
              }
            },
          },
          {
            sessionId: sessionRef.current ?? undefined,
            speaker,
            source,
            mode,
            language,
            engine: stt.engine,
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
          setError('Не удалось запустить ни один источник звука');
          await endInterviewSession();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось запустить сессию');
        liveRef.current.forEach((e) => e.session.stop());
        liveRef.current = [];
        await endInterviewSession();
      }
    },
    [appendLine, cancelPendingQuestion, clearSpeculative, endInterviewSession, flushQuestion, patchSttDebug, removeStream, scheduleFinalFallback, scheduleSpeechFinal, trySpeculative],
  );

  const stop = useCallback(async () => {
    if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
    clearSpeculative();
    streamGenRef.current += 1;
    cancelStreamRef.current?.();
    streamLockRef.current = false;
    setStreaming(false);
    const hadStreams = liveRef.current.length > 0;
    liveRef.current.forEach((e) => e.session.stop());
    liveRef.current = [];
    setActive(false);
    sessionContextRef.current = createEmptySessionContext();
    if (hadStreams) await endInterviewSession();
  }, [clearSpeculative, endInterviewSession]);

  const updateAnswerEntry = useCallback((id: string, spoken: string) => {
    setAnswerHistory((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, spoken, ts: Date.now() } : entry)),
    );
  }, []);

  const setLiveAnswerText = useCallback((text: string) => {
    setStreamText(text);
  }, []);

  return {
    active,
    lines,
    answerHistory,
    currentQuestion,
    streamText,
    streaming,
    suggestLoading,
    error,
    sttDebug,
    sessionId,
    sessionStartedAt,
    updateAnswerEntry,
    setLiveAnswerText,
    start,
    stop,
  };
}
