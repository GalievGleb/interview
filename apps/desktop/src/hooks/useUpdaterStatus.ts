import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '../types/electron';

/** Текущий статус electron-updater в установленном приложении. */
export function useUpdaterStatus(): UpdaterStatus | null {
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

  return status;
}
