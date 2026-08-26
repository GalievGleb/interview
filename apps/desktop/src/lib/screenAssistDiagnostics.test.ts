import { describe, expect, it } from 'vitest';
import type { DebugBundle } from './liveDebugRecorder';
import {
  ActiveScreenAssistCancellation,
  ScreenAssistDiagnostics,
  SerializedDiagnosticsWriter,
  TimeoutScreenPartialState,
  freezeTimeoutScreenPartial,
  mergeDebugBundles,
} from './screenAssistDiagnostics';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function bundle(marker: string): DebugBundle {
  return {
    schemaVersion: 2,
    generatedAt: '2026-08-24T00:00:00.000Z',
    sampleRate: 16000,
    durationMs: 1,
    audioFile: null,
    events: [{ tMs: 1, type: 'partial', reason: marker }],
    retention: {
      events: { limit: 1000, retained: 1, dropped: 0, total: 1 },
      screenAssists: { limit: 40, retained: 0, dropped: 0, total: 0 },
    },
    extra: { marker },
  };
}

describe('ScreenAssistDiagnostics', () => {
  it('records request, capture, first output, and done once without retaining image data', () => {
    let now = 10_000;
    const diagnostics = new ScreenAssistDiagnostics(() => now);
    diagnostics.reset(9_000);
    const id = diagnostics.request({
      id: 'screen-7',
      generation: 7,
      trigger: 'stt_timeout',
      mode: 'deep',
      effectiveQuestion: 'Что видно?',
    });
    now = 10_040;
    expect(diagnostics.captured(id, 'data:image/png;base64,QUJD')).toBe(true);
    now = 10_120;
    expect(diagnostics.firstOutput(id, 'первый токен')).toBe(true);
    expect(diagnostics.firstOutput(id, 'ещё токен')).toBe(false);
    now = 10_300;
    expect(diagnostics.done(id, {
      answer: 'Ответ по экрану',
      model: 'openai/gpt-4.1',
      modelSource: 'auto',
    })).toBe(true);
    expect(diagnostics.done(id, { answer: 'late' })).toBe(false);
    expect(diagnostics.error(id, 'late error')).toBe(false);
    expect(diagnostics.cancel(id)).toBe(false);

    const snapshot = diagnostics.snapshot();
    expect(snapshot.entries).toEqual([expect.objectContaining({
      id: 'screen-7',
      generation: 7,
      trigger: 'stt_timeout',
      status: 'done',
      model: 'openai/gpt-4.1',
      modelSource: 'auto',
      answer: 'Ответ по экрану',
      captureMs: 40,
      firstOutputMs: 120,
      totalMs: 300,
      imageMimeType: 'image/png',
      encodedByteCount: 3,
    })]);
    expect(JSON.stringify(snapshot)).not.toContain('data:image');
    expect(JSON.stringify(snapshot)).not.toContain(';base64,');
    expect(JSON.stringify(snapshot)).not.toContain('image":');
  });

  it('settles error and cancellation once and rejects stale callbacks', () => {
    const diagnostics = new ScreenAssistDiagnostics(() => 2_000);
    diagnostics.reset(1_000);
    const failed = diagnostics.request({
      id: 'failed', generation: 1, trigger: 'manual', mode: 'general', effectiveQuestion: 'Q',
    });
    expect(diagnostics.error(failed, 'Bearer secret-token')).toBe(true);
    expect(diagnostics.error(failed, 'again')).toBe(false);
    const cancelled = diagnostics.request({
      id: 'cancelled', generation: 2, trigger: 'visual_question', mode: 'deep', effectiveQuestion: 'Q2',
    });
    expect(diagnostics.cancel(cancelled)).toBe(true);
    expect(diagnostics.captured(cancelled, 'data:image/png;base64,QUJD')).toBe(false);
    expect(diagnostics.done(cancelled, { answer: 'stale' })).toBe(false);

    expect(diagnostics.snapshot().entries.map((entry) => entry.status)).toEqual([
      'error',
      'cancelled',
    ]);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('secret-token');
  });

  it('retains the newest 40 screen records with explicit full counters', () => {
    const diagnostics = new ScreenAssistDiagnostics(() => 1_000);
    diagnostics.reset(0);
    for (let generation = 1; generation <= 42; generation += 1) {
      diagnostics.request({
        id: `screen-${generation}`,
        generation,
        trigger: 'manual',
        mode: 'general',
        effectiveQuestion: `Q${generation}`,
      });
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.entries).toHaveLength(40);
    expect(snapshot.entries[0].id).toBe('screen-3');
    expect(snapshot.retention).toEqual({ limit: 40, retained: 40, dropped: 2, total: 42 });
  });
});

describe('ActiveScreenAssistCancellation integration', () => {
  it('cancels a deferred local capture before reset so it cannot call screen API or mutate UI', async () => {
    const lifecycle: string[] = [];
    const owner = new ActiveScreenAssistCancellation();
    const diagnostics = new ScreenAssistDiagnostics(() => 1_000);
    diagnostics.reset(0);
    let generation = 0;
    let screenApiCalls = 0;
    let exchangeMutations = 0;
    let usageMutations = 0;
    const capture = deferred<string>();

    const runStandaloneScreen = async () => {
      const requestGeneration = ++generation;
      const id = diagnostics.request({
        id: 'local-screen', generation: requestGeneration, trigger: 'manual',
        mode: 'general', effectiveQuestion: 'Что на экране?',
      });
      owner.register(() => {
        generation += 1;
        lifecycle.push('cancel');
        diagnostics.cancel(id);
      });
      const image = await capture.promise;
      if (requestGeneration !== generation) return;
      diagnostics.captured(id, image);
      screenApiCalls += 1;
      exchangeMutations += 1;
      usageMutations += 1;
    };

    const pending = runStandaloneScreen();
    owner.cancelAndClear();
    lifecycle.push(`terminal:${diagnostics.snapshot().entries[0]?.status}`);
    diagnostics.reset(2_000);
    lifecycle.push('reset');
    capture.resolve('data:image/png;base64,QUJD');
    await pending;

    expect(lifecycle).toEqual(['cancel', 'terminal:cancelled', 'reset']);
    expect(screenApiCalls).toBe(0);
    expect(exchangeMutations).toBe(0);
    expect(usageMutations).toBe(0);
    expect(owner.cancelAndClear()).toBe(false);
  });
});

describe('freezeTimeoutScreenPartial', () => {
  const eligible = {
    text: '  current partial  ',
    source: 'system' as const,
    receivedAtMs: 9_900,
    capturedAtMs: 9_800,
    active: true,
    rejected: false,
  };

  it('freezes only an active selected-source pre-press partial and caps it at 500 characters', () => {
    expect(freezeTimeoutScreenPartial({
      partial: eligible,
      selectedSource: 'system',
      pressedAtMs: 10_000,
    })).toBe('current partial');
    expect(freezeTimeoutScreenPartial({
      partial: { ...eligible, text: 'x'.repeat(700) },
      selectedSource: 'system',
      pressedAtMs: 10_000,
    })).toHaveLength(500);
  });

  it.each([
    ['wrong source', { ...eligible, source: 'mic' as const }],
    ['inactive', { ...eligible, active: false }],
    ['older than five seconds', { ...eligible, receivedAtMs: 4_999 }],
    ['capture older than twenty seconds', { ...eligible, capturedAtMs: -10_001 }],
    ['received after press', { ...eligible, receivedAtMs: 10_001 }],
    ['captured after press', { ...eligible, capturedAtMs: 10_001 }],
    ['unknown capture time', { ...eligible, capturedAtMs: undefined }],
    ['rejected garbage', { ...eligible, rejected: true }],
  ])('omits %s', (_label, partial) => {
    expect(freezeTimeoutScreenPartial({
      partial,
      selectedSource: 'system',
      pressedAtMs: 10_000,
    })).toBeUndefined();
  });
});

describe('TimeoutScreenPartialState', () => {
  it('drops a rejected generation hint and never reuses a pre-pause partial', () => {
    const state = new TimeoutScreenPartialState();
    state.observe({
      text: 'fresh selected partial', source: 'system', receivedAtMs: 9_900,
      capturedAtMs: 9_800, active: true, rejected: false,
    });
    state.freezeGeneration(1, 'system', 10_000);
    expect(state.hintFor(1)).toBe('fresh selected partial');
    state.clearGeneration(1);
    expect(state.hintFor(1)).toBeUndefined();

    state.clearCandidates();
    state.freezeGeneration(2, 'system', 10_100);
    expect(state.hintFor(2)).toBeUndefined();
  });
});

describe('SerializedDiagnosticsWriter', () => {
  it('serializes A then coalesces B/C/final into only the latest deferred PUT', async () => {
    const saved: string[] = [];
    let releaseA!: () => void;
    const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
    const writer = new SerializedDiagnosticsWriter(async (_sessionId, snapshot) => {
      const marker = snapshot.events[0]?.reason ?? '';
      saved.push(marker);
      if (marker === 'A') await blockedA;
    });
    writer.activate(1, 'same-session');
    writer.enqueue(1, 'same-session', () => bundle('A'));
    await Promise.resolve();
    writer.enqueue(1, 'same-session', () => bundle('B'));
    writer.enqueue(1, 'same-session', () => bundle('C'));
    writer.enqueue(1, 'same-session', () => bundle('final'));
    expect(saved).toEqual(['A']);
    releaseA();
    await writer.flush(1, 'same-session');
    expect(saved).toEqual(['A', 'final']);
  });

  it('orders a new epoch after a late old write even when the durable session id is reused', async () => {
    const saved: string[] = [];
    let releaseOld!: () => void;
    const blockedOld = new Promise<void>((resolve) => { releaseOld = resolve; });
    const writer = new SerializedDiagnosticsWriter(async (_sessionId, snapshot) => {
      const marker = snapshot.events[0]?.reason ?? '';
      saved.push(marker);
      if (marker === 'old-A') await blockedOld;
    });
    writer.activate(1, 'reused-session');
    writer.enqueue(1, 'reused-session', () => bundle('old-A'));
    await Promise.resolve();
    writer.activate(2, 'reused-session');
    writer.enqueue(2, 'reused-session', () => bundle('new-final'));
    writer.enqueue(1, 'reused-session', () => bundle('stale-old-final'));
    releaseOld();
    await writer.flush(2, 'reused-session');
    expect(saved).toEqual(['old-A', 'new-final']);
  });

  it('does not drop an old final when a new epoch activates on the same durable session', async () => {
    const saved: string[] = [];
    let releaseOld!: () => void;
    const blockedOld = new Promise<void>((resolve) => { releaseOld = resolve; });
    const writer = new SerializedDiagnosticsWriter(async (_sessionId, snapshot) => {
      const marker = snapshot.events[0]?.reason ?? '';
      saved.push(marker);
      if (marker === 'old-A') await blockedOld;
    });
    writer.activate(1, 'reused-session');
    writer.enqueue(1, 'reused-session', () => bundle('old-A'));
    await Promise.resolve();
    writer.enqueue(1, 'reused-session', () => bundle('old-final'));
    writer.activate(2, 'reused-session');
    writer.enqueue(2, 'reused-session', () => bundle('new-current'));

    releaseOld();
    await writer.flush(1, 'reused-session');
    await writer.flush(2, 'reused-session');
    expect(saved).toEqual(['old-A', 'old-final', 'new-current']);
  });

  it('persists epoch one final before end and uses it as the reused epoch two merge base', async () => {
    const order: string[] = [];
    let persisted: DebugBundle | null = null;
    let releaseFirst!: () => void;
    const blockedFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writer = new SerializedDiagnosticsWriter(async (_sessionId, snapshot) => {
      const marker = snapshot.events.at(-1)?.reason ?? '';
      if (marker === 'epoch-1-A') await blockedFirst;
      persisted = snapshot;
      order.push(`put:${marker}`);
    });
    writer.activate(1, 'reused-session');
    writer.enqueue(1, 'reused-session', () => bundle('epoch-1-A'));
    await Promise.resolve();
    writer.enqueue(1, 'reused-session', () => bundle('epoch-1-final'));

    const endEpochOne = (async () => {
      await writer.flush(1, 'reused-session');
      order.push('end:epoch-1');
    })();
    const startEpochTwo = (async () => {
      await endEpochOne;
      const base = persisted;
      writer.activate(2, 'reused-session');
      const merged = mergeDebugBundles(base, bundle('epoch-2-current'));
      writer.enqueue(2, 'reused-session', () => merged);
      await writer.flush(2, 'reused-session');
      return merged;
    })();

    expect(order).toEqual([]);
    releaseFirst();
    const merged = await startEpochTwo;
    expect(order).toEqual([
      'put:epoch-1-A',
      'put:epoch-1-final',
      'end:epoch-1',
      'put:epoch-2-current',
    ]);
    expect(merged.events.map((event) => event.reason)).toEqual([
      'epoch-1-final',
      'epoch-2-current',
    ]);
  });

  it('propagates a failed final save and permits an explicit retry', async () => {
    let fail = true;
    const saved: string[] = [];
    const writer = new SerializedDiagnosticsWriter(async (_sessionId, snapshot) => {
      const marker = snapshot.events[0]?.reason ?? '';
      if (fail) throw new Error('disk unavailable');
      saved.push(marker);
    });
    writer.activate(1, 'session');
    writer.enqueue(1, 'session', () => bundle('final'));
    await expect(writer.flush(1, 'session')).rejects.toThrow('disk unavailable');

    fail = false;
    writer.enqueue(1, 'session', () => bundle('final-retry'));
    await writer.flush(1, 'session');
    expect(saved).toEqual(['final-retry']);
  });
});

describe('mergeDebugBundles', () => {
  it('preserves a prior reused-session segment and keeps newest bounded records', () => {
    const previous = bundle('previous');
    previous.extra = {
      ...previous.extra,
      screenAssists: [{ id: 'old-screen', generation: 1, status: 'done' }],
    };
    const current = bundle('current');
    current.extra = {
      ...current.extra,
      screenAssists: [{ id: 'new-screen', generation: 2, status: 'error' }],
    };
    const merged = mergeDebugBundles(previous, current);
    expect(merged.events.map((event) => event.reason)).toEqual(['previous', 'current']);
    expect((merged.extra?.screenAssists as Array<{ id: string }>).map((entry) => entry.id))
      .toEqual(['old-screen', 'new-screen']);
  });

  it('offsets a reused segment so event and screen timelines stay monotonic', () => {
    const previous = bundle('previous');
    previous.durationMs = 6_000;
    previous.events[0].tMs = 5_000;
    previous.extra = {
      screenAssists: [{
        id: 'old', generation: 1, startedAtMs: 5_500, trigger: 'manual',
        mode: 'general', effectiveQuestion: 'old', status: 'done',
      }],
    };
    const current = bundle('current');
    current.durationMs = 1_000;
    current.events[0].tMs = 0;
    current.extra = {
      screenAssists: [{
        id: 'new', generation: 2, startedAtMs: 0, trigger: 'manual',
        mode: 'general', effectiveQuestion: 'new', status: 'done',
      }],
    };

    const merged = mergeDebugBundles(previous, current);
    expect(merged.durationMs).toBe(7_000);
    expect(merged.events.map((event) => event.tMs)).toEqual([5_000, 6_000]);
    expect((merged.extra?.screenAssists as Array<{ startedAtMs: number }>).map((entry) => entry.startedAtMs))
      .toEqual([5_500, 6_000]);
  });
});
