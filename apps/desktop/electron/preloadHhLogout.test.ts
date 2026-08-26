import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe('HH logout preload bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    electron.exposeInMainWorld.mockClear();
    electron.invoke.mockClear();
  });

  it('routes an account logout through the dedicated HH assistant IPC channel', async () => {
    await import('./preload');
    const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'electronAPI');
    const api = exposed?.[1] as { hhAssistant?: { logout?: () => Promise<unknown> } } | undefined;

    await api?.hhAssistant?.logout?.();

    expect(electron.invoke).toHaveBeenCalledWith('hh-assistant:logout');
  });
});
