import type { DesktopUpdaterStatus } from './updaterStatusStore';

interface AutoUpdateDeps {
  checkForUpdates: () => Promise<unknown>;
  installSilently: () => void;
  publish: (status: DesktopUpdaterStatus) => void;
  schedule: (fn: () => void) => void;
}

export function createAutoUpdateCoordinator(deps: AutoUpdateDeps) {
  let checkPromise: Promise<unknown> | null = null;
  let updateCycleActive = false;
  let live = false;
  let downloadedVersion: string | null = null;
  let installRequested = false;
  let installScheduled = false;
  let installStarted = false;

  const publishWaiting = () => {
    if (!downloadedVersion) return;
    deps.publish({ state: 'waiting-for-session-end', version: downloadedVersion });
  };

  const maybeInstall = () => {
    if (!downloadedVersion || installStarted || !installRequested) return;
    if (live) {
      publishWaiting();
      return;
    }
    if (installScheduled) return;

    installScheduled = true;
    deps.publish({ state: 'installing', version: downloadedVersion });
    deps.schedule(() => {
      installScheduled = false;
      if (!downloadedVersion || installStarted) return;
      if (live) {
        publishWaiting();
        return;
      }
      installStarted = true;
      deps.installSilently();
    });
  };

  return {
    check(): Promise<unknown> {
      if (updateCycleActive) return checkPromise ?? Promise.resolve();
      updateCycleActive = true;
      deps.publish({ state: 'checking' });
      checkPromise = deps.checkForUpdates();
      return checkPromise;
    },
    setLive(active: boolean): void {
      live = active;
      maybeInstall();
    },
    markDownloaded(version: string): void {
      updateCycleActive = false;
      checkPromise = null;
      downloadedVersion = version;
      deps.publish({ state: 'ready', version });
      if (installRequested) maybeInstall();
    },
    requestInstall(): void {
      installRequested = true;
      maybeInstall();
    },
    markNoUpdate(): void {
      updateCycleActive = false;
      checkPromise = null;
      downloadedVersion = null;
      installRequested = false;
      installScheduled = false;
      installStarted = false;
      deps.publish({ state: 'none' });
    },
    resetAfterError(message: string): void {
      updateCycleActive = false;
      checkPromise = null;
      downloadedVersion = null;
      installRequested = false;
      installScheduled = false;
      installStarted = false;
      deps.publish({ state: 'error', message });
    },
  };
}
