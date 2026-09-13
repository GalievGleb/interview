import { describe, expect, it } from 'vitest';
import { LiveAnswerMemory } from './liveAnswerMemory';

describe('LiveAnswerMemory', () => {
  it('retains only two bounded completed turns and excludes failed/empty answers', () => {
    const memory = new LiveAnswerMemory();
    const epoch = memory.reset();
    memory.complete(epoch, 'first', 'answer', true);
    memory.complete(epoch, 'second', 'answer', true);
    memory.complete(epoch, 'q'.repeat(900), 'a'.repeat(1900), true);
    memory.complete(epoch, 'failed', 'partial', false);
    memory.complete(epoch, 'empty', ' ', true);
    expect(memory.snapshot()).toEqual([
      { question: 'second', answer: 'answer' },
      { question: 'q'.repeat(800), answer: 'a'.repeat(1800) },
    ]);
  });

  it('reset discards history and rejects late completion from an older session/source', () => {
    const memory = new LiveAnswerMemory();
    const old = memory.reset();
    memory.complete(old, 'project', 'answer', true);
    memory.reset();
    memory.complete(old, 'late', 'answer', true);
    expect(memory.snapshot()).toEqual([]);
  });
});
