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

  it('keeps Escape scoped to overlay visibility without changing stable movement', () => {
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

  it('moves and scrolls an unfocused overlay while it is visible', () => {
    const callbacks = new Map<string, () => void>();
    const shortcuts = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        callbacks.set(accelerator, callback);
        return true;
      }),
      unregister: vi.fn((accelerator: string) => callbacks.delete(accelerator)),
    };
    const move = vi.fn();
    const scroll = vi.fn();
    const overlay = fakeOverlayWindow();

    bindOverlayShortcutLifecycle(overlay, shortcuts, vi.fn(), { move, scroll, step: 40 });
    overlay.emit('show');

    callbacks.get('CommandOrControl+Right')?.();
    callbacks.get('CommandOrControl+Up')?.();
    callbacks.get('CommandOrControl+Left')?.();
    callbacks.get('CommandOrControl+Down')?.();
    callbacks.get('CommandOrControl+Shift+Up')?.();
    callbacks.get('CommandOrControl+Shift+Down')?.();
    expect(move).toHaveBeenNthCalledWith(1, 40, 0);
    expect(move).toHaveBeenNthCalledWith(2, 0, -40);
    expect(move).toHaveBeenNthCalledWith(3, -40, 0);
    expect(move).toHaveBeenNthCalledWith(4, 0, 40);
    expect(scroll).toHaveBeenNthCalledWith(1, -1);
    expect(scroll).toHaveBeenNthCalledWith(2, 1);

    overlay.emit('hide');
    expect(shortcuts.unregister).toHaveBeenCalledWith('CommandOrControl+Right');
    expect(shortcuts.unregister).toHaveBeenCalledWith('CommandOrControl+Up');
    expect(shortcuts.unregister).toHaveBeenCalledWith('CommandOrControl+Shift+Down');
  });

  it('enables global movement and scrolling in every build while the overlay is visible', () => {
    expect(mainSource).toContain(
      "win.webContents.send('overlay:scroll', direction)",
    );
    expect(mainSource).not.toContain('isDeveloperBuild ? { move: moveOverlay');
  });

  it('uses a native Windows tool window and one protected show path', () => {
    expect(mainSource).toContain("process.platform === 'win32' ? { type: 'toolbar' as const } : {}");
    expect(mainSource).toContain('showOverlayWindowPrivately(win, overlayContentProtectionEnabled, mode)');
    expect(mainSource).toContain("win.on('show', () => {");
    expect(mainSource).not.toContain('prepareOverlayForOpen(win);\n    win.show();');
  });
});
