export interface LazyWindowHandle {
  isDestroyed(): boolean;
}

export interface RendererReadyWindow extends LazyWindowHandle {
  webContents: {
    isLoadingMainFrame(): boolean;
    once(event: 'did-finish-load', listener: () => void): unknown;
  };
}

export class LazyWindow<T extends LazyWindowHandle> {
  private current: T | null = null;

  constructor(private readonly create: () => T) {}

  peek(): T | null {
    if (this.current?.isDestroyed()) this.current = null;
    return this.current;
  }

  getOrCreate(): T {
    const current = this.peek();
    if (current) return current;
    this.current = this.create();
    return this.current;
  }

  clear(expected: T): void {
    if (this.current === expected) this.current = null;
  }
}

export function showWindowAfterRendererReady(
  window: RendererReadyWindow,
  show: () => void,
): Promise<void> {
  if (window.isDestroyed()) return Promise.resolve();
  if (!window.webContents.isLoadingMainFrame()) {
    show();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed()) show();
      resolve();
    });
  });
}
