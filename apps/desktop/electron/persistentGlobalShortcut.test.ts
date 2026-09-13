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

  it('retries candidate registration and delivers after the overlay loses focus', () => {
    let callback: (() => void) | null = null;
    const registry = {
      register: vi.fn((_accelerator: string, handler: () => void) => {
        if (registry.register.mock.calls.length === 1) return false;
        callback = handler;
        return true;
      }),
      unregister: vi.fn(),
      isRegistered: vi.fn(() => callback !== null),
    };
    const deliver = vi.fn();
    const shortcut = new PersistentGlobalShortcut(
      registry,
      'CommandOrControl+\\',
      deliver,
    );

    expect(shortcut.ensureRegistered()).toBe(false);
    expect(shortcut.ensureRegistered()).toBe(true);
    callback?.();
    expect(deliver).toHaveBeenCalledOnce();
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

  it('lets Dev answer shortcuts reveal a hidden overlay while Alpha stays isolated', () => {
    const registerShortcutsAt = mainSource.indexOf('function registerShortcuts');
    const createTrayAt = mainSource.indexOf('function createTray', registerShortcutsAt);
    const startupSource = mainSource.slice(registerShortcutsAt, createTrayAt);
    expect(startupSource).toContain('registerForceAnswerShortcut();');
    expect(startupSource).toContain('registerForceScreenAnswerShortcut();');
    expect(startupSource).toContain('registerCandidateFollowUpShortcut();');
    expect(mainSource).toContain('scheduleToggleOverlayShortcutRetry');
    expect(mainSource).toContain('toggleOverlayShortcutBinding?.ensureRegistered()');
    expect(mainSource.match(
      /if \(BUILD_CHANNEL === 'alpha' && \(!existingOverlay \|\| !existingOverlay\.isVisible\(\)\)\) return;/g,
    )).toHaveLength(2);
    expect(mainSource).toContain("if (!win.isVisible()) showOverlayWindow(win, 'inactive');");
    expect(mainSource).toContain("win.webContents.send('overlay:force-answer')");
    expect(mainSource).toContain("win.webContents.send('overlay:force-screen-answer')");
    expect(mainSource).toContain('scheduleCandidateFollowUpShortcutRetry');
    expect(mainSource).toContain('candidateFollowUpShortcutBinding?.ensureRegistered()');
    expect(mainSource).toContain("win.webContents.send('overlay:candidate-follow-up')");
  });

  it('keeps candidate follow-up out of the visibility-scoped shortcut owner', () => {
    const lifecycleSource = fs.readFileSync(
      path.resolve(__dirname, 'overlayShortcutLifecycle.ts'),
      'utf8',
    );
    expect(lifecycleSource).not.toContain('CANDIDATE_FOLLOW_UP_ACCELERATOR');
    expect(lifecycleSource).not.toContain('candidateFollowUp');
  });
});
