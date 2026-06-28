import { useCallback, useEffect, useRef, useState } from 'react';
import { startLiveSession, type LiveSession } from '../liveSession';

/**
 * Lightweight voice capture for a single mock-interview answer. Reuses the live
 * STT WebSocket (mic → Whisper) but accumulates only the final transcript and
 * streams it back via `onText`, so the answer textarea fills as you speak.
 */
export function useVoiceAnswer(onText: (text: string) => void, language = 'ru') {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef<LiveSession | null>(null);
  const bufferRef = useRef('');

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError('');
    bufferRef.current = '';
    try {
      const session = await startLiveSession(
        {
          onTranscript: (text, isFinal) => {
            if (!isFinal) return;
            const t = text.trim();
            if (!t) return;
            bufferRef.current = `${bufferRef.current} ${t}`.trim();
            onText(bufferRef.current);
          },
          onError: (msg) => {
            setError(msg);
            stop();
          },
        },
        { source: 'mic', speaker: 'me', mode: 'stable', language },
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
