import { buildCopilotSessionExport, buildExchangeLatency, formatInterviewSessionTxt } from '../lib/interviewSessionExport';
import type { CopilotAnswerEntry } from '../lib/interviewSessionExport';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const sampleEntry: CopilotAnswerEntry = {
  id: '1',
  question: 'Что такое smoke testing?',
  spoken: 'Smoke testing — быстрая проверка, что основные функции работают.',
  ts: Date.parse('2026-06-24T12:00:00Z'),
  source: 'live',
  latency: buildExchangeLatency(4917, 4412),
  pipeline: {
    rawTranscript: 'Что такое smoke testing?',
    glossaryCorrected: 'Что такое smoke testing?',
    intentCorrected: 'Что такое smoke testing?',
    resolvedQuestion: 'Что такое smoke testing?',
    questionIntent: 'technical_definition',
  },
};

const exportData = buildCopilotSessionExport({
  sessionId: 'session-123',
  startedAt: Date.parse('2026-06-24T12:00:00Z'),
  active: false,
  transcriptLines: [{ speaker: 'other', text: 'Что такое smoke testing?', isFinal: true }],
  exchanges: [sampleEntry],
});

assert(exportData.exchanges.length === 1, 'one exchange');
assert(exportData.exchanges[0]?.latency?.sttLatencyMs === 4917, 'stt latency');
assert(exportData.exchanges[0]?.latency?.llmLatencyMs === 4412, 'llm latency');
assert(exportData.exchanges[0]?.latency?.totalLatencyMs === 9329, 'total latency');
assert(exportData.transcript.length === 1, 'one transcript line');
assert(formatInterviewSessionTxt(exportData).includes('STT: 4917 ms'), 'txt contains stt');
assert(formatInterviewSessionTxt(exportData).includes('Total: 9329 ms'), 'txt contains total');

console.log('interviewSessionExport.test.ts: ok');
