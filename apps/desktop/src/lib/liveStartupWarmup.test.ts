import { describe, expect, it, vi } from 'vitest';
import { LiveStartupWarmup } from './liveStartupWarmup';

describe('LiveStartupWarmup', () => {
  it('deduplicates concurrent provider and STT warmups', async () => {
    let release!: () => void;
    const providerReadiness = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => {
        release = () => resolve({ ok: true });
      }),
    );
    const sttWarmup = vi.fn(async () => ({ warmed: {}, ms: 1 }));
    const warmup = new LiveStartupWarmup({ providerReadiness, sttWarmup });

    const first = warmup.warm();
    const second = warmup.warm();
    expect(providerReadiness).toHaveBeenCalledOnce();
    expect(sttWarmup).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await expect(warmup.warm()).resolves.toBe(true);
    expect(providerReadiness).toHaveBeenCalledOnce();
    expect(sttWarmup).toHaveBeenCalledOnce();
  });

  it('does not cache a failed warmup and retries after backend recovery', async () => {
    const providerReadiness = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error('backend restarting'))
      .mockResolvedValueOnce({ ok: true });
    const sttWarmup = vi.fn(async () => ({ warmed: {}, ms: 1 }));
    const warmup = new LiveStartupWarmup({ providerReadiness, sttWarmup });

    await expect(warmup.warm()).resolves.toBe(false);
    await expect(warmup.warm()).resolves.toBe(true);
    expect(providerReadiness).toHaveBeenCalledTimes(2);
    expect(sttWarmup).toHaveBeenCalledTimes(2);
  });

  it('retries when readiness responds but is not ready', async () => {
    const providerReadiness = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const sttWarmup = vi.fn(async () => ({ warmed: {}, ms: 1 }));
    const warmup = new LiveStartupWarmup({ providerReadiness, sttWarmup });

    await expect(warmup.warm()).resolves.toBe(false);
    await expect(warmup.warm()).resolves.toBe(true);
    expect(providerReadiness).toHaveBeenCalledTimes(2);
  });
});
