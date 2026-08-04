import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import {
  clearSessionKnowledge,
  loadSessionWeakTopics,
  mergeKnowledgeTopics,
  refreshSessionKnowledge,
  saveSessionKnowledge,
  SESSION_KNOWLEDGE_EPOCH_KEY,
} from './sessionKnowledge';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe('session knowledge cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage(),
    });
  });

  it('merges repeated topics using confidence-weighted scores', () => {
    expect(
      mergeKnowledgeTopics([
        { topic: 'Тест-дизайн', score: 40, confidence: 0.8 },
        { topic: '  тест-дизайн ', score: 60, confidence: 1 },
      ]),
    ).toEqual([
      { topic: 'Тест-дизайн', score: 51, confidence: 0.9, evidenceCount: 2 },
    ]);
  });

  it('persists only validated weak-topic rows and survives damaged JSON', () => {
    saveSessionKnowledge({
      weakTopics: [
        { topic: 'API', score: 45, confidence: 0.8, evidenceCount: 2 },
      ],
      strongTopics: [],
      updatedAt: '2026-08-02T00:00:00',
    });
    expect(loadSessionWeakTopics()).toEqual([
      { topic: 'API', score: 45, confidence: 0.8, evidenceCount: 2 },
    ]);

    localStorage.setItem('skillcue:session-knowledge:v1', '{broken');
    expect(loadSessionWeakTopics()).toEqual([]);
  });

  it('removes cached topics after private data is deleted', () => {
    saveSessionKnowledge({
      weakTopics: [{ topic: 'API', score: 45, confidence: 0.8, evidenceCount: 2 }],
      strongTopics: [],
      updatedAt: '2026-08-02T00:00:00',
    });

    clearSessionKnowledge();

    expect(localStorage.getItem('skillcue:session-knowledge:v1')).toBeNull();
    expect(loadSessionWeakTopics()).toEqual([]);
  });

  it('does not restore stale topics when an earlier refresh finishes after deletion', async () => {
    let resolveRequest!: (value: Awaited<ReturnType<typeof api.getKnowledgeMap>>) => void;
    vi.spyOn(api, 'getKnowledgeMap').mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const refresh = refreshSessionKnowledge();
    clearSessionKnowledge();
    resolveRequest({
      weakTopics: [{ topic: 'Deleted topic', score: 30, confidence: 0.9, evidenceCount: 1 }],
      strongTopics: [],
      updatedAt: '2026-08-02T00:00:00',
    });
    await refresh;

    expect(localStorage.getItem('skillcue:session-knowledge:v1')).toBeNull();
  });

  it('does not restore stale topics after another window clears the cache', async () => {
    let resolveRequest!: (value: Awaited<ReturnType<typeof api.getKnowledgeMap>>) => void;
    vi.spyOn(api, 'getKnowledgeMap').mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const refresh = refreshSessionKnowledge();
    localStorage.setItem(SESSION_KNOWLEDGE_EPOCH_KEY, 'cleared-in-another-window');
    localStorage.removeItem('skillcue:session-knowledge:v1');
    resolveRequest({
      weakTopics: [{ topic: 'Deleted topic', score: 30, confidence: 0.9, evidenceCount: 1 }],
      strongTopics: [],
      updatedAt: '2026-08-02T00:00:00',
    });
    await refresh;

    expect(localStorage.getItem('skillcue:session-knowledge:v1')).toBeNull();
  });
});
