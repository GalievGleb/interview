import type { ReportComparison } from '../../test-lab/voice-test-report-compare';

const toneClass: Record<string, string> = {
  passed: 'text-emerald-700',
  warning: 'text-amber-700',
  failed: 'text-red-700',
  error: 'text-red-800',
};

function formatDelta(value: number, suffix = ''): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${value}${suffix}`;
}

interface VoiceReportCompareProps {
  comparison: ReportComparison;
}

export default function VoiceReportCompare({ comparison }: VoiceReportCompareProps) {
  const { summaryDelta, regressions, improvements, latency } = comparison;

  return (
    <div className="rounded-lg border border-surface-border bg-surface-panel p-4">
      <h3 className="text-sm font-semibold text-ink">Сравнение с предыдущим отчётом</h3>
      <p className="mt-1 text-xs text-ink-muted">
        {comparison.previousGeneratedAt} → {comparison.currentGeneratedAt}
      </p>
      <p className="mt-2 text-sm text-ink">
        Summary delta: passed {formatDelta(summaryDelta.passed)}, warning {formatDelta(summaryDelta.warning)},
        failed {formatDelta(summaryDelta.failed)}, error {formatDelta(summaryDelta.error)}
      </p>

      <p className="mt-2 text-sm text-ink">
        Latency avg: total {latency.previous.avgTotalLatencyMs} → {latency.current.avgTotalLatencyMs} ms (
        {formatDelta(latency.avgTotalDeltaMs, ' ms')}), STT {formatDelta(latency.avgSttDeltaMs, ' ms')}, LLM{' '}
        {formatDelta(latency.avgLlmDeltaMs, ' ms')}
      </p>

      {regressions.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-red-700">Regressions</p>
          <ul className="mt-1 space-y-1 text-sm">
            {regressions.map((item) => (
              <li key={item.caseId}>
                <span className="font-medium">{item.title}</span>:{' '}
                <span className={toneClass[item.previousStatus]}>{item.previousStatus}</span>
                {' → '}
                <span className={toneClass[item.currentStatus]}>{item.currentStatus}</span>
                {' · score '}
                {formatDelta(item.answerScoreDelta)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {improvements.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">Improvements</p>
          <ul className="mt-1 space-y-1 text-sm">
            {improvements.map((item) => (
              <li key={item.caseId}>
                <span className="font-medium">{item.title}</span>:{' '}
                <span className={toneClass[item.previousStatus]}>{item.previousStatus}</span>
                {' → '}
                <span className={toneClass[item.currentStatus]}>{item.currentStatus}</span>
                {' · score '}
                {formatDelta(item.answerScoreDelta)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {regressions.length === 0 && improvements.length === 0 && (
        <p className="mt-2 text-sm text-ink-muted">Статусы кейсов не изменились.</p>
      )}
    </div>
  );
}
