import { describe, expect, it, vi } from 'vitest';
import {
  enforceOverlayWindowPrivacy,
  showOverlayWindowPrivately,
} from './overlayWindowPrivacy';

function fakeWindow(destroyed = false) {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: vi.fn(() => destroyed),
    setSkipTaskbar: vi.fn((skip: boolean) => calls.push(`taskbar:${skip}`)),
    setContentProtection: vi.fn((enable: boolean) => calls.push(`capture:${enable}`)),
    show: vi.fn(() => calls.push('show')),
    showInactive: vi.fn(() => calls.push('showInactive')),
    moveTop: vi.fn(() => calls.push('moveTop')),
  };
}

describe('overlay window privacy', () => {
  it('reapplies capture and taskbar protection after the native window is shown', () => {
    const window = fakeWindow();

    expect(showOverlayWindowPrivately(window, true)).toBe(true);
    expect(window.calls).toEqual([
      'taskbar:true',
      'capture:true',
      'show',
      'moveTop',
      'taskbar:true',
      'capture:true',
    ]);
  });

  it('raises a non-focusable overlay above the active main window without taking focus', () => {
    const window = fakeWindow();

    expect(showOverlayWindowPrivately(window, false, 'inactive')).toBe(true);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.calls).toEqual([
      'taskbar:true',
      'capture:false',
      'showInactive',
      'moveTop',
      'taskbar:true',
      'capture:false',
    ]);
  });

  it('uses the same privacy contract for an inactive forced-answer show', () => {
    const window = fakeWindow();

    expect(showOverlayWindowPrivately(window, true, 'inactive')).toBe(true);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(2);
    expect(window.setContentProtection).toHaveBeenNthCalledWith(2, true);
  });

  it('updates a visible window without changing its visibility', () => {
    const window = fakeWindow();

    expect(enforceOverlayWindowPrivacy(window, false)).toBe(true);
    expect(window.calls).toEqual(['taskbar:true', 'capture:false']);
    expect(window.show).not.toHaveBeenCalled();
  });

  it('does nothing after the native window is destroyed', () => {
    const window = fakeWindow(true);

    expect(showOverlayWindowPrivately(window, true)).toBe(false);
    expect(window.calls).toEqual([]);
  });
});
