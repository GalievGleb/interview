export const SCREEN_CAPTURE_THUMBNAIL_SIZE = { width: 1440, height: 900 } as const;
export const SCREEN_CAPTURE_MAX_JPEG_BYTES = 400_000;

const JPEG_QUALITIES = [55, 45, 35, 25] as const;
const FALLBACK_WIDTHS = [1440, 1200, 1024, 800] as const;

export interface ScreenCaptureImage {
  getSize(): { width: number; height: number };
  resize(options: { width: number; quality: 'good' }): ScreenCaptureImage;
  toJPEG(quality: number): Buffer;
}

/**
 * Keep vision requests quick and bounded even for a noisy 4K desktop. Most UI
 * screenshots fit at 1440 px / quality 55; photographs progressively fall
 * back to a lower JPEG quality and then a smaller width.
 */
export function encodeScreenCapture(image: ScreenCaptureImage): Buffer {
  let current = image;
  let smallest: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  for (const width of FALLBACK_WIDTHS) {
    const size = current.getSize();
    if (size.width > width) current = current.resize({ width, quality: 'good' });

    for (const quality of JPEG_QUALITIES) {
      const jpeg = current.toJPEG(quality);
      if (!smallest.length || jpeg.length < smallest.length) smallest = jpeg;
      if (jpeg.length <= SCREEN_CAPTURE_MAX_JPEG_BYTES) return jpeg;
    }
  }

  return smallest;
}

export function screenCaptureDataUrl(image: ScreenCaptureImage): string {
  const jpeg = encodeScreenCapture(image);
  return jpeg.length ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : '';
}
