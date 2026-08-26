import { describe, expect, it } from 'vitest';
import {
  captureScreenWithoutOverlay,
  encodeScreenCapture,
  ScreenCaptureCoordinator,
  screenCaptureDataUrl,
  SCREEN_CAPTURE_MAX_JPEG_BYTES,
  type ScreenCaptureImage,
} from './screenCapture';

function noisyImage(width: number): ScreenCaptureImage {
  return {
    getSize: () => ({ width, height: Math.round((width * 9) / 16) }),
    resize: ({ width: nextWidth }) => noisyImage(nextWidth),
    toJPEG: (quality) => Buffer.alloc(Math.ceil(width * quality * 12)),
  };
}

describe('screen capture compression', () => {
  it('progressively compresses a noisy desktop below the request budget', () => {
    const jpeg = encodeScreenCapture(noisyImage(2560));

    expect(jpeg.length).toBeGreaterThan(0);
    expect(jpeg.length).toBeLessThanOrEqual(SCREEN_CAPTURE_MAX_JPEG_BYTES);
  });

  it('returns a JPEG data URL accepted by the vision endpoint', () => {
    expect(screenCaptureDataUrl(noisyImage(1440))).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('hides a visible overlay before capture and restores it without stealing focus', async () => {
    const calls: string[] = [];
    const overlay = {
      isDestroyed: () => false,
      isVisible: () => true,
      hide: () => calls.push('hide'),
    };

    const result = await captureScreenWithoutOverlay(
      overlay,
      async () => {
        calls.push('capture');
        return 'image';
      },
      () => calls.push('restore-inactive'),
      async () => {
        calls.push('settle');
      },
    );

    expect(result).toBe('image');
    expect(calls).toEqual(['hide', 'settle', 'capture', 'restore-inactive']);
  });

  it('restores the overlay even when desktop capture fails', async () => {
    const calls: string[] = [];
    const overlay = {
      isDestroyed: () => false,
      isVisible: () => true,
      hide: () => calls.push('hide'),
    };

    await expect(
      captureScreenWithoutOverlay(
        overlay,
        async () => {
          calls.push('capture');
          throw new Error('capture failed');
        },
        () => calls.push('restore-inactive'),
        async () => {
          calls.push('settle');
        },
      ),
    ).rejects.toThrow('capture failed');
    expect(calls).toEqual(['hide', 'settle', 'capture', 'restore-inactive']);
  });

  it('captures immediately when the overlay is already hidden', async () => {
    const calls: string[] = [];
    const overlay = {
      isDestroyed: () => false,
      isVisible: () => false,
      hide: () => calls.push('hide'),
    };

    await captureScreenWithoutOverlay(
      overlay,
      async () => {
        calls.push('capture');
        return 'image';
      },
      () => calls.push('restore-inactive'),
      async () => {
        calls.push('settle');
      },
    );

    expect(calls).toEqual(['capture']);
  });

  it('serializes concurrent captures so every request gets a clean settled desktop', async () => {
    const calls: string[] = [];
    let visible = true;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const overlay = {
      isDestroyed: () => false,
      isVisible: () => visible,
      hide: () => {
        visible = false;
        calls.push('hide');
      },
    };
    const restore = () => {
      visible = true;
      calls.push('restore-inactive');
    };
    const settle = async () => {
      calls.push('settle');
    };
    const coordinator = new ScreenCaptureCoordinator();

    const first = coordinator.run(() =>
      captureScreenWithoutOverlay(
        overlay,
        async () => {
          calls.push('capture:first');
          markFirstStarted();
          await firstBlocked;
          return 'first';
        },
        restore,
        settle,
      ),
    );
    const second = coordinator.run(() =>
      captureScreenWithoutOverlay(
        overlay,
        async () => {
          calls.push('capture:second');
          return 'second';
        },
        restore,
        settle,
      ),
    );

    await firstStarted;
    expect(calls).toEqual(['hide', 'settle', 'capture:first']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(calls).toEqual([
      'hide',
      'settle',
      'capture:first',
      'restore-inactive',
      'hide',
      'settle',
      'capture:second',
      'restore-inactive',
    ]);
  });
});
