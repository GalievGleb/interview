import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScreenFallbackLaunchCoordinator,
  ScreenRequestCoordinator,
  isCurrentForceScreenFallbackRequest,
  presentScreenRequestTerminal,
  type ScreenRequestStreamHandlers,
} from './screenRequestCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ScreenRequestCoordinator', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces a duplicate while one screen request is active and completes the first request', async () => {
    const capture = deferred<string>();
    const onTerminal = vi.fn();
    const cancel = vi.fn();
    let handlers: ScreenRequestStreamHandlers | undefined;
    const startStream = vi.fn((_image: string, next: ScreenRequestStreamHandlers) => {
      handlers = next;
      return cancel;
    });
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });

    expect(coordinator.start({ capture: () => capture.promise, startStream, onTerminal })).not.toBeNull();
    expect(coordinator.start({ capture: () => capture.promise, startStream, onTerminal })).toBeNull();

    await flushPromises();
    expect(startStream).not.toHaveBeenCalled();
    capture.resolve('data:image/jpeg;base64,QUJD');
    await flushPromises();
    expect(startStream).toHaveBeenCalledTimes(1);

    handlers!.onChunk('Answer');
    handlers!.onDone();

    expect(cancel).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'done', answer: 'Answer',
    }));
    expect(coordinator.isActive()).toBe(false);
  });

  it.each([
    ['capture timeout', async (capture: ReturnType<typeof deferred<string>>, handlers: () => ScreenRequestStreamHandlers | undefined) => {
      void capture;
      void handlers;
      vi.advanceTimersByTime(1_001);
    }, 'capture_timeout'],
    ['capture rejection', async (capture: ReturnType<typeof deferred<string>>, handlers: () => ScreenRequestStreamHandlers | undefined) => {
      void handlers;
      capture.reject(new Error('capture failed'));
      await flushPromises();
    }, 'capture_failed'],
    ['empty capture', async (capture: ReturnType<typeof deferred<string>>, handlers: () => ScreenRequestStreamHandlers | undefined) => {
      void handlers;
      capture.resolve('');
      await flushPromises();
    }, 'capture_empty'],
    ['provider error', async (capture: ReturnType<typeof deferred<string>>, handlers: () => ScreenRequestStreamHandlers | undefined) => {
      capture.resolve('data:image/jpeg;base64,QUJD');
      await flushPromises();
      handlers!()!.onError('provider down');
    }, 'stream_error'],
    ['empty done', async (capture: ReturnType<typeof deferred<string>>, handlers: () => ScreenRequestStreamHandlers | undefined) => {
      capture.resolve('data:image/jpeg;base64,QUJD');
      await flushPromises();
      handlers!()!.onDone();
    }, 'stream_empty'],
  ])('terminalizes %s and permits retry', async (_name, drive, reason) => {
    vi.useFakeTimers();
    const capture = deferred<string>();
    const onTerminal = vi.fn();
    let handlers: ScreenRequestStreamHandlers | undefined;
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });
    const startStream = vi.fn((_image: string, next: ScreenRequestStreamHandlers) => {
      handlers = next;
      return vi.fn();
    });
    const operation = { capture: () => capture.promise, startStream, onTerminal };

    expect(coordinator.start(operation)).not.toBeNull();
    await flushPromises();
    await drive(capture, () => handlers);

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', reason }));
    expect(coordinator.isActive()).toBe(false);
    expect(coordinator.start(operation)).not.toBeNull();
  });

  it('settles a synchronous capture throw and permits retry', async () => {
    const onTerminal = vi.fn();
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });
    const operation = {
      capture: () => {
        throw new Error('capture threw');
      },
      startStream: vi.fn(),
      onTerminal,
    };

    expect(() => coordinator.start(operation)).not.toThrow();
    await flushPromises();

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', reason: 'capture_failed', message: 'capture threw',
    }));
    expect(coordinator.isActive()).toBe(false);
    expect(coordinator.start(operation)).not.toBeNull();
  });

  it('settles an onCaptured throw once and permits retry', async () => {
    const capture = deferred<string>();
    const onTerminal = vi.fn();
    const startStream = vi.fn();
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });

    expect(coordinator.start({
      capture: () => capture.promise,
      onCaptured: () => {
        throw new Error('captured callback failed');
      },
      startStream,
      onTerminal,
    })).not.toBeNull();
    await flushPromises();
    capture.resolve('data:image/jpeg;base64,QUJD');
    await flushPromises();

    expect(startStream).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      reason: 'capture_failed',
      message: 'captured callback failed',
    }));
    expect(coordinator.isActive()).toBe(false);

    const retryCapture = deferred<string>();
    expect(coordinator.start({
      capture: () => retryCapture.promise,
      startStream: vi.fn(),
      onTerminal: vi.fn(),
    })).not.toBeNull();
    coordinator.cancelActive();
  });

  it('settles a startStream throw once and permits retry', async () => {
    const capture = deferred<string>();
    const onTerminal = vi.fn();
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });

    expect(coordinator.start({
      capture: () => capture.promise,
      startStream: () => {
        throw new Error('stream startup failed');
      },
      onTerminal,
    })).not.toBeNull();
    await flushPromises();
    capture.resolve('data:image/jpeg;base64,QUJD');
    await flushPromises();

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      reason: 'stream_error',
      message: 'stream startup failed',
    }));
    expect(coordinator.isActive()).toBe(false);

    const retryCapture = deferred<string>();
    expect(coordinator.start({
      capture: () => retryCapture.promise,
      startStream: vi.fn(),
      onTerminal: vi.fn(),
    })).not.toBeNull();
    coordinator.cancelActive();
  });

  it('preserves a stable server error code for lifecycle decisions', async () => {
    const capture = deferred<string>();
    const onTerminal = vi.fn();
    let handlers: ScreenRequestStreamHandlers | undefined;
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });

    coordinator.start({
      capture: () => capture.promise,
      startStream: (_image, next) => {
        handlers = next;
        return vi.fn();
      },
      onTerminal,
    });
    await flushPromises();
    capture.resolve('data:image/jpeg;base64,QUJD');
    await flushPromises();
    handlers!.onError('expired', 'screen_task_state_expired');

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      errorCode: 'screen_task_state_expired',
    }));
  });

  it('ignores stale callbacks after a newer request owns the coordinator', async () => {
    const firstCapture = deferred<string>();
    const secondCapture = deferred<string>();
    const onTerminal = vi.fn();
    const cancel = vi.fn();
    const streams: ScreenRequestStreamHandlers[] = [];
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 1_000 });
    const startStream = vi.fn((_image: string, handlers: ScreenRequestStreamHandlers) => {
      streams.push(handlers);
      return cancel;
    });

    expect(coordinator.start({ capture: () => firstCapture.promise, startStream, onTerminal })).not.toBeNull();
    await flushPromises();
    firstCapture.resolve('data:image/jpeg;base64,QUJD');
    await flushPromises();
    coordinator.cancelActive();

    expect(coordinator.start({ capture: () => secondCapture.promise, startStream, onTerminal })).not.toBeNull();
    await flushPromises();
    secondCapture.resolve('data:image/jpeg;base64,REVG');
    await flushPromises();

    streams[0].onError('old request failed');
    streams[0].onDone();
    expect(onTerminal).not.toHaveBeenCalled();

    streams[1].onChunk('New answer');
    streams[1].onDone();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'done', answer: 'New answer',
    }));
  });
});

describe('presentScreenRequestTerminal', () => {
  it('keeps partial code visibly marked incomplete and rejects it for publication', () => {
    expect(presentScreenRequestTerminal({
      status: 'error',
      answer: '```sql\nSELECT partial',
      reason: 'stream_error',
      message: 'Ответ обрезан. Это неполное решение — повторите запрос.',
    })).toEqual({
      text: '```sql\nSELECT partial',
      streaming: false,
      issue: 'Ответ обрезан. Это неполное решение — повторите запрос.',
      complete: false,
    });
  });

  it('marks only a successful terminal as publishable', () => {
    expect(presentScreenRequestTerminal({
      status: 'done', answer: 'Полный ответ', meta: { model: 'test' },
    })).toEqual({
      text: 'Полный ответ',
      streaming: false,
      complete: true,
    });
  });
});

describe('ScreenFallbackLaunchCoordinator', () => {
  it('rejects a retained fallback after reset moved its force phase to error', () => {
    const retained = { generation: 7, screenRevision: 2, question: 'old task' };

    expect(isCurrentForceScreenFallbackRequest(retained, 7, 'screen-fallback')).toBe(true);
    expect(isCurrentForceScreenFallbackRequest(retained, 7, 'error')).toBe(false);
  });

  it('rejects an old fallback when a newer force generation owns the screen phase', () => {
    expect(isCurrentForceScreenFallbackRequest(
      { generation: 7, screenRevision: 2, question: 'old task' },
      8,
      'screen-fallback',
    )).toBe(false);
  });

  it('publishes owner and request key only after the screen request actually starts', () => {
    const launches = new ScreenFallbackLaunchCoordinator();
    const request = { generation: 7, screenRevision: 2, question: 'latest' };

    expect(launches.launch(request, {
      isActive: () => false,
      cancelActive: vi.fn(),
      start: () => 'busy',
    })).toBe('busy');
    expect(launches.ownerGeneration()).toBe(0);

    expect(launches.launch(request, {
      isActive: () => false,
      cancelActive: vi.fn(),
      start: () => 'started',
    })).toBe('started');
    expect(launches.ownerGeneration()).toBe(7);
    expect(launches.launch(request, {
      isActive: () => false,
      cancelActive: vi.fn(),
      start: () => 'started',
    })).toBe('duplicate');
  });

  it('cancels an older active revision before launching the newest revision once', () => {
    const launches = new ScreenFallbackLaunchCoordinator();
    const cancelActive = vi.fn();
    let active = false;
    const start = vi.fn(() => {
      active = true;
      return 'started' as const;
    });

    expect(launches.launch(
      { generation: 4, screenRevision: 1, question: 'partial' },
      { isActive: () => active, cancelActive, start },
    )).toBe('started');
    expect(launches.launch(
      { generation: 4, screenRevision: 2, question: 'exact' },
      { isActive: () => active, cancelActive: () => {
        cancelActive();
        active = false;
      }, start },
    )).toBe('started');

    expect(cancelActive).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(launches.ownerGeneration()).toBe(4);
    expect(launches.launch(
      { generation: 4, screenRevision: 2, question: 'exact' },
      { isActive: () => active, cancelActive, start },
    )).toBe('duplicate');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('reset releases the owner and permits the same request in a new task epoch', () => {
    const launches = new ScreenFallbackLaunchCoordinator();
    const request = { generation: 3, screenRevision: 1, question: 'screen' };
    const callbacks = {
      isActive: () => false,
      cancelActive: vi.fn(),
      start: () => 'started' as const,
    };

    expect(launches.launch(request, callbacks)).toBe('started');
    launches.reset();
    expect(launches.ownerGeneration()).toBe(0);
    expect(launches.launch(request, callbacks)).toBe('started');
  });
});
