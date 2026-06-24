import { useCallback, useMemo, useState } from 'react';
import PageHeader from '../interview/PageHeader';
import StatusBadge from '../ui/StatusBadge';
import VoiceTestDetails from './VoiceTestDetails';
import VoiceTestTable from './VoiceTestTable';
import {
  buildVoiceRegressionReport,
  exportReportCsv,
  exportReportJson,
} from '../../test-lab/voice-test-report';
import {
  initResultsFromCases,
  loadVoiceTestCases,
  runSingleVoiceTest,
  saveVoiceRegressionReport,
} from '../../test-lab/voice-test-runner';
import type { VoiceRegressionReport, VoiceTestCase, VoiceTestResult } from '../../test-lab/voice-test-types';

const actionBtn =
  'rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm font-medium transition hover:bg-surface-panel disabled:cursor-not-allowed disabled:opacity-50';

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить отчёт');
    }
  }, []);

  const handleRunAll = useCallback(async () => {
    if (cases.length === 0) return;
    setRunning(true);
    setError('');
    setSavedReportPath('');
    await runAndSave(cases, results.length ? results : initResultsFromCases(cases));
    setRunning(false);
  }, [cases, results, runAndSave]);

  const handleRunSelected = useCallback(async () => {
    const toRun = cases.filter((c) => selectedIds.has(c.id));
    if (toRun.length === 0) return;
    setRunning(true);
    setError('');
    setSavedReportPath('');
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

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 p-6">
      <PageHeader
        title="Voice Tests"
        subtitle="Voice Regression Test Mode — прогон записанных аудио через STT и LLM pipeline"
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={actionBtn} disabled={loadingCases} onClick={handleLoadCases}>
          {loadingCases ? 'Loading…' : 'Load test cases'}
        </button>
        <button
          type="button"
          className={actionBtn}
          disabled={running || cases.length === 0}
          onClick={handleRunAll}
        >
          {running ? 'Running…' : 'Run all voice tests'}
        </button>
        <button
          type="button"
          className={actionBtn}
          disabled={running || selectedIds.size === 0}
          onClick={handleRunSelected}
        >
          Run selected
        </button>
        <button
          type="button"
          className={actionBtn}
          disabled={!report}
          onClick={() => report && exportReportJson(report)}
        >
          Export report JSON
        </button>
        <button
          type="button"
          className={actionBtn}
          disabled={!report}
          onClick={() => report && exportReportCsv(report)}
        >
          Export report CSV
        </button>
      </div>

      {summary && (
        <div className="flex flex-wrap gap-2">
          <StatusBadge label={`Total ${summary.total}`} tone="idle" />
          <StatusBadge label={`Passed ${summary.passed}`} tone="success" />
          <StatusBadge label={`Warning ${summary.warning}`} tone="warning" />
          <StatusBadge label={`Failed ${summary.failed}`} tone="error" />
          <StatusBadge label={`Error ${summary.error}`} tone="error" />
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
