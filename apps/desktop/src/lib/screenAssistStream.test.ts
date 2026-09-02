import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function validTaskState(now = Date.now()): string {
  return JSON.stringify({
    version: 1,
    task_kind: 'code',
    response_kind: 'code_solution',
    correction_mode: 'accumulate',
    requirements: { objective: 'Solve the visible task' },
    frames: [],
    ledger: [],
    ttl: {
      created_at_ms: now - 1_000,
      updated_at_ms: now,
      expires_at_ms: now + 60_000,
    },
  });
}

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

  it('sends bounded prior frames and the prior solution summary in the screen payload', async () => {
    let requestBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return streamResponse(['data: {"type":"done"}\n\n']);
    });
    vi.stubGlobal('fetch', fetchMock);

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Apply the latest correction', {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    }, {
      previousImages: ['data:image/jpeg;base64,previous-1', 'data:image/jpeg;base64,previous-2'],
      priorSolutionSummary: '```sql\nSELECT * FROM users;\n```\nKeep the filter.',
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestBody).toMatchObject({
      image: 'data:image/jpeg;base64,current',
      question: 'Apply the latest correction',
      previous_images: ['data:image/jpeg;base64,previous-1', 'data:image/jpeg;base64,previous-2'],
      prior_solution_summary: '```sql\nSELECT * FROM users;\n```\nKeep the filter.',
    });
  });

  it('starts a structured task without prior state and forwards its validated done state', async () => {
    const taskState = validTaskState();
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return streamResponse([
        'data: {"type":"chunk","text":"answer"}\n\n',
        `data: ${JSON.stringify({ type: 'done', task_state: taskState })}\n\n`,
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: done, onError: error,
    }, { structuredScreen: true });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(requestBody).toMatchObject({ structuredScreen: true, taskAction: 'new' });
    expect(requestBody).not.toHaveProperty('taskState');
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ taskState }));
    expect(error).not.toHaveBeenCalled();
  });

  it('continues a structured task only when a committed state is supplied', async () => {
    const taskState = validTaskState();
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return streamResponse([
        `data: ${JSON.stringify({ type: 'done', task_state: taskState })}\n\n`,
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    }, { structuredScreen: true, taskState });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestBody).toMatchObject({
      structuredScreen: true,
      taskAction: 'continue',
      taskState,
    });
  });

  it.each([
    ['clean EOF', ['data: {"type":"chunk","text":"partial"}\n\n']],
    ['done without state', ['data: {"type":"done"}\n\n']],
    ['done with malformed state', [
      `data: ${JSON.stringify({ type: 'done', task_state: '{bad-json' })}\n\n`,
    ]],
    ['done with incomplete state envelope', [
      `data: ${JSON.stringify({
        type: 'done',
        task_state: JSON.stringify({
          version: 1,
          ttl: {
            created_at_ms: Date.now() - 1_000,
            updated_at_ms: Date.now(),
            expires_at_ms: Date.now() + 60_000,
          },
        }),
      })}\n\n`,
    ]],
  ])('rejects a structured %s instead of publishing partial output', async (_case, events) => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(events)));
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: done, onError: error,
    }, { structuredScreen: true });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(done).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON data', 'data: {bad-json\n\n'],
    ['non-string chunk', 'data: {"type":"chunk","text":null}\n\n'],
  ])('fails a structured stream closed after %s even if a valid done follows', async (
    _case,
    invalidEvent,
  ) => {
    const state = validTaskState();
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      invalidEvent,
      'data: {"type":"chunk","text":"partial"}\n\n',
      `data: ${JSON.stringify({ type: 'done', task_state: state })}\n\n`,
    ])));
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: done, onError: error,
    }, { structuredScreen: true });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(done).not.toHaveBeenCalled();
  });

  it('keeps the legacy stream tolerant of an unrelated malformed data line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {bad-json\n\n',
      'data: {"type":"chunk","text":"answer"}\n\n',
      'data: {"type":"done"}\n\n',
    ])));
    const chunk = vi.fn();
    const done = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: chunk, onDone: done, onError: vi.fn(),
    });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(chunk).toHaveBeenCalledWith('answer');
  });

  it('suppresses the queued invalid-state error when cancelled synchronously', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    const error = vi.fn();
    const cancel = api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: done, onError: error,
    }, { structuredScreen: true, taskState: '{bad-json' });

    cancel();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('forwards the stable structured error code without treating it as done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {"type":"error","message":"expired","code":"screen_task_state_expired"}\n\n',
    ])));
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: done, onError: error,
    }, { structuredScreen: true });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith('expired', 'screen_task_state_expired');
    expect(done).not.toHaveBeenCalled();
  });

  it('falls back exactly once to the legacy screen stream for an unsupported Python profile', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return streamResponse([
          'data: {"type":"error","message":"unsupported","code":"unsupported_screen_python_profile"}\n\n',
        ]);
      }
      return streamResponse([
        'data: {"type":"chunk","text":"legacy answer"}\n\n',
        'data: {"type":"done","model":"openai/gpt-5.6-sol"}\n\n',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const chunk = vi.fn();
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: chunk, onDone: done, onError: error,
    }, { structuredScreen: true, previousImages: ['data:image/jpeg;base64,prior'] });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toMatchObject({ structuredScreen: true, taskAction: 'new' });
    expect(requestBodies[1]).not.toHaveProperty('structuredScreen');
    expect(requestBodies[1]).not.toHaveProperty('taskAction');
    expect(requestBodies[1]).not.toHaveProperty('taskState');
    expect(requestBodies[1]).toMatchObject({
      previous_images: ['data:image/jpeg;base64,prior'],
    });
    expect(chunk).toHaveBeenCalledWith('legacy answer');
    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      legacyFallback: true,
      model: 'openai/gpt-5.6-sol',
    }));
    expect(error).not.toHaveBeenCalled();
  });

  it('never falls back after structured output has already started', async () => {
    const fetchMock = vi.fn(async () => streamResponse([
      'data: {"type":"chunk","text":"partial"}\n\n',
      'data: {"type":"error","message":"unsupported","code":"unsupported_screen_python_profile"}\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: done, onError: error,
    }, { structuredScreen: true });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('unsupported', 'unsupported_screen_python_profile');
    expect(done).not.toHaveBeenCalled();
  });

  it('does not fall back for any other structured error code', async () => {
    const fetchMock = vi.fn(async () => streamResponse([
      'data: {"type":"error","message":"invalid","code":"invalid_screen_answer"}\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'Q', {
      onChunk: vi.fn(), onDone: vi.fn(), onError: error,
    }, { structuredScreen: true });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('invalid', 'invalid_screen_answer');
  });
});
