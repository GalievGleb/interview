import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '../types/electron';

/** Bottom-right toast reflecting electron-updater progress (packaged app only). */
export default function UpdateToast() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => window.electronAPI?.updater?.onStatus(setStatus), []);

  if (!status || status.state === 'error') return null;

  return (
    <div className="fixed bottom-4 right-4 z-[85] w-72 rounded-2xl border border-surface-border bg-surface-elevated p-4 shadow-pop">
      {status.state === 'available' && (
        <p className="text-sm text-ink">Доступно обновление {status.version} — загружается…</p>
      )}
      {status.state === 'downloading' && (
        <>
          <p className="mb-2 flex items-center justify-between text-sm text-ink">
            <span>Загрузка обновления…</span>
            <span className="sc-mono text-ink-muted">{status.percent ?? 0}%</span>
          </p>
          <span className="sc-progress">
            <span className="sc-progress__fill" style={{ width: `${status.percent ?? 0}%` }} />
          </span>
        </>
      )}
      {status.state === 'ready' && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink">Обновление {status.version} готово</p>
          <button
            type="button"
            onClick={() => void window.electronAPI?.updater?.install()}
            className="btn-primary btn-sm"
          >
            Перезапустить
          </button>
        </div>
      )}
    </div>
  );
}
