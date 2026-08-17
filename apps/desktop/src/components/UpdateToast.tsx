import { useLocation } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { useUpdaterStatus } from '../hooks/useUpdaterStatus';
import { shouldShowUpdateButton } from '../lib/updaterPrompt';

/** Bottom-right toast reflecting electron-updater progress (packaged app only). */
export default function UpdateToast() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const status = useUpdaterStatus();

  if (
    pathname === '/settings' ||
    !status ||
    !shouldShowUpdateButton(status.state)
  ) {
    return null;
  }

  const installing = status.state === 'installing';

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
          <div className="sc-progress">
            <div className="sc-progress__fill" style={{ width: `${status.percent ?? 0}%` }} />
          </div>
        </>
      )}
      {status.state === 'ready' && (
        <p className="text-sm text-ink">
          {t('update.readyPre')} {status.version} {t('update.readyPost')}
        </p>
      )}
      {status.state === 'waiting-for-session-end' && (
        <p className="text-sm text-ink">{t('update.waitingForSessionEnd')}</p>
      )}
      {status.state === 'installing' && (
        <p className="text-sm text-ink">{t('update.installing')}</p>
      )}
      <button
        type="button"
        className="btn-primary btn-sm mt-3 w-full"
        disabled={installing}
        onClick={() => void window.electronAPI?.updater?.install()}
      >
        {t('update.apply')}
      </button>
    </div>
  );
}
