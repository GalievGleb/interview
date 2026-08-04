import { describe, expect, it, vi } from 'vitest';
import { SessionTranscriptWriteQueue } from './sessionTranscriptWriteQueue';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = () => fail(new Error('write failed'));
  });
  return { promise, resolve, reject };
}

describe('SessionTranscriptWriteQueue', () => {
  it('keeps writes ordered and waits for all of them before finalization', async () => {
    const queue = new SessionTranscriptWriteQueue();
    const first = deferred();
    const events: string[] = [];

    queue.enqueue('session-1', async () => {
      events.push('first:start');
      await first.promise;
      events.push('first:end');
    });
    queue.enqueue('session-1', async () => {
      events.push('second');
    });

    const drained = vi.fn();
    void queue.drain('session-1').then(drained);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['first:start']);
    expect(drained).not.toHaveBeenCalled();

    first.resolve();
    await queue.drain('session-1');
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(drained).toHaveBeenCalledOnce();
  });

  it('continues after a failed write so ending the session cannot hang', async () => {
    const queue = new SessionTranscriptWriteQueue();
    const next = vi.fn(async () => undefined);

    queue.enqueue('session-1', async () => {
      throw new Error('network failure');
    });
    queue.enqueue('session-1', next);

    await expect(queue.drain('session-1')).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
