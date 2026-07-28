import {
  classifyInterviewQuestionIntent,
  createEmptySessionContext,
  extractCanonicalTopic,
  getDangerQuestionStrategy,
  resolveFollowUpQuestion,
} from '@interview/shared';
import type {
  AnswerStrategyResult,
  FollowUpResolutionResult,
  InterviewSessionContext,
} from '@interview/shared';
import { normalizeTranscript } from './normalizeTranscript';

export interface PreparedTranscript {
  rawTranscript: string;
  normalized: string;
  resolvedQuestion: string;
  followUp: FollowUpResolutionResult;
  canonicalTopic: string | null;
  answerStrategy: AnswerStrategyResult;
}

/** Raw final STT -> intent/follow-up analysis, with no text correction. */
export function prepareTranscriptForLlm(
  rawTranscript: string,
  sessionContext: InterviewSessionContext = createEmptySessionContext(),
): PreparedTranscript {
  const raw = rawTranscript.trim();
  const normalized = normalizeTranscript(raw);
  const followUp = resolveFollowUpQuestion({
    raw,
    corrected: normalized,
    intentCorrected: normalized,
    sessionContext,
  });
  const resolvedQuestion = followUp.resolvedQuestion.trim();
  const topicSource = followUp.resetPreviousTopic ? normalized : resolvedQuestion;
  const canonicalTopic =
    followUp.currentTopic ??
    extractCanonicalTopic(topicSource) ??
    extractCanonicalTopic(normalized);

  let answerStrategy = classifyInterviewQuestionIntent({
    question: resolvedQuestion,
    rawQuestion: raw,
    intentChanged: followUp.usedPreviousContext,
  });
  const dangerOverride = getDangerQuestionStrategy(resolvedQuestion);
  if (dangerOverride) answerStrategy = { ...answerStrategy, ...dangerOverride };

  return {
    rawTranscript: raw,
    normalized,
    resolvedQuestion,
    followUp,
    canonicalTopic,
    answerStrategy,
  };
}
