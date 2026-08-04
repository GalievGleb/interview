interface OverlayPointerRecoveryWindow {
  isDestroyed(): boolean;
  setIgnoreMouseEvents(ignore: boolean, options: { forward: boolean }): void;
  webContents: {
    on(event: 'render-process-gone' | 'did-fail-load', listener: () => void): void;
  };
}

/** A crashed or failed overlay renderer must never leave an invisible mouse blocker. */
export function bindOverlayPointerRecovery(window: OverlayPointerRecoveryWindow): void {
  const restoreClickThrough = () => {
    if (window.isDestroyed()) return;
    window.setIgnoreMouseEvents(true, { forward: true });
  };
  window.webContents.on('render-process-gone', restoreClickThrough);
  window.webContents.on('did-fail-load', restoreClickThrough);
}
