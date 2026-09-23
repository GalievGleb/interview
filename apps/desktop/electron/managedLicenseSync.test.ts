import { describe, expect, it, vi } from 'vitest';
import { syncManagedLicenseAfterBackendReady } from './managedLicenseSync';

describe('managed license startup sync', () => {
  it('waits for restored sign-in and retries a transient backend timeout', async () => {
    let finishRestore!: () => void;
    const accountReady = new Promise<void>((resolve) => { finishRestore = resolve; });
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error('backend startup timeout'))
      .mockResolvedValueOnce(true);
    const publish = vi.fn();
    const wait = vi.fn(async () => undefined);
    const onError = vi.fn();
    const task = syncManagedLicenseAfterBackendReady({
      accountReady, sync, publish, wait, shouldStop: () => false, onError,
    });

    expect(sync).not.toHaveBeenCalled();
    finishRestore();
    expect(await task).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(publish).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('stops retrying when the app quits', async () => {
    let stopped = false;
    const sync = vi.fn(async () => { stopped = true; throw new Error('timeout'); });
    const publish = vi.fn();
    const result = await syncManagedLicenseAfterBackendReady({
      accountReady: null,
      sync,
      publish,
      wait: async () => undefined,
      shouldStop: () => stopped,
      onError: vi.fn(),
    });
    expect(result).toBe(false);
    expect(sync).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
