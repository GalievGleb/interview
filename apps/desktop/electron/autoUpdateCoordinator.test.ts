import { describe, expect, it, vi } from 'vitest';
import { createAutoUpdateCoordinator } from './autoUpdateCoordinator';

describe('auto update coordinator', () => {
  it('reuses one update check for the entire active cycle', async () => {
    let resolve!: () => void;
    const checkForUpdates = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates,
      installSilently: vi.fn(),
      publish: vi.fn(),
      schedule: (fn) => fn(),
    });

    const first = coordinator.check();
    const second = coordinator.check();

    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(second).toBe(first);

    resolve();
    await Promise.all([first, second]);
    await coordinator.check();
    expect(checkForUpdates).toHaveBeenCalledOnce();

    coordinator.markNoUpdate();
    const nextCycle = coordinator.check();
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    resolve();
    await nextCycle;
  });

  it('keeps a downloaded update ready until the user clicks Update', () => {
    const installSilently = vi.fn();
    const publish = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish,
      schedule: (fn) => fn(),
    });

    coordinator.markDownloaded('0.0.16');

    expect(installSilently).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({ state: 'ready', version: '0.0.16' });

    coordinator.requestInstall();
    expect(installSilently).toHaveBeenCalledOnce();
  });

  it('installs after download if Update was clicked earlier', () => {
    const installSilently = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish: vi.fn(),
      schedule: (fn) => fn(),
    });

    coordinator.requestInstall();
    expect(installSilently).not.toHaveBeenCalled();

    coordinator.markDownloaded('0.0.16');
    expect(installSilently).toHaveBeenCalledOnce();
  });

  it('waits for a live session to end before installing once', () => {
    const installSilently = vi.fn();
    const publish = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish,
      schedule: (fn) => fn(),
    });

    coordinator.setLive(true);
    coordinator.markDownloaded('0.0.16');
    coordinator.requestInstall();

    expect(installSilently).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({
      state: 'waiting-for-session-end',
      version: '0.0.16',
    });

    coordinator.setLive(false);
    coordinator.setLive(false);
    expect(installSilently).toHaveBeenCalledOnce();
  });

  it('installs immediately when no session is active', () => {
    const installSilently = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish: vi.fn(),
      schedule: (fn) => fn(),
    });

    coordinator.markDownloaded('0.0.16');
    coordinator.requestInstall();

    expect(installSilently).toHaveBeenCalledOnce();
  });

  it('rechecks the live gate when a scheduled install starts', () => {
    const scheduled: Array<() => void> = [];
    const installSilently = vi.fn();
    const publish = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish,
      schedule: (fn) => scheduled.push(fn),
    });

    coordinator.markDownloaded('0.0.16');
    coordinator.requestInstall();
    coordinator.setLive(true);
    scheduled.shift()?.();

    expect(installSilently).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({
      state: 'waiting-for-session-end',
      version: '0.0.16',
    });

    coordinator.setLive(false);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(installSilently).toHaveBeenCalledOnce();
  });

  it('routes a legacy install request through the same live gate', () => {
    const installSilently = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish: vi.fn(),
      schedule: (fn) => fn(),
    });

    coordinator.setLive(true);
    coordinator.markDownloaded('0.0.16');
    coordinator.requestInstall();
    expect(installSilently).not.toHaveBeenCalled();

    coordinator.setLive(false);
    coordinator.requestInstall();
    expect(installSilently).toHaveBeenCalledOnce();
  });
});
