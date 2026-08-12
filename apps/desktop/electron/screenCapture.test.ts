import { describe, expect, it } from 'vitest';
import {
  encodeScreenCapture,
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
});
