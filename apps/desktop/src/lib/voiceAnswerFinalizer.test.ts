import { describe, expect, it, vi } from 'vitest';
import { createVoiceAnswerFinalizer } from './voiceAnswerFinalizer';

describe('voice answer finalization', () => {
  it('waits for the forced transcript before closing the STT session', async () => {
    let transcript = '';
    const events: string[] = [];
    const session = {
      stopCapture: vi.fn(() => events.push('capture-stopped')),
      flush: vi.fn((requestId: string) => {
        events.push(`finalize:${requestId}`);
        return true;
      }),
      stop: vi.fn(() => events.push('session-stopped')),
    };
    const finalizer = createVoiceAnswerFinalizer({
      createRequestId: () => 'answer-1',
      timeoutMs: 10_000,
    });

    const answerPromise = finalizer.finish(session, () => transcript);

    expect(events).toEqual(['capture-stopped', 'finalize:answer-1']);
    expect(session.stop).not.toHaveBeenCalled();

    transcript = 'List изменяемый, tuple неизменяемый.';
    expect(finalizer.settle(undefined)).toBe(false);
    expect(finalizer.settle('another-request')).toBe(false);
    expect(finalizer.settle('answer-1')).toBe(true);

    await expect(answerPromise).resolves.toEqual({ status: 'completed', text: transcript });
    expect(events).toEqual([
      'capture-stopped',
      'finalize:answer-1',
      'session-stopped',
    ]);
  });

  it('falls back to the transcript already received when finalize cannot be sent', async () => {
    const session = {
      stopCapture: vi.fn(),
      flush: vi.fn(() => false),
      stop: vi.fn(),
    };
    const finalizer = createVoiceAnswerFinalizer({ createRequestId: () => 'answer-2' });

    await expect(finalizer.finish(session, () => 'Уже распознано')).resolves.toEqual({
      status: 'completed',
      text: 'Уже распознано',
    });
    expect(session.stop).toHaveBeenCalledOnce();
    expect(finalizer.isPending()).toBe(false);
  });

  it('does not leave the microphone session hanging when STT finalization times out', async () => {
    vi.useFakeTimers();
    try {
      const session = {
        stopCapture: vi.fn(),
        flush: vi.fn(() => true),
        stop: vi.fn(),
      };
      const finalizer = createVoiceAnswerFinalizer({
        createRequestId: () => 'answer-3',
        timeoutMs: 500,
      });

      const answerPromise = finalizer.finish(session, () => 'Последний промежуточный текст');
      await vi.advanceTimersByTimeAsync(500);

      await expect(answerPromise).resolves.toEqual({
        status: 'completed',
        text: 'Последний промежуточный текст',
      });
      expect(session.stop).toHaveBeenCalledOnce();
      expect(finalizer.isPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending finish without allowing its awaiting submit to continue', async () => {
    const session = {
      stopCapture: vi.fn(),
      flush: vi.fn(() => true),
      stop: vi.fn(),
    };
    const finalizer = createVoiceAnswerFinalizer({ createRequestId: () => 'answer-4' });
    const answerPromise = finalizer.finish(session, () => 'Не отправлять');

    expect(finalizer.cancel()).toBe(true);

    await expect(answerPromise).resolves.toEqual({
      status: 'cancelled',
      text: 'Не отправлять',
    });
    expect(session.stop).toHaveBeenCalledOnce();
    expect(finalizer.isPending()).toBe(false);
  });
});
