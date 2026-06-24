import {
  classifyInterviewQuestionIntent,
  correctQuestionIntent,
  IntentCorrectionResult,
} from '@interview/shared';
import type { AnswerStrategyResult } from '@interview/shared';
import type { FollowUpResolutionResult } from '@interview/shared';
import type { InterviewSessionContext } from '@interview/shared';
import { correctTranscriptWithGlossary, CorrectionResult } from '@interview/shared';
import { createEmptySessionContext } from '@interview/shared';
import { extractCanonicalTopic } from '@interview/shared';
import { getDangerQuestionStrategy } from '@interview/shared';
import { resolveFollowUpQuestion } from '@interview/shared';
import { normalizeTranscript } from './normalizeTranscript';

export interface PreparedTranscript {
  rawTranscript: string;
  normalized: string;
  corrected: string;
  intentCorrected: string;
  resolvedQuestion: string;
  correction: CorrectionResult;
  intent: IntentCorrectionResult;
  followUp: FollowUpResolutionResult;
  canonicalTopic: string | null;
  answerStrategy: AnswerStrategyResult;
}

/** STT raw → normalize → glossary → intent → follow-up resolve → answer strategy */
export function prepareTranscriptForLlm(
  rawTranscript: string,
  sessionContext: InterviewSessionContext = createEmptySessionContext(),
): PreparedTranscript {
  const raw = rawTranscript.trim();
  const normalized = normalizeTranscript(raw);
  const correction = correctTranscriptWithGlossary(normalized, {
    interviewMode: true,
    isShort: raw.length <= 120,
  });
  const intent = correctQuestionIntent({
    raw: normalized,
    corrected: correction.corrected,
    corrections: correction.corrections,
  });
  const allCorrections = [
    ...correction.corrections,
    ...intent.intentCorrections.map((c) => ({
      from: c.from,
      to: c.to,
      confidence: c.confidence,
    })),
  ];
  const followUp = resolveFollowUpQuestion({
    raw,
    corrected: correction.corrected,
    intentCorrected: intent.intentCorrected,
    sessionContext,
    corrections: allCorrections,
  });
  const resolvedQuestion = followUp.resolvedQuestion.trim();
  const topicSource = followUp.resetPreviousTopic ? intent.intentCorrected : resolvedQuestion;
  const canonicalTopic =
    followUp.currentTopic ??
    extractCanonicalTopic(topicSource, allCorrections) ??
    extractCanonicalTopic(intent.intentCorrected, allCorrections);
  let answerStrategy = classifyInterviewQuestionIntent({
    question: resolvedQuestion,
    rawQuestion: raw,
    glossaryCorrected: correction.corrected,
    intentChanged: intent.changed || followUp.usedPreviousContext,
    intentConfidence: intent.confidence !== 'none' ? intent.confidence : undefined,
    correctionMaxConfidence: correction.maxConfidence,
    ambiguity: intent.ambiguity,
  });
  const dangerOverride = getDangerQuestionStrategy(resolvedQuestion);
  if (dangerOverride) {
    answerStrategy = { ...answerStrategy, ...dangerOverride };
  }
  return {
    rawTranscript: raw,
    normalized,
    corrected: correction.corrected,
    intentCorrected: intent.intentCorrected,
    resolvedQuestion,
    correction,
    intent,
    followUp,
    canonicalTopic,
    answerStrategy,
  };
}
