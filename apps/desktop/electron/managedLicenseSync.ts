interface ManagedLicenseSyncOptions {
  accountReady: Promise<unknown> | null;
  sync: () => Promise<unknown>;
  publish: () => void;
  wait: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  onError: (error: unknown) => void;
}

/** Backend startup and account restore run concurrently; retry transient local IPC failures. */
export async function syncManagedLicenseAfterBackendReady({
  accountReady, sync, publish, wait, shouldStop, onError,
}: ManagedLicenseSyncOptions): Promise<boolean> {
  try {
    await accountReady;
  } catch (error) {
    onError(error);
  }

  for (const delayMs of [0, 1_000, 3_000, 6_000]) {
    if (shouldStop()) return false;
    if (delayMs) await wait(delayMs);
    if (shouldStop()) return false;
    try {
      await sync();
      publish();
      return true;
    } catch (error) {
      onError(error);
    }
  }
  return false;
}
