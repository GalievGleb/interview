import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  buildMockAnswerGuidance,
  startMockAnswerRecording,
  type MockAnswerRecording,
} from '../mockAnswerAudio';

interface VoiceAnswerOptions {
  language?: string;
  question: string;
  topicLabels?: string[];
}

/** One complete mock answer: native-rate mic WAV -> contextual gpt-transcribe. */
export function useVoiceAnswer(onText: (text: string) => void, options: VoiceAnswerOptions) {
  const [recording, setRecording] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState('');
  const recordingRef = useRef<MockAnswerRecording | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const onTextRef = useRef(onText);
  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const finishRef = useRef<() => Promise<string | null>>(async () => null);

  useEffect(() => {
    onTextRef.current = onText;
    optionsRef.current = options;
  }, [onText, options]);

  const stop = useCallback(() => {
    operationRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    if (mountedRef.current) {
      setRecording(false);
      setFinalizing(false);
    }
    return '';
  }, []);

  const finish = useCallback(async () => {
    const activeRecording = recordingRef.current;
    if (!activeRecording) return null;
    const operation = operationRef.current;
    recordingRef.current = null;
    setError('');
    setRecording(false);
    setFinalizing(true);
    transcriptionAbortRef.current?.abort();
    const controller = new AbortController();
    transcriptionAbortRef.current = controller;

    try {
      const wav = activeRecording.stop();
      if (wav.size <= 44) throw new Error('Речь не обнаружена в записи');
      const currentOptions = optionsRef.current;
      const guidance = buildMockAnswerGuidance(
        currentOptions.question,
        currentOptions.topicLabels ?? [],
      );
      const result = await api.transcribeMockAnswer(wav, {
        ...guidance,
        language: currentOptions.language ?? 'ru',
      }, { signal: controller.signal });
      if (operation !== operationRef.current || !mountedRef.current) return null;

      const transcript = String(result.text ?? '').trim();
      if (!transcript) {
        throw new Error(
          (currentOptions.language ?? 'ru') === 'en'
            ? 'No speech was recognized. Try recording the answer again.'
            : 'Речь не распознана. Запишите ответ ещё раз.',
        );
      }
      onTextRef.current(transcript);
      return transcript;
    } catch (cause) {
      if (operation === operationRef.current && mountedRef.current) {
        setError(cause instanceof Error ? cause.message : 'Не удалось распознать ответ');
      }
      return null;
    } finally {
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null;
      if (operation === operationRef.current && mountedRef.current) setFinalizing(false);
    }
  }, []);
  finishRef.current = finish;

  const start = useCallback(async () => {
    operationRef.current += 1;
    const operation = operationRef.current;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setError('');
    setFinalizing(false);
    try {
      const session = await startMockAnswerRecording({
        onLimitReached: () => {
          if (operation === operationRef.current) void finishRef.current();
        },
      });
      if (!mountedRef.current || operation !== operationRef.current) {
        session.cancel();
        return;
      }
      recordingRef.current = session;
      setRecording(true);
    } catch (cause) {
      if (mountedRef.current && operation === operationRef.current) {
        setError(cause instanceof Error ? cause.message : 'Нет доступа к микрофону');
      }
    }
  }, []);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      transcriptionAbortRef.current?.abort();
      transcriptionAbortRef.current = null;
      recordingRef.current?.cancel();
      recordingRef.current = null;
    };
  }, []);

  return { recording, finalizing, error, start, stop, finish, toggle };
}
