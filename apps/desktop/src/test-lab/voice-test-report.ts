import type { VoiceRegressionReport, VoiceTestResult } from './voice-test-types';

export function buildVoiceRegressionReport(results: VoiceTestResult[]): VoiceRegressionReport {
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    warning: results.filter((r) => r.status === 'warning').length,
    failed: results.filter((r) => r.status === 'failed').length,
    error: results.filter((r) => r.status === 'error').length,
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    results,
  };
}

export function reportToJson(report: VoiceRegressionReport): string {
  return JSON.stringify(report, null, 2);
}

function csvEscape(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function reportToCsv(report: VoiceRegressionReport): string {
  const header = [
    'id',
    'title',
    'status',
    'transcriptScore',
    'answerScore',
    'totalLatencyMs',
    'answerWordCount',
    'failureReason',
  ].join(',');

  const rows = report.results.map((r) =>
    [
      r.caseId,
      r.title,
      r.status,
      r.metrics.transcriptScore,
      r.metrics.answerScore,
      r.metrics.totalLatencyMs,
      r.metrics.answerWordCount,
      r.failureReason ?? '',
    ]
      .map(csvEscape)
      .join(','),
  );

  return [header, ...rows].join('\n');
}

export function downloadTextFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportReportJson(report: VoiceRegressionReport): void {
  const ts = report.generatedAt.replace(/[:.]/g, '-');
  downloadTextFile(reportToJson(report), `voice-regression-${ts}.json`, 'application/json');
}

export function exportReportCsv(report: VoiceRegressionReport): void {
  const ts = report.generatedAt.replace(/[:.]/g, '-');
  downloadTextFile(reportToCsv(report), `voice-regression-${ts}.csv`, 'text/csv');
}
