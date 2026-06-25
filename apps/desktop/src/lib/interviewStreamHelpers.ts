import type { SttDebugInfo } from '../components/SttDebugPanel';
import type { PreparedTranscript } from './prepareTranscriptForLlm';
import type { StreamInterviewOpts } from './api';
import type { PipelineStreamInput } from './answerRevision';

export function sttDebugFromPrepared(
  prepared: PreparedTranscript,
  previousTopic?: string | null,
): SttDebugInfo {
  return {
    rawTranscript: prepared.rawTranscript,
    glossaryCorrected: prepared.corrected,
    intentCorrected: prepared.intentCorrected,
    correctedTranscript: prepared.intentCorrected,
    resolvedQuestion: prepared.resolvedQuestion,
    previousTopic: previousTopic ?? undefined,
    currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
    isFollowUp: prepared.followUp.isFollowUp,
    usedPreviousContext: prepared.followUp.usedPreviousContext,
    wasPreviousTopicUsed: prepared.followUp.wasPreviousTopicUsed,
    followUpReason: prepared.followUp.reason,
    resetPreviousTopic: prepared.followUp.resetPreviousTopic,
    resetPreviousTopicReason: prepared.followUp.resetPreviousTopicReason,
    hallucinationRisk: prepared.followUp.hallucinationRisk,
    resumeFactSource: prepared.answerStrategy.resumeContextLevel,
    corrections: prepared.correction.corrections,
    intentCorrections: prepared.intent.intentCorrections,
    intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
    intentReason: prepared.intent.reason,
    ambiguity: prepared.intent.ambiguity,
    questionIntent: prepared.answerStrategy.questionIntent,
    answerStrategy: prepared.answerStrategy.answerStrategy,
    resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
    resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
    resumeContextReason: prepared.answerStrategy.resumeContextReason,
  };
}

export function streamOptsFromPrepared(
  prepared: PreparedTranscript,
  previousTopic?: string | null,
): StreamInterviewOpts {
  return {
    rawQuestion: prepared.rawTranscript,
    glossaryCorrected: prepared.corrected,
    intentCorrected: prepared.intentCorrected,
    resolvedQuestion: prepared.resolvedQuestion,
    previousTopic: previousTopic ?? undefined,
    isFollowUp: prepared.followUp.isFollowUp,
    usedPreviousContext: prepared.followUp.usedPreviousContext,
    followUpReason: prepared.followUp.reason,
    currentCanonicalTopic: prepared.canonicalTopic ?? undefined,
    ambiguity: prepared.intent.ambiguity,
    corrections: prepared.correction.corrections,
    intentCorrections: prepared.intent.intentCorrections,
    intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
    intentReason: prepared.intent.reason,
    needsLlmCorrection: prepared.correction.needsLlmCorrection,
    questionIntent: prepared.answerStrategy.questionIntent,
    answerStrategy: prepared.answerStrategy.answerStrategy,
    resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
    resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
    resumeContextReason: prepared.answerStrategy.resumeContextReason,
    suggestUnclearPrefix: prepared.answerStrategy.suggestUnclearPrefix,
  };
}

export function debugInfoToPipeline(debug: SttDebugInfo | null): PipelineStreamInput | undefined {
  if (!debug) return undefined;
  return {
    rawTranscript: debug.rawTranscript,
    glossaryCorrected: debug.glossaryCorrected,
    intentCorrected: debug.intentCorrected,
    resolvedQuestion: debug.resolvedQuestion,
    questionIntent: debug.questionIntent,
    answerStrategy: debug.answerStrategy,
    previousTopic: debug.previousTopic,
    isFollowUp: debug.isFollowUp,
    usedPreviousContext: debug.usedPreviousContext,
    followUpReason: debug.followUpReason,
    currentCanonicalTopic: debug.currentCanonicalTopic,
    corrections: debug.corrections,
    intentCorrections: debug.intentCorrections,
    intentConfidence: debug.intentConfidence,
    intentReason: debug.intentReason,
    ambiguity: debug.ambiguity,
    resumeContextUsed: debug.resumeContextUsed,
    resumeContextLevel: debug.resumeContextLevel,
    resumeContextReason: debug.resumeContextReason,
  };
}

export function patchSttDebugFromMeta(
  prev: SttDebugInfo | null,
  meta: {
    llm_corrected?: string;
    question_intent?: string;
    answer_strategy?: string;
    resume_context_used?: boolean;
    resume_context_level?: string;
    resume_context_reason?: string;
  },
): SttDebugInfo | null {
  if (!prev) return prev;
  const next = { ...prev };
  const llmText = meta.llm_corrected?.trim();
  if (llmText) {
    next.llmCorrectedTranscript = llmText;
    next.intentCorrected = llmText;
  }
  if (meta.question_intent) next.questionIntent = meta.question_intent;
  if (meta.answer_strategy) next.answerStrategy = meta.answer_strategy;
  if (meta.resume_context_used != null) next.resumeContextUsed = meta.resume_context_used;
  if (meta.resume_context_level) next.resumeContextLevel = meta.resume_context_level;
  if (meta.resume_context_reason) next.resumeContextReason = meta.resume_context_reason;
  return next;
}
