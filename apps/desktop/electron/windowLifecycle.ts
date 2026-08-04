export interface WindowLifecycleHandle {
  isDestroyed(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
}

export function isLiveWindow<T extends Pick<WindowLifecycleHandle, 'isDestroyed'>>(
  window: T | null | undefined,
): window is T {
  return Boolean(window && !window.isDestroyed());
}

export function hideOverlayOnly(
  overlay: WindowLifecycleHandle | null | undefined,
): void {
  if (isLiveWindow(overlay)) overlay.hide();
}

export function hideOverlayAndShowMain(
  overlay: WindowLifecycleHandle | null | undefined,
  main: WindowLifecycleHandle | null | undefined,
): void {
  if (isLiveWindow(overlay)) overlay.hide();
  if (!isLiveWindow(main)) return;
  main.show();
  main.focus();
}

export function hideWindowOnClose(
  event: { preventDefault(): void },
  window: WindowLifecycleHandle | null | undefined,
  quitting: boolean,
): boolean {
  if (quitting || !isLiveWindow(window)) return false;
  event.preventDefault();
  window.hide();
  return true;
}
