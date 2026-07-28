import { findForbiddenPhrases, keywordKeys, matchKeywords } from './voice-test-keywords';
import type {
  VoiceTestCase,
  VoiceTestFailureCategory,
  VoiceTestMetrics,
  VoiceTestStatus,
} from './voice-test-types';

export interface SttStageTimings {
  modelLoadMs?: number;
  openaiInferenceMs?: number;
}

const OPTIONAL_SCORE_WEIGHT = 0.25;

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function scorePercent(foundCount: number, total: number): number {
  if (total === 0) return 100;
  return Math.round((foundCount / total) * 100);
}

function combineAnswerScore(requiredScore: number, optionalScore: number, hasOptional: boolean): number {
  if (!hasOptional) return requiredScore;
  return Math.min(100, requiredScore + Math.round(optionalScore * OPTIONAL_SCORE_WEIGHT));
}

type ConcisenessLevel = 'ok' | 'warning' | 'failed';

function evaluateConciseness(wordCount: number, maxWords: number): ConcisenessLevel {
  if (wordCount <= maxWords) return 'ok';
  if (wordCount <= maxWords * 1.25) return 'warning';
  return 'failed';
}

export function computeVoiceTestMetrics(
  testCase: VoiceTestCase,
  transcript: string,
  answer: string,
  sttLatencyMs: number,
  llmLatencyMs: number,
  stageTimings: SttStageTimings = {},
): VoiceTestMetrics {
  const transcriptMatch = matchKeywords(transcript, testCase.requiredTranscriptKeywords);
  const requiredAnswerMatch = matchKeywords(answer, testCase.requiredAnswerKeywords);
  const optionalKeywords = testCase.optionalAnswerKeywords ?? [];
  const optionalAnswerMatch = optionalKeywords.length
    ? matchKeywords(answer, optionalKeywords)
    : { found: [], missing: [] };
  const forbiddenPhrasesFound = findForbiddenPhrases(answer, testCase.forbiddenAnswerPhrases);
  const totalLatencyMs = sttLatencyMs + llmLatencyMs;

  const transcriptTotal = keywordKeys(testCase.requiredTranscriptKeywords).length;
  const requiredAnswerTotal = keywordKeys(testCase.requiredAnswerKeywords).length;
  const optionalAnswerTotal = keywordKeys(optionalKeywords).length;

  const requiredAnswerScore = scorePercent(requiredAnswerMatch.found.length, requiredAnswerTotal);
  const optionalAnswerScore = scorePercent(optionalAnswerMatch.found.length, optionalAnswerTotal);
  const answerScore = combineAnswerScore(
    requiredAnswerScore,
    optionalAnswerScore,
    optionalAnswerTotal > 0,
  );

  return {
    transcriptKeywordsFound: transcriptMatch.found,
    missingTranscriptKeywords: transcriptMatch.missing,
    transcriptScore: scorePercent(transcriptMatch.found.length, transcriptTotal),
    answerKeywordsFound: requiredAnswerMatch.found,
    missingAnswerKeywords: requiredAnswerMatch.missing,
    requiredAnswerScore,
    optionalAnswerScore,
    optionalAnswerKeywordsFound: optionalAnswerMatch.found,
    answerScore,
    sttLatencyMs,
    llmLatencyMs,
    totalLatencyMs,
    answerWordCount: countWords(answer),
    forbiddenPhrasesFound,
    modelLoadMs: stageTimings.modelLoadMs,
    openaiInferenceMs: stageTimings.openaiInferenceMs,
  };
}

export function resolveVoiceTestStatus(
  testCase: VoiceTestCase,
  metrics: VoiceTestMetrics,
  answer: string,
): {
  status: VoiceTestStatus;
  failureReason: string | null;
  failureCategory: VoiceTestFailureCategory | null;
} {
  const reasons: string[] = [];

  if (!answer.trim()) {
    return { status: 'failed', failureReason: 'Ответ пустой', failureCategory: 'empty-answer' };
  }

  if (metrics.forbiddenPhrasesFound.length > 0) {
    return {
      status: 'failed',
      failureReason: `Запрещённые фразы: ${metrics.forbiddenPhrasesFound.join(', ')}`,
      failureCategory: 'forbidden',
    };
  }

  const latencyHard = testCase.maxTotalLatencyMs * 1.5;
  if (metrics.totalLatencyMs > latencyHard) {
    return {
      status: 'failed',
      failureReason: `Latency ${metrics.totalLatencyMs}ms > ${Math.round(latencyHard)}ms`,
      failureCategory: 'latency',
    };
  }

  const conciseness = evaluateConciseness(metrics.answerWordCount, testCase.maxAnswerLengthWords);
  if (conciseness === 'failed') {
    return {
      status: 'failed',
      failureReason:
        `Answer length ${metrics.answerWordCount} words > ${Math.round(testCase.maxAnswerLengthWords * 1.25)} ` +
        `(max ${testCase.maxAnswerLengthWords} + 25%)`,
      failureCategory: 'answer-quality',
    };
  }

  if (metrics.transcriptScore < 50) {
    return {
      status: 'failed',
      failureReason: `Transcript score ${metrics.transcriptScore}% < 50%`,
      failureCategory: 'stt-quality',
    };
  }

  if (metrics.requiredAnswerScore < 50) {
    return {
      status: 'failed',
      failureReason: `Required answer score ${metrics.requiredAnswerScore}% < 50%`,
      failureCategory: 'answer-quality',
    };
  }

  if (metrics.transcriptScore < 70) {
    reasons.push(`Transcript score ${metrics.transcriptScore}% (50–69%)`);
  }
  if (metrics.requiredAnswerScore < 70) {
    reasons.push(`Required answer score ${metrics.requiredAnswerScore}% (50–69%)`);
  }
  if (metrics.totalLatencyMs > testCase.maxTotalLatencyMs) {
    reasons.push(
      `Latency ${metrics.totalLatencyMs}ms > ${testCase.maxTotalLatencyMs}ms (до ${Math.round(latencyHard)}ms)`,
    );
  }
  if (conciseness === 'warning') {
    reasons.push(
      `Answer length ${metrics.answerWordCount} > ${testCase.maxAnswerLengthWords} words ` +
        `(до ${Math.round(testCase.maxAnswerLengthWords * 1.25)})`,
    );
  }

  if (reasons.length > 0) {
    return { status: 'warning', failureReason: reasons.join('; '), failureCategory: null };
  }

  return { status: 'passed', failureReason: null, failureCategory: null };
}
