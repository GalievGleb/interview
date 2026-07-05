import { beforeEach, describe, expect, it } from 'vitest';
import {
  answerLanguageParam,
  loadAnswerLanguage,
  saveAnswerLanguage,
} from './answerLanguage';

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

describe('answerLanguage', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    localStorage.clear();
  });

  it('defaults to auto when storage is empty or corrupt', () => {
    expect(loadAnswerLanguage()).toBe('auto');
    localStorage.setItem('skillcue.answerLanguage', 'klingon');
    expect(loadAnswerLanguage()).toBe('auto');
  });

  it('round-trips ru/en through storage', () => {
    saveAnswerLanguage('en');
    expect(loadAnswerLanguage()).toBe('en');
    saveAnswerLanguage('ru');
    expect(loadAnswerLanguage()).toBe('ru');
    saveAnswerLanguage('auto');
    expect(loadAnswerLanguage()).toBe('auto');
  });

  it('maps auto to null for the API payload', () => {
    expect(answerLanguageParam()).toBeNull();
    saveAnswerLanguage('en');
    expect(answerLanguageParam()).toBe('en');
  });
});
