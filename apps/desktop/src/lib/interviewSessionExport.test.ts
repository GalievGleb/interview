import { describe, it, expect } from 'vitest';
import { buildCopilotSessionExport, buildExchangeLatency, buildStoredSessionExport, formatInterviewSessionTxt } from '../lib/interviewSessionExport';
import type { CopilotAnswerEntry } from '../lib/interviewSessionExport';
import type { SessionDetail } from '../lib/api';

const sampleEntry: CopilotAnswerEntry = {
  id: '1',
  question: 'Что такое smoke testing?',
  spoken: 'Smoke testing — быстрая проверка, что основные функции работают.',
  ts: Date.parse('2026-06-24T12:00:00Z'),
  source: 'live',
  latency: buildExchangeLatency(4917, 4412),
  pipeline: {
    rawTranscript: 'Что такое smoke testing?',
    normalizedTranscript: 'Что такое smoke testing?',
    resolvedQuestion: 'Что такое smoke testing?',
    questionIntent: 'technical_definition',
  },
};

describe('interviewSessionExport', () => {
  const exportData = buildCopilotSessionExport({
    sessionId: 'session-123',
    startedAt: Date.parse('2026-06-24T12:00:00Z'),
    active: false,
    transcriptLines: [{ speaker: 'other', text: 'Что такое smoke testing?', isFinal: true }],
    exchanges: [sampleEntry],
  });

  it('captures exchanges and latency', () => {
    expect(exportData.exchanges.length).toBe(1);
    expect(exportData.exchanges[0]?.latency?.sttLatencyMs).toBe(4917);
    expect(exportData.exchanges[0]?.latency?.llmLatencyMs).toBe(4412);
    expect(exportData.exchanges[0]?.latency?.totalLatencyMs).toBe(9329);
    expect(exportData.transcript.length).toBe(1);
  });

  it('formats latency into the txt export', () => {
    const txt = formatInterviewSessionTxt(exportData);
    expect(txt).toContain('STT: 4917 ms');
    expect(txt).toContain('Total: 9329 ms');
    expect(txt).not.toContain('Glossary');
  });

  it('keeps stored answer model, timestamp, and durable diagnostics for old history pages', () => {
    const stored: SessionDetail = {
      id: 'stored-1',
      mode: 'interview',
      title: 'QA Automation',
      started_at: '2026-08-21T10:00:00Z',
      ended_at: '2026-08-21T10:30:00Z',
      summary: null,
      transcripts: [],
      answers: [{
        id: 'answer-1',
        question: 'Что такое API?',
        short: '',
        spoken: 'API — интерфейс взаимодействия программ.',
        detailed: '',
        english: '',
        risk: '',
        model: 'openai/gpt-4.1-mini',
        ts: '2026-08-21T10:05:00Z',
      }],
      diagnostics: {
        schemaVersion: 1,
        generatedAt: '2026-08-21T10:30:00Z',
        sampleRate: 16000,
        durationMs: 1_800_000,
        audioFile: null,
        events: [{ tMs: 2500, type: 'answer_first_token' }],
      },
    };

    const result = buildStoredSessionExport(stored);

    expect(result.exchanges[0]?.ts).toBe('2026-08-21T10:05:00.000Z');
    expect(result.exchanges[0]?.pipeline?.model).toBe('openai/gpt-4.1-mini');
    expect(result.diagnostics?.events[0]?.type).toBe('answer_first_token');
  });
});
