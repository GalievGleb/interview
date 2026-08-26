import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function streamResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events.join('')));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function deferredStreamResponse(): { response: Response; emit: (event: string) => void } {
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({
    start(controller) { streamController = controller; },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  return { response, emit: (event) => streamController.enqueue(encoder.encode(event)) };
}

describe('screen-assist SSE settlement', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { getApiToken: async () => '' } });
    vi.stubGlobal('localStorage', { getItem: () => null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('forwards the actual model metadata and calls done exactly once at event plus EOF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {"type":"chunk","text":"answer"}\n\n',
      'data: {"type":"done","model":"openai/gpt-4.1","model_source":"auto"}\n\n',
    ])));
    const chunks: string[] = [];
    const done = vi.fn();
    const error = vi.fn();
    api.streamScreenAssist('data:image/jpeg;base64,QUJD', 'Q', {
      onChunk: (chunk) => chunks.push(chunk),
      onDone: done,
      onError: error,
    });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(chunks).toEqual(['answer']);
    expect(done).toHaveBeenCalledWith({ model: 'openai/gpt-4.1', modelSource: 'auto' });
    expect(error).not.toHaveBeenCalled();
  });

  it('never reports done after an error event followed by EOF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {"type":"error","message":"provider failed"}\n\n',
    ])));
    const done = vi.fn();
    const error = vi.fn();
    api.streamScreenAssist('data:image/jpeg;base64,QUJD', 'Q', {
      onChunk: vi.fn(),
      onDone: done,
      onError: error,
    });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('provider failed');
    expect(done).not.toHaveBeenCalled();
  });

  it('settles a clean terminal-less EOF as done exactly once with unknown metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {"type":"chunk","text":"answer"}\n\n',
    ])));
    const done = vi.fn();
    api.streamScreenAssist('data:image/jpeg;base64,QUJD', 'Q', {
      onChunk: vi.fn(),
      onDone: done,
      onError: vi.fn(),
    });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('emits no late chunks or terminal callbacks after cancellation', async () => {
    const deferred = deferredStreamResponse();
    vi.stubGlobal('fetch', vi.fn(async () => deferred.response));
    const chunk = vi.fn();
    const done = vi.fn();
    const error = vi.fn();
    const cancel = api.streamScreenAssist('data:image/jpeg;base64,QUJD', 'Q', {
      onChunk: chunk,
      onDone: done,
      onError: error,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    cancel();
    deferred.emit('data: {"type":"chunk","text":"late"}\n\n');
    deferred.emit('data: {"type":"done"}\n\n');
    await Promise.resolve();
    await Promise.resolve();
    expect(chunk).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
