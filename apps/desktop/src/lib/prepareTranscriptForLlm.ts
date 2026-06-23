import { correctQuestionIntent, IntentCorrectionResult } from '@interview/shared';
import { correctTranscriptWithGlossary, CorrectionResult } from '@interview/shared';
import { normalizeTranscript } from './normalizeTranscript';

export interface PreparedTranscript {
  rawTranscript: string;
  normalized: string;
  corrected: string;
  intentCorrected: string;
  correction: CorrectionResult;
  intent: IntentCorrectionResult;
}

/** STT raw → normalize → glossary → question intent */
export function prepareTranscriptForLlm(rawTranscript: string): PreparedTranscript {
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
  return {
    rawTranscript: raw,
    normalized,
    corrected: correction.corrected,
    intentCorrected: intent.intentCorrected,
    correction,
    intent,
  };
}
