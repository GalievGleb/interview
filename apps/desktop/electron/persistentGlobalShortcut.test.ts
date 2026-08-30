import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PersistentGlobalShortcut } from './persistentGlobalShortcut';

const mainSource = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');

describe('PersistentGlobalShortcut', () => {
  it('keeps Ctrl+Enter active independently of overlay focus and visibility', () => {
    let registeredCallback: (() => void) | null = null;
    const registry = {
      register: vi.fn((_accelerator: string, callback: () => void) => {
        registeredCallback = callback;
        return true;
      }),
      unregister: vi.fn(),
      isRegistered: vi.fn(() => registeredCallback !== null),
    };
    const onTrigger = vi.fn();
    const shortcut = new PersistentGlobalShortcut(
      registry,
      'Control+Enter',
      onTrigger,
    );

    expect(shortcut.ensureRegistered()).toBe(true);
    registeredCallback?.();
    expect(onTrigger).toHaveBeenCalledOnce();

    // Overlay show/hide is intentionally absent from this lifecycle. Re-checking
    // registration must not replace or unregister the system-wide callback.
    expect(shortcut.ensureRegistered()).toBe(true);
    expect(registry.register).toHaveBeenCalledOnce();
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it('can recover after Windows temporarily rejects registration', () => {
    const onUnavailable = vi.fn();
    const registry = {
      register: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      unregister: vi.fn(),
      isRegistered: vi.fn(() => false),
    };
    const shortcut = new PersistentGlobalShortcut(
      registry,
      'Control+Enter',
      vi.fn(),
      onUnavailable,
    );

    expect(shortcut.ensureRegistered()).toBe(false);
    expect(onUnavailable).toHaveBeenCalledWith('Control+Enter');
    expect(shortcut.ensureRegistered()).toBe(true);
    expect(registry.register).toHaveBeenCalledTimes(2);
  });

  it('unregisters only when the application is disposed', () => {
    const registry = {
      register: vi.fn(() => true),
      unregister: vi.fn(),
      isRegistered: vi.fn(() => false),
    };
    const shortcut = new PersistentGlobalShortcut(
      registry,
      'Control+Enter',
      vi.fn(),
    );

    shortcut.ensureRegistered();
    shortcut.dispose();

    expect(registry.unregister).toHaveBeenCalledWith('Control+Enter');
  });

  it('is wired at startup but never creates or reveals a hidden developer overlay', () => {
    const registerShortcutsAt = mainSource.indexOf('function registerShortcuts');
    const createTrayAt = mainSource.indexOf('function createTray', registerShortcutsAt);
    const startupSource = mainSource.slice(registerShortcutsAt, createTrayAt);
    expect(startupSource).toContain('registerForceAnswerShortcut();');
    expect(startupSource).toContain('registerForceScreenAnswerShortcut();');
    expect(mainSource).toContain('scheduleToggleOverlayShortcutRetry');
    expect(mainSource).toContain('toggleOverlayShortcutBinding?.ensureRegistered()');
    expect(mainSource).toContain(
      'if (isDeveloperBuild && (!existingOverlay || !existingOverlay.isVisible())) return;',
    );
    expect(mainSource).toContain("if (!win.isVisible()) showOverlayWindow(win, 'inactive');");
    expect(mainSource).toContain("win.webContents.send('overlay:force-answer')");
    expect(mainSource).toContain("win.webContents.send('overlay:force-screen-answer')");
  });
});
