import { describe, expect, it, vi } from 'vitest';
import { LazyWindow, showWindowAfterRendererReady } from './lazyWindow';

function fakeWindow() {
  let readyListener: (() => void) | null = null;
  return {
    destroyed: false,
    loading: true,
    window: {
      isDestroyed: () => false,
      webContents: {
        isLoadingMainFrame: () => true,
        once: (_event: 'did-finish-load', listener: () => void) => {
          readyListener = listener;
        },
      },
    },
    finishLoading: () => readyListener?.(),
  };
}

describe('lazy Electron window lifecycle', () => {
  it('does not create a hidden renderer until the window is requested', () => {
    const create = vi.fn(() => ({ isDestroyed: () => false }));
    const slot = new LazyWindow(create);

    expect(create).not.toHaveBeenCalled();
    expect(slot.peek()).toBeNull();

    const first = slot.getOrCreate();
    expect(create).toHaveBeenCalledOnce();
    expect(slot.getOrCreate()).toBe(first);
    expect(create).toHaveBeenCalledOnce();
  });

  it('does not reveal the first overlay before its renderer has loaded', async () => {
    const pending = fakeWindow();
    const show = vi.fn();

    const shown = showWindowAfterRendererReady(pending.window, show);
    expect(show).not.toHaveBeenCalled();

    pending.finishLoading();
    await shown;
    expect(show).toHaveBeenCalledOnce();
  });
});
