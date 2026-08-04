import { describe, expect, it } from 'vitest';
import { resolveVoiceAnswerSubmission } from './voiceAnswerSubmission';

describe('voice answer submission', () => {
  it('never turns an empty STT result into a skipped scored answer', () => {
    expect(resolveVoiceAnswerSubmission('', '   ')).toBeNull();
  });

  it('does not submit a stale typed fallback after voice finalization was cancelled', () => {
    expect(resolveVoiceAnswerSubmission(null, 'Старый черновик')).toBeNull();
  });

  it('prefers the finalized voice transcript and preserves a typed fallback', () => {
    expect(resolveVoiceAnswerSubmission('Голосовой ответ', 'Черновик')).toEqual({
      text: 'Голосовой ответ',
      source: 'voice',
    });
    expect(resolveVoiceAnswerSubmission('', 'Текстовый ответ')).toEqual({
      text: 'Текстовый ответ',
      source: 'text',
    });
  });
});
