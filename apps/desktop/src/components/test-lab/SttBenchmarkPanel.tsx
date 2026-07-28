import { useCallback, useEffect, useState } from 'react';
import { api, type SttBenchmarkReport } from '../../lib/api';

function pct(value: number | undefined): string {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

export default function SttBenchmarkPanel() {
  const [report, setReport] = useState<SttBenchmarkReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [reports, setReports] = useState<Array<{ filename: string; modifiedAt: string }>>([]);

  const loadReports = useCallback(async () => {
    try {
      setReports((await api.sttBenchmarkReports()).reports);
    } catch {
      // История не блокирует новый прогон.
    }
  }, []);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      setReport(await api.sttBenchmarkRunAll(true));
      await loadReports();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось запустить бенчмарк');
    } finally {
      setRunning(false);
    }
  };

  const exportJson = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `stt-benchmark-${report.generatedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="sc-badge sc-badge--accent">OpenAI · gpt-4o-mini-transcribe</span>
        {reports.length > 0 && (
          <select
            className="select-compact min-w-[220px]"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) {
                void api.sttBenchmarkReport(event.target.value).then(setReport);
              }
            }}
          >
            <option value="">История отчетов</option>
            {reports.map((item) => (
              <option key={item.filename} value={item.filename}>
                {item.filename}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex gap-2">
          {report && (
            <button type="button" onClick={exportJson} className="btn-ghost btn-sm">
              Скачать JSON
            </button>
          )}
          <button type="button" onClick={() => void run()} disabled={running} className="btn-primary btn-sm">
            {running ? 'Выполняется…' : 'Запустить бенчмарк'}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {!report && !running && (
        <div className="sc-empty rounded-2xl border border-dashed border-surface-border">
          Бенчмарк оценивает исходный текст OpenAI Mini без словарей и автоматических замен.
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Модель" value={report.model} />
            <Metric label="Средняя задержка" value={`${(report.avgLatencyMs / 1000).toFixed(2)} с`} />
            <Metric label="Совпадение терминов" value={pct(report.avgKeywordMatchRaw)} />
            <Metric label="Кейсов" value={String(report.caseCount)} />
          </div>

          <div className="space-y-3">
            {report.cases.map((item) => (
              <article key={item.caseId} className="sc-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="sc-mono text-xs text-ink-faint">{item.caseId}</span>
                  <span className="font-medium text-ink">{item.title ?? item.caseId}</span>
                  <span className="ml-auto sc-badge">
                    {item.raw?.latencyMs != null
                      ? `${(item.raw.latencyMs / 1000).toFixed(2)} с`
                      : 'Ошибка'}
                  </span>
                </div>
                {item.error ? (
                  <p className="mt-3 text-sm text-red-400">{item.error}</p>
                ) : (
                  <>
                    <p className="mt-3 text-sm leading-relaxed text-ink">{item.raw?.transcript || 'Пусто'}</p>
                    <p className="mt-2 text-xs text-ink-faint">
                      Совпадение терминов: {pct(item.raw?.keywordMatch)}
                    </p>
                  </>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="sc-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="sc-mono mt-1.5 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}
