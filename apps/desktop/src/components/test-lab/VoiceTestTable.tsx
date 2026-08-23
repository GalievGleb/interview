import StatusBadge from '../ui/StatusBadge';
import type { VoiceTestResult, VoiceTestStatus } from '../../test-lab/voice-test-types';

function statusTone(status: VoiceTestStatus): 'success' | 'warning' | 'error' | 'idle' {
  switch (status) {
    case 'passed':
      return 'success';
    case 'warning':
      return 'warning';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

interface VoiceTestTableProps {
  results: VoiceTestResult[];
  selectedId: string | null;
  selectedIds: Set<string>;
  onSelectRow: (caseId: string) => void;
  onToggleSelected: (caseId: string) => void;
}

export default function VoiceTestTable({
  results,
  selectedId,
  selectedIds,
  onSelectRow,
  onToggleSelected,
}: VoiceTestTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-surface-border bg-surface-panel">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-surface-border bg-surface text-xs uppercase tracking-wide text-ink-faint">
          <tr>
            <th className="px-3 py-2.5 w-10" />
            <th className="px-3 py-2.5">ID</th>
            <th className="px-3 py-2.5">Title</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Transcript</th>
            <th className="px-3 py-2.5">Answer</th>
            <th className="px-3 py-2.5">Latency</th>
            <th className="px-3 py-2.5">Words</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => {
            const active = selectedId === row.caseId;
            return (
              <tr
                key={row.caseId}
                className={`cursor-pointer border-b border-surface-border/70 transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  active ? 'bg-accent/5' : ''
                }`}
                onClick={() => onSelectRow(row.caseId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectRow(row.caseId);
                  }
                }}
                tabIndex={0}
              >
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.caseId)}
                    onChange={() => onToggleSelected(row.caseId)}
                    className="rounded border-surface-border"
                  />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">{row.caseId}</td>
                <td className="px-3 py-2.5">{row.title}</td>
                <td className="px-3 py-2.5">
                  <StatusBadge label={row.status} tone={statusTone(row.status)} />
                </td>
                <td className="px-3 py-2.5">{row.metrics.transcriptScore}%</td>
                <td className="px-3 py-2.5">{row.metrics.answerScore}%</td>
                <td className="px-3 py-2.5">{row.metrics.totalLatencyMs} ms</td>
                <td className="px-3 py-2.5">{row.metrics.answerWordCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {results.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-ink-faint">Нет тестов. Нажмите Load test cases.</p>
      )}
    </div>
  );
}
