import type { BackendStatus } from '../../types/electron';

export type BackendBannerKind = 'none' | 'failed' | 'dev-offline';

export function getBackendBannerKind({
  backendOnline,
  backendStatus,
  isDev,
}: {
  backendOnline: boolean;
  backendStatus: BackendStatus | null;
  isDev: boolean;
}): BackendBannerKind {
  if (backendOnline) return 'none';
  if (backendStatus?.state === 'failed') return 'failed';
  if (isDev) return 'dev-offline';
  return 'none';
}
