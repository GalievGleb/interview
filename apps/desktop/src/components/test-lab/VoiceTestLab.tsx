import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import VoiceReportCompare from './VoiceReportCompare';
import VoiceTestDetails from './VoiceTestDetails';
import VoiceTestTable from './VoiceTestTable';
import {
  buildVoiceRegressionReport,
  exportReportCsv,
  exportReportJson,
} from '../../test-lab/voice-test-report';
import {
  compareVoiceReports,
  parseVoiceRegressionReport,
  type ReportComparison,
} from '../../test-lab/voice-test-report-compare';
import {
  initResultsFromCases,
  loadPreviousVoiceReport,
  loadVoiceTestCases,
  runSingleVoiceTest,
  saveVoiceRegressionReport,
} from '../../test-lab/voice-test-runner';
import type { VoiceRegressionReport, VoiceTestCase, VoiceTestResult } from '../../test-lab/voice-test-types';

function StatTile({
  label,
  value,
  dot,
  valueClass,
}: {
  label: string;
  value: number | string;
  dot?: string;
  valueClass?: string;
}) {
  return (
    <div className="sc-card px-4 py-3">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
        {dot && <span className={`sc-dot ${dot}`} />}
        {label}
      </p>
      <p className={`sc-mono mt-1 text-2xl font-semibold ${valueClass ?? 'text-ink'}`}>{value}</p>
    </div>
  );
}

export default function VoiceTestLab() {
  const [cases, setCases] = useState<VoiceTestCase[]>([]);
  const [results, setResults] = useState<VoiceTestResult[]>([]);
  const [report, setReport] = useState<VoiceRegressionReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [loadingCases, setLoadingCases] = useState(false);
  const [error, setError] = useState('');
  const [savedReportPath, setSavedReportPath] = useState('');
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);

  const selectedResult = useMemo(
    () => results.find((r) => r.caseId === selectedId) ?? null,
    [results, selectedId],
  );

  const summary = report?.summary;

  const handleLoadCases = useCallback(async () => {
    setLoadingCases(true);
    setError('');
    try {
      const loaded = await loadVoiceTestCases();
      setCases(loaded);
      setResults(initResultsFromCases(loaded));
      setSelectedIds(new Set(loaded.map((c) => c.id)));
      if (loaded.length > 0) setSelectedId(loaded[0].id);
      setReport(null);
      setSavedReportPath('');
      setComparison(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить cases.json');
    } finally {
      setLoadingCases(false);
    }
  }, []);

  const runAndSave = useCallback(async (toRun: VoiceTestCase[], baseResults: VoiceTestResult[]) => {
    const merged = [...baseResults];

    for (const testCase of toRun) {
      setResults((prev) =>
        prev.map((r) => (r.caseId === testCase.id ? { ...r, status: 'running' as const } : r)),
      );
      const result = await runSingleVoiceTest(testCase);
      const idx = merged.findIndex((r) => r.caseId === result.caseId);
      if (idx >= 0) merged[idx] = result;
      setResults([...merged]);
    }

    const finalReport = buildVoiceRegressionReport(merged);
    setReport(finalReport);

    try {
      const path = await saveVoiceRegressionReport(finalReport);
      setSavedReportPath(path);
      const previous = await loadPreviousVoiceReport(path);
      if (previous) {
        setComparison(compareVoiceReports(previous, finalReport));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить отчёт');
    }
  }, []);

  const handleRunAll = useCallback(async () => {
    if (cases.length === 0) return;
    setRunning(true);
    setError('');
    setSavedReportPath('');
    setComparison(null);
    await runAndSave(cases, results.length ? results : initResultsFromCases(cases));
    setRunning(false);
  }, [cases, results, runAndSave]);

  const handleRunSelected = useCallback(async () => {
    const toRun = cases.filter((c) => selectedIds.has(c.id));
    if (toRun.length === 0) return;
    setRunning(true);
    setError('');
    setSavedReportPath('');
    setComparison(null);
    await runAndSave(toRun, results.length ? results : initResultsFromCases(cases));
    setRunning(false);
  }, [cases, selectedIds, results, runAndSave]);

  const toggleSelected = useCallback((caseId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  }, []);

  const handleCompareReport = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !report) return;

    try {
      const raw = await file.text();
      const previous = parseVoiceRegressionReport(raw);
      setComparison(compareVoiceReports(previous, report));
      setError('');
    } catch (err) {
      setComparison(null);
      setError(err instanceof Error ? err.message : 'Не удалось сравнить отчёты');
    }
  }, [report]);

  return (
    <div className="flex w-full flex-col gap-4">
      {error && <div className="cockpit-alert cockpit-alert-error"><span>{error}</span></div>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={loadingCases} onClick={handleLoadCases}>
          {loadingCases ? 'Loading…' : 'Load test cases'}
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={running || selectedIds.size === 0}
          onClick={handleRunSelected}
        >
          Run selected
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!report}
          onClick={() => report && exportReportCsv(report)}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!report}
          onClick={() => report && exportReportJson(report)}
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!report}
          onClick={() => compareInputRef.current?.click()}
        >
          Compare report
        </button>
        <input
          ref={compareInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleCompareReport}
        />
        <button
          type="button"
          className="btn-primary btn-sm ml-auto"
          disabled={running || cases.length === 0}
          onClick={handleRunAll}
        >
          {running ? 'Running…' : 'Run all tests'}
        </button>
      </div>

      {comparison && <VoiceReportCompare comparison={comparison} />}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Test cases" value={summary.total} />
          <StatTile label="Passed" value={summary.passed} dot="sc-dot--success" valueClass="text-emerald-400" />
          <StatTile label="Warnings" value={summary.warning} dot="sc-dot--warning" valueClass="text-amber-300" />
          <StatTile label="Failed" value={summary.failed} dot="sc-dot--error" valueClass="text-red-400" />
          <StatTile label="Errors" value={summary.error} dot="sc-dot--error" valueClass="text-red-400" />
        </div>
      )}

      {savedReportPath && <p className="text-xs text-ink-muted">Отчёт сохранён: {savedReportPath}</p>}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <VoiceTestTable
          results={results}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelectRow={setSelectedId}
          onToggleSelected={toggleSelected}
        />
        <VoiceTestDetails result={selectedResult} />
      </div>
    </div>
  );
}
