import type { QuestionIntent } from './classifyInterviewQuestionIntent';

export interface InterviewSessionContext {
  lastRawQuestion?: string;
  lastCorrectedQuestion?: string;
  lastIntentCorrectedQuestion?: string;
  lastQuestionIntent?: QuestionIntent;
  lastCanonicalTopic?: string;
  lastAnswerSummary?: string;
  recentTopics: string[];
  recentQuestions: string[];
}

export const MAX_RECENT_TOPICS = 5;

export function createEmptySessionContext(): InterviewSessionContext {
  return { recentTopics: [], recentQuestions: [] };
}

export interface SessionContextUpdate {
  rawQuestion: string;
  correctedQuestion: string;
  intentCorrectedQuestion: string;
  resolvedQuestion: string;
  questionIntent: QuestionIntent;
  canonicalTopic: string | null;
  answerSummary: string;
  resetPreviousTopic?: boolean;
}

export function updateSessionContextAfterAnswer(
  ctx: InterviewSessionContext,
  update: SessionContextUpdate,
): InterviewSessionContext {
  const topic = update.resetPreviousTopic
    ? update.canonicalTopic
    : (update.canonicalTopic ?? ctx.lastCanonicalTopic);
  const recentTopics =
    topic != null
      ? [topic, ...ctx.recentTopics.filter((t) => t !== topic)].slice(0, MAX_RECENT_TOPICS)
      : update.resetPreviousTopic
        ? ctx.recentTopics
        : ctx.recentTopics;
  const recentQuestions = [
    update.resolvedQuestion,
    ...ctx.recentQuestions.filter((q) => q !== update.resolvedQuestion),
  ].slice(0, MAX_RECENT_TOPICS);

  return {
    lastRawQuestion: update.rawQuestion,
    lastCorrectedQuestion: update.correctedQuestion,
    lastIntentCorrectedQuestion: update.intentCorrectedQuestion,
    lastQuestionIntent: update.questionIntent,
    lastCanonicalTopic: update.resetPreviousTopic ? (topic ?? undefined) : (topic ?? ctx.lastCanonicalTopic),
    lastAnswerSummary: update.answerSummary.slice(0, 300),
    recentTopics,
    recentQuestions,
  };
}
