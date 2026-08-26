export const SCREEN_CAPTURE_THUMBNAIL_SIZE = { width: 1440, height: 900 } as const;
export const SCREEN_CAPTURE_MAX_JPEG_BYTES = 400_000;

const JPEG_QUALITIES = [55, 45, 35, 25] as const;
const FALLBACK_WIDTHS = [1440, 1200, 1024, 800] as const;

export interface ScreenCaptureImage {
  getSize(): { width: number; height: number };
  resize(options: { width: number; quality: 'good' }): ScreenCaptureImage;
  toJPEG(quality: number): Buffer;
}

export interface ScreenCaptureOverlayWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  hide(): void;
}

/**
 * Electron may receive a second vision request while the first one is still
 * waiting for the hidden overlay to leave the Windows compositor. Keep those
 * captures strictly ordered so every request performs its own hide/settle/
 * capture/restore cycle instead of photographing a half-restored overlay.
 */
export class ScreenCaptureCoordinator {
  private tail: Promise<void> = Promise.resolve();

  run<T>(capture: () => Promise<T>): Promise<T> {
    const result = this.tail.then(capture);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const waitForOverlayToLeaveDesktop = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  });

/**
 * Capture the desktop behind SkillCue, never SkillCue itself. Hiding the
 * transparent overlay is more reliable than relying on optional Windows
 * content-protection flags, and showInactive restores it without stealing
 * focus from the interview window.
 */
export async function captureScreenWithoutOverlay<T>(
  overlay: ScreenCaptureOverlayWindow | null,
  capture: () => Promise<T>,
  restoreInactive: () => void,
  settle: () => Promise<void> = waitForOverlayToLeaveDesktop,
): Promise<T> {
  const shouldRestore = Boolean(
    overlay && !overlay.isDestroyed() && overlay.isVisible(),
  );
  if (!shouldRestore || !overlay) return capture();

  overlay.hide();
  try {
    await settle();
    return await capture();
  } finally {
    if (!overlay.isDestroyed()) restoreInactive();
  }
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
