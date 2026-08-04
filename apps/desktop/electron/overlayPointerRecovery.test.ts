import { describe, expect, it, vi } from 'vitest';
import { bindOverlayPointerRecovery } from './overlayPointerRecovery';

describe('overlay pointer recovery', () => {
  it.each(['render-process-gone', 'did-fail-load'])(
    'restores click-through after %s',
    (eventName) => {
      const listeners = new Map<string, () => void>();
      const window = {
        isDestroyed: vi.fn(() => false),
        setIgnoreMouseEvents: vi.fn(),
        webContents: {
          on: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
        },
      };

      bindOverlayPointerRecovery(window);
      listeners.get(eventName)?.();

      expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    },
  );

  it('does not touch an already destroyed window', () => {
    const listeners = new Map<string, () => void>();
    const window = {
      isDestroyed: vi.fn(() => true),
      setIgnoreMouseEvents: vi.fn(),
      webContents: {
        on: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
      },
    };

    bindOverlayPointerRecovery(window);
    listeners.get('render-process-gone')?.();

    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  });
});
