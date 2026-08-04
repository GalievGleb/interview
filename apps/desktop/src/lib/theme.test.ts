import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('theme isolation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps an overlay dark after another window switches the saved theme to light', async () => {
    const listeners: {
      storage?: (event: { key: string; newValue: string | null }) => void;
    } = {};
    const documentElement = { dataset: {} as Record<string, string> };

    vi.stubGlobal('document', { documentElement });
    vi.stubGlobal('localStorage', {
      getItem: () => 'light',
      setItem: vi.fn(),
    });
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
      addEventListener: (name: string, listener: NonNullable<typeof listeners.storage>) => {
        if (name === 'storage') listeners.storage = listener;
      },
    });

    const theme = await import('./theme');
    theme.initTheme();
    expect(documentElement.dataset.theme).toBe('light');

    theme.forceDarkTheme();
    listeners.storage?.({ key: 'skillcue.theme', newValue: 'light' });

    expect(documentElement.dataset.theme).toBe('dark');
  });
});
