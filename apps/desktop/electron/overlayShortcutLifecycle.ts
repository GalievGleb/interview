interface OverlayShortcutWindow {
  on(event: 'show' | 'hide' | 'closed', listener: () => void): unknown;
  webContents: { send(channel: string): void };
}

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export function bindOverlayShortcutLifecycle(
  window: OverlayShortcutWindow,
  shortcuts: ShortcutRegistry,
  forceAnswerShortcut: string,
  hideOverlay: () => void,
  onUnavailable: (accelerator: string) => void = () => {},
): void {
  const unregister = () => {
    shortcuts.unregister('Escape');
    shortcuts.unregister(forceAnswerShortcut);
  };

  window.on('show', () => {
    try {
      shortcuts.register('Escape', hideOverlay);
      const registered = shortcuts.register(forceAnswerShortcut, () => {
        window.webContents.send('overlay:force-answer');
      });
      if (!registered) onUnavailable(forceAnswerShortcut);
    } catch {
      // Another application may own the accelerator; the overlay remains usable.
    }
  });
  window.on('hide', unregister);
  window.on('closed', unregister);
}
