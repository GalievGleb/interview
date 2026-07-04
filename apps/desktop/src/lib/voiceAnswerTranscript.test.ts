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

  it('removes mic-check noise and long filler from a recorded answer', () => {
    const acc = createVoiceAnswerTranscript();
    const visible = acc.accept(
      'CI-CD GitLab, Docker, контейнеры, Linux, SQL. Блин, меня не записывает нифига. Всем проблема. Раз, раз, раз, раз-раз-раз. Также для вызова запросов использовал Requests, HTTPX. Ммммммммммммммммммммммммммммммммммммммммммммммммммммм',
      true,
    );

    expect(visible).toBe(
      'CI-CD GitLab, Docker, контейнеры, Linux, SQL. Также для вызова запросов использовал Requests, HTTPX.',
    );
    expect(flushVoiceAnswerTranscript(acc)).toBe(visible);
  });

  it('does not show pure mic-check partials as answer text', () => {
    const acc = createVoiceAnswerTranscript();

    expect(acc.accept('Раз, раз, раз-раз-раз. Ммммммммммммм', false)).toBe('');
  });
});
