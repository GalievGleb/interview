import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { UpdaterStatus } from '../types/electron';
import { useI18n } from '../lib/i18n';

/** Bottom-right toast reflecting electron-updater progress (packaged app only). */
export default function UpdateToast() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => {
    const updater = window.electronAPI?.updater;
    if (!updater) return;
    let receivedLiveStatus = false;
    const unsubscribe = updater.onStatus((next) => {
      receivedLiveStatus = true;
      setStatus(next);
    });
    void updater.getStatus?.().then((current) => {
      if (!receivedLiveStatus) setStatus(current);
    });
    return unsubscribe;
  }, []);

  if (
    pathname === '/settings' ||
    !status ||
    status.state === 'idle' ||
    status.state === 'checking' ||
    status.state === 'none' ||
    status.state === 'error'
  ) {
    return null;
  }

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
    </div>
  );
}
