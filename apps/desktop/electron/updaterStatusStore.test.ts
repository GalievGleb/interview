import { describe, expect, it, vi } from 'vitest';
import { createUpdaterStatusStore } from './updaterStatusStore';

describe('updater status store', () => {
  it('retains a downloaded update for Settings opened later', () => {
    const notify = vi.fn();
    const store = createUpdaterStatusStore(notify);

    store.publish({ state: 'ready', version: '0.0.11' });

    expect(store.get()).toEqual({ state: 'ready', version: '0.0.11' });
    expect(notify).toHaveBeenCalledWith({ state: 'ready', version: '0.0.11' });
  });

  it('returns immutable snapshots', () => {
    const store = createUpdaterStatusStore(() => {});
    store.publish({ state: 'downloading', version: '0.0.11', percent: 42 });

    const snapshot = store.get();
    snapshot.percent = 100;

    expect(store.get().percent).toBe(42);
  });

  it.each(['waiting-for-session-end', 'installing'] as const)(
    'retains the %s automatic install state',
    (state) => {
      const store = createUpdaterStatusStore(() => {});

      store.publish({ state, version: '0.0.16' });

      expect(store.get()).toEqual({ state, version: '0.0.16' });
    },
  );
});
