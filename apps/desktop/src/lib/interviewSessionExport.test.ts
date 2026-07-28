import { describe, it, expect } from 'vitest';
import { buildCopilotSessionExport, buildExchangeLatency, formatInterviewSessionTxt } from '../lib/interviewSessionExport';
import type { CopilotAnswerEntry } from '../lib/interviewSessionExport';

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
});
