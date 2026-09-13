interface OverlayShortcutWindow {
  on(event: 'show' | 'hide' | 'closed', listener: () => void): unknown;
}

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface OverlayMoveShortcuts {
  move(dx: number, dy: number): void;
  scroll?(direction: -1 | 1): void;
  step?: number;
}

export interface OverlayClickThroughShortcut {
  toggle(): void;
}

const MOVE_ACCELERATORS = [
  ['CommandOrControl+Up', 0, -1],
  ['CommandOrControl+Down', 0, 1],
  ['CommandOrControl+Left', -1, 0],
  ['CommandOrControl+Right', 1, 0],
] as const;

const SCROLL_ACCELERATORS = [
  ['CommandOrControl+Shift+Up', -1],
  ['CommandOrControl+Shift+Down', 1],
] as const;

const CLICK_THROUGH_ACCELERATORS = ['CommandOrControl+Alt+0', 'CommandOrControl+Alt+O'] as const;

export function bindOverlayShortcutLifecycle(
  window: OverlayShortcutWindow,
  shortcuts: ShortcutRegistry,
  hideOverlay: () => void,
  moveShortcuts?: OverlayMoveShortcuts,
  clickThroughShortcut?: OverlayClickThroughShortcut,
): void {
  const unregister = () => {
    shortcuts.unregister('Escape');
    if (moveShortcuts) {
      for (const [accelerator] of MOVE_ACCELERATORS) shortcuts.unregister(accelerator);
      if (moveShortcuts.scroll) {
        for (const [accelerator] of SCROLL_ACCELERATORS) shortcuts.unregister(accelerator);
      }
    }
    if (clickThroughShortcut) {
      for (const accelerator of CLICK_THROUGH_ACCELERATORS) shortcuts.unregister(accelerator);
    }
  };

  window.on('show', () => {
    try {
      shortcuts.register('Escape', hideOverlay);
    } catch {
      // Another application may own the accelerator; the overlay remains usable.
    }
    if (moveShortcuts) {
      const step = moveShortcuts.step ?? 40;
      for (const [accelerator, xDirection, yDirection] of MOVE_ACCELERATORS) {
        try {
          shortcuts.register(accelerator, () => {
            moveShortcuts.move(xDirection * step, yDirection * step);
          });
        } catch {
          // Keep the other directions usable if one accelerator is unavailable.
        }
      }
      if (moveShortcuts.scroll) {
        for (const [accelerator, direction] of SCROLL_ACCELERATORS) {
          try {
            shortcuts.register(accelerator, () => moveShortcuts.scroll?.(direction));
          } catch {
            // Scrolling inside the focused overlay remains available.
          }
        }
      }
    }
    if (clickThroughShortcut) {
      for (const accelerator of CLICK_THROUGH_ACCELERATORS) {
        try {
          shortcuts.register(accelerator, clickThroughShortcut.toggle);
        } catch {
          // Keep the alternate shortcut available if another app owns one.
        }
      }
    }
  });
  window.on('hide', unregister);
  window.on('closed', unregister);
}
