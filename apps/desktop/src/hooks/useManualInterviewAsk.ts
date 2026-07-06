import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createEmptySessionContext,
  sanitizeLiveAnswer,
  updateSessionContextAfterAnswer,
  type InterviewSessionContext,
} from '@interview/shared';
import type { SttDebugInfo } from '../components/SttDebugPanel';
import { api } from '../lib/api';
import { buildExchangeLatency, buildPipelineFromPrepared } from '../lib/interviewSessionExport';
import type { CopilotAnswerEntry } from '../lib/interviewSessionExport';
import {
  patchSttDebugFromMeta,
  sttDebugFromPrepared,
  streamOptsFromPrepared,
} from '../lib/interviewStreamHelpers';
import { prepareTranscriptForLlm } from '../lib/prepareTranscriptForLlm';

interface UseManualInterviewAskOptions {
  hasSession: boolean;
  onSessionStarted?: () => void;
}

export function useManualInterviewAsk(options: UseManualInterviewAskOptions) {
  const [question, setQuestion] = useState('');
  const [manualStream, setManualStream] = useState('');
  const [manualCurrentQuestion, setManualCurrentQuestion] = useState('');
  const [manualHistory, setManualHistory] = useState<CopilotAnswerEntry[]>([]);
  const [manualDebug, setManualDebug] = useState<SttDebugInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualError, setManualError] = useState('');

  const sessionContextRef = useRef<InterviewSessionContext>(createEmptySessionContext());
  const debugRef = useRef<SttDebugInfo | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    debugRef.current = manualDebug;
  }, [manualDebug]);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
  }, []);

  // Анмаунт посреди стрима: обрываем SSE, иначе запрос дожёвывает токены впустую.
  useEffect(() => cancel, [cancel]);

  const ask = useCallback(() => {
    const input = question.trim();
    if (!input) return;

    if (!options.hasSession) {
      options.onSessionStarted?.();
    }

    cancelRef.current?.();

    const prepared = prepareTranscriptForLlm(input, sessionContextRef.current);
    setLoading(true);
    setManualError('');
    setManualStream('');
    setManualCurrentQuestion(prepared.resolvedQuestion);
    setManualDebug(sttDebugFromPrepared(prepared, sessionContextRef.current.lastCanonicalTopic));

    let text = '';
    const answerStartedAt = performance.now();

    cancelRef.current = api.streamInterview(
      prepared.resolvedQuestion,
      {
        onChunk: (chunk) => {
          text += chunk;
          setManualStream(sanitizeLiveAnswer(text));
          setLoading(false);
        },
        onDone: (spoken) => {
          const cleaned = sanitizeLiveAnswer(spoken);
          const llmLatencyMs = performance.now() - answerStartedAt;
          const pipeline = buildPipelineFromPrepared(prepared, {
            previousTopic: sessionContextRef.current.lastCanonicalTopic,
            llmCorrectedTranscript: debugRef.current?.llmCorrectedTranscript,
          });

          sessionContextRef.current = updateSessionContextAfterAnswer(sessionContextRef.current, {
            rawQuestion: prepared.rawTranscript,
            correctedQuestion: prepared.corrected,
            intentCorrectedQuestion: prepared.intentCorrected,
            resolvedQuestion: prepared.resolvedQuestion,
            questionIntent: prepared.answerStrategy.questionIntent,
            canonicalTopic: prepared.canonicalTopic,
            answerSummary: cleaned,
            resetPreviousTopic: prepared.followUp.resetPreviousTopic,
          });

          setManualHistory((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              question: prepared.resolvedQuestion,
              spoken: cleaned,
              ts: Date.now(),
              source: 'manual',
              pipeline,
              latency: buildExchangeLatency(null, llmLatencyMs),
            },
          ]);

          setManualStream('');
          setManualCurrentQuestion('');
          setLoading(false);
          setQuestion('');
        },
        onError: (msg) => {
          setManualStream('');
          setManualCurrentQuestion('');
          setManualError(msg);
          setLoading(false);
        },
      },
      {
        ...streamOptsFromPrepared(prepared, sessionContextRef.current.lastCanonicalTopic),
        onMeta: (meta) => {
          setManualDebug((prev) => patchSttDebugFromMeta(prev, meta));
        },
      },
    );
  }, [options, question]);

  return {
    question,
    setQuestion,
    manualStream,
    setManualStream,
    manualCurrentQuestion,
    manualHistory,
    setManualHistory,
    manualDebug,
    loading,
    manualError,
    setManualError,
    ask,
    cancel,
  };
}
