import type { StreamInterviewCorrectionMeta } from './api';

export type StreamInterviewEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      id?: string;
      spoken?: string;
      model?: string;
      modelSource?: string;
      correction?: StreamInterviewCorrectionMeta;
    }
  | { type: 'error'; message: string };

export function parseInterviewStreamEvent(raw: string): StreamInterviewEvent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type === 'chunk' && typeof value.text === 'string') {
      return { type: 'chunk', text: value.text };
    }
    if (value.type === 'error' && typeof value.message === 'string') {
      return { type: 'error', message: value.message };
    }
    if (value.type !== 'done') return null;
    return {
      type: 'done',
      ...(typeof value.id === 'string' ? { id: value.id } : {}),
      ...(typeof value.spoken === 'string' ? { spoken: value.spoken } : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.model_source === 'string' ? { modelSource: value.model_source } : {}),
      ...(value.correction && typeof value.correction === 'object'
        ? { correction: value.correction as StreamInterviewCorrectionMeta }
        : {}),
    };
  } catch {
    return null;
  }
}
