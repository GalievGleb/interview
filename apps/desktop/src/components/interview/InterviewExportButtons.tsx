import type { InterviewSessionExport } from '../../lib/interviewSessionExport';
import {
  exportInterviewSessionJson,
  exportInterviewSessionTxt,
} from '../../lib/interviewSessionExport';

interface InterviewExportButtonsProps {
  exportData: InterviewSessionExport;
  disabled?: boolean;
  compact?: boolean;
}

export default function InterviewExportButtons({
  exportData,
  disabled = false,
  compact = false,
}: InterviewExportButtonsProps) {
  const canExport =
    !disabled && (exportData.exchanges.length > 0 || exportData.transcript.length > 0);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={!canExport}
        onClick={() => exportInterviewSessionJson(exportData)}
        title="Скачать JSON для анализа в AI"
      >
        {compact ? 'JSON' : 'Export JSON'}
      </button>
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={!canExport}
        onClick={() => exportInterviewSessionTxt(exportData)}
        title="Скачать TXT для анализа в AI"
      >
        {compact ? 'TXT' : 'Export TXT'}
      </button>
    </div>
  );
}
