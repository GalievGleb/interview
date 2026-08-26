import { describe, expect, it } from 'vitest';
import type { SessionDetail } from './api';
import { sanitizeDebugBundle } from './liveDebugRecorder';
import { buildSessionDebugReport } from './sessionDebugReport';

function sessionFixture(): SessionDetail {
  return {
    id: 'session-12345678',
    mode: 'interview',
    title: 'QA Automation — Acme',
    started_at: '2026-08-21T10:00:00Z',
    ended_at: '2026-08-21T10:10:00Z',
    summary: null,
    transcripts: [
      { speaker: 'other', text: 'Что такое техники тест-дизайна?', ts: '2026-08-21T10:01:00Z' },
    ],
    answers: [{
      id: 'a-1',
      question: 'Что такое техники тест-дизайна?',
      short: '',
      spoken: 'Это методы выбора проверок.',
      detailed: '',
      english: '',
      risk: '',
      model: 'openai/gpt-4.1-mini',
      ts: '2026-08-21T10:01:06Z',
    }],
    diagnostics: {
      schemaVersion: 1,
      generatedAt: '2026-08-21T10:10:00Z',
      sampleRate: 16000,
      durationMs: 600_000,
      audioFile: null,
      events: [
        { tMs: 0, type: 'session_start' },
        { tMs: 900, type: 'ready', meta: { model: 'gpt-4o-mini-transcribe', sampleRate: 16000 } },
        { tMs: 60_000, type: 'answer_started', text: 'Что такое техники тест-дизайна?' },
        { tMs: 64_500, type: 'answer_first_token' },
        { tMs: 66_200, type: 'answer_done', meta: { sttLatencyMs: 1200, llmLatencyMs: 6200 } },
        { tMs: 70_000, type: 'error', reason: 'reconnecting 1/5', meta: { recoverable: true } },
      ],
      extra: {
        sources: { mic: true, system: true },
        exchanges: [{
          question: 'Что такое техники тест-дизайна?',
          pipeline: { model: 'openai/gpt-4.1-mini', modelSource: 'live_fast' },
          latency: {
            sttLatencyMs: 1200,
            llmLatencyMs: 6200,
            totalLatencyMs: 7400,
            breakdown: { llmFirstTokenMs: 4500, llmTotalMs: 6200 },
          },
        }],
      },
    },
  };
}

describe('buildSessionDebugReport', () => {
  it('renders every retained event with explicit full counters instead of silently slicing at 500', () => {
    const session = sessionFixture();
    session.diagnostics!.schemaVersion = 2;
    session.diagnostics!.events = Array.from({ length: 650 }, (_, index) => ({
      tMs: index,
      type: 'partial' as const,
      reason: `retained-event-${index}`,
    }));
    session.diagnostics!.retention = {
      events: { limit: 1000, retained: 650, dropped: 37, total: 687 },
      screenAssists: { limit: 40, retained: 0, dropped: 0, total: 0 },
    };

    const report = buildSessionDebugReport({
      session,
      issue: 'Проверка retention.',
      app: { version: '0.0.40', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('retained-event-649');
    expect(report.content).toContain('Сохранено событий: 650');
    expect(report.content).toContain('отброшено: 37');
    expect(report.content).toContain('всего записано: 687');
  });

  it('reports sanitizer trimming counters for oversized valid event and screen arrays', () => {
    const session = sessionFixture();
    session.diagnostics = sanitizeDebugBundle({
      schemaVersion: 2,
      events: Array.from({ length: 1005 }, (_, index) => ({
        tMs: index, type: 'partial', reason: `trimmed-event-${index}`,
      })),
      extra: {
        screenAssists: Array.from({ length: 45 }, (_, index) => ({
          id: `trimmed-screen-${index}`, generation: index, status: 'done',
        })),
      },
      retention: {
        events: { retained: 1005, dropped: 0, total: 1005 },
        screenAssists: { retained: 45, dropped: 0, total: 45 },
      },
    });
    const report = buildSessionDebugReport({
      session,
      issue: 'Проверка sanitizer trimming.',
      app: { version: '0.0.40', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('Сохранено событий: 1000; отброшено: 5; всего записано: 1005');
    expect(report.content).toContain('Сохранено screen-запросов: 40; отброшено: 5; всего записано: 45');
    expect(report.content).toContain('trimmed-event-1004');
    expect(report.content).toContain('trimmed-screen-5');
  });

  it('keeps every event from old schema when no ring counters were recorded', () => {
    const session = sessionFixture();
    session.diagnostics!.events = Array.from({ length: 620 }, (_, index) => ({
      tMs: index,
      type: 'partial' as const,
      reason: `legacy-${index}`,
    }));
    const report = buildSessionDebugReport({
      session,
      issue: 'Старая схема.',
      app: { version: '0.0.39', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('legacy-619');
    expect(report.content).toContain('отброшено: не записано');
  });

  it('reports source evidence, degradation counts, and screen request details truthfully', () => {
    const session = sessionFixture();
    session.diagnostics!.schemaVersion = 2;
    session.diagnostics!.events.push(
      { tMs: 71_000, type: 'low_quality', source: 'system', reason: 'too_few_words' },
      { tMs: 72_000, type: 'source_warning', source: 'system', reason: 'system_no_signal_after_mic_speech' },
    );
    session.diagnostics!.retention = {
      events: { limit: 1000, retained: session.diagnostics!.events.length, dropped: 2, total: session.diagnostics!.events.length + 2 },
      screenAssists: { limit: 40, retained: 1, dropped: 3, total: 4 },
    };
    session.diagnostics!.extra = {
      ...session.diagnostics!.extra,
      sourceHealth: {
        warning: 'system_no_signal_after_mic_speech',
        sources: {
          mic: { requested: true, ready: true, firstSignalAtMs: 10, firstSpeechAtMs: 20, warning: null },
          system: { requested: true, ready: true, firstSignalAtMs: null, firstSpeechAtMs: null, warning: 'system_no_signal_after_mic_speech' },
        },
      },
      screenAssists: [{
        id: 'screen-1', generation: 9, startedAtMs: 80_000, trigger: 'stt_timeout',
        mode: 'deep', effectiveQuestion: 'Реши видимую задачу', status: 'done',
        model: 'openai/gpt-4.1', modelSource: 'auto', answer: 'Точный screen-ответ',
        captureMs: 110, firstOutputMs: 780, totalMs: 1600,
        imageMimeType: 'image/jpeg', encodedByteCount: 12345,
      }],
    };

    const report = buildSessionDebugReport({
      session,
      issue: 'Системный канал молчал.',
      app: { version: '0.0.40', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('| system | да | да | нет | нет | system_no_signal_after_mic_speech |');
    expect(report.content).toContain('low_quality: 1');
    expect(report.content).toContain('предупреждений источника: 1');
    expect(report.content).toContain('Запрошенный канал system не показал сигнал или речь');
    expect(report.content).toContain('Реши видимую задачу');
    expect(report.content).toContain('Точный screen-ответ');
    expect(report.content).toContain('openai/gpt-4.1');
    expect(report.content).toContain('110 мс');
    expect(report.content).toContain('780 мс');
    expect(report.content).toContain('1600 мс');
    expect(report.content).not.toContain('data:image');
  });

  it('labels provider STT and queue timings separately and never calls final-to-dispatch STT', () => {
    const session = sessionFixture();
    const exchanges = session.diagnostics!.extra!.exchanges as Array<Record<string, unknown>>;
    exchanges[0] = {
      ...exchanges[0],
      stt: {
        utteranceId: 'utterance-9', source: 'system', capturedAtMs: 1_000,
        speechEndToFinalMs: 444, openaiInferenceMs: 333, queueWaitMs: 222, queueDepth: 1,
      },
      latency: {
        ...(exchanges[0].latency as object),
        sttLatencyMs: null,
        breakdown: { finalToAnswerStartMs: 62, llmFirstTokenMs: 4500, llmTotalMs: 6200 },
      },
    };
    const report = buildSessionDebugReport({
      session,
      issue: 'Проверка подписей.',
      app: { version: '0.0.40', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('444 мс');
    expect(report.content).toContain('333 мс');
    expect(report.content).toContain('222 мс');
    expect(report.content).toContain('Final→LLM dispatch');
    expect(report.content).toContain('62 мс');
    expect(report.content).not.toMatch(/STT[^\n|]*62 мс/);
  });

  it('adds an explicit omission count instead of cutting the final report silently', () => {
    const session = sessionFixture();
    session.transcripts = Array.from({ length: 1200 }, (_, index) => ({
      speaker: 'other', text: `${index}-${'x'.repeat(900)}`, ts: '2026-08-21T10:01:00Z',
    }));
    const report = buildSessionDebugReport({
      session,
      issue: 'Большой отчёт.',
      app: { version: '0.0.40', channel: 'stable', platform: 'win32' },
    });
    expect(report.content.length).toBeLessThanOrEqual(900_000);
    expect(report.content).toMatch(/ОПУЩЕНО ИЗ-ЗА ЛИМИТА: \d+ строк/);
  });

  it('reserves space for all 1000 retained event rows before optional long sections', () => {
    const session = sessionFixture();
    session.diagnostics!.schemaVersion = 2;
    session.diagnostics!.events = Array.from({ length: 1000 }, (_, index) => ({
      tMs: index,
      type: 'partial' as const,
      reason: `event-${index}-${'e'.repeat(530)}`,
    }));
    const screens = Array.from({ length: 40 }, (_, index) => ({
      id: `screen-${index}`, generation: index, startedAtMs: index,
      trigger: 'manual' as const, mode: 'deep', effectiveQuestion: `screen question ${index}`,
      status: 'done' as const, answer: `screen-answer-${index}-${'s'.repeat(7_980)}`,
    }));
    session.diagnostics!.extra = { ...session.diagnostics!.extra, screenAssists: screens };
    session.diagnostics!.retention = {
      events: { limit: 1000, retained: 1000, dropped: 27, total: 1027 },
      screenAssists: { limit: 40, retained: 40, dropped: 2, total: 42 },
    };
    expect(JSON.stringify(session.diagnostics).length).toBeLessThan(1_000_000);

    const report = buildSessionDebugReport({
      session,
      issue: 'Большой валидный bundle.',
      app: { version: '0.0.40', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('event-999-');
    expect((report.content.match(/\| \d+ мс \| partial \|/g) ?? [])).toHaveLength(1000);
    expect(report.content).toMatch(/Screen[^\n]*ОПУЩЕНО|ОПУЩЕНО[^\n]*screen/i);
    expect(report.content.length).toBeLessThanOrEqual(900_000);
  });

  it('renders missing source-health properties as unknown without inventing degradation', () => {
    const session = sessionFixture();
    session.diagnostics!.schemaVersion = 1;
    session.diagnostics!.extra = {
      ...session.diagnostics!.extra,
      sourceHealth: { sources: { system: { requested: true } } },
    };
    const report = buildSessionDebugReport({
      session,
      issue: 'Legacy health.',
      app: { version: '0.0.39', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).toContain('| system | да | не записано | не записано | не записано | — |');
    expect(report.content).not.toContain('источник деградирован');
  });

  it('redacts legacy generic credentials, cookies, data URLs, and raw base64 text', () => {
    const session = sessionFixture();
    session.transcripts[0].text = [
      'token=generic-secret',
      'licenseKey: licensed-secret',
      'Cookie: sid=cookie-secret',
      'data:image/png;base64,QUJDREVGRw==',
      'data:text/plain;base64,c2VjcmV0LXRleHQ=',
      'data:text/plain,secret-token',
      'data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E',
      'data:application/json,%7B%22token%22%3A%22secret%22%7D',
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
    ].join(' ');
    const report = buildSessionDebugReport({
      session,
      issue: 'Privacy.',
      app: { version: '0.0.39', channel: 'stable', platform: 'win32' },
    });
    expect(report.content).not.toMatch(/generic-secret|licensed-secret|cookie-secret|secret-token|data:|%3Csvg|%7B%22token|QUJDREV|c2VjcmV0/i);
    expect(report.content).toContain('[REDACTED]');
  });

  it('preserves ordinary legacy metadata and data-science prose that is not a data URL', () => {
    const session = sessionFixture();
    const ordinary = 'metadata:model=actual userdata:value ordinary data science';
    session.transcripts[0].text = ordinary;
    const report = buildSessionDebugReport({
      session,
      issue: ordinary,
      app: { version: '0.0.39', channel: 'stable', platform: 'win32' },
    });
    expect(report.content.match(new RegExp(ordinary, 'g'))?.length).toBeGreaterThanOrEqual(2);
  });

  it('explains the session models, bottleneck, per-answer timing, and recoverable errors', () => {
    const report = buildSessionDebugReport({
      session: sessionFixture(),
      issue: 'Подсказка грузилась около пяти минут.',
      app: { version: '0.0.39', channel: 'stable', platform: 'win32 10.0.26100 x64' },
    });

    expect(report.filename).toMatch(/^skillcue-session-session-1-.*\.md$/);
    expect(report.content).toContain('Подсказка грузилась около пяти минут.');
    expect(report.content).toContain('STT: `gpt-4o-mini-transcribe`');
    expect(report.content).toContain('LLM: `openai/gpt-4.1-mini` (`live_fast`)');
    expect(report.content).toContain('| 1 | Что такое техники тест-дизайна? | 1200 мс | 4500 мс | 6200 мс | 7400 мс |');
    expect(report.content).toContain('Самый медленный этап: LLM');
    expect(report.content).toContain('reconnecting 1/5');
    expect(report.content).toContain('## Транскрипт');
  });

  it('keeps an old session useful and explicitly says that live telemetry was not recorded', () => {
    const old = sessionFixture();
    old.diagnostics = null;
    const report = buildSessionDebugReport({
      session: old,
      issue: '',
      app: { version: '0.0.38', channel: 'stable', platform: 'win32' },
    });

    expect(report.content).toContain('Live-тайминг не записывался этой версией SkillCue');
    expect(report.content).toContain('openai/gpt-4.1-mini');
    expect(report.content).toContain('Что такое техники тест-дизайна?');
  });

  it('redacts keys, authorization values, emails, and local Windows usernames', () => {
    const unsafe = sessionFixture();
    unsafe.transcripts[0].text = [
      'sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz',
      'Bearer abc.def.ghi',
      'dima@example.com',
      'C:\\Users\\student\\Documents\\resume.pdf',
    ].join(' ');

    const report = buildSessionDebugReport({
      session: unsafe,
      issue: 'Ключ SKILLCUE-max-secret-value не сработал',
      app: { version: '0.0.39', channel: 'stable', platform: 'win32' },
    });

    expect(report.content).not.toContain('sk-or-v1-');
    expect(report.content).not.toContain('abc.def.ghi');
    expect(report.content).not.toContain('dima@example.com');
    expect(report.content).not.toContain('student');
    expect(report.content).not.toContain('SKILLCUE-max-secret-value');
    expect(report.content).toContain('[REDACTED]');
    expect(report.content).toContain('%USERPROFILE%');
  });
});
