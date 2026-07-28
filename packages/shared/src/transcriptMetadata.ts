export type CorrectionConfidence = 'high' | 'medium' | 'low';

/**
 * Kept only for backward-compatible debug/session payloads.
 * The STT pipeline no longer creates transcript corrections.
 */
export interface AppliedCorrection {
  from: string;
  to: string;
  confidence: CorrectionConfidence;
}

export interface CorrectionResult {
  raw: string;
  corrected: string;
  corrections: AppliedCorrection[];
  changed: boolean;
  maxConfidence: CorrectionConfidence | 'none';
  needsLlmCorrection: boolean;
}

export interface IntentCorrection {
  from: string;
  to: string;
  reason: string;
  confidence: CorrectionConfidence;
}

export interface IntentCorrectionResult {
  raw: string;
  corrected: string;
  intentCorrected: string;
  intentCorrections: IntentCorrection[];
  changed: boolean;
  confidence: CorrectionConfidence | 'none';
  reason?: string;
  ambiguity?: string;
}
