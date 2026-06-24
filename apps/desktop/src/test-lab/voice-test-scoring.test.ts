import { describe, it, expect } from 'vitest';
import { computeVoiceTestMetrics, resolveVoiceTestStatus } from './voice-test-scoring';
import type { VoiceTestCase } from './voice-test-types';

const baseCase: VoiceTestCase = {
  id: 'test',
  title: 'test',
  audioFile: 'x.wav',
  expectedQuestion: 'q',
  requiredTranscriptKeywords: [{ key: 'pytest', aliases: ['pytest'] }],
  requiredAnswerKeywords: [
    { key: 'fixture', aliases: ['fixture'] },
    { key: 'scope', aliases: ['scope', 'function'] },
    { key: 'conftest', aliases: ['conftest'] },
    { key: 'setup/teardown', aliases: ['setup', 'yield'] },
  ],
  optionalAnswerKeywords: [
    { key: 'function', aliases: ['function'] },
    { key: 'test data', aliases: ['test data'] },
  ],
  forbiddenAnswerPhrases: [],
  maxAnswerLengthWords: 90,
  maxTotalLatencyMs: 10000,
};

describe('voice-test-scoring', () => {
  it('passes when all required keywords present', () => {
    const answer = 'Fixtures для setup и scope function/class. conftest.py для shared fixtures, yield для cleanup.';
    const metrics = computeVoiceTestMetrics(baseCase, 'pytest fixtures', answer, 100, 200);
    expect(metrics.requiredAnswerScore).toBe(100);
    expect(metrics.answerScore).toBeGreaterThanOrEqual(100);
    const status = resolveVoiceTestStatus(baseCase, metrics, answer);
    expect(status.status).toBe('passed');
  });

  it('boosts score with optional keywords but caps at 100', () => {
    const answer = 'fixture и scope function. conftest + setup. test data для API.';
    const metrics = computeVoiceTestMetrics(baseCase, 'pytest', answer, 100, 200);
    expect(metrics.requiredAnswerScore).toBe(100);
    expect(metrics.optionalAnswerScore).toBe(100);
    expect(metrics.answerScore).toBe(100);
  });

  it('warns when answer slightly exceeds max length', () => {
    const words = Array.from({ length: 95 }, (_, i) => `word${i}`).join(' ');
    const answer = `${words} fixture scope conftest setup yield function`;
    const metrics = computeVoiceTestMetrics(baseCase, 'pytest', answer, 100, 200);
    const status = resolveVoiceTestStatus(baseCase, metrics, answer);
    expect(status.status).toBe('warning');
  });

  it('fails when answer far exceeds max length', () => {
    const words = Array.from({ length: 114 }, (_, i) => `word${i}`).join(' ');
    const answer = `${words} fixture scope conftest setup`;
    const metrics = computeVoiceTestMetrics(baseCase, 'pytest', answer, 100, 200);
    const status = resolveVoiceTestStatus(baseCase, metrics, answer);
    expect(status.status).toBe('failed');
  });
});
