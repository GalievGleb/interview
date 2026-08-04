import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMockAnswerTranscriptionForm } from './api';

describe('mock answer submission', () => {
  it('serializes one WAV and bounded context as multipart form data', () => {
    const wav = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
    const form = createMockAnswerTranscriptionForm(wav, {
      question: 'Что проверяете в API-ответе кроме 200?',
      hints: ['API', 'JSON', 'schema'],
      language: 'ru',
    });

    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('question')).toBe('Что проверяете в API-ответе кроме 200?');
    expect(form.get('hints')).toBe(JSON.stringify(['API', 'JSON', 'schema']));
    expect(form.get('language')).toBe('ru');
  });

  it('keeps mock voice capture completely outside the live STT path', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'vacancyReview', 'useVoiceAnswer.ts'),
      'utf8',
    );

    expect(source).not.toContain('startLiveSession');
    expect(source).not.toContain('createVoiceAnswerTranscript');
    expect(source).not.toContain('createVoiceAnswerFinalizer');
    expect(source).toContain('startMockAnswerRecording');
    expect(source).toContain('buildMockAnswerGuidance');
    expect(source).toContain('api.transcribeMockAnswer');
  });
});
