import { describe, expect, it } from 'vitest';
import { getBackendBannerKind } from './backendBanner';

describe('getBackendBannerKind', () => {
  it('hides normal packaged startup while backend is still warming up', () => {
    expect(
      getBackendBannerKind({
        backendOnline: false,
        backendStatus: null,
        isDev: false,
      }),
    ).toBe('none');
  });

  it('hides packaged restart noise unless the backend has actually failed', () => {
    expect(
      getBackendBannerKind({
        backendOnline: false,
        backendStatus: { state: 'restarting', attempt: 1, max: 3 },
        isDev: false,
      }),
    ).toBe('none');
  });

  it('shows a packaged failure only after main process gives up', () => {
    expect(
      getBackendBannerKind({
        backendOnline: false,
        backendStatus: { state: 'failed', attempt: 3, max: 3 },
        isDev: false,
      }),
    ).toBe('failed');
  });

  it('keeps the developer hint in dev mode', () => {
    expect(
      getBackendBannerKind({
        backendOnline: false,
        backendStatus: null,
        isDev: true,
      }),
    ).toBe('dev-offline');
  });
});
