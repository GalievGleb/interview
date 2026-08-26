import { describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from './api';
import { evaluateForcedFinalTranscript } from './forcedTranscriptQuality';
import {
  LatestForcedAnswerCoordinator,
  notifyDelayedForcedTranscript,
  type ForceAcceptDecision,
} from './latestForcedAnswer';
import {
  selectForceTargetSource,
  shouldFinalizeCurrentSpeech,
} from './forceLiveAnswer';
import { sanitizeDebugBundle, type DebugEvent } from './liveDebugRecorder';
import { LiveSourceHealth, SYSTEM_NO_SIGNAL_WARNING } from './liveSourceHealth';
import {
  ActiveScreenAssistCancellation,
  ScreenAssistDiagnostics,
} from './screenAssistDiagnostics';
import { buildSessionDebugReport } from './sessionDebugReport';

describe('live session reliability integration', () => {
  it('answers consecutive interviewer questions without candidate speech stealing the cursor', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');
    const sources = { mic: true, system: true };
    const firstFinals = [
      {
        sequence: 1,
        text: 'Расскажи про принципы ООП.',
        source: 'system' as const,
      },
      {
        sequence: 2,
        text: 'Не припомнилось, прикинь.',
        source: 'mic' as const,
      },
    ];
    const firstTarget = selectForceTargetSource(
      sources,
      { mic: true, system: false },
      { mic: 1, system: 1 },
    );

    expect(firstTarget).toBe('system');
    expect(coordinator.press(firstFinals, firstTarget)).toMatchObject({
      action: 'submit',
      sequence: 1,
      question: 'Расскажи про принципы ООП.',
    });

    const secondFinals = [
      ...firstFinals,
      {
        sequence: 3,
        text: 'А чем абстракция отличается от инкапсуляции?',
        source: 'system' as const,
      },
      {
        sequence: 4,
        text: 'Сейчас попробую ответить.',
        source: 'mic' as const,
      },
    ];
    const secondTarget = selectForceTargetSource(
      sources,
      { mic: true, system: false },
      { mic: 1, system: 1 },
    );

    expect(secondTarget).toBe('system');
    expect(coordinator.press(secondFinals, secondTarget)).toMatchObject({
      action: 'submit',
      sequence: 3,
      question: 'А чем абстракция отличается от инкапсуляции?',
    });
  });

  it('keeps a short-pause continuation in the same Ctrl+Enter question', () => {
    let now = 8_193;
    const coordinator = new LatestForcedAnswerCoordinator(
      () => 'force-split-question',
      () => now,
    );
    const prefix = {
      sequence: 1,
      text: 'Какие техники',
      source: 'mic' as const,
      receivedAt: 7_561,
    };

    const mustFlush = shouldFinalizeCurrentSpeech(
      'mic',
      { mic: false, system: false },
      { mic: 1, system: 0 },
      prefix.receivedAt,
      now,
    );
    expect(mustFlush).toBe(true);
    const force = coordinator.press([prefix], 'mic', mustFlush);
    if (force.action !== 'flush') throw new Error(`Expected forced flush, got ${force.action}`);

    // finalize crossed the wire just before speech_started; keep ownership of
    // the next id-less final instead of answering the incomplete prefix.
    expect(coordinator.acceptEmpty(force.requestId)).toEqual({
      action: 'wait',
      generation: 1,
    });
    now = 10_327;
    expect(
      coordinator.acceptFinal({
        sequence: 2,
        text: 'тест-дизайна ты знаешь?',
        source: 'mic',
        receivedAt: now,
      }),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 2,
      question: 'Какие техники тест-дизайна ты знаешь?',
    });
  });

  it('waits through delayed STT and submits Ctrl+Enter through text without a screen request', () => {
    let now = 200_000;
    const coordinator = new LatestForcedAnswerCoordinator(
      () => 'force-test-design',
      () => now,
    );
    const screen = new ScreenAssistDiagnostics(() => now);
    const waiting = vi.fn();
    let textSseStarts = 0;

    const force = coordinator.press([], 'system', true);
    if (force.action !== 'flush') throw new Error(`Expected forced flush, got ${force.action}`);

    // Move beyond the former 3.5-second automatic screen fallback boundary.
    now += 5_000;
    expect(notifyDelayedForcedTranscript(coordinator, force.generation, waiting)).toBe(true);
    expect(waiting).toHaveBeenCalledOnce();
    expect(screen.snapshot().entries).toEqual([]);
    expect(coordinator.snapshot().phase).toBe('finalizing-transcript');

    const decision = coordinator.acceptFinal(
      {
        sequence: 1,
        text: 'Какие техники тест-дизайна ты применяешь?',
        source: 'system',
        capturedAtMs: 204_500,
        receivedAt: now,
      },
      force.requestId,
    );
    if (decision.action === 'submit') textSseStarts += 1;

    expect(decision).toMatchObject({
      action: 'submit',
      question: 'Какие техники тест-дизайна ты применяешь?',
    });
    expect(textSseStarts).toBe(1);
    expect(screen.snapshot().entries).toEqual([]);
  });

  it('keeps committed screen output authoritative and exports bounded adversarial evidence', () => {
    let now = 100_000;
    const clock = () => now;
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-screen-1', clock);
    const screen = new ScreenAssistDiagnostics(clock);
    const sourceHealth = new LiveSourceHealth({ mic: true, system: true }, clock);
    const screenCancellation = new ActiveScreenAssistCancellation();
    let textSseStarts = 0;
    let textSseCancels = 0;

    sourceHealth.markCaptureReady('mic', 1);
    sourceHealth.markCaptureReady('system', 1);
    sourceHealth.markSpeechStarted('mic', 1);
    sourceHealth.markSpeechStarted('mic', 1);
    sourceHealth.markSpeechStarted('mic', 1);

    const force = coordinator.press([], 'system', true);
    if (force.action !== 'flush') throw new Error(`Expected forced flush, got ${force.action}`);
    expect(force).toEqual({
      action: 'flush', generation: 1, requestId: 'force-screen-1', source: 'system',
    });
    expect(coordinator.beginScreenFallback(force.generation)).toBe(true);

    screen.reset(100_000);
    const screenId = screen.request({
      id: 'screen-1',
      generation: force.generation,
      trigger: 'stt_timeout',
      mode: 'deep',
      effectiveQuestion: 'Реши задачу, видимую на экране',
    });
    screenCancellation.register(() => { textSseCancels += 1; });
    now += 120;
    expect(screen.captured(screenId, 'data:image/jpeg;base64,QUJDRA==')).toBe(true);
    now += 680;
    expect(screen.firstOutput(screenId, 'Авторитетный ответ с экрана')).toBe(true);
    const screenRevision = coordinator.snapshot().screenRevision;
    expect(coordinator.commitScreenFirstOutput(force.generation, screenRevision)).toBe(true);
    now += 700;
    expect(screen.done(screenId, {
      answer: 'Авторитетный ответ с экрана',
      model: 'openai/gpt-4.1',
      modelSource: 'screen_auto',
    })).toBe(true);

    // This is both foreign garbage and older than the 20-second capture limit.
    now = 130_001;
    const delayedFinal = {
      sequence: 1,
      text: 'Hücum',
      source: 'system' as const,
      utteranceId: 'turn-4',
      capturedAtMs: 109_999,
      receivedAt: now,
      queueWaitMs: 21_000,
      queueDepth: 1,
      speechEndToFinalMs: 21_100,
      openaiInferenceMs: 100,
    };
    expect(evaluateForcedFinalTranscript(
      delayedFinal.text,
      'ru',
      force.requestId,
      coordinator.snapshot().requestId,
      delayedFinal.source,
      coordinator.snapshot().source,
      delayedFinal.capturedAtMs,
      now,
    )).toEqual({ action: 'defer-to-coordinator' });
    const lateDecision: ForceAcceptDecision = coordinator.acceptFinal(
      delayedFinal,
      force.requestId,
    );
    if (lateDecision.action === 'submit') textSseStarts += 1;
    expect(lateDecision).toEqual({ action: 'store-only' });
    expect(coordinator.snapshot().screenOutputCommitted).toBe(true);
    expect(textSseStarts).toBe(0);
    expect(textSseCancels).toBe(0);

    const healthResult = sourceHealth.evaluate(now);
    expect(healthResult).toEqual({
      warning: SYSTEM_NO_SIGNAL_WARNING,
      transition: 'warning',
    });
    expect(sourceHealth.snapshot().sources.system.ready).toBe(true);

    const screenSnapshot = screen.snapshot();
    const rawEvents: DebugEvent[] = Array.from({ length: 1_001 }, (_, index) => ({
      tMs: index,
      type: 'partial' as const,
      source: 'system' as const,
      reason: `rapid-event-${index}`,
    }));
    rawEvents.push({
      tMs: 30_001,
      type: 'source_warning',
      source: 'system',
      reason: SYSTEM_NO_SIGNAL_WARNING,
    });
    const diagnostics = sanitizeDebugBundle({
      schemaVersion: 2,
      generatedAt: '2026-08-24T00:00:00.000Z',
      sampleRate: 16_000,
      durationMs: 30_001,
      audioFile: null,
      events: rawEvents,
      retention: {
        events: { limit: 1_000, retained: rawEvents.length, dropped: 0, total: rawEvents.length },
        screenAssists: screenSnapshot.retention,
      },
      extra: {
        sources: { mic: true, system: true },
        sourceHealth: sourceHealth.snapshot(),
        exchanges: [{
          id: 'screen-exchange-1',
          question: 'Hücum',
          source: 'live',
          stt: {
            utteranceId: delayedFinal.utteranceId,
            source: delayedFinal.source,
            capturedAtMs: delayedFinal.capturedAtMs,
            queueWaitMs: delayedFinal.queueWaitMs,
            queueDepth: delayedFinal.queueDepth,
            speechEndToFinalMs: delayedFinal.speechEndToFinalMs,
            openaiInferenceMs: delayedFinal.openaiInferenceMs,
          },
          latency: {
            sttLatencyMs: null,
            llmLatencyMs: null,
            totalLatencyMs: null,
            breakdown: { finalToAnswerStartMs: 0 },
          },
        }],
        screenAssists: screenSnapshot.entries,
      },
    });
    const session: SessionDetail = {
      id: 'adversarial-session',
      mode: 'interview',
      title: 'Adversarial reliability fixture',
      started_at: '2026-08-24T00:00:00.000Z',
      ended_at: '2026-08-24T00:00:30.001Z',
      summary: null,
      transcripts: [{
        speaker: 'other', text: delayedFinal.text, ts: '2026-08-24T00:00:30.001Z',
      }],
      answers: [],
      diagnostics,
    };
    const report = buildSessionDebugReport({
      session,
      issue: 'Проверка перегрузки STT и screen fallback.',
      app: { version: '0.0.40', channel: 'test', platform: 'win32' },
    }).content;

    expect(report).toContain('Сохранено событий: 1000; отброшено: 2; всего записано: 1002');
    expect(report).toContain('| system | да | да | нет | нет | system_no_signal_after_mic_speech |');
    expect(report).toContain('turn-4');
    expect(report).toContain('21000 мс');
    expect(report).toContain('| 1 | turn-4 | system | 109999 мс | 21100 мс | 100 мс | 21000 мс | 1 | 0 мс |');
    expect(report).toContain('Реши задачу, видимую на экране');
    expect(report).toContain('openai/gpt-4.1');
    expect(report).toContain('screen_auto');
    expect(report).toContain('120 мс');
    expect(report).toContain('800 мс');
    expect(report).toContain('1500 мс');
    expect(report).toContain('Авторитетный ответ с экрана');
    expect(session.answers).toEqual([]);
    expect(JSON.stringify(diagnostics)).not.toContain('QUJDRA==');
    expect(report).not.toContain('QUJDRA==');
    expect(report).not.toContain('data:image');
  });
});
