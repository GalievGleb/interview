import { beforeEach, describe, expect, it } from 'vitest';
import { activationStage, getActivation, markMilestone } from './activation';

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe('activation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    localStorage.clear();
  });

  it('records a milestone once and does not overwrite the first timestamp', () => {
    expect(markMilestone('firstRun', 1000)).toBe(true);
    expect(markMilestone('firstRun', 2000)).toBe(false); // уже пройдено
    expect(getActivation().firstRun).toBe(1000);
  });

  it('activationStage counts consecutive funnel steps from the start', () => {
    expect(activationStage()).toBe(0);
    markMilestone('firstRun');
    expect(activationStage()).toBe(1);
    markMilestone('vacancyAnalyzed');
    expect(activationStage()).toBe(2);
    markMilestone('mockCompleted');
    markMilestone('liveStarted');
    expect(activationStage()).toBe(4);
  });

  it('stage stops at the first gap (funnel is ordered)', () => {
    // live без mock — воронка не «перепрыгивает»: считаем до разрыва.
    markMilestone('firstRun');
    markMilestone('vacancyAnalyzed');
    markMilestone('liveStarted'); // пропущен mockCompleted
    expect(activationStage()).toBe(2);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('skillcue.activation.v1', 'not json');
    expect(getActivation()).toEqual({});
    expect(markMilestone('firstRun')).toBe(true);
  });
});
