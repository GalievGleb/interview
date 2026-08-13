export interface OverlayPrivacyWindow {
  isDestroyed(): boolean;
  setSkipTaskbar(skip: boolean): void;
  setContentProtection(enable: boolean): void;
  show(): void;
  showInactive(): void;
}

export type OverlayShowMode = 'active' | 'inactive';

/**
 * Keep the floating assistant out of task switching and screen capture.
 *
 * Windows can recreate native window styles while a transparent window is
 * shown. Applying these flags only while the BrowserWindow is hidden is not
 * sufficient, so callers enforce them on both sides of the native show.
 */
export function enforceOverlayWindowPrivacy(
  window: OverlayPrivacyWindow,
  contentProtected: boolean,
): boolean {
  if (window.isDestroyed()) return false;
  window.setSkipTaskbar(true);
  window.setContentProtection(contentProtected);
  return true;
}

export function showOverlayWindowPrivately(
  window: OverlayPrivacyWindow,
  contentProtected: boolean,
  mode: OverlayShowMode = 'active',
): boolean {
  if (!enforceOverlayWindowPrivacy(window, contentProtected)) return false;
  if (mode === 'inactive') window.showInactive();
  else window.show();
  return enforceOverlayWindowPrivacy(window, contentProtected);
}
