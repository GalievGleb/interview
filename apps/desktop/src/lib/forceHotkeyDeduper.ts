export type ForceHotkeySource = 'renderer' | 'global' | 'button';

export interface ForceHotkeyEvent {
  source: ForceHotkeySource;
  at: number;
}

const DUPLICATE_WINDOW_MS = 200;

/**
 * Electron can deliver one physical Ctrl+Enter through both the renderer and
 * the global shortcut. Only that cross-source pair is a duplicate; a second
 * event from the same source is a deliberate newer request and must win.
 */
export function acceptForceHotkey(
  previous: ForceHotkeyEvent | null,
  next: ForceHotkeyEvent,
): boolean {
  if (!previous) return true;
  if (next.source === 'button' || previous.source === 'button') return true;
  return !(
    next.source !== previous.source &&
    next.at >= previous.at &&
    next.at - previous.at < DUPLICATE_WINDOW_MS
  );
}
