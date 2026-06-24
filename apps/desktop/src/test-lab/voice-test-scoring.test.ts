import { computeVoiceTestMetrics, resolveVoiceTestStatus } from './voice-test-scoring';
import type { VoiceTestCase } from './voice-test-types';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

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

function testRequiredOnlyPass(): void {
  const answer = 'Fixtures для setup и scope function/class. conftest.py для shared fixtures, yield для cleanup.';
  const metrics = computeVoiceTestMetrics(baseCase, 'pytest fixtures', answer, 100, 200);
  assert(metrics.requiredAnswerScore === 100, `required score ${metrics.requiredAnswerScore}`);
  assert(metrics.answerScore >= 100, `combined score ${metrics.answerScore}`);
  const status = resolveVoiceTestStatus(baseCase, metrics, answer);
  assert(status.status === 'passed', status.failureReason ?? status.status);
}

function testOptionalBoost(): void {
  const answer = 'fixture и scope function. conftest + setup. test data для API.';
  const metrics = computeVoiceTestMetrics(baseCase, 'pytest', answer, 100, 200);
  assert(metrics.requiredAnswerScore === 100, 'all required');
  assert(metrics.optionalAnswerScore === 100, 'optional found');
  assert(metrics.answerScore === 100, 'boost capped');
}

function testConcisenessWarning(): void {
  const words = Array.from({ length: 95 }, (_, i) => `word${i}`).join(' ');
  const answer = `${words} fixture scope conftest setup yield function`;
  const metrics = computeVoiceTestMetrics(baseCase, 'pytest', answer, 100, 200);
  const status = resolveVoiceTestStatus(baseCase, metrics, answer);
  assert(status.status === 'warning', `expected warning, got ${status.status}`);
}

function testConcisenessFailed(): void {
  const words = Array.from({ length: 114 }, (_, i) => `word${i}`).join(' ');
  const answer = `${words} fixture scope conftest setup`;
  const metrics = computeVoiceTestMetrics(baseCase, 'pytest', answer, 100, 200);
  const status = resolveVoiceTestStatus(baseCase, metrics, answer);
  assert(status.status === 'failed', `expected failed, got ${status.status}`);
}

testRequiredOnlyPass();
testOptionalBoost();
testConcisenessWarning();
testConcisenessFailed();
console.log('voice-test-scoring.test.ts: ok');
