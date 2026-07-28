import { useCallback, useEffect, useRef, useState } from 'react';
import { startLiveSession, type LiveSession } from '../liveSession';
import { createVoiceAnswerTranscript, flushVoiceAnswerTranscript } from '../voiceAnswerTranscript';

/**
 * Lightweight voice capture for a single mock-interview answer. Reuses the live
 * STT WebSocket (mic -> OpenAI Mini) but accumulates only the final transcript and
 * streams it back via `onText`, so the answer textarea fills as you speak.
 */
export function useVoiceAnswer(onText: (text: string) => void, language = 'ru') {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef<LiveSession | null>(null);
  const transcriptRef = useRef(createVoiceAnswerTranscript());

  const stop = useCallback(() => {
    const flushed = flushVoiceAnswerTranscript(transcriptRef.current);
    if (flushed) onText(flushed);
    sessionRef.current?.stop();
    sessionRef.current = null;
    setRecording(false);
    return flushed;
  }, [onText]);

  const start = useCallback(async () => {
    setError('');
    transcriptRef.current.reset();
    try {
      const session = await startLiveSession(
        {
          onTranscript: (text, isFinal) => {
            const next = transcriptRef.current.accept(text, isFinal);
            if (next) onText(next);
          },
          onError: (msg) => {
            setError(msg);
            stop();
          },
        },
        { source: 'mic', speaker: 'me', language },
      );
      sessionRef.current = session;
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Нет доступа к микрофону');
    }
  }, [onText, language, stop]);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  useEffect(() => () => sessionRef.current?.stop(), []);

  return { recording, error, start, stop, toggle };
}
