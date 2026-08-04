import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAnswerLanguage } from './answerLanguage';
import { api } from './api';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe('recap API language contract', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage(),
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          getApiToken: vi.fn(async () => 'local-token'),
        },
      },
    });
    saveAnswerLanguage('ru');
  });

  it('sends the configured language in normal and streaming recap requests', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (String(_url).endsWith('/stream')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      const payload = String(_url).includes('interview-review')
        ? { review: 'ok' }
        : { summary: 'ok' };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.meetingSummary('transcript');
    await api.interviewReview('transcript');
    const streamsDone = Promise.all([
      new Promise<void>((resolve, reject) =>
        api.streamMeetingSummary('transcript', {
          onChunk: () => undefined,
          onDone: resolve,
          onError: (message) => reject(new Error(message)),
        }),
      ),
      new Promise<void>((resolve, reject) =>
        api.streamInterviewReview('transcript', {
          onChunk: () => undefined,
          onDone: resolve,
          onError: (message) => reject(new Error(message)),
        }),
      ),
    ]);
    await streamsDone;

    expect(bodies).toHaveLength(4);
    expect(bodies.every((body) => body.answer_language === 'ru')).toBe(true);
  });
});
