import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('question speech API', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          getApiToken: vi.fn(async () => 'local-token'),
        },
      },
    });
  });

  it('requests authenticated WAV speech as a blob', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(['RIFF-wav'], { type: 'audio/wav' }), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.synthesizeSpeech('Что такое API?', 'ru');

    expect(result.type).toBe('audio/wav');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/tts/speech',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SkillCue-Token': 'local-token',
        },
        body: JSON.stringify({ input: 'Что такое API?', language: 'ru' }),
      }),
    );
  });
});
