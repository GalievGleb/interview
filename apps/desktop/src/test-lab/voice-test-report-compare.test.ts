import { describe, expect, it } from 'vitest';
import { compareVoiceReports, formatSummaryDelta } from './voice-test-report-compare';
import type { VoiceRegressionReport } from './voice-test-types';

function makeReport(
  generatedAt: string,
  rows: Array<{ id: string; status: 'passed' | 'warning' | 'failed'; answerScore: number }>,
): VoiceRegressionReport {
  return {
    generatedAt,
    summary: {
      total: rows.length,
      passed: rows.filter((r) => r.status === 'passed').length,
      warning: rows.filter((r) => r.status === 'warning').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      error: 0,
    },
    results: rows.map((row) => ({
      caseId: row.id,
      title: row.id,
      status: row.status,
      expectedQuestion: 'q',
      actualTranscript: 't',
      generatedAnswer: 'a',
      metrics: {
        transcriptKeywordsFound: [],
        missingTranscriptKeywords: [],
        transcriptScore: 100,
        answerKeywordsFound: [],
        missingAnswerKeywords: [],
        requiredAnswerScore: row.answerScore,
        optionalAnswerScore: 0,
        optionalAnswerKeywordsFound: [],
        answerScore: row.answerScore,
        sttLatencyMs: 1000,
        llmLatencyMs: 2000,
        totalLatencyMs: 3000,
        answerWordCount: 50,
        forbiddenPhrasesFound: [],
      },
      failureReason: null,
      startedAt: generatedAt,
      finishedAt: generatedAt,
    })),
  };
}

describe('compareVoiceReports', () => {
  it('detects regression and improvement', () => {
    const previous = makeReport('2026-01-01', [
      { id: 'a', status: 'passed', answerScore: 90 },
      { id: 'b', status: 'failed', answerScore: 40 },
    ]);
    const current = makeReport('2026-01-02', [
      { id: 'a', status: 'warning', answerScore: 80 },
      { id: 'b', status: 'passed', answerScore: 95 },
    ]);

    const comparison = compareVoiceReports(previous, current);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]?.caseId).toBe('a');
    expect(comparison.improvements).toHaveLength(1);
    expect(comparison.improvements[0]?.caseId).toBe('b');
    expect(formatSummaryDelta(comparison)).toContain('passed 0');
  });
});
