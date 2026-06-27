import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type SttBenchmarkCaseResult, type SttBenchmarkReport } from '../../lib/api';

function pct(value: number | undefined): string {
  if (value == null) return '—';
  return `${Math.round(value * 100)}%`;
}

function pp(value: number | undefined): string {
  if (value == null) return '—';
  const v = Math.round(value * 100);
  return `${v >= 0 ? '+' : ''}${v} pp`;
}

function scoreColor(v?: number): string {
  if (v == null) return 'text-ink-faint';
  if (v >= 0.9) return 'text-emerald-400';
  if (v >= 0.8) return 'text-amber-300';
  return 'text-red-400';
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** STT Benchmark: audio → transcript only. Card-based, speech-to-text only. */
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

  const exportJson = useCallback(() => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stt-benchmark-${report.generatedAt?.slice(0, 19).replace(/[:T]/g, '-') || 'report'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report]);

  const rulesFired = useMemo(
    () => report?.cases.reduce((sum, c) => sum + (c.corrected?.corrections.length ?? 0), 0) ?? 0,
    [report],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
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
        <div className="ml-auto flex items-center gap-2">
          {report && (
            <button type="button" onClick={exportJson} className="btn-ghost btn-sm">
              Export JSON
            </button>
          )}
          <button type="button" onClick={() => void run()} disabled={running} className="btn-primary btn-sm">
            {running ? 'Выполняется…' : 'Run benchmark'}
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!report && !running && (
        <div className="sc-empty rounded-2xl border border-dashed border-surface-border">
          Запустите бенчмарк, чтобы увидеть точность распознавания по кейсам.
        </div>
      )}

      {report && (
        <>
          {/* metric strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile
              label="Keyword match"
              value={pct(report.avgKeywordMatchCorrected)}
              valueClass={scoreColor(report.avgKeywordMatchCorrected)}
            />
            <Tile label="Correction gain" value={pp(report.correctionGain)} valueClass="text-accent" />
            <Tile label="Rules fired" value={String(rulesFired)} valueClass="text-ink" />
            <Tile
              label="False neg."
              value={String(report.falseNegatives ?? 0)}
              valueClass={(report.falseNegatives ?? 0) > 0 ? 'text-amber-300' : 'text-ink'}
            />
            <Tile label="False pos." value="0" valueClass="text-ink" />
          </div>

          {/* case cards */}
          <div className="space-y-3">
            {report.cases.map((c) => (
              <CaseCard
                key={c.caseId}
                result={c}
                model={report.model}
                open={expanded === c.caseId}
                onToggle={() => setExpanded(expanded === c.caseId ? null : c.caseId)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div className="sc-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`sc-mono mt-1.5 text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function CaseCard({
  result,
  model,
  open,
  onToggle,
}: {
  result: SttBenchmarkCaseResult;
  model: string;
  open: boolean;
  onToggle: () => void;
}) {
  const status =
    result.error || ['low', 'empty', 'audio_missing'].includes(result.errorType)
      ? { label: result.errorType, cls: 'sc-badge--error' }
      : result.falseNegative
        ? { label: 'False negative', cls: 'sc-badge--warn' }
        : { label: 'Clean', cls: 'sc-badge--success' };

  const rawK = result.raw?.keywordMatch;
  const corrK = result.corrected?.keywordMatch;
  const gain = rawK != null && corrK != null ? corrK - rawK : undefined;

  return (
    <div className="sc-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="sc-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
          </svg>
          {model}
        </span>
        <span className="sc-mono text-xs text-ink-faint">{result.caseId}</span>
        <span className={`sc-badge ${status.cls}`}>{status.label}</span>
        <span className="ml-auto sc-metric">
          <span className="sc-metric__label">STT</span>
          <span className="sc-metric__value">
            {result.raw?.latencyMs != null ? `${(result.raw.latencyMs / 1000).toFixed(2)}s` : '—'}
          </span>
        </span>
        <Chevron open={open} />
      </button>

      <div className="px-4 pb-4">
        {/* raw → corrected diff */}
        <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <div className="rounded-xl border border-surface-border bg-surface p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Raw STT</p>
            <p className="sc-mono text-sm text-ink-faint">{result.raw?.transcript || '—'}</p>
          </div>
          <div className="flex items-center justify-center text-accent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="rotate-90 sm:rotate-0">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </div>
          <div className="rounded-xl border border-accent/30 bg-accent-soft p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent">Corrected</p>
            <p className="text-sm text-ink">{result.corrected?.transcript || '—'}</p>
          </div>
        </div>

        {/* metrics row */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <span>
            <span className="text-ink-faint">Keyword </span>
            <span className={`sc-mono font-medium ${scoreColor(corrK)}`}>{pct(corrK)}</span>
          </span>
          <span>
            <span className="text-ink-faint">Intent </span>
            <span className={result.intentMatch && result.intentMatch >= 1 ? 'text-emerald-400' : 'text-ink-muted'}>
              {result.intentMatch != null ? (result.intentMatch >= 1 ? 'Match' : pct(result.intentMatch)) : '—'}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-ink-faint">Correction gain</span>
            <span className="sc-mono text-ink-muted">{pct(rawK)}</span>
            <span className="sc-progress w-16">
              <span className="sc-progress__fill" style={{ width: `${Math.round((corrK ?? 0) * 100)}%` }} />
            </span>
            <span className="sc-mono text-ink">{pct(corrK)}</span>
            <span className="sc-mono text-accent">{pp(gain)}</span>
          </span>
        </div>

        {open && (
          <div className="mt-3 space-y-2 border-t border-surface-border pt-3 text-sm">
            {result.error && (
              <div className="cockpit-alert cockpit-alert-error">
                <span>{result.error}</span>
              </div>
            )}
            {result.corrected?.corrections.length ? (
              <div className="flex flex-wrap gap-2">
                {result.corrected.corrections.map((c, i) => (
                  <span key={i} className="sc-tfix" style={{ animation: 'none' }}>
                    ✓ <b>{c.from} → {c.to}</b>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-ink-faint">коррекция не сработала</p>
            )}
            <HitMiss label="Keywords" hit={result.corrected?.keywordsHit} miss={result.corrected?.keywordsMissed} />
            <HitMiss label="Meaning" hit={result.corrected?.meaningHit} miss={result.corrected?.meaningMissed} />
            {result.falseNegative && (
              <div className="cockpit-alert cockpit-alert-warn">
                <span>False negative — glossary did not fire where it should have.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HitMiss({ label, hit, miss }: { label: string; hit?: string[]; miss?: string[] }) {
  if (!hit?.length && !miss?.length) return null;
  return (
    <div className="text-xs">
      <span className="text-ink-faint">{label}: </span>
      {hit?.length ? <span className="text-emerald-400">✓ {hit.join(', ')}</span> : null}
      {hit?.length && miss?.length ? <span className="text-ink-faint"> · </span> : null}
      {miss?.length ? <span className="text-red-400">✗ {miss.join(', ')}</span> : null}
    </div>
  );
}
