import { describe, expect, it } from 'vitest';
import { shouldQueueIncomingAnswer } from './liveAnswerQueue';

describe('live answer queue', () => {
  it('queues a new question instead of canceling the answer currently streaming', () => {
    expect(
      shouldQueueIncomingAnswer(
        'Как вы тестировали CI и CD?',
        'Какие бывают варианты?',
      ),
    ).toBe(true);
  });

  it('does not queue duplicate restatements of the same question', () => {
    expect(
      shouldQueueIncomingAnswer(
        'Какие бывают виды тестирования?',
        'Какие бывают виды тестирования?',
      ),
    ).toBe(false);
  });
});
