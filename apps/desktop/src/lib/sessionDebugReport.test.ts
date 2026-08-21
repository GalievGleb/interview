import { describe, expect, it } from 'vitest';
import type { SessionDetail } from './api';
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
