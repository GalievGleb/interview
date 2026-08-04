import { describe, expect, it } from 'vitest';
import {
  OverlayPointerController,
  clampFloatingPanel,
  shouldCaptureOverlayPointer,
} from './overlayPointerPolicy';

describe('overlay pointer policy', () => {
  it('captures only an explicit visible hit region', () => {
    expect(shouldCaptureOverlayPointer({ closest: () => null } as never)).toBe(false);
    expect(shouldCaptureOverlayPointer({ closest: () => ({}) } as never)).toBe(true);
  });

  it('releases a removed hit region immediately without another mouse move', () => {
    const clickThrough: boolean[] = [];
    let hit = true;
    const controller = new OverlayPointerController(
      (enabled) => clickThrough.push(enabled),
      () => ({ closest: () => (hit ? {} : null) } as never),
    );

    controller.initialize();
    controller.move(100, 120);
    hit = false;
    controller.refresh();

    expect(clickThrough).toEqual([true, false, true]);
  });

  it('clamps a tooltip at the left and top edges', () => {
    expect(
      clampFloatingPanel(
        { left: 4, top: 3, right: 44, bottom: 27, width: 40, height: 24 },
        { width: 220, height: 48 },
        { width: 680, height: 780 },
        'top',
      ),
    ).toEqual({ left: 8, top: 35 });
  });

  it('keeps a tall menu inside the native window', () => {
    const result = clampFloatingPanel(
      { left: 520, top: 500, right: 560, bottom: 540, width: 40, height: 40 },
      { width: 300, height: 600 },
      { width: 680, height: 780 },
      'top',
    );

    expect(result.left).toBe(372);
    expect(result.top).toBe(172);
  });
});
