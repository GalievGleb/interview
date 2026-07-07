import type { InterviewSessionExport } from '../../lib/interviewSessionExport';
import {
  exportInterviewSessionJson,
  exportInterviewSessionMd,
  exportInterviewSessionTxt,
} from '../../lib/interviewSessionExport';
import { useI18n } from '../../lib/i18n';

interface InterviewExportButtonsProps {
  exportData: InterviewSessionExport;
  disabled?: boolean;
  compact?: boolean;
  /** Download the debug bundle (mic WAV + timestamped event timeline). */
  onDownloadDebug?: () => boolean | void;
}

export default function InterviewExportButtons({
  exportData,
  disabled = false,
  compact = false,
  onDownloadDebug,
}: InterviewExportButtonsProps) {
  const { t } = useI18n();
  const canExport =
    !disabled && (exportData.exchanges.length > 0 || exportData.transcript.length > 0);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={!canExport}
        onClick={() => exportInterviewSessionJson(exportData)}
        title={t('export.jsonTitle')}
      >
        {compact ? 'JSON' : t('export.json')}
      </button>
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={!canExport}
        onClick={() => exportInterviewSessionTxt(exportData)}
        title={t('export.txtTitle')}
      >
        {compact ? 'TXT' : t('export.txt')}
      </button>
      <button
        type="button"
        className="btn-secondary btn-sm"
        disabled={!canExport}
        onClick={() => exportInterviewSessionMd(exportData)}
        title={t('export.mdTitle')}
      >
        {compact ? 'MD' : t('export.md')}
      </button>
      {onDownloadDebug && (
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!canExport}
          onClick={() => onDownloadDebug()}
          title={t('export.debugTitle')}
        >
          {compact ? t('export.debug') : t('export.debugFull')}
        </button>
      )}
    </div>
  );
}
