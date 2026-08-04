interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered?(accelerator: string): boolean;
}

/**
 * Owns one application-wide shortcut for the entire Electron process lifetime.
 *
 * This deliberately has no BrowserWindow show/hide lifecycle. A live interview
 * normally happens while Teams, a browser, or Zoom owns focus, so Ctrl+Enter
 * must remain registered while the overlay is unfocused or temporarily hidden.
 */
export class PersistentGlobalShortcut {
  private registered = false;
  private disposed = false;

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly accelerator: string,
    private readonly onTrigger: () => void,
    private readonly onUnavailable: (accelerator: string) => void = () => {},
  ) {}

  ensureRegistered(): boolean {
    if (this.disposed) return false;
    if (this.registered && this.registry.isRegistered?.(this.accelerator) !== false) {
      return true;
    }

    try {
      const registered = this.registry.register(this.accelerator, this.onTrigger);
      this.registered = registered;
      if (!registered) this.onUnavailable(this.accelerator);
      return registered;
    } catch {
      this.registered = false;
      this.onUnavailable(this.accelerator);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.registered || this.registry.isRegistered?.(this.accelerator)) {
      this.registry.unregister(this.accelerator);
    }
    this.registered = false;
  }
}
