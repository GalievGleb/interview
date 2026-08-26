import { api } from './api';

export interface LiveStartupWarmupDependencies {
  providerReadiness: () => Promise<{ ok: boolean }>;
  sttWarmup: () => Promise<unknown>;
}

/**
 * Renderer-local, retryable warmup gate. Both the main and overlay renderer can
 * request it safely; concurrent calls in one renderer share the same promise.
 */
export class LiveStartupWarmup {
  private warmed = false;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly dependencies: LiveStartupWarmupDependencies) {}

  warm(): Promise<boolean> {
    if (this.warmed) return Promise.resolve(true);
    if (this.inFlight) return this.inFlight;

    const run = this.perform().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async perform(): Promise<boolean> {
    const [provider, stt] = await Promise.allSettled([
      this.dependencies.providerReadiness(),
      this.dependencies.sttWarmup(),
    ]);
    if (
      provider.status !== 'fulfilled' ||
      !provider.value.ok ||
      stt.status !== 'fulfilled'
    ) {
      return false;
    }
    this.warmed = true;
    return true;
  }
}

export const liveStartupWarmup = new LiveStartupWarmup({
  providerReadiness: () => api.providerReadiness(),
  sttWarmup: () => api.sttWarmup(),
});
