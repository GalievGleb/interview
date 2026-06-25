import type { VoiceRegressionReport, VoiceTestResult, VoiceTestStatus } from './voice-test-types';

const STATUS_RANK: Record<VoiceTestStatus, number> = {
  passed: 0,
  warning: 1,
  failed: 2,
  error: 3,
  pending: 4,
  running: 5,
};

export interface ReportCaseDelta {
  caseId: string;
  title: string;
  previousStatus: VoiceTestStatus;
  currentStatus: VoiceTestStatus;
  statusChanged: boolean;
  answerScoreDelta: number;
  transcriptScoreDelta: number;
  totalLatencyDelta: number;
  failureReason?: string | null;
}

export interface ReportComparison {
  previousGeneratedAt: string;
  currentGeneratedAt: string;
  summaryDelta: {
    passed: number;
    warning: number;
    failed: number;
    error: number;
  };
  latency: LatencyComparison;
  cases: ReportCaseDelta[];
  regressions: ReportCaseDelta[];
  improvements: ReportCaseDelta[];
}

export interface LatencySummary {
  avgTotalLatencyMs: number;
  avgSttLatencyMs: number;
  avgLlmLatencyMs: number;
  maxTotalLatencyMs: number;
}

export interface LatencyComparison {
  previous: LatencySummary;
  current: LatencySummary;
  avgTotalDeltaMs: number;
  avgSttDeltaMs: number;
  avgLlmDeltaMs: number;
}

function findResult(results: VoiceTestResult[], caseId: string): VoiceTestResult | undefined {
  return results.find((item) => item.caseId === caseId);
}

function isRegression(prev: VoiceTestStatus, current: VoiceTestStatus): boolean {
  return STATUS_RANK[current] > STATUS_RANK[prev];
}

function isImprovement(prev: VoiceTestStatus, current: VoiceTestStatus): boolean {
  return STATUS_RANK[current] < STATUS_RANK[prev];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function summarizeReportLatency(report: VoiceRegressionReport): LatencySummary {
  const rows = report.results.filter(
    (item) => item.status !== 'pending' && item.status !== 'running' && item.status !== 'error',
  );
  if (rows.length === 0) {
    return { avgTotalLatencyMs: 0, avgSttLatencyMs: 0, avgLlmLatencyMs: 0, maxTotalLatencyMs: 0 };
  }
  const totals = rows.map((item) => item.metrics.totalLatencyMs);
  return {
    avgTotalLatencyMs: average(totals),
    avgSttLatencyMs: average(rows.map((item) => item.metrics.sttLatencyMs)),
    avgLlmLatencyMs: average(rows.map((item) => item.metrics.llmLatencyMs)),
    maxTotalLatencyMs: Math.max(...totals),
  };
}

function compareLatency(previous: VoiceRegressionReport, current: VoiceRegressionReport): LatencyComparison {
  const prev = summarizeReportLatency(previous);
  const curr = summarizeReportLatency(current);
  return {
    previous: prev,
    current: curr,
    avgTotalDeltaMs: curr.avgTotalLatencyMs - prev.avgTotalLatencyMs,
    avgSttDeltaMs: curr.avgSttLatencyMs - prev.avgSttLatencyMs,
    avgLlmDeltaMs: curr.avgLlmLatencyMs - prev.avgLlmLatencyMs,
  };
}

export function compareVoiceReports(
  previous: VoiceRegressionReport,
  current: VoiceRegressionReport,
): ReportComparison {
  const caseIds = new Set([
    ...previous.results.map((item) => item.caseId),
    ...current.results.map((item) => item.caseId),
  ]);

  const cases: ReportCaseDelta[] = [];

  for (const caseId of caseIds) {
    const prev = findResult(previous.results, caseId);
    const curr = findResult(current.results, caseId);
    if (!prev || !curr) continue;

    cases.push({
      caseId,
      title: curr.title,
      previousStatus: prev.status,
      currentStatus: curr.status,
      statusChanged: prev.status !== curr.status,
      answerScoreDelta: curr.metrics.answerScore - prev.metrics.answerScore,
      transcriptScoreDelta: curr.metrics.transcriptScore - prev.metrics.transcriptScore,
      totalLatencyDelta: curr.metrics.totalLatencyMs - prev.metrics.totalLatencyMs,
      failureReason: curr.failureReason,
    });
  }

  return {
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    summaryDelta: {
      passed: current.summary.passed - previous.summary.passed,
      warning: current.summary.warning - previous.summary.warning,
      failed: current.summary.failed - previous.summary.failed,
      error: current.summary.error - previous.summary.error,
    },
    latency: compareLatency(previous, current),
    cases,
    regressions: cases.filter((item) => isRegression(item.previousStatus, item.currentStatus)),
    improvements: cases.filter((item) => isImprovement(item.previousStatus, item.currentStatus)),
  };
}

export function parseVoiceRegressionReport(raw: string): VoiceRegressionReport {
  return assertVoiceRegressionReport(JSON.parse(raw) as unknown);
}

export function assertVoiceRegressionReport(data: unknown): VoiceRegressionReport {
  const parsed = data as VoiceRegressionReport;
  if (!parsed?.generatedAt || !Array.isArray(parsed.results)) {
    throw new Error('Invalid voice regression report JSON');
  }
  return parsed;
}

function formatDelta(value: number, suffix = ''): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${value}${suffix}`;
}

export function formatSummaryDelta(comparison: ReportComparison): string {
  const { summaryDelta } = comparison;
  return [
    `passed ${formatDelta(summaryDelta.passed)}`,
    `warning ${formatDelta(summaryDelta.warning)}`,
    `failed ${formatDelta(summaryDelta.failed)}`,
    `error ${formatDelta(summaryDelta.error)}`,
  ].join(', ');
}
