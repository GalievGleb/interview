import { describe, expect, it } from 'vitest';
import { applyRuntimePlatform } from './runtimePlatform';

describe('runtime platform marker', () => {
  it('marks the document as macOS before the shell is rendered', () => {
    const root = { dataset: {} as Record<string, string> };

    applyRuntimePlatform(root, 'darwin');

    expect(root.dataset.platform).toBe('darwin');
  });

  it('removes a stale platform marker outside Electron', () => {
    const root = { dataset: { platform: 'darwin' } as Record<string, string> };

    applyRuntimePlatform(root, undefined);

    expect(root.dataset.platform).toBeUndefined();
  });
});
