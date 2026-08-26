import { describe, expect, it, vi } from 'vitest';
import {
  hideOverlayAndShowMain,
  openOverlayOverWorkspace,
  hideOverlayOnly,
  hideWindowOnClose,
  isLiveWindow,
} from './windowLifecycle';

function fakeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe('window lifecycle helpers', () => {
  it('shows the overlay over the active workspace without hiding the main app first', () => {
    const overlay = fakeWindow(false);
    const main = fakeWindow(false);

    openOverlayOverWorkspace(main, () => {
      overlay.show();
      overlay.focus();
    });

    expect(main.hide).not.toHaveBeenCalled();
    expect(overlay.show).toHaveBeenCalledOnce();
    expect(overlay.focus).toHaveBeenCalledOnce();
  });

  it('hides the overlay without showing or focusing another window', () => {
    const overlay = fakeWindow(false);
    const main = fakeWindow(false);

    hideOverlayOnly(overlay);

    expect(overlay.hide).toHaveBeenCalledOnce();
    expect(main.show).not.toHaveBeenCalled();
    expect(main.focus).not.toHaveBeenCalled();
  });

  it('does not call Electron methods on a destroyed overlay', () => {
    const overlay = fakeWindow(true);
    const main = fakeWindow(false);

    hideOverlayAndShowMain(overlay, main);

    expect(overlay.hide).not.toHaveBeenCalled();
    expect(main.show).toHaveBeenCalledOnce();
    expect(main.focus).toHaveBeenCalledOnce();
  });

  it('treats missing and destroyed windows as unavailable', () => {
    expect(isLiveWindow(null)).toBe(false);
    expect(isLiveWindow(fakeWindow(true))).toBe(false);
    expect(isLiveWindow(fakeWindow(false))).toBe(true);
  });

  it('hides the main window instead of destroying it while the app stays in tray', () => {
    const main = fakeWindow(false);
    const event = { preventDefault: vi.fn() };

    expect(hideWindowOnClose(event, main, false)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(main.hide).toHaveBeenCalledOnce();

    event.preventDefault.mockClear();
    main.hide.mockClear();
    expect(hideWindowOnClose(event, main, true)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(main.hide).not.toHaveBeenCalled();
  });
});
