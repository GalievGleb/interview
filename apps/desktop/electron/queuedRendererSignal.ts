type IpcListener = (...args: unknown[]) => void;

export interface RendererSignalSource {
  on(channel: string, listener: IpcListener): unknown;
}

/** Keeps one startup signal until preload's renderer consumer is ready. */
export class QueuedRendererSignal {
  private pending = false;
  private subscriber: (() => void) | null = null;

  constructor(source: RendererSignalSource, channel: string) {
    source.on(channel, () => {
      if (this.subscriber) {
        this.subscriber();
        return;
      }
      this.pending = true;
    });
  }

  subscribe(callback: () => void): () => void {
    this.subscriber = callback;
    if (this.pending) {
      this.pending = false;
      callback();
    }
    return () => {
      if (this.subscriber === callback) this.subscriber = null;
    };
  }
}
