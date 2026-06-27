import { createEmptySessionContext } from '@interview/shared';
import { api } from '../lib/api';
import { generateAnswerFromTranscript, transcribeAudioFile } from '../lib/interviewPipeline';
import { keywordKeys } from './voice-test-keywords';
import { buildVoiceRegressionReport } from './voice-test-report';
import { assertVoiceRegressionReport } from './voice-test-report-compare';
import { computeVoiceTestMetrics, resolveVoiceTestStatus } from './voice-test-scoring';
import type {
  VoiceRegressionReport,
  VoiceTestCase,
  VoiceTestResult,
  VoiceTestStatus,
} from './voice-test-types';

export async function loadVoiceTestCases(): Promise<VoiceTestCase[]> {
  const data = await api.voiceTestCases();
  return data.cases as VoiceTestCase[];
}

function pendingResult(testCase: VoiceTestCase): VoiceTestResult {
  const now = new Date().toISOString();
  return {
    caseId: testCase.id,
    title: testCase.title,
    status: 'pending',
    expectedQuestion: testCase.expectedQuestion,
    actualTranscript: '',
    generatedAnswer: '',
    metrics: {
      transcriptKeywordsFound: [],
      missingTranscriptKeywords: keywordKeys(testCase.requiredTranscriptKeywords),
      transcriptScore: 0,
      answerKeywordsFound: [],
      missingAnswerKeywords: keywordKeys(testCase.requiredAnswerKeywords),
      requiredAnswerScore: 0,
      optionalAnswerScore: 0,
      optionalAnswerKeywordsFound: [],
      answerScore: 0,
      sttLatencyMs: 0,
      llmLatencyMs: 0,
      totalLatencyMs: 0,
      answerWordCount: 0,
      forbiddenPhrasesFound: [],
    },
    failureReason: null,
    startedAt: now,
    finishedAt: now,
  };
}

export async function runSingleVoiceTest(
  testCase: VoiceTestCase,
  onStatus?: (status: VoiceTestStatus) => void,
): Promise<VoiceTestResult> {
  const startedAt = new Date().toISOString();
  onStatus?.('running');

  try {
    const { transcript, sttLatencyMs, timings } = await transcribeAudioFile(testCase.id);
    const { answer, llmLatencyMs } = await generateAnswerFromTranscript(
      transcript,
      createEmptySessionContext(),
    );

    const metrics = computeVoiceTestMetrics(testCase, transcript, answer, sttLatencyMs, llmLatencyMs, {
      modelLoadMs: timings?.modelLoadMs,
      whisperInferenceMs: timings?.whisperInferenceMs,
    });
    const { status, failureReason, failureCategory } = resolveVoiceTestStatus(testCase, metrics, answer);

    return {
      caseId: testCase.id,
      title: testCase.title,
      status,
      expectedQuestion: testCase.expectedQuestion,
      actualTranscript: transcript,
      generatedAnswer: answer,
      metrics,
      failureReason,
      failureCategory,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      caseId: testCase.id,
      title: testCase.title,
      status: 'error',
      expectedQuestion: testCase.expectedQuestion,
      actualTranscript: '',
      generatedAnswer: '',
      metrics: pendingResult(testCase).metrics,
      failureReason: message,
      errorMessage: message,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

export async function runVoiceTests(
  cases: VoiceTestCase[],
  opts: {
    onCaseStart?: (caseId: string) => void;
    onCaseComplete?: (result: VoiceTestResult) => void;
  } = {},
): Promise<VoiceRegressionReport> {
  const results: VoiceTestResult[] = [];

  for (const testCase of cases) {
    opts.onCaseStart?.(testCase.id);
    const result = await runSingleVoiceTest(testCase);
    results.push(result);
    opts.onCaseComplete?.(result);
  }

  return buildVoiceRegressionReport(results);
}

export async function saveVoiceRegressionReport(report: VoiceRegressionReport): Promise<string> {
  const saved = await api.voiceTestSaveReport(report);
  return saved.path;
}

export async function listSavedVoiceReports() {
  const response = await api.voiceTestListReports();
  return response.reports;
}

export async function loadSavedVoiceReport(filename: string): Promise<VoiceRegressionReport> {
  const raw = await api.voiceTestGetReport(filename);
  return assertVoiceRegressionReport(raw);
}

export async function loadPreviousVoiceReport(currentPath?: string): Promise<VoiceRegressionReport | null> {
  const reports = await listSavedVoiceReports();
  if (reports.length < 2) return null;

  const currentName = currentPath ? currentPath.split(/[/\\]/).pop() : undefined;
  const previous = reports.find((item) => item.filename !== currentName) ?? reports[1];
  if (!previous) return null;

  return loadSavedVoiceReport(previous.filename);
}

export function initResultsFromCases(cases: VoiceTestCase[]): VoiceTestResult[] {
  return cases.map(pendingResult);
}
