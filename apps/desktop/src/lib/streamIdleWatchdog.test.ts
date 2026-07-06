import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleWatchdog } from './api';

// Сторож простоя SSE-стримов: тишина STREAM_IDLE_TIMEOUT_MS (25с) = мёртвый
// поток → abort + timedOut. Без него зависший live-суфлёр держал бы streamLock
// навсегда и молча игнорировал все следующие вопросы до конца сессии.
describe('createIdleWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts and flags timedOut after idle window with no activity', () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller, 'abort');
    const wd = createIdleWatchdog(controller);

    wd.arm();
    expect(wd.state.timedOut).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(24_999);
    expect(spy).not.toHaveBeenCalled(); // ещё в пределах окна

    vi.advanceTimersByTime(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(wd.state.timedOut).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('re-arming on activity prevents the abort (rolling window)', () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller, 'abort');
    const wd = createIdleWatchdog(controller);

    wd.arm();
    // Каждые 20с приходит байт → перевзвод; сторож никогда не срабатывает.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      wd.arm();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(wd.state.timedOut).toBe(false);
  });

  it('disarm cancels a pending abort (normal completion)', () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller, 'abort');
    const wd = createIdleWatchdog(controller);

    wd.arm();
    wd.disarm();
    vi.advanceTimersByTime(60_000);
    expect(spy).not.toHaveBeenCalled();
    expect(wd.state.timedOut).toBe(false);
  });
});
