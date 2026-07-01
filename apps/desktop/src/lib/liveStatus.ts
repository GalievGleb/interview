/** Pure derivation of the live-session status shown on the Interview screen.
 * Extracted so it can be unit-tested without rendering React. */

export type LiveTone = 'idle' | 'listening' | 'processing' | 'ready';

export interface LiveStateInput {
  active: boolean;
  isGenerating: boolean;
  streaming: boolean;
  hasAnswer: boolean;
}

export interface LiveStateView {
  tone: LiveTone;
  /** Human label for the status pill. */
  label: string;
  /** Active step in the Listening→Transcribing→Answering flow (-1 = none). */
  flowStep: number;
}

export function deriveLiveState({
  active,
  isGenerating,
  streaming,
  hasAnswer,
}: LiveStateInput): LiveStateView {
  const tone: LiveTone = isGenerating
    ? 'processing'
    : active
      ? 'listening'
      : hasAnswer
        ? 'ready'
        : 'idle';

  const label = streaming
    ? 'Отвечаю'
    : isGenerating
      ? 'Распознаю'
      : active
        ? 'Слушаю'
        : hasAnswer
          ? 'Ответ готов'
          : 'Ожидание';

  const flowStep = streaming ? 2 : isGenerating ? 1 : active ? 0 : -1;

  return { tone, label, flowStep };
}
