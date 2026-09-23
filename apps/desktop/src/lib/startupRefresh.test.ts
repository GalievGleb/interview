import { expect, it, vi } from 'vitest';
import { runStartupRefreshes } from './startupRefresh';

it('starts backend and account refreshes concurrently', async () => {
  let finishBackend!: () => void;
  const backendPending = new Promise<void>((resolve) => { finishBackend = resolve; });
  const refreshBackend = vi.fn(() => backendPending);
  const refreshAccount = vi.fn(async () => undefined);

  const startup = runStartupRefreshes(refreshBackend, refreshAccount);

  expect(refreshBackend).toHaveBeenCalledOnce();
  expect(refreshAccount).toHaveBeenCalledOnce();
  finishBackend();
  await startup;
});
