import { createEmptySessionContext, updateSessionContextAfterAnswer } from '@interview/shared';
import { describe, expect, it } from 'vitest';
import { prepareTranscriptForLlm } from './prepareTranscriptForLlm';

describe('prepareTranscriptForLlm', () => {
  it('corrects list vs tuple STT errors', () => {
    const prepared = prepareTranscriptForLlm('Чем лист отличает от typo?');
    expect(prepared.resolvedQuestion.toLowerCase()).toContain('list');
    expect(prepared.resolvedQuestion.toLowerCase()).toContain('tuple');
  });

  it('resets topic when a new canonical term appears', () => {
    let ctx = createEmptySessionContext();
    const jenkins = prepareTranscriptForLlm('Что такое Jenkins?', ctx);
    ctx = updateSessionContextAfterAnswer(ctx, {
      rawQuestion: jenkins.rawTranscript,
      correctedQuestion: jenkins.corrected,
      intentCorrectedQuestion: jenkins.intentCorrected,
      resolvedQuestion: jenkins.resolvedQuestion,
      questionIntent: jenkins.answerStrategy.questionIntent,
      canonicalTopic: jenkins.canonicalTopic,
      answerSummary: 'Jenkins — CI/CD сервер.',
      resetPreviousTopic: jenkins.followUp.resetPreviousTopic,
    });

    const pom = prepareTranscriptForLlm('Что такое Page Object Model?', ctx);
    expect(pom.followUp.resetPreviousTopic).toBe(true);
    expect(pom.resolvedQuestion).not.toMatch(/Jenkins/i);
    expect(pom.canonicalTopic).toMatch(/Page Object Model/i);
  });

  it('resolves follow-up using previous topic', () => {
    let ctx = createEmptySessionContext();
    const fixtures = prepareTranscriptForLlm('Что такое pytest fixtures?', ctx);
    ctx = updateSessionContextAfterAnswer(ctx, {
      rawQuestion: fixtures.rawTranscript,
      correctedQuestion: fixtures.corrected,
      intentCorrectedQuestion: fixtures.intentCorrected,
      resolvedQuestion: fixtures.resolvedQuestion,
      questionIntent: fixtures.answerStrategy.questionIntent,
      canonicalTopic: fixtures.canonicalTopic,
      answerSummary: 'Fixtures — подготовка данных для тестов.',
      resetPreviousTopic: fixtures.followUp.resetPreviousTopic,
    });

    const followUp = prepareTranscriptForLlm('Как ты это использовал?', ctx);
    expect(followUp.followUp.isFollowUp).toBe(true);
    expect(followUp.resolvedQuestion.toLowerCase()).toContain('pytest fixtures');
  });

  it('does not treat standalone definition as follow-up after smoke testing', () => {
    let ctx = createEmptySessionContext();
    const smoke = prepareTranscriptForLlm('Что такое smoke testing?', ctx);
    ctx = updateSessionContextAfterAnswer(ctx, {
      rawQuestion: smoke.rawTranscript,
      correctedQuestion: smoke.corrected,
      intentCorrectedQuestion: smoke.intentCorrected,
      resolvedQuestion: smoke.resolvedQuestion,
      questionIntent: smoke.answerStrategy.questionIntent,
      canonicalTopic: smoke.canonicalTopic,
      answerSummary: 'Smoke — быстрая проверка основных функций.',
      resetPreviousTopic: smoke.followUp.resetPreviousTopic,
    });

    const testCase = prepareTranscriptForLlm('Что такое test case?', ctx);
    expect(testCase.followUp.resetPreviousTopic).toBe(true);
    expect(testCase.resolvedQuestion.toLowerCase()).toContain('test case');
    expect(testCase.resolvedQuestion.toLowerCase()).not.toContain('smoke');
  });
});
