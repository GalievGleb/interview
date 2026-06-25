import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type SttBenchmarkCaseResult,
  type SttBenchmarkReport,
} from '../../lib/api';

function pct(value: number | undefined): string {
  if (value == null) return '—';
  return `${Math.round(value * 100)}%`;
}

const ERROR_TONE: Record<string, string> = {
  ok: 'text-emerald-400',
  partial: 'text-amber-300',
  low: 'text-red-400',
  empty: 'text-red-400',
  audio_missing: 'text-red-400',
};

/**
 * STT Benchmark: audio → transcript only. No LLM, no answer keywords.
 * Compares Whisper raw vs glossary-corrected transcripts with latency and
 * transcript-keyword match.
 */
export default function SttBenchmarkPanel() {
  const [report, setReport] = useState<SttBenchmarkReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [reports, setReports] = useState<Array<{ filename: string; modifiedAt: string }>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    try {
      const r = await api.sttBenchmarkReports();
      setReports(r.reports);
    } catch {
      // ignore — history is non-critical
    }
  }, []);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const run = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const rep = await api.sttBenchmarkRunAll(true);
      setReport(rep);
      await loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось запустить бенчмарк');
    } finally {
      setRunning(false);
    }
  }, [loadReports]);

  const openReport = useCallback(async (filename: string) => {
    if (!filename) return;
    setError('');
    try {
      setReport(await api.sttBenchmarkReport(filename));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось открыть отчёт');
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink">STT Benchmark</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          Только аудио → транскрипт. Без LLM. Сравнение Whisper raw против исправленного глоссарием.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void run()} disabled={running} className="btn-primary">
            {running ? 'Выполняется…' : 'Запустить бенчмарк'}
          </button>
          {reports.length > 0 && (
            <select
              className="select-compact min-w-[220px]"
              defaultValue=""
              onChange={(e) => void openReport(e.target.value)}
            >
              <option value="">История отчётов…</option>
              {reports.map((r) => (
                <option key={r.filename} value={r.filename}>
                  {r.filename}
                </option>
              ))}
            </select>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>

      {report && (
        <>
          <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
            <Metric label="Движок" value={`${report.engine} · ${report.model}`} />
            <Metric label="Средняя латентность" value={`${report.avgLatencyMs} ms`} />
            <Metric
              label="Keyword raw → corrected"
              value={`${pct(report.avgKeywordMatchRaw)} → ${pct(report.avgKeywordMatchCorrected)}`}
            />
            <Metric label="Прирост от коррекции" value={pct(report.correctionGain)} />
          </div>

          <div className="card overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-surface-border text-left text-xs text-ink-faint">
                <tr>
                  <th className="px-4 py-2">Case</th>
                  <th className="px-4 py-2">Raw</th>
                  <th className="px-4 py-2">Corrected</th>
                  <th className="px-4 py-2">Intent</th>
                  <th className="px-4 py-2">Fixes</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {report.cases.map((c) => (
                  <CaseRow
                    key={c.caseId}
                    result={c}
                    open={expanded === c.caseId}
                    onToggle={() => setExpanded(expanded === c.caseId ? null : c.caseId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-ink">{value}</p>
    </div>
  );
}

function CaseRow({
  result,
  open,
  onToggle,
}: {
  result: SttBenchmarkCaseResult;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = ERROR_TONE[result.errorType] ?? 'text-ink-muted';
  return (
    <>
      <tr className="cursor-pointer border-b border-surface-border/60 hover:bg-surface-hover" onClick={onToggle}>
        <td className="px-4 py-2 text-ink">{result.caseId}</td>
        <td className="px-4 py-2 text-ink-muted">{pct(result.raw?.keywordMatch)}</td>
        <td className="px-4 py-2 text-ink">{pct(result.corrected?.keywordMatch)}</td>
        <td className="px-4 py-2 text-ink-muted">{pct(result.intentMatch)}</td>
        <td className="px-4 py-2 text-ink-muted">{result.corrected?.corrections.length ?? 0}</td>
        <td className={`px-4 py-2 font-medium ${tone}`}>{result.errorType}</td>
      </tr>
      {open && (
        <tr className="border-b border-surface-border/60 bg-surface">
          <td colSpan={6} className="px-4 py-3">
            {result.error ? (
              <p className="text-sm text-red-400">{result.error}</p>
            ) : (
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-xs text-ink-faint">Raw:</span>{' '}
                  <span className="text-ink-muted">{result.raw?.transcript || '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-ink-faint">Corrected:</span>{' '}
                  <span className="text-ink">{result.corrected?.transcript || '—'}</span>
                </div>
                {result.corrected?.corrections.length ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {result.corrected.corrections.map((c, i) => (
                      <span
                        key={i}
                        className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
                      >
                        {c.from} → {c.to}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
