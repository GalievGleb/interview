import { useCallback, useRef, useState } from 'react';
import { api, InterviewAnswer } from '../lib/api';
import { startLiveSession, LiveSession, SttMode } from '../lib/liveSession';
import { prepareTranscriptForLlm, PreparedTranscript } from '../lib/prepareTranscriptForLlm';
import { SttSessionOptions } from '../lib/sttOptions';
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

export interface LiveSources {
  mic: boolean;
  system: boolean;
}

interface LiveEntry {
  source: 'mic' | 'system';
  session: LiveSession;
}

/** Fallback debounce, если speech_final / utterance_end не пришли. */
const FINAL_FALLBACK_MS = 400;
const SPEECH_FINAL_DELAY_MS = 120;

export function useLiveCopilot() {
  const [active, setActive] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [suggestion, setSuggestion] = useState<InterviewAnswer | null>(null);
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
    const q = prepared.intentCorrected.trim();
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
      corrections: prepared.correction.corrections,
      intentCorrections: prepared.intent.intentCorrections,
      intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
      intentReason: prepared.intent.reason,
      ambiguity: prepared.intent.ambiguity,
      sttEngine: meta?.engine,
      sttModel: meta?.model,
      sampleRate: meta?.sampleRate,
      timeToFinalMs:
        questionFinalAtRef.current != null ? answerStartedAt - questionFinalAtRef.current : undefined,
    });

    setStreaming(true);
    setSuggestLoading(true);
    setStreamText('');
    setSuggestion(null);
    setError('');

    let accumulated = '';
    cancelStreamRef.current = api.streamInterview(
      q,
      {
        onChunk: (chunk) => {
          if (gen !== streamGenRef.current) return;
          accumulated += chunk;
          setStreamText(accumulated);
          setSuggestLoading(false);
        },
        onDone: (spoken) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          lastCompletedRef.current = q;
          const text = stripExperienceFooter(spoken || accumulated);
          setStreamText(text);
          setSuggestion({
            id: '',
            short: text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '),
            spoken: text,
            detailed: '',
            english: '',
            risk: '',
          });
        },
        onError: (msg) => {
          if (gen !== streamGenRef.current) return;
          streamLockRef.current = false;
          setStreaming(false);
          setSuggestLoading(false);
          if (accumulated) {
            lastCompletedRef.current = q;
            const text = stripExperienceFooter(accumulated);
            setStreamText(text);
            setSuggestion({
              id: '',
              short: text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '),
              spoken: text,
              detailed: '',
              english: '',
              risk: '',
            });
          } else {
            setError(msg);
          }
        },
      },
      {
        sessionId: sessionRef.current ?? undefined,
        rawQuestion: prepared.rawTranscript,
        glossaryCorrected: prepared.corrected,
        intentCorrected: prepared.intentCorrected,
        ambiguity: prepared.intent.ambiguity,
        corrections: prepared.correction.corrections,
        intentCorrections: prepared.intent.intentCorrections,
        intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
        intentReason: prepared.intent.reason,
        needsLlmCorrection: prepared.correction.needsLlmCorrection,
        onFirstChunk: () => {
          setSttDebug((prev) =>
            prev ? { ...prev, timeToAnswerMs: performance.now() - answerStartedAt } : prev,
          );
        },
        onMeta: (correctionMeta) => {
          const llmText = correctionMeta.llm_corrected?.trim();
          if (llmText) {
            setSttDebug((prev) =>
              prev ? { ...prev, llmCorrectedTranscript: llmText, intentCorrected: llmText } : prev,
            );
          }
        },
      },
    );
  }, []);

  const requestSuggestion = useCallback(
    (rawMerged: string) => {
      const prepared = prepareTranscriptForLlm(rawMerged);
      const q = prepared.intentCorrected;
      if (q.length < 8) return;
      if (!looksLikeQuestion(q) && q.length < 20) return;

      if (q === lastCompletedRef.current) return;
      if (streamLockRef.current && q === lastQuestionRef.current) return;

      if (streamLockRef.current) {
        if (!questionChanged(lastQuestionRef.current, q)) return;
        cancelStreamRef.current?.();
        streamGenRef.current += 1;
        streamLockRef.current = false;
      }

      runStream(prepared);
    },
    [runStream],
  );

  const cancelPendingQuestion = useCallback(() => {
    if (finalDebounceRef.current) {
      clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = null;
    }
    finalPartsRef.current = [];
  }, []);

  const flushQuestion = useCallback(() => {
    if (finalDebounceRef.current) {
      clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = null;
    }
    const merged = mergeRawParts(finalPartsRef.current);
    finalPartsRef.current = [];
    questionFinalAtRef.current = performance.now();
    if (merged) requestSuggestion(merged);
  }, [requestSuggestion]);

  const pushFinalPart = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = finalPartsRef.current[finalPartsRef.current.length - 1];
    if (last === trimmed) return;
    finalPartsRef.current.push(trimmed);
    if (finalPartsRef.current.length > 2) {
      finalPartsRef.current = finalPartsRef.current.slice(-2);
    }
  }, []);

  const scheduleSpeechFinal = useCallback(
    (text: string) => {
      if (!speechStartedAtRef.current) speechStartedAtRef.current = performance.now();
      pushFinalPart(text);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = setTimeout(flushQuestion, SPEECH_FINAL_DELAY_MS);
    },
    [flushQuestion, pushFinalPart],
  );

  const scheduleFinalFallback = useCallback(
    (text: string) => {
      pushFinalPart(text);
      if (finalDebounceRef.current) clearTimeout(finalDebounceRef.current);
      finalDebounceRef.current = setTimeout(flushQuestion, FINAL_FALLBACK_MS);
    },
    [flushQuestion, pushFinalPart],
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
      setSuggestion(null);
      setStreamText('');
      setSttDebug(null);
      lastQuestionRef.current = '';
      lastCompletedRef.current = '';
      finalPartsRef.current = [];
      speechStartedAtRef.current = null;
      questionFinalAtRef.current = null;
      sttMetaRef.current = null;
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

      const triggerSpeaker: Speaker = sources.system && !sources.mic ? 'other' : 'me';

      const startOne = async (source: 'mic' | 'system', speaker: Speaker) => {
        const label = source === 'mic' ? 'Микрофон' : 'Системный звук';
        const live = await startLiveSession(
          {
            onTranscript: (text, isFinal, speechFinal) => {
              appendLine(text, isFinal, speaker);
              if (speaker !== triggerSpeaker) return;
              const trimmed = text.trim();
              if (!trimmed) return;
              if (speechFinal) {
                scheduleSpeechFinal(trimmed);
              } else if (isFinal && trimmed.length > 3) {
                scheduleFinalFallback(trimmed);
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
              if (speaker !== triggerSpeaker) return;
              flushQuestion();
            },
            onTurnResumed: () => {
              if (speaker !== triggerSpeaker) return;
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
    if (hadStreams) await endInterviewSession();
  }, [endInterviewSession]);

  return {
    active,
    lines,
    suggestion,
    streamText,
    streaming,
    suggestLoading,
    error,
    sttDebug,
    start,
    stop,
  };
}
