import { beforeEach, describe, expect, it, vi } from 'vitest';
import { latestCompleted } from './vacancyReviewStore';
import { getWeakTopicTitles } from './weakTopics';

vi.mock('./vacancyReviewStore', () => ({ latestCompleted: vi.fn() }));

describe('weak topic bridge', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn(() =>
          JSON.stringify({
            weakTopics: [
              { topic: 'API', score: 35, confidence: 0.9, evidenceCount: 2 },
              { topic: 'SQL', score: 48, confidence: 0.8, evidenceCount: 1 },
            ],
          }),
        ),
      },
    });
    vi.mocked(latestCompleted).mockReturnValue({
      report: {
        topicScores: [
          { title: 'API', score: 20, status: 'critical' },
          { title: 'Pytest', score: 50, status: 'weak' },
        ],
      },
    } as never);
  });

  it('keeps mock priority, deduplicates it, then appends lowest live-session topics', () => {
    expect(getWeakTopicTitles(5)).toEqual(['API', 'Pytest', 'SQL']);
  });
});
