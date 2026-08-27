import { describe, expect, it } from 'vitest';
import { subscribeToSessionHistoryRefresh } from './sessionHistoryRefresh';

describe('subscribeToSessionHistoryRefresh', () => {
  it('refreshes on live-stop and focus and detaches cleanly', () => {
    const target = new EventTarget();
    let refreshes = 0;
    const unsubscribe = subscribeToSessionHistoryRefresh(target, () => {
      refreshes += 1;
    });

    target.dispatchEvent(new Event('skillcue:live-stop'));
    target.dispatchEvent(new Event('focus'));

    expect(refreshes).toBe(2);

    unsubscribe();
    target.dispatchEvent(new Event('skillcue:live-stop'));
    target.dispatchEvent(new Event('focus'));

    expect(refreshes).toBe(2);
  });
});
