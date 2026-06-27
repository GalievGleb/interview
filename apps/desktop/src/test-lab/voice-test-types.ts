export type VoiceTestStatus = 'pending' | 'running' | 'passed' | 'warning' | 'failed' | 'error';

export type VoiceTestKeywordInput = string | { key: string; aliases: string[] };

export interface VoiceTestKeywordSpec {
  key: string;
  aliases: string[];
}

export interface VoiceTestKeywordMatch {
  key: string;
  matchedAlias: string;
}

export interface VoiceTestCase {
  id: string;
  title: string;
  audioFile: string;
  expectedQuestion: string;
  requiredTranscriptKeywords: VoiceTestKeywordInput[];
  requiredAnswerKeywords: VoiceTestKeywordInput[];
  optionalAnswerKeywords?: VoiceTestKeywordInput[];
  forbiddenAnswerPhrases: string[];
  maxAnswerLengthWords: number;
  maxTotalLatencyMs: number;
}

export interface VoiceTestMetrics {
  transcriptKeywordsFound: VoiceTestKeywordMatch[];
  missingTranscriptKeywords: string[];
  transcriptScore: number;
  answerKeywordsFound: VoiceTestKeywordMatch[];
  missingAnswerKeywords: string[];
  requiredAnswerScore: number;
  optionalAnswerScore: number;
  optionalAnswerKeywordsFound: VoiceTestKeywordMatch[];
  answerScore: number;
  sttLatencyMs: number;
  llmLatencyMs: number;
  totalLatencyMs: number;
  answerWordCount: number;
  forbiddenPhrasesFound: string[];
  /** STT stage breakdown (optional — only present for newer runs). */
  modelLoadMs?: number;
  whisperInferenceMs?: number;
}

/**
 * What actually broke, so the report can separate STT-quality failures from
 * answer-quality failures from latency failures instead of lumping them together.
 */
export type VoiceTestFailureCategory =
  | 'stt-quality'
  | 'answer-quality'
  | 'latency'
  | 'forbidden'
  | 'empty-answer';

export interface VoiceTestResult {
  caseId: string;
  title: string;
  status: VoiceTestStatus;
  expectedQuestion: string;
  actualTranscript: string;
  generatedAnswer: string;
  metrics: VoiceTestMetrics;
  failureReason: string | null;
  failureCategory?: VoiceTestFailureCategory | null;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
}

export interface VoiceRegressionReport {
  generatedAt: string;
  summary: {
    total: number;
    passed: number;
    warning: number;
    failed: number;
    error: number;
  };
  results: VoiceTestResult[];
}

export interface VoiceTestRow extends VoiceTestResult {
  selected: boolean;
}
