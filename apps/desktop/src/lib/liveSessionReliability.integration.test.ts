import { describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from './api';
import { evaluateForcedFinalTranscript } from './forcedTranscriptQuality';
import {
  completeForcedAnswerStream,
  expireDelayedForcedTranscript,
  LatestForcedAnswerCoordinator,
  markForcedAnswerStreamStarted,
  notifyDelayedForcedTranscript,
  type ForceAcceptDecision,
} from './latestForcedAnswer';
import {
  dispatchForcedSttAcceptDecision,
  ForcedFinalMetadataLedger,
} from '../hooks/useLiveCopilot';
import {
  selectForceTargetSource,
  SpeechActivityTracker,
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
  it('releases coordinator, ledger, and stream ownership across ten answers and lost-final recovery', () => {
    let request = 0;
    const coordinator = new LatestForcedAnswerCoordinator(() => `force-${++request}`);
    const ledger = new ForcedFinalMetadataLedger();
    const completedQuestions: string[] = [];
    const dispatch = (decision: ForceAcceptDecision) =>
      dispatchForcedSttAcceptDecision(decision, 'ru', {
        prepare: () => {},
        reject: (_question, _generation, reason) => { throw new Error(reason); },
        routeVisualToScreen: () => false,
        askQuestion: (question, generation) => {
          expect(markForcedAnswerStreamStarted(coordinator, generation)).toBe(true);
          completedQuestions.push(question);
          expect(completeForcedAnswerStream(coordinator, generation)).toBe(true);
        },
      });

    for (let sequence = 1; sequence <= 10; sequence += 1) {
      const force = coordinator.press([], 'system', true);
      if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);
      const line = ledger.append(
        `Вопрос номер ${sequence}?`,
        'system',
        { forceRequestId: force.requestId, utteranceId: `utterance-${sequence}` },
        sequence * 1_000,
      );
      expect(dispatch(coordinator.acceptFinal(line, force.requestId))).toBe('text');
      expect(coordinator.snapshot()).toMatchObject({
        phase: 'done', requestId: null, pendingRequestCount: 0,
      });
    }

    const lost = coordinator.press([], 'system', true);
    if (lost.action !== 'flush') throw new Error(`Expected flush, got ${lost.action}`);
    expect(expireDelayedForcedTranscript(coordinator, lost.generation, () => {})).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'error', requestId: null, pendingRequestCount: 0,
    });

    const recovered = coordinator.press([], 'system', true);
    if (recovered.action !== 'flush') throw new Error(`Expected flush, got ${recovered.action}`);
    const recoveredLine = ledger.append(
      'Восстановленный вопрос?',
      'system',
      { forceRequestId: recovered.requestId, utteranceId: 'utterance-recovered' },
      12_000,
    );
    expect(dispatch(coordinator.acceptFinal(recoveredLine, recovered.requestId))).toBe('text');
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'done', requestId: null, pendingRequestCount: 0,
    });
    expect(ledger.snapshot()).toHaveLength(11);
    expect(completedQuestions).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `Вопрос номер ${index + 1}?`),
      'Восстановленный вопрос?',
    ]);
  });

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

  it('waits for the active phrase even when an older final is already visible', () => {
    let now = 125_358;
    const coordinator = new LatestForcedAnswerCoordinator(
      () => 'force-active-continuation',
      () => now,
    );
    const activity = new SpeechActivityTracker();
    const prefix = {
      sequence: 1,
      text: 'Платёж может быть банковской картой или бонусами.',
      source: 'system' as const,
      receivedAt: 110_625,
    };

    activity.started('system', 125_281);
    const mustFlush = shouldFinalizeCurrentSpeech(
      'system',
      activity.snapshot(),
      { mic: 0, system: 1 },
      prefix.receivedAt,
      now,
      activity.latestStartedAt('system'),
    );

    expect(mustFlush).toBe(true);
    const force = coordinator.press([prefix], 'system', mustFlush);
    if (force.action !== 'flush') throw new Error(`Expected forced flush, got ${force.action}`);

    now = 126_148;
    expect(
      coordinator.acceptFinal(
        {
          sequence: 2,
          text: 'Как бы ты подходил к тестированию этой задачи?',
          source: 'system',
          receivedAt: now,
        },
        force.requestId,
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 2,
      question:
        'Платёж может быть банковской картой или бонусами. Как бы ты подходил к тестированию этой задачи?',
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

  it('submits the microphone question instead of hanging when system capture has no signal', () => {
    const now = 40_000;
    const clock = () => now;
    const sourceHealth = new LiveSourceHealth({ mic: true, system: true }, clock);
    const coordinator = new LatestForcedAnswerCoordinator(() => 'must-not-flush', clock);

    sourceHealth.markCaptureReady('system', 1, 1_000);
    sourceHealth.markCaptureReady('mic', 1, 1_000);
    sourceHealth.markSpeechStarted('mic', 1, 2_000);
    sourceHealth.markSpeechStarted('mic', 1, 4_000);
    sourceHealth.markSpeechStarted('mic', 1, 6_000);
    expect(sourceHealth.evaluate(now).warning).toBe(SYSTEM_NO_SIGNAL_WARNING);

    const finals = [{
      sequence: 1,
      text: 'Какие техники тест-дизайна вы знаете?',
      source: 'mic' as const,
      capturedAtMs: 39_000,
      receivedAt: 39_500,
    }];
    const target = selectForceTargetSource(
      { mic: true, system: true },
      { mic: false, system: false },
      { mic: 1, system: 0 },
      { systemSilent: sourceHealth.snapshot().warning === SYSTEM_NO_SIGNAL_WARNING },
    );
    const decision = coordinator.press(finals, target);

    expect(target).toBe('mic');
    expect(decision).toMatchObject({
      action: 'submit',
      question: 'Какие техники тест-дизайна вы знаете?',
    });
    expect(coordinator.snapshot().phase).toBe('waiting-first-token');
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
