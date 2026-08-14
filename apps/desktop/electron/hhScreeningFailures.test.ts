import { describe, expect, it } from 'vitest';
import { partitionUnresolvedScreeningQuestions } from './hhScreeningFailures';

describe('HH screening generation failures', () => {
  it('does not materialize rejected AI batches as personal pending questions', () => {
    const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
    const partition = partitionUnresolvedScreeningQuestions(
      questions,
      new Set(['q1', 'q2', 'q3']),
      new Set(['q1', 'q2', 'q3']),
    );

    expect(partition.pendingQuestions).toEqual([]);
    expect(partition.transientUnresolved).toBe(3);
  });

  it('keeps genuine manual questions when another batch failed transiently', () => {
    const questions = [{ id: 'manual' }, { id: 'timeout' }];
    const partition = partitionUnresolvedScreeningQuestions(
      questions,
      new Set(['manual', 'timeout']),
      new Set(['timeout']),
    );

    expect(partition.pendingQuestions).toEqual([{ id: 'manual' }]);
    expect(partition.transientUnresolved).toBe(1);
  });
});
