import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultLiveCopilotPrefs,
  loadLiveCopilotPrefs,
  prefsToSttOptions,
  saveLiveCopilotPrefs,
} from './liveCopilotPrefs';

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('liveCopilotPrefs', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    localStorage.clear();
  });

  it('returns defaults when storage is empty', () => {
    const prefs = loadLiveCopilotPrefs();
    expect(prefs).not.toHaveProperty('mode');
    expect(prefs.language).toBe('ru');
    expect(prefs).not.toHaveProperty('sttEngine');
    expect(prefs.sources.mic).toBe(true);
  });

  it('persists and restores valid prefs', () => {
    const prefs = {
      ...defaultLiveCopilotPrefs(),
      language: 'en',
      audioRate: '48k-native' as const,
      sources: { mic: false, system: true },
    };
    saveLiveCopilotPrefs(prefs);
    expect(loadLiveCopilotPrefs()).toEqual(prefs);
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem(
      'copilot-live-prefs',
      JSON.stringify({ mode: 'broken', sttEngine: 'nova3-multi', language: '' }),
    );
    const prefs = loadLiveCopilotPrefs();
    expect(prefs).not.toHaveProperty('mode');
    expect(prefs).not.toHaveProperty('sttEngine');
    expect(prefs.language).toBe('ru');
  });

  it('maps prefs to STT session options', () => {
    const options = prefsToSttOptions({
      ...defaultLiveCopilotPrefs(),
      language: 'en',
      audioRate: '48k-native',
    });
    expect(options).toEqual({
      language: 'en',
      audioSampleRate: '48k-native',
    });
  });
});
