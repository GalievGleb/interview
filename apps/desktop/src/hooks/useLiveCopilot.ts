import { useCallback, useRef, useState } from 'react';
import { api } from '../lib/api';
import { startLiveSession, LiveSession, SttMode } from '../lib/liveSession';
import { prepareTranscriptForLlm, PreparedTranscript } from '../lib/prepareTranscriptForLlm';
import { SttSessionOptions } from '../lib/sttOptions';
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
} from '../lib/normalizeTranscript';
import type { SttDebugInfo } from '../components/SttDebugPanel';

export type Speaker = 'me' | 'other';

export interface TranscriptLine {
  text: string;
  normalized?: string;
  isFinal: boolean;
  speaker: Speaker;
}

export type { SttDebugInfo };

export interface CopilotAnswerEntry {
  id: string;
  question: string;
  spoken: string;
  ts: number;
}

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

  const sessionRef = useRef<string | null>(null);
  const liveRef = useRef<LiveEntry[]>([]);
  const cancelStreamRef = useRef<(() => void) | null>(null);
  const streamLockRef = useRef(false);
  const lastQuestionRef = useRef('');
  const lastCompletedRef = useRef('');
  const streamGenRef = useRef(0);
  const finalPartsRef = useRef<string[]>([]);
  const finalDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttMetaRef = useRef<{ engine: string; model: string; sampleRate: number } | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const questionFinalAtRef = useRef<number | null>(null);
  const sessionContextRef = useRef<InterviewSessionContext>(createEmptySessionContext());
  const utteranceBufferRef = useRef<UtteranceBufferEntry[]>([]);
  const triggerSpeakerRef = useRef<Speaker>('other');
  const liveSourcesRef = useRef<LiveSources>({ mic: true, system: false });
  const incompleteRetryRef = useRef(0);
  const lastFlushSpeakerRef = useRef<UtteranceSpeaker>('interviewer');

  const patchSttDebug = useCallback((patch: Partial<SttDebugInfo>) => {
    setSttDebug((prev) => ({
      rawTranscript: '',
      glossaryCorrected: '',
      intentCorrected: '',
      correctedTranscript: '',
      corrections: [],
      intentCorrections: [],
      ...prev,
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
        sampleRate: sttMetaRef.current?.sampleRate,
        ...extra,
      });
    },
    [patchSttDebug],
  );

  const endInterviewSession = useCallback(async () => {
    const sid = sessionRef.current;
    sessionRef.current = null;
    if (sid) {
      try {
        await api.endSession(sid);
      } catch {
        // ignore
      }
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
    const meta = sttMetaRef.current;

    setSttDebug({
      rawTranscript: prepared.rawTranscript,
      glossaryCorrected: prepared.corrected,
      intentCorrected: prepared.intentCorrected,
      correctedTranscript: prepared.intentCorrected,
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
      sampleRate: meta?.sampleRate,
      timeToFinalMs:
        questionFinalAtRef.current != null ? answerStartedAt - questionFinalAtRef.current : undefined,
    });

    setStreaming(true);
    setSuggestLoading(true);
    setStreamText('');
    setCurrentQuestion(q);
    setError('');

    const pushHistory = (text: string, answerId?: string) => {
      setAnswerHistory((prev) => [
        ...prev,
        {
          id: answerId || crypto.randomUUID(),
          question: q,
          spoken: text,
          ts: Date.now(),
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
            setSttDebug((prev) =>
              prev ? { ...prev, timeToAnswerMs: performance.now() - answerStartedAt } : prev,
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
          lastCompletedRef.current = q;
          const text = sanitizeLiveAnswer(stripExperienceFooter(spoken || accumulated));
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
          pushHistory(text, answerId);
        },
        onError: (msg) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          if (accumulated) {
            lastCompletedRef.current = q;
            const text = sanitizeLiveAnswer(stripExperienceFooter(accumulated));
            pushHistory(text);
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
      const prepared = prepareTranscriptForLlm(rawMerged, sessionContextRef.current);
      const q = prepared.resolvedQuestion.trim();
      const raw = rawMerged.trim();

      if (q.length < 6 && raw.length < 6) {
        syncDebugFromPrepared(prepared, { answerTriggered: false, waitReason: 'question too short' });
        return;
      }
      if (!looksLikeQuestion(q) && !looksLikeQuestion(raw)) {
        syncDebugFromPrepared(prepared, {
          answerTriggered: false,
          waitReason: 'not recognized as question — speak the full question',
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

  const cancelPendingQuestion = useCallback(() => {
    if (finalDebounceRef.current) {
      clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = null;
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
    syncDebugFromPrepared(preparedPreview, { answerTriggered: undefined, waitReason: undefined });
    requestSuggestion(toEvaluate);
  }, [requestSuggestion, syncDebugFromPrepared]);

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
      sttMetaRef.current = null;
      sessionContextRef.current = createEmptySessionContext();
      utteranceBufferRef.current = [];
      incompleteRetryRef.current = 0;
      streamLockRef.current = false;
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      liveRef.current.forEach((e) => e.session.stop());
      liveRef.current = [];

      try {
        const s = await api.createSession('interview');
        sessionRef.current = s.id;
      } catch {
        sessionRef.current = null;
      }

      const triggerSpeaker: Speaker = sources.system ? 'other' : 'me';
      triggerSpeakerRef.current = triggerSpeaker;
      liveSourcesRef.current = { ...sources };

      const startOne = async (source: 'mic' | 'system', speaker: Speaker) => {
        const label = source === 'mic' ? 'Микрофон' : 'Системный звук';
        const live = await startLiveSession(
          {
            onTranscript: (text, isFinal, speechFinal) => {
              appendLine(text, isFinal, speaker);
              const trimmed = text.trim();
              if (!trimmed) return;
              if (speechFinal) {
                scheduleSpeechFinal(trimmed, speaker);
              } else if (isFinal && trimmed.length > 2) {
                scheduleFinalFallback(trimmed, speaker);
              }
            },
            onReady: (info) => {
              sttMetaRef.current = {
                engine: info.engine,
                model: info.model,
                sampleRate: info.sampleRate,
              };
            },
            onUtteranceEnd: () => {
              lastFlushSpeakerRef.current = speaker === 'other' ? 'interviewer' : 'me';
              flushQuestion();
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
                  `${label}: соединение прервано. Проверьте Deepgram key и backend.`,
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
        if (liveRef.current.length > 0) setActive(true);
        else setError('Не удалось запустить ни один источник звука');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось запустить сессию');
        liveRef.current.forEach((e) => e.session.stop());
        liveRef.current = [];
      }
    },
    [appendLine, cancelPendingQuestion, flushQuestion, removeStream, scheduleFinalFallback, scheduleSpeechFinal],
  );

  const stop = useCallback(async () => {
    if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
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
  }, [endInterviewSession]);

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
    start,
    stop,
  };
}
