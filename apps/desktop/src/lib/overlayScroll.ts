const OVERLAY_SCROLL_LINE_PX = 24;

/** Один шаг Ctrl+Shift+↑/↓ — примерно одна строка кода. */
export function overlayScrollOffset(direction: -1 | 1): number {
  return direction * OVERLAY_SCROLL_LINE_PX;
}
