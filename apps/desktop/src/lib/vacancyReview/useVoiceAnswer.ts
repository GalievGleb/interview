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
  previewBeforeTranscription?: boolean;
}

function friendlyVoiceError(cause: unknown, language: string): string {
  const message = cause instanceof Error ? cause.message.trim() : '';
  if (/aborted|aborterror/i.test(message)) return '';
  if (/internal server error|temporarily unavailable|stt_upstream|status\s*5\d\d/i.test(message)) {
    return language === 'en'
      ? 'Speech recognition is temporarily unavailable. Your recording is saved — try again.'
      : 'Распознавание временно недоступно. Запись сохранена — попробуйте ещё раз.';
  }
  return message || (language === 'en' ? 'Could not transcribe the answer' : 'Не удалось распознать ответ');
}

/** One complete mock answer: native-rate mic WAV -> contextual gpt-transcribe. */
export function useVoiceAnswer(onText: (text: string) => void, options: VoiceAnswerOptions) {
  const [recording, setRecording] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const recordingRef = useRef<MockAnswerRecording | null>(null);
  const previewBlobRef = useRef<Blob | null>(null);
  const previewUrlRef = useRef('');
  const recordingStartedAtRef = useRef(0);
  const recordingTimerRef = useRef<number | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const onTextRef = useRef(onText);
  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const finishRef = useRef<() => Promise<string | null>>(async () => null);
  const finishRecordingRef = useRef<() => Blob | null>(() => null);

  useEffect(() => {
    onTextRef.current = onText;
    optionsRef.current = options;
  }, [onText, options]);

  const stopRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = '';
    previewBlobRef.current = null;
    if (mountedRef.current) setPreviewUrl('');
  }, []);

  const stop = useCallback(() => {
    operationRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    stopRecordingTimer();
    clearPreview();
    if (mountedRef.current) {
      setRecording(false);
      setFinalizing(false);
      setRecordingSeconds(0);
      setInputLevel(0);
    }
    return '';
  }, [clearPreview, stopRecordingTimer]);

  const finishRecording = useCallback(() => {
    const activeRecording = recordingRef.current;
    if (!activeRecording) return previewBlobRef.current;
    recordingRef.current = null;
    stopRecordingTimer();
    setRecording(false);
    setInputLevel(0);
    setError('');

    const wav = activeRecording.stop();
    if (wav.size <= 44) {
      setError(
        (optionsRef.current.language ?? 'ru') === 'en'
          ? 'No speech was detected in the recording.'
          : 'В записи не слышно речи. Попробуйте ещё раз.',
      );
      return null;
    }
    clearPreview();
    previewBlobRef.current = wav;
    const url = URL.createObjectURL(wav);
    previewUrlRef.current = url;
    setPreviewUrl(url);
    if (recordingStartedAtRef.current) {
      setRecordingSeconds(Math.max(1, Math.round((Date.now() - recordingStartedAtRef.current) / 1000)));
    }
    return wav;
  }, [clearPreview, stopRecordingTimer]);
  finishRecordingRef.current = finishRecording;

  const transcribeBlob = useCallback(async (wav: Blob) => {
    const operation = operationRef.current;
    setError('');
    setFinalizing(true);
    transcriptionAbortRef.current?.abort();
    const controller = new AbortController();
    transcriptionAbortRef.current = controller;

    try {
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
        setError(friendlyVoiceError(cause, optionsRef.current.language ?? 'ru'));
      }
      return null;
    } finally {
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null;
      if (operation === operationRef.current && mountedRef.current) setFinalizing(false);
    }
  }, []);

  const transcribePreview = useCallback(async () => {
    const wav = previewBlobRef.current;
    if (!wav) return null;
    return transcribeBlob(wav);
  }, [transcribeBlob]);

  const finish = useCallback(async () => {
    const wav = finishRecording();
    if (!wav) return null;
    return transcribeBlob(wav);
  }, [finishRecording, transcribeBlob]);
  finishRef.current = finish;

  const start = useCallback(async () => {
    operationRef.current += 1;
    const operation = operationRef.current;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    stopRecordingTimer();
    clearPreview();
    setError('');
    setFinalizing(false);
    setRecordingSeconds(0);
    setInputLevel(0);
    try {
      const session = await startMockAnswerRecording({
        onLevel: (level) => {
          if (operation === operationRef.current && mountedRef.current) setInputLevel(level);
        },
        onLimitReached: () => {
          if (operation !== operationRef.current) return;
          if (optionsRef.current.previewBeforeTranscription) finishRecordingRef.current();
          else void finishRef.current();
        },
      });
      if (!mountedRef.current || operation !== operationRef.current) {
        session.cancel();
        return;
      }
      recordingRef.current = session;
      recordingStartedAtRef.current = Date.now();
      recordingTimerRef.current = window.setInterval(() => {
        if (operation === operationRef.current && mountedRef.current) {
          setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000));
        }
      }, 250);
      setRecording(true);
    } catch (cause) {
      if (mountedRef.current && operation === operationRef.current) {
        setError(cause instanceof Error ? cause.message : 'Нет доступа к микрофону');
      }
    }
  }, [clearPreview, stopRecordingTimer]);

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
      stopRecordingTimer();
      clearPreview();
    };
  }, [clearPreview, stopRecordingTimer]);

  return {
    recording,
    finalizing,
    error,
    previewUrl,
    recordingSeconds,
    inputLevel,
    start,
    stop,
    finish,
    finishRecording,
    transcribePreview,
    discardPreview: clearPreview,
    toggle,
  };
}
