import { describe, expect, it } from 'vitest';
import { LatestForcedAnswerCoordinator } from './latestForcedAnswer';

describe('LatestForcedAnswerCoordinator', () => {
  it('lets the newest Ctrl+Enter supersede an older finalization', () => {
    const ids = ['force-1', 'force-2'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);

    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush',
      generation: 1,
      requestId: 'force-1',
      source: 'system',
    });
    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush',
      generation: 2,
      requestId: 'force-2',
      source: 'system',
    });

    expect(coordinator.acceptFinal({ sequence: 1, text: 'Old question' }, 'force-1')).toEqual({
      action: 'store-only',
    });
    expect(
      coordinator.acceptFinal({ sequence: 2, text: 'Which test-design techniques?' }, 'force-2'),
    ).toMatchObject({
      action: 'submit',
      generation: 2,
      question: 'Which test-design techniques?',
    });
  });

  it('waits for the request-tagged latest final instead of answering an earlier id-less final', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');

    expect(
      coordinator.acceptFinal({
        sequence: 7,
        text: 'Какие бывают техники тестирования?',
        source: 'system',
      }),
    ).toEqual({ action: 'wait', generation: 1 });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'finalizing-transcript',
      consumedSequence: 0,
      generation: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 8,
          text: 'Что ты знаешь про принципы REST API?',
          source: 'system',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 8,
      question: 'Что ты знаешь про принципы REST API?',
    });
  });

  it('ignores a late empty result after the tagged final consumed the request', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');
    coordinator.acceptFinal({ sequence: 7, text: 'Use this final' }, 'force-1');

    expect(coordinator.acceptEmpty('force-1')).toEqual({ action: 'store-only' });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'waiting-first-token',
      consumedSequence: 7,
    });
  });

  it('keeps the current generation pending when an empty result races a late final', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'mic');

    expect(coordinator.acceptEmpty('force-1')).toEqual({ action: 'wait', generation: 1 });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'finalizing-transcript',
      requestId: 'force-1',
      generation: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 1,
          text: 'Что такое тестирование?',
          source: 'mic',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      question: 'Что такое тестирование?',
    });
  });

  it('keeps accepting the real transcript after screen fallback has started', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');

    expect(coordinator.beginScreenFallback(1)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      generation: 1,
      phase: 'screen-fallback',
      requestId: 'force-1',
      pendingRequestCount: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 1,
          text: 'Какие бывают техники тест-дизайна?',
          source: 'system',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      question: 'Какие бывают техники тест-дизайна?',
    });
  });

  it('does not consume a final from the wrong source while finalizing', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');

    expect(
      coordinator.acceptFinal({
        sequence: 1,
        text: 'My microphone answer',
        source: 'mic',
      }),
    ).toEqual({ action: 'store-only' });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 2,
          text: 'The interviewer question',
          source: 'system',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      question: 'The interviewer question',
    });
  });

  it('submits an already finalized unconsumed question without STT flush', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');

    expect(coordinator.press([{ sequence: 3, text: 'How do you handle flaky tests?' }], 'system'))
      .toMatchObject({
        action: 'submit',
        generation: 1,
        sequence: 3,
        question: 'How do you handle flaky tests?',
      });
  });

  it('finalizes current speech instead of reusing an older unconsumed final', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-current');

    expect(
      coordinator.press(
        [{ sequence: 1, text: 'Предыдущая уже распознанная фраза', source: 'mic' }],
        'mic',
        true,
      ),
    ).toMatchObject({
      action: 'flush',
      requestId: 'force-current',
      source: 'mic',
    });
    expect(
      coordinator.acceptFinal(
        { sequence: 2, text: 'Самая последняя фраза', source: 'mic' },
        'force-current',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 2,
      question: 'Самая последняя фраза',
    });
  });

  it('reports empty audio only for the current request', () => {
    const ids = ['old', 'current'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);
    coordinator.press([], 'mic');
    coordinator.press([], 'mic');

    expect(coordinator.acceptEmpty('old')).toEqual({ action: 'store-only' });
    expect(coordinator.acceptEmpty('current')).toMatchObject({
      action: 'wait',
      generation: 2,
    });
  });

  it('never reuses a final that the normal answer flow already handled', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'next-flush');
    coordinator.markHandled(4);

    expect(
      coordinator.press([{ sequence: 4, text: 'Already answered question' }], 'system'),
    ).toMatchObject({
      action: 'flush',
      requestId: 'next-flush',
    });
  });

  it('stores a superseded final without consuming it for a later press', () => {
    const ids = ['old', 'current', 'next'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);
    coordinator.press([], 'system');
    coordinator.press([], 'system');

    expect(coordinator.acceptFinal({ sequence: 8, text: 'Stale question' }, 'old')).toEqual({
      action: 'store-only',
    });
    expect(coordinator.snapshot().consumedSequence).toBe(0);
    expect(coordinator.acceptEmpty('current')).toMatchObject({ action: 'wait' });
    expect(coordinator.press([{ sequence: 8, text: 'Stale question' }], 'system')).toMatchObject({
      action: 'submit',
      generation: 3,
      sequence: 8,
      question: 'Stale question',
    });
  });

  it('keeps only the current transcript-finalization request', () => {
    let nextId = 0;
    const coordinator = new LatestForcedAnswerCoordinator(() => `force-${++nextId}`);

    for (let index = 0; index < 100; index += 1) coordinator.press([], 'mic');

    expect(coordinator.snapshot().pendingRequestCount).toBe(1);
    coordinator.setPhase(100, 'error');
    expect(coordinator.snapshot().pendingRequestCount).toBe(0);
  });

  it('starts a typed question as a newer generation', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'old-flush');
    coordinator.press([], 'system');

    expect(coordinator.submitQuestion('What is contract testing?')).toMatchObject({
      action: 'submit',
      generation: 2,
      question: 'What is contract testing?',
    });
    expect(coordinator.snapshot()).toMatchObject({
      generation: 2,
      phase: 'waiting-first-token',
      pendingRequestCount: 0,
    });
    expect(coordinator.acceptEmpty('old-flush')).toEqual({ action: 'store-only' });
  });
});
