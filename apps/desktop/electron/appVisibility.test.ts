import { describe, expect, it, vi } from 'vitest';
import { setAppHiddenFromSwitcher } from './appVisibility';

describe('app visibility by desktop platform', () => {
  it('hides and restores the Dock icon on macOS', () => {
    const window = { setSkipTaskbar: vi.fn() };
    const dock = { hide: vi.fn(), show: vi.fn() };

    setAppHiddenFromSwitcher('darwin', true, window, dock);
    setAppHiddenFromSwitcher('darwin', false, window, dock);

    expect(dock.hide).toHaveBeenCalledOnce();
    expect(dock.show).toHaveBeenCalledOnce();
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it('uses the native taskbar flag on Windows', () => {
    const window = { setSkipTaskbar: vi.fn() };
    const dock = { hide: vi.fn(), show: vi.fn() };

    setAppHiddenFromSwitcher('win32', true, window, dock);

    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(dock.hide).not.toHaveBeenCalled();
  });
});
