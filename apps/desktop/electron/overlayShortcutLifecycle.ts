interface OverlayShortcutWindow {
  on(event: 'show' | 'hide' | 'closed', listener: () => void): unknown;
}

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export function bindOverlayShortcutLifecycle(
  window: OverlayShortcutWindow,
  shortcuts: ShortcutRegistry,
  hideOverlay: () => void,
): void {
  const unregister = () => {
    shortcuts.unregister('Escape');
  };

  window.on('show', () => {
    try {
      shortcuts.register('Escape', hideOverlay);
    } catch {
      // Another application may own the accelerator; the overlay remains usable.
    }
  });
  window.on('hide', unregister);
  window.on('closed', unregister);
}
