import { describe, expect, it } from 'vitest';
import { createVoiceAnswerTranscript, flushVoiceAnswerTranscript } from './voiceAnswerTranscript';

describe('voice answer transcript accumulator', () => {
  it('surfaces partial text while the user is still speaking', () => {
    const acc = createVoiceAnswerTranscript();

    const visible = acc.accept('Проверял API через негативные кейсы', false);

    expect(visible).toBe('Проверял API через негативные кейсы');
  });

  it('keeps the latest partial when recording stops before a final transcript', () => {
    const acc = createVoiceAnswerTranscript();
    acc.accept('Расскажу про контракт и авторизацию', false);

    expect(flushVoiceAnswerTranscript(acc)).toBe('Расскажу про контракт и авторизацию');
  });

  it('appends final phrases without duplicating the partial preview', () => {
    const acc = createVoiceAnswerTranscript();
    acc.accept('Проверял API', false);
    const visible = acc.accept('Проверял API через схемы и negative payloads.', true);

    expect(visible).toBe('Проверял API через схемы и negative payloads.');
    expect(flushVoiceAnswerTranscript(acc)).toBe('Проверял API через схемы и negative payloads.');
  });
});
