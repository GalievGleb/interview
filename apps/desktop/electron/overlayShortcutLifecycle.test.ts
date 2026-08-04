import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bindOverlayShortcutLifecycle } from './overlayShortcutLifecycle';

const mainSource = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');

function fakeOverlayWindow() {
  const handlers = new Map<string, Array<() => void>>();
  return {
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    webContents: { send: vi.fn() },
  };
}

describe('overlay shortcut lifecycle', () => {
  it('routes hide shortcuts through the hide-only lifecycle', () => {
    expect(mainSource).toContain('hideOverlayOnly(overlayWindow)');
    expect(mainSource).not.toContain(
      'function hideOverlay(): void {\n  hideOverlayAndShowMain(overlayWindow, mainWindow);',
    );
  });

  it('keeps only Escape scoped to overlay visibility', () => {
    const callbacks = new Map<string, () => void>();
    const shortcuts = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        callbacks.set(accelerator, callback);
        return true;
      }),
      unregister: vi.fn(),
    };
    const hideOverlay = vi.fn();
    const overlay = fakeOverlayWindow();

    bindOverlayShortcutLifecycle(overlay, shortcuts, hideOverlay);
    overlay.emit('show');

    callbacks.get('Escape')?.();
    expect(hideOverlay).toHaveBeenCalledOnce();
    expect(shortcuts.register).not.toHaveBeenCalledWith(
      'Control+Enter',
      expect.any(Function),
    );

    overlay.emit('hide');
    expect(shortcuts.unregister).toHaveBeenCalledWith('Escape');
    expect(shortcuts.unregister).not.toHaveBeenCalledWith('Control+Enter');
  });
});
