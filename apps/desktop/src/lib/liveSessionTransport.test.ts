import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  captureStops: [] as ReturnType<typeof vi.fn>[],
  startCapture: vi.fn(async () => {
    const stop = vi.fn();
    dependencies.captureStops.push(stop);
    return { stop };
  }),
}));

vi.mock('./api', () => ({
  api: { apiUrl: 'http://127.0.0.1:8000' },
  getApiToken: vi.fn(async () => ''),
}));

vi.mock('./audioCapture', () => ({
  startCapture: dependencies.startCapture,
}));

vi.mock('./sttOptions', () => ({
  probeOutputSampleRate: vi.fn(async () => 16_000),
}));

import { LiveSourceHealth } from './liveSourceHealth';
import { LatestForcedAnswerCoordinator, type ForcedTranscriptLine } from './latestForcedAnswer';
import { LiveDebugRecorder } from './liveDebugRecorder';
import { startLiveSession } from './liveSession';
import {
  dispatchForcedSttAcceptDecision,
  dispatchForcedSttSubmission,
  ForcedFinalMetadataLedger,
  toSttDiagnosticMeta,
} from '../hooks/useLiveCopilot';

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType = '';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('live-session transport epochs', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    dependencies.captureStops.length = 0;
    dependencies.startCapture.mockClear();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores delayed speech from the pre-pause socket and accepts the resumed socket', async () => {
    let nowMs = 0;
    const health = new LiveSourceHealth({ mic: true, system: true }, () => nowMs);
    health.markCaptureReady('system', 1, 0);

    const session = await startLiveSession(
      {
        onTranscript: () => undefined,
        onCaptureReady: ({ captureEpoch }) => {
          health.markCaptureReady('mic', captureEpoch, nowMs);
        },
        onSpeechStarted: (captureEpoch) => {
          health.markSpeechStarted('mic', captureEpoch, nowMs);
        },
        onError: (message) => {
          throw new Error(message);
        },
      },
      { source: 'mic' },
    );

    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.open();
    await flushPromises();
    session.pause();
    await session.resume();

    expect(oldSocket.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const resumedSocket = FakeWebSocket.instances[1];
    resumedSocket.open();
    await flushPromises();

    oldSocket.message({ type: 'speech_started' });
    oldSocket.message({ type: 'speech_started' });
    oldSocket.message({ type: 'speech_started' });
    resumedSocket.message({ type: 'speech_started' });

    nowMs = 30_000;
    expect(health.snapshot().sources.mic.speechStartCount).toBe(1);
    expect(health.evaluate()).toEqual({ warning: null, transition: null });
    session.stop();
  });

  it('turns force-empty followed by the current id-less final into one text answer', async () => {
    const coordinator = new LatestForcedAnswerCoordinator(
      () => 'force-user-wav',
      () => 100_000,
    );
    const ledger = new ForcedFinalMetadataLedger();
    const askQuestion = vi.fn();
    const force = coordinator.press([], 'mic', true);
    if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);

    const session = await startLiveSession(
      {
        onTranscript: (text, isFinal, _speechFinal, metadata) => {
          if (!isFinal) return;
          const line = ledger.append(text, 'mic', metadata, 100_000);
          const decision = coordinator.acceptFinal(line, metadata?.forceRequestId);
          if (decision.action !== 'submit') return;
          dispatchForcedSttSubmission(decision, 'ru', {
            prepare: vi.fn(),
            reject: vi.fn(),
            routeVisualToScreen: () => false,
            askQuestion,
          });
        },
        onForceEmpty: (requestId) => {
          if (!requestId) return;
          coordinator.acceptEmpty(requestId);
        },
        onError: (message) => {
          throw new Error(message);
        },
      },
      { source: 'mic' },
    );

    const socket = FakeWebSocket.instances[0];
    socket.open();
    await flushPromises();
    socket.message({ type: 'force_empty', force_request_id: force.requestId });
    socket.message({
      type: 'transcript',
      text: 'Расскажи, пожалуйста, про техники тест-дизайна, какие ты знаешь.',
      is_final: true,
      speech_final: true,
      utterance_id: 'wav-2026-08-25-11-11-24',
      captured_at_ms: 99_800,
      speechEndToFinalMs: 1_650,
      openaiInferenceMs: 1_500,
    });

    expect(askQuestion).toHaveBeenCalledOnce();
    expect(askQuestion).toHaveBeenCalledWith(
      'Расскажи, пожалуйста, про техники тест-дизайна, какие ты знаешь.',
      1,
    );
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'waiting-first-token',
      requestId: null,
      consumedSequence: 1,
    });
    session.stop();
  });

  it('turns an id-less final followed by force-empty into one text answer', async () => {
    const coordinator = new LatestForcedAnswerCoordinator(
      () => 'force-final-before-empty',
      () => 100_000,
    );
    const ledger = new ForcedFinalMetadataLedger();
    const askQuestion = vi.fn();
    const force = coordinator.press([], 'mic', true);
    if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);

    const routeDecision = (
      decision: ReturnType<LatestForcedAnswerCoordinator['acceptFinal']>,
    ) => dispatchForcedSttAcceptDecision(decision, 'ru', {
      prepare: vi.fn(),
      reject: vi.fn(),
      routeVisualToScreen: () => false,
      askQuestion,
    });

    const session = await startLiveSession(
      {
        onTranscript: (text, isFinal, _speechFinal, metadata) => {
          if (!isFinal) return;
          const line = ledger.append(text, 'mic', metadata, 100_000);
          routeDecision(coordinator.acceptFinal(line, metadata?.forceRequestId));
        },
        onForceEmpty: (requestId) => {
          if (!requestId) return;
          routeDecision(coordinator.acceptEmpty(requestId));
        },
        onError: (message) => {
          throw new Error(message);
        },
      },
      { source: 'mic' },
    );

    const socket = FakeWebSocket.instances[0];
    socket.open();
    await flushPromises();
    socket.message({
      type: 'transcript',
      text: 'Привет! Расскажи, пожалуйста, про виды тестирования, которые ты знаешь.',
      is_final: true,
      speech_final: true,
      utterance_id: 'user-wav-final-before-empty',
      captured_at_ms: 99_800,
    });
    expect(askQuestion).not.toHaveBeenCalled();

    socket.message({
      type: 'force_empty',
      force_request_id: force.requestId,
    });

    expect(askQuestion).toHaveBeenCalledOnce();
    expect(askQuestion).toHaveBeenCalledWith(
      'Привет! Расскажи, пожалуйста, про виды тестирования, которые ты знаешь.',
      1,
    );
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'waiting-first-token',
      requestId: null,
      consumedSequence: 1,
    });
    session.stop();
  });

  it('threads authoritative metadata from real STT frames into rejected and store-only owners', async () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-transport-1', () => 200_000);
    const ledger = new ForcedFinalMetadataLedger();
    const diagnostics = new LiveDebugRecorder();
    diagnostics.start(16_000);
    const force = coordinator.press([], 'system', true);
    if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);
    expect(coordinator.beginScreenFallback(force.generation)).toBe(true);
    const screenRevision = coordinator.snapshot().screenRevision;
    expect(coordinator.commitScreenFirstOutput(force.generation, screenRevision)).toBe(true);

    let lowQualityMetadata: Parameters<NonNullable<import('./liveSession').LiveHandlers['onLowQuality']>>[3];
    let storedLine: ForcedTranscriptLine | null = null;
    let storeDecision: ReturnType<LatestForcedAnswerCoordinator['acceptFinal']> | null = null;

    const session = await startLiveSession(
      {
        onTranscript: (text, isFinal, _speechFinal, metadata) => {
          if (!isFinal) return;
          storedLine = ledger.append(text, 'system', metadata, 200_000);
          diagnostics.event('final', {
            text,
            source: 'system',
            meta: toSttDiagnosticMeta(metadata),
          });
          storeDecision = coordinator.acceptFinal(storedLine, metadata?.forceRequestId);
        },
        onLowQuality: (_text, _reason, _forceRequestId, metadata) => {
          lowQualityMetadata = metadata;
          diagnostics.event('low_quality', {
            text: _text,
            reason: _reason,
            source: 'system',
            meta: toSttDiagnosticMeta(metadata),
          });
        },
        onError: (message) => {
          throw new Error(message);
        },
      },
      { source: 'system' },
    );

    const socket = FakeWebSocket.instances[0];
    socket.open();
    await flushPromises();
    socket.message({
      type: 'low_quality',
      text: 'Нет',
      reason: 'too_few_words',
      utterance_id: 'rejected-turn',
      captured_at_ms: 198_500,
      queueWaitMs: 700,
      queueDepth: 3,
      speechEndToFinalMs: 900,
      openaiInferenceMs: 200,
    });
    socket.message({
      type: 'transcript',
      text: 'Какие гарантии дает этот алгоритм?',
      is_final: true,
      speech_final: true,
      force_request_id: force.requestId,
      utterance_id: 'stored-turn',
      captured_at_ms: 199_000,
      queueWaitMs: 620,
      queueDepth: 2,
      speechEndToFinalMs: 810,
      openaiInferenceMs: 190,
    });

    expect(lowQualityMetadata).toEqual({
      forceRequestId: undefined,
      utteranceId: 'rejected-turn',
      capturedAtMs: 198_500,
      queueWaitMs: 700,
      queueDepth: 3,
      speechEndToFinalMs: 900,
      openaiInferenceMs: 200,
    });
    expect(storedLine).toMatchObject({
      utteranceId: 'stored-turn',
      capturedAtMs: 199_000,
      queueWaitMs: 620,
      queueDepth: 2,
      speechEndToFinalMs: 810,
      openaiInferenceMs: 190,
    });
    expect(storeDecision).toEqual({ action: 'store-only' });
    const events = diagnostics.buildJson(null).events;
    expect(events.find((event) => event.type === 'low_quality')?.meta).toEqual({
      utteranceId: 'rejected-turn',
      capturedAtMs: 198_500,
      queueWaitMs: 700,
      queueDepth: 3,
      speechEndToFinalMs: 900,
      openaiInferenceMs: 200,
    });
    expect(events.find((event) => event.type === 'final')?.meta).toEqual({
      utteranceId: 'stored-turn',
      capturedAtMs: 199_000,
      queueWaitMs: 620,
      queueDepth: 2,
      speechEndToFinalMs: 810,
      openaiInferenceMs: 190,
    });
    session.stop();
  });
});
