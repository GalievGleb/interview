import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StreamInterviewOpts } from '../lib/api';
import { buildRevisionStreamOpts, type AnswerRevisionMode } from '../lib/answerRevision';
import { sanitizeLiveAnswer } from '@interview/shared';

interface RevisionHandlers {
  onStream: (text: string) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
}

export function useAnswerRevision() {
  const [revising, setRevising] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setRevising(false);
  }, []);

  // Анмаунт посреди ревизии: обрываем SSE, не жжём токены на невидимый ответ.
  useEffect(() => cancel, [cancel]);

  const revise = useCallback(
    (
      question: string,
      previousAnswer: string,
      mode: AnswerRevisionMode,
      baseOpts: StreamInterviewOpts,
      handlers: RevisionHandlers,
    ) => {
      cancelRef.current?.();
      setRevising(true);
      let accumulated = '';

      const opts = buildRevisionStreamOpts(baseOpts, mode, previousAnswer);
      cancelRef.current = api.streamInterview(
        question,
        {
          onChunk: (chunk) => {
            accumulated += chunk;
            const cleaned = sanitizeLiveAnswer(accumulated);
            handlers.onStream(cleaned);
          },
          onDone: (spoken) => {
            cancelRef.current = null;
            setRevising(false);
            handlers.onDone(sanitizeLiveAnswer(spoken || accumulated));
          },
          onError: (msg) => {
            cancelRef.current = null;
            setRevising(false);
            if (accumulated.trim()) {
              handlers.onDone(sanitizeLiveAnswer(accumulated));
            } else {
              handlers.onError(msg);
            }
          },
        },
        opts,
      );
    },
    [],
  );

  return { revise, revising, cancel };
}
