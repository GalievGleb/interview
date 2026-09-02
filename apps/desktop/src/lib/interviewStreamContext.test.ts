import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function doneResponse(): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"done","spoken":"ok"}\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('interview fast-path active screen context', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { getApiToken: async () => '' } });
    vi.stubGlobal('localStorage', { getItem: () => null });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends the bounded active task in the same fast interview request', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return doneResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    api.streamInterview('Теперь добавь TTL.', {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    }, {
      fastAnswer: true,
      activeScreenTask: {
        rootQuestion: 'Реализуй LRU cache.',
        currentQuestion: 'Добавь eviction по capacity.',
        latestAnswer: 'class LruCache: ...',
        updatedAtMs: 1_777_777,
      },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestBody).toMatchObject({
      question: 'Теперь добавь TTL.',
      fast_answer: true,
      active_screen_task: {
        root_question: 'Реализуй LRU cache.',
        current_question: 'Добавь eviction по capacity.',
        latest_answer: 'class LruCache: ...',
        updated_at_ms: 1_777_777,
      },
    });
  });
});
