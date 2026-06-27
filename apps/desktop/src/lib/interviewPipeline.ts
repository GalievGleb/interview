import {
  createEmptySessionContext,
  sanitizeLiveAnswer,
  updateSessionContextAfterAnswer,
  type InterviewSessionContext,
} from '@interview/shared';
import { api } from '../lib/api';
import { prepareTranscriptForLlm, type PreparedTranscript } from '../lib/prepareTranscriptForLlm';
import { stripExperienceFooter } from '../lib/normalizeTranscript';

export async function transcribeAudioFile(caseId: string): Promise<{
  transcript: string;
  sttLatencyMs: number;
  timings?: { modelLoadMs: number; whisperInferenceMs: number; audioBytes: number; modelReused: boolean };
}> {
  const data = await api.voiceTestTranscribe(caseId);
  return { transcript: data.transcript, sttLatencyMs: data.sttLatencyMs, timings: data.timings };
}

export function generateAnswerFromTranscript(
  rawTranscript: string,
  sessionContext: InterviewSessionContext = createEmptySessionContext(),
): Promise<{
  answer: string;
  prepared: PreparedTranscript;
  llmLatencyMs: number;
  sessionContext: InterviewSessionContext;
}> {
  const prepared = prepareTranscriptForLlm(rawTranscript, sessionContext);
  const started = performance.now();

  return new Promise((resolve, reject) => {
    let accumulated = '';
    api.streamInterview(
      prepared.resolvedQuestion,
      {
        onChunk: (chunk) => {
          accumulated += chunk;
        },
        onDone: (spoken) => {
          const answer = sanitizeLiveAnswer(stripExperienceFooter(spoken || accumulated));
          const llmLatencyMs = Math.round(performance.now() - started);
          const nextContext = updateSessionContextAfterAnswer(sessionContext, {
            rawQuestion: prepared.rawTranscript,
            correctedQuestion: prepared.corrected,
            intentCorrectedQuestion: prepared.intentCorrected,
            resolvedQuestion: prepared.resolvedQuestion,
            questionIntent: prepared.answerStrategy.questionIntent,
            canonicalTopic: prepared.canonicalTopic,
            answerSummary: answer,
            resetPreviousTopic: prepared.followUp.resetPreviousTopic,
          });
          resolve({ answer, prepared, llmLatencyMs, sessionContext: nextContext });
        },
        onError: (msg) => reject(new Error(msg)),
      },
      {
        rawQuestion: prepared.rawTranscript,
        glossaryCorrected: prepared.corrected,
        intentCorrected: prepared.intentCorrected,
        resolvedQuestion: prepared.resolvedQuestion,
        previousTopic: sessionContext.lastCanonicalTopic,
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
      },
    );
  });
}
