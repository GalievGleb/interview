import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '../types/electron';
import { useI18n } from '../lib/i18n';

/** Bottom-right toast reflecting electron-updater progress (packaged app only). */
export default function UpdateToast() {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => window.electronAPI?.updater?.onStatus(setStatus), []);

  if (!status || status.state === 'error') return null;

  return (
    <div className="fixed bottom-4 right-4 z-[85] w-72 rounded-2xl border border-surface-border bg-surface-elevated p-4 shadow-pop">
      {status.state === 'available' && (
        <p className="text-sm text-ink">
          {t('update.availablePre')} {status.version} — {t('update.downloadingInline')}
        </p>
      )}
      {status.state === 'downloading' && (
        <>
          <p className="mb-2 flex items-center justify-between text-sm text-ink">
            <span>{t('update.downloading')}</span>
            <span className="sc-mono text-ink-muted">{status.percent ?? 0}%</span>
          </p>
          <span className="sc-progress">
            <span className="sc-progress__fill" style={{ width: `${status.percent ?? 0}%` }} />
          </span>
        </>
      )}
      {status.state === 'ready' && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink">
            {t('update.readyPre')} {status.version} {t('update.readyPost')}
          </p>
          <button
            type="button"
            onClick={() => void window.electronAPI?.updater?.install()}
            className="btn-primary btn-sm"
          >
            {t('update.restart')}
          </button>
        </div>
      )}
    </div>
  );
}
