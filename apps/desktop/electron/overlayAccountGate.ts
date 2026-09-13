import type { BuildChannel } from './buildChannel';

type OverlayAccount = { authenticated: boolean; user: { id: string } | null };

export function runWithOverlayAccount(
  channel: BuildChannel,
  account: OverlayAccount | null | undefined,
  reveal: () => void,
  requireLogin: () => void,
): boolean {
  if (channel === 'alpha' && (!account?.authenticated || !account.user?.id)) {
    requireLogin();
    return false;
  }
  reveal();
  return true;
}
